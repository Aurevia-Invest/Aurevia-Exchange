import {createHash,randomBytes} from 'node:crypto';
import {AccountMode,NotificationType,Prisma,VerificationChannel} from '@prisma/client';
import {NextResponse} from 'next/server';
import {generateAureviaExchangeId} from '@/lib/aurevia-exchange-id';
import {createNotification,notifyActiveAdmins} from '@/lib/notifications';
import {ensureSystemAccount,initializePaperAccount} from '@/lib/ledger';

export const REGISTRATION_COOKIE_NAME='aurevia_registration';
export const REGISTRATION_LIFETIME_MS=10*60_000;

export function createRegistrationToken(){
	return randomBytes(32).toString('base64url');
}

export function hashRegistrationToken(token:string){
	return createHash('sha256').update(token).digest('hex');
}

export function registrationTokenFromRequest(request:Request){
	const header=request.headers.get('cookie');
	if(!header)return null;
	for(const item of header.split(';')){
		const separator=item.indexOf('=');
		if(separator<0||item.slice(0,separator).trim()!==REGISTRATION_COOKIE_NAME)continue;
		const token=item.slice(separator+1).trim();
		return /^[A-Za-z0-9_-]{40,60}$/.test(token)?token:null;
	}
	return null;
}

export function setRegistrationCookie(response:NextResponse,token:string,expiresAt:Date){
	response.cookies.set(REGISTRATION_COOKIE_NAME,token,{
		httpOnly:true,
		secure:process.env.NODE_ENV==='production',
		sameSite:'lax',
		path:'/api/register',
		expires:expiresAt,
		maxAge:Math.max(0,Math.floor((expiresAt.getTime()-Date.now())/1000)),
	});
}

export function clearRegistrationCookie(response:NextResponse){
	response.cookies.set(REGISTRATION_COOKIE_NAME,'',{
		httpOnly:true,
		secure:process.env.NODE_ENV==='production',
		sameSite:'lax',
		path:'/api/register',
		expires:new Date(0),
		maxAge:0,
	});
}

export async function createVerifiedRegistration(
	tx:Prisma.TransactionClient,
	registrationAttemptId:string,
	channel:VerificationChannel,
	now=new Date(),
){
	const attempt=await tx.registrationAttempt.findUnique({where:{id:registrationAttemptId}});
	if(!attempt||attempt.expiresAt<=now)throw new Error('REGISTRATION_ATTEMPT_EXPIRED');
	const claimed=await tx.registrationAttempt.deleteMany({
		where:{id:registrationAttemptId,expiresAt:{gt:now}},
	});
	if(claimed.count!==1)throw new Error('REGISTRATION_ATTEMPT_CONSUMED');

	let userCreated=false;
	for(let collisionAttempt=0;collisionAttempt<5&&!userCreated;collisionAttempt++){
		const created=await tx.user.createMany({
			data:[{
				aureviaExchangeId:generateAureviaExchangeId(now),
				email:attempt.email,
				passwordHash:attempt.passwordHash,
				name:attempt.name,
				country:attempt.country,
				phone:attempt.phone,
				accountMode:attempt.accountMode,
				termsAcceptedAt:attempt.termsAcceptedAt,
				emailVerifiedAt:now,
				verifiedChannel:channel,
				requiresRegistrationVerification:false,
				createdAt:now,
				updatedAt:now,
			}],
			skipDuplicates:true,
		});
		if(created.count===1){
			userCreated=true;
			break;
		}
		const existingEmail=await tx.user.findUnique({where:{email:attempt.email},select:{id:true}});
		if(existingEmail)throw new Error('REGISTRATION_EMAIL_ALREADY_EXISTS');
	}
	if(!userCreated)throw new Error('AUREVIA_ID_COLLISION_RETRIES_EXHAUSTED');
	const user=await tx.user.findUniqueOrThrow({where:{email:attempt.email}});
	await tx.waitlistEntry.updateMany({
		where:{email:attempt.email,userId:null},
		data:{userId:user.id,status:'REGISTERED',updatedAt:now},
	});
	await tx.kycProfile.upsert({
		where:{userId:user.id},
		update:{dob:attempt.dateOfBirth},
		create:{userId:user.id,dob:attempt.dateOfBirth},
	});
	await initializePaperAccount(tx,user.id,AccountMode.DEMO);
	await initializePaperAccount(tx,user.id,AccountMode.REAL);
	await ensureSystemAccount(tx,'SYSTEM:LIABILITY','Customer Funds');
	await createNotification(tx,{
		userId:user.id,
		type:NotificationType.ACCOUNT,
		title:'Welcome to Aurevia Exchange',
		message:'Your account was created after successful email verification. Identity review remains separate for eligible account services.',
		dedupeKey:`registration:${user.id}:created`,
		actionUrl:'/dashboard',
	});
	await createNotification(tx,{
		userId:user.id,
		type:NotificationType.ACCOUNT,
		title:'Email address verified',
		message:'Your email address was verified through the configured provider.',
		dedupeKey:`registration:${user.id}:verified:email`,
		actionUrl:'/dashboard',
	});
	await notifyActiveAdmins(tx,{
		type:NotificationType.ACCOUNT,
		title:'Verified account registration',
		message:'A new account completed email verification.',
		dedupeKey:`registration:${user.id}:admin`,
		relatedEntity:'USER',
		relatedId:user.id,
		actionUrl:'/admin',
	});
	return user;
}
