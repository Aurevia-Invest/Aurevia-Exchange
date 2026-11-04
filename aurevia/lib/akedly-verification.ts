import {createHash,randomUUID} from 'node:crypto';
import {AccountMode,NotificationType,VerificationChannel} from '@prisma/client';
import {db} from '@/lib/db';
import {createNotification} from '@/lib/notifications';
import {verificationConfig} from '@/lib/config';
import {retryAureviaExchangeIdCollision} from '@/lib/aurevia-exchange-id';
import {
	AkedlyAttempt,
	createAkedlyAttempt,
	isConfirmedAkedlyAttempt,
	isConfirmedAkedlyLookup,
	lookupAkedlyAttempt,
} from '@/lib/akedly';

const ATTEMPT_PREFIX='AKEDLY:';
export async function startAkedlyVerification(userId:string,channel:typeof VerificationChannel.SMS,contact:{phoneNumber:string}):Promise<AkedlyAttempt>{
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
	const challenge=await db.verificationCode.findFirst({
		where:{providerReference:reference},
		include:{user:{select:{id:true,phone:true,role:true,status:true,accountMode:true,phoneVerified:true}}},
	});
	if(!challenge||challenge.channel!==VerificationChannel.SMS||challenge.user.role!=='USER'||challenge.user.status!=='ACTIVE'||!challenge.user.phone)return 'ignored' as const;
	const contact={phoneNumber:challenge.user.phone};
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
		if(challenge.channel===VerificationChannel.SMS){
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

export async function reconcileAkedlyAttempt(attemptId:string,userId?:string){
	const challenge=await db.verificationCode.findFirst({
		where:{providerReference:`${ATTEMPT_PREFIX}${attemptId}`,...(userId?{userId}:{})},
		include:{user:{select:{phone:true}}},
	});
	if(!challenge||challenge.channel!==VerificationChannel.SMS||!challenge.user.phone)return 'ignored' as const;
	const result=await lookupAkedlyAttempt(attemptId);
	return completeAkedlyVerification(attemptId,result,'lookup');
}

export async function getAkedlyVerificationState(userId:string,attemptId:string,channel:typeof VerificationChannel.SMS=VerificationChannel.SMS){
	const challenge=await db.verificationCode.findFirst({
		where:{userId,providerReference:`${ATTEMPT_PREFIX}${attemptId}`},
		include:{user:{select:{phoneVerified:true,phoneVerifiedAt:true}}},
	});
	if(!challenge||(channel&&challenge.channel!==channel))return null;
	return {verified:challenge.user.phoneVerified&&Boolean(challenge.user.phoneVerifiedAt),expiresAt:challenge.expiresAt};
}

export function akedlyAttemptIdFromReference(reference:string|null){
	return reference?.startsWith(ATTEMPT_PREFIX)?reference.slice(ATTEMPT_PREFIX.length):null;
}

function hashAttemptReference(attemptId:string){
	return createHash('sha256').update(attemptId).digest('hex').slice(0,16);
}
