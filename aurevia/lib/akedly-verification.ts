import {createHash,randomUUID} from 'node:crypto';
import {AccountMode,NotificationType,Prisma,VerificationChannel} from '@prisma/client';
import {db} from '@/lib/db';
import {createNotification} from '@/lib/notifications';
import {verificationConfig} from '@/lib/config';
import {createVerifiedRegistration} from '@/lib/registration-attempt';
import {generateAureviaExchangeId,retryAureviaExchangeIdCollision} from '@/lib/aurevia-exchange-id';
import {
	AkedlyContact,
	AkedlyAttempt,
	createAkedlyAttempt,
	isConfirmedAkedlyAttempt,
	isConfirmedAkedlyLookup,
	lookupAkedlyAttempt,
} from '@/lib/akedly';

const ATTEMPT_PREFIX='AKEDLY:';
type RegistrationChallenge={
	id:string;
	channel:VerificationChannel;
	expiresAt:Date;
	registrationAttempt:{
		id:string;
		email:string;
		expiresAt:Date;
	};
};

export async function startAkedlyRegistrationVerification(registrationAttemptId:string,email:string):Promise<AkedlyAttempt>{
	const now=new Date();
	const existing=await db.registrationVerification.findUnique({where:{registrationAttemptId}});
	if(existing&&existing.resendAfter>now)throw new Error('AKEDLY_RESEND_COOLDOWN');
	const reservation=createHash('sha256').update(randomUUID()).digest('hex');
	const expiresAt=new Date(now.getTime()+5*60_000);
	const resendAfter=new Date(now.getTime()+verificationConfig.resendCooldownSeconds*1000);
	if(existing){
		const reserved=await db.registrationVerification.updateMany({
			where:{id:existing.id,resendAfter:{lte:now}},
			data:{codeHash:reservation,channel:VerificationChannel.EMAIL,providerReference:'AKEDLY_PENDING',expiresAt,resendAfter,attempts:0},
		});
		if(reserved.count!==1)throw new Error('AKEDLY_RESEND_COOLDOWN');
	}else{
		await db.registrationVerification.create({
			data:{registrationAttemptId,codeHash:reservation,channel:VerificationChannel.EMAIL,providerReference:'AKEDLY_PENDING',expiresAt,resendAfter},
		});
	}
	try{
		const attempt=await createAkedlyAttempt({email});
		const saved=await db.registrationVerification.updateMany({
			where:{registrationAttemptId,codeHash:reservation,providerReference:'AKEDLY_PENDING'},
			data:{providerReference:`${ATTEMPT_PREFIX}${attempt.attemptId}`,expiresAt:attempt.expiresAt},
		});
		if(saved.count!==1)throw new Error('AKEDLY_ATTEMPT_RESERVATION_LOST');
		return attempt;
	}catch(error){
		if(existing){
			await db.registrationVerification.updateMany({
				where:{id:existing.id,codeHash:reservation},
				data:{
					codeHash:existing.codeHash,
					channel:existing.channel,
					providerReference:existing.providerReference,
					expiresAt:existing.expiresAt,
					resendAfter:existing.resendAfter,
					attempts:existing.attempts,
				},
			});
		}else{
			await db.registrationVerification.deleteMany({where:{registrationAttemptId,codeHash:reservation,providerReference:'AKEDLY_PENDING'}});
		}
		throw error;
	}
}

export async function startAkedlyVerification(userId:string,channel:VerificationChannel,contact:AkedlyContact):Promise<AkedlyAttempt>{
	const now=new Date();
	const existing=await db.verificationCode.findUnique({where:{userId}});
	if(existing&&existing.resendAfter>now)throw new Error('AKEDLY_RESEND_COOLDOWN');
	const reservation=createHash('sha256').update(randomUUID()).digest('hex');
	const expiresAt=new Date(now.getTime()+5*60_000);
	const resendAfter=new Date(now.getTime()+verificationConfig.resendCooldownSeconds*1000);
	if(existing){
		const reserved=await db.verificationCode.updateMany({
			where:{id:existing.id,resendAfter:{lte:now}},
			data:{codeHash:reservation,channel,providerReference:'AKEDLY_PENDING',expiresAt,resendAfter,attempts:0},
		});
		if(reserved.count!==1)throw new Error('AKEDLY_RESEND_COOLDOWN');
	}else{
		await db.verificationCode.create({data:{userId,codeHash:reservation,channel,providerReference:'AKEDLY_PENDING',expiresAt,resendAfter}});
	}
	try{
		const attempt=await createAkedlyAttempt(contact);
		const saved=await db.verificationCode.updateMany({
			where:{userId,codeHash:reservation,providerReference:'AKEDLY_PENDING'},
			data:{providerReference:`${ATTEMPT_PREFIX}${attempt.attemptId}`,expiresAt:attempt.expiresAt},
		});
		if(saved.count!==1)throw new Error('AKEDLY_ATTEMPT_RESERVATION_LOST');
		return attempt;
	}catch(error){
		if(existing){
			await db.verificationCode.updateMany({
				where:{id:existing.id,codeHash:reservation},
				data:{
					codeHash:existing.codeHash,
					channel:existing.channel,
					providerReference:existing.providerReference,
					expiresAt:existing.expiresAt,
					resendAfter:existing.resendAfter,
					attempts:existing.attempts,
				},
			});
		}else{
			await db.verificationCode.deleteMany({where:{userId,codeHash:reservation,providerReference:'AKEDLY_PENDING'}});
		}
		throw error;
	}
}

export async function completeAkedlyVerification(attemptId:string,result:unknown,source:'webhook'|'lookup'){
	const reference=`${ATTEMPT_PREFIX}${attemptId}`;
	const registrationChallenge=await db.registrationVerification.findFirst({
		where:{providerReference:reference},
		include:{registrationAttempt:true},
	});
	if(registrationChallenge){
		return completeAkedlyRegistrationVerification(registrationChallenge,result,attemptId,source);
	}
	const challenge=await db.verificationCode.findFirst({
		where:{providerReference:reference},
		include:{user:{select:{id:true,email:true,phone:true,role:true,status:true,accountMode:true,phoneVerified:true,emailVerifiedAt:true,requiresRegistrationVerification:true,aureviaExchangeId:true,createdAt:true}}},
	});
	if(!challenge||challenge.user.role!=='USER'||challenge.user.status!=='ACTIVE')return 'ignored' as const;
	const contact=challenge.channel===VerificationChannel.EMAIL
		?{email:challenge.user.email}
		:challenge.channel===VerificationChannel.SMS&&challenge.user.phone
			?{phoneNumber:challenge.user.phone}
			:null;
	if(!contact)return 'ignored' as const;
	const confirmed=source==='webhook'
		?isConfirmedAkedlyAttempt(result,attemptId,contact,challenge.expiresAt)
		:isConfirmedAkedlyLookup(result,contact,challenge.expiresAt);
	if(!confirmed)return 'ignored' as const;

	const now=new Date();
	return retryAureviaExchangeIdCollision(()=>db.$transaction(async tx=>{
		const stillCurrent=await tx.verificationCode.findFirst({
			where:{id:challenge.id,providerReference:reference},
			select:{id:true},
		});
		if(!stillCurrent)return 'ignored' as const;
		if(challenge.channel===VerificationChannel.EMAIL){
			const updated=await tx.user.updateMany({
				where:{id:challenge.userId,role:'USER',status:'ACTIVE',requiresRegistrationVerification:true,emailVerifiedAt:null,email:challenge.user.email},
				data:{
					emailVerifiedAt:now,
					verifiedChannel:VerificationChannel.EMAIL,
					requiresRegistrationVerification:false,
					...(!challenge.user.aureviaExchangeId?{aureviaExchangeId:generateAureviaExchangeId(challenge.user.createdAt)}:{}),
				},
			});
			if(updated.count===0){
				const current=await tx.user.findUnique({where:{id:challenge.userId},select:{emailVerifiedAt:true,verifiedChannel:true,requiresRegistrationVerification:true}});
				return current?.verifiedChannel===VerificationChannel.EMAIL&&current.emailVerifiedAt&&!current.requiresRegistrationVerification?'already' as const:'ignored' as const;
			}
			await createNotification(tx,{
				userId:challenge.userId,
				type:NotificationType.ACCOUNT,
				title:'Email address verified',
				message:'Your email address was verified with Akedly.',
				dedupeKey:`akedly:${attemptId}:verified`,
				actionUrl:'/login?verified=1',
			});
			await tx.auditLog.create({
				data:{action:'AKEDLY_EMAIL_VERIFIED',entity:'USER',entityId:challenge.userId,metadata:{provider:'akedly',attemptRef:hashAttemptReference(attemptId)}},
			});
			return 'verified' as const;
		}
		if(challenge.channel===VerificationChannel.SMS&&challenge.user.phone){
			const updated=await tx.user.updateMany({
				where:{id:challenge.userId,role:'USER',status:'ACTIVE',accountMode:AccountMode.REAL,phone:challenge.user.phone,phoneVerified:false},
				data:{phoneVerified:true,phoneVerifiedAt:now},
			});
			if(updated.count===0){
				const current=await tx.user.findUnique({where:{id:challenge.userId},select:{phone:true,phoneVerified:true}});
				return current?.phone===challenge.user.phone&&current.phoneVerified?'already' as const:'ignored' as const;
			}
			await createNotification(tx,{
				userId:challenge.userId,
				type:NotificationType.ACCOUNT,
				title:'Phone number verified',
				message:'Your phone number was verified with Akedly.',
				dedupeKey:`akedly:${attemptId}:verified`,
				actionUrl:'/kyc',
			});
			await tx.auditLog.create({
				data:{action:'AKEDLY_PHONE_VERIFIED',entity:'USER',entityId:challenge.userId,metadata:{provider:'akedly',attemptRef:hashAttemptReference(attemptId)}},
			});
			return 'verified' as const;
		}
		return 'ignored' as const;
	}));
}

async function completeAkedlyRegistrationVerification(
	challenge:RegistrationChallenge|null,
	result:unknown,
	attemptId:string,
	source:'webhook'|'lookup',
){
	if(!challenge||challenge.channel!==VerificationChannel.EMAIL)return 'ignored' as const;
	const attempt=challenge.registrationAttempt;
	const now=new Date();
	if(attempt.expiresAt<=now||challenge.expiresAt<=now){
		await db.registrationAttempt.deleteMany({where:{id:attempt.id}});
		return 'ignored' as const;
	}
	const confirmed=source==='webhook'
		?isConfirmedAkedlyAttempt(result,attemptId,{email:attempt.email},challenge.expiresAt)
		:isConfirmedAkedlyLookup(result,{email:attempt.email},challenge.expiresAt);
	if(!confirmed)return 'ignored' as const;

	try{
		return await db.$transaction(async tx=>{
			const stillCurrent=await tx.registrationVerification.findFirst({
				where:{
					id:challenge.id,
					providerReference:`${ATTEMPT_PREFIX}${attemptId}`,
					expiresAt:{gt:now},
					registrationAttempt:{is:{expiresAt:{gt:now}}},
				},
				select:{registrationAttemptId:true},
			});
			if(!stillCurrent)return 'ignored' as const;
			const user=await createVerifiedRegistration(tx,stillCurrent.registrationAttemptId,VerificationChannel.EMAIL,now);
			await tx.auditLog.create({
				data:{action:'AKEDLY_EMAIL_VERIFIED',entity:'USER',entityId:user.id,metadata:{provider:'akedly',attemptRef:hashAttemptReference(attemptId)}},
			});
			return 'verified' as const;
		});
	}catch(error){
		if(error instanceof Error&&error.message==='REGISTRATION_PHONE_ALREADY_IN_USE'){
			await db.registrationAttempt.deleteMany({where:{id:attempt.id}});
			return 'phone-conflict' as const;
		}
		if(error instanceof Prisma.PrismaClientKnownRequestError&&error.code==='P2002'){
			await db.registrationAttempt.deleteMany({where:{id:attempt.id}});
			return 'ignored' as const;
		}
		throw error;
	}
}

export async function reconcileAkedlyAttempt(attemptId:string,userId?:string){
	const registrationChallenge=await db.registrationVerification.findFirst({
		where:{providerReference:`${ATTEMPT_PREFIX}${attemptId}`},
		include:{registrationAttempt:true},
	});
	if(registrationChallenge&&!userId){
		const result=await lookupAkedlyAttempt(attemptId);
		return completeAkedlyVerification(attemptId,result,'lookup');
	}
	const challenge=await db.verificationCode.findFirst({
		where:{providerReference:`${ATTEMPT_PREFIX}${attemptId}`,...(userId?{userId}:{})},
		include:{user:{select:{email:true,phone:true}}},
	});
	if(!challenge)return 'ignored' as const;
	const contact=challenge.channel===VerificationChannel.EMAIL
		?{email:challenge.user.email}
		:challenge.channel===VerificationChannel.SMS&&challenge.user.phone
			?{phoneNumber:challenge.user.phone}
			:null;
	if(!contact)return 'ignored' as const;
	const result=await lookupAkedlyAttempt(attemptId);
	return completeAkedlyVerification(attemptId,result,'lookup');
}

export async function getAkedlyVerificationState(userId:string,attemptId:string,channel?:VerificationChannel){
	const challenge=await db.verificationCode.findFirst({
		where:{userId,providerReference:`${ATTEMPT_PREFIX}${attemptId}`},
		include:{user:{select:{emailVerifiedAt:true,verifiedChannel:true,phoneVerified:true,phoneVerifiedAt:true}}},
	});
	if(!challenge||(channel&&challenge.channel!==channel))return null;
	const verified=challenge.channel===VerificationChannel.EMAIL
		?challenge.user.verifiedChannel===VerificationChannel.EMAIL&&Boolean(challenge.user.emailVerifiedAt)
		:challenge.user.phoneVerified&&Boolean(challenge.user.phoneVerifiedAt);
	return {verified,expiresAt:challenge.expiresAt};
}

export function akedlyAttemptIdFromReference(reference:string|null){
	return reference?.startsWith(ATTEMPT_PREFIX)?reference.slice(ATTEMPT_PREFIX.length):null;
}

function hashAttemptReference(attemptId:string){
	return createHash('sha256').update(attemptId).digest('hex').slice(0,16);
}
