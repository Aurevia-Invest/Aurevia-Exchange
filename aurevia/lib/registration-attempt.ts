import {AccountMode,GenderSelection,Prisma} from '@prisma/client';
import {generateAureviaExchangeId} from '@/lib/aurevia-exchange-id';
import {initializePaperAccount} from '@/lib/ledger';

export type ImmediateRegistrationInput={
	email:string;
	passwordHash:string;
	name:string;
	country:string;
	gender:GenderSelection;
	phone:string|null;
	dateOfBirth:Date;
	accountMode:AccountMode;
	termsAcceptedAt:Date;
};

export async function createImmediateRegistration(
	tx:Prisma.TransactionClient,
	input:ImmediateRegistrationInput,
	now=new Date(),
){
	await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.email})::bigint)`;
	if(input.phone)await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.phone})::bigint)`;

	if(await tx.user.findFirst({where:{email:{equals:input.email,mode:'insensitive'}},select:{id:true}}))throw new Error('REGISTRATION_EMAIL_ALREADY_EXISTS');
	if(input.phone&&await tx.user.findFirst({where:{phone:input.phone},select:{id:true}}))throw new Error('REGISTRATION_PHONE_ALREADY_IN_USE');

	let userCreated=false;
	for(let collisionAttempt=0;collisionAttempt<5&&!userCreated;collisionAttempt++){
		const created=await tx.user.createMany({
			data:[{
				aureviaExchangeId:generateAureviaExchangeId(now),
				email:input.email,
				passwordHash:input.passwordHash,
				name:input.name,
				country:input.country,
				gender:input.gender,
				phone:input.phone,
				phoneVerified:false,
				phoneVerifiedAt:null,
				twoFactorEnabled:false,
				role:'USER',
				accountMode:input.accountMode,
				termsAcceptedAt:input.termsAcceptedAt,
				status:'ACTIVE',
				createdAt:now,
				updatedAt:now,
			}],
			skipDuplicates:true,
		});
		if(created.count===1){
			userCreated=true;
			break;
		}
		if(await tx.user.findFirst({where:{email:{equals:input.email,mode:'insensitive'}},select:{id:true}}))throw new Error('REGISTRATION_EMAIL_ALREADY_EXISTS');
		if(input.phone&&await tx.user.findFirst({where:{phone:input.phone},select:{id:true}}))throw new Error('REGISTRATION_PHONE_ALREADY_IN_USE');
	}
	if(!userCreated)throw new Error('AUREVIA_ID_COLLISION_RETRIES_EXHAUSTED');

	const user=await tx.user.findUniqueOrThrow({where:{email:input.email}});
	await tx.kycProfile.upsert({
		where:{userId:user.id},
		update:{dob:input.dateOfBirth},
		create:{userId:user.id,dob:input.dateOfBirth},
	});
	await initializePaperAccount(tx,user.id,AccountMode.DEMO);
	await initializePaperAccount(tx,user.id,AccountMode.REAL);
	return user;
}
