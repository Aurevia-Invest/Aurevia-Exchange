import {AccountMode,NotificationType,Prisma} from '@prisma/client';
import {generateAureviaExchangeId} from '@/lib/aurevia-exchange-id';
import {createNotification,notifyActiveAdmins} from '@/lib/notifications';
import {ensureSystemAccount,initializePaperAccount} from '@/lib/ledger';

export type ImmediateRegistrationInput={
	email:string;
	passwordHash:string;
	name:string;
	country:string;
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
				phone:input.phone,
				phoneVerified:false,
				phoneVerifiedAt:null,
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
	await tx.waitlistEntry.updateMany({
		where:{email:input.email,userId:null},
		data:{userId:user.id,status:'REGISTERED',updatedAt:now},
	});
	await tx.kycProfile.upsert({
		where:{userId:user.id},
		update:{dob:input.dateOfBirth},
		create:{userId:user.id,dob:input.dateOfBirth},
	});
	await initializePaperAccount(tx,user.id,AccountMode.DEMO);
	await initializePaperAccount(tx,user.id,AccountMode.REAL);
	await ensureSystemAccount(tx,'SYSTEM:LIABILITY','Customer Funds');
	await createNotification(tx,{
		userId:user.id,
		type:NotificationType.ACCOUNT,
		title:'Welcome to Aurevia Exchange',
		message:'Your account is active. Identity verification is only required for eligible account services.',
		dedupeKey:`registration:${user.id}:created`,
		actionUrl:'/dashboard',
	});
	await notifyActiveAdmins(tx,{
		type:NotificationType.ACCOUNT,
		title:'New account registration',
		message:'A new customer account was created.',
		dedupeKey:`registration:${user.id}:admin`,
		relatedEntity:'USER',
		relatedId:user.id,
		actionUrl:'/admin',
	});
	return user;
}
