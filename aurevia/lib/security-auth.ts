import {NotificationType,Prisma} from '@prisma/client';
import bcrypt from 'bcryptjs';
import {db} from '@/lib/db';
import {createNotification} from '@/lib/notifications';
import {RateLimitError} from '@/lib/rate-limit';
import {decryptTotpSecret,verifyRecoveryCode,verifyTotp} from '@/lib/security';
import {clearPersistentRateLimit,persistentRateLimit} from '@/lib/security-rate-limit';

type SecurityTransaction=Prisma.TransactionClient;

export async function consumeSecondFactor(tx:SecurityTransaction,input:{
	userId:string;
	secretEncrypted:string|null;
	lastTotpCounter:bigint|null;
	code:string;
}){
	if(input.secretEncrypted){
		const counter=await verifyTotp(decryptTotpSecret(input.secretEncrypted),input.code);
		if(counter!==null){
			const updated=await tx.user.updateMany({
				where:{id:input.userId,OR:[{lastTotpCounter:null},{lastTotpCounter:{lt:BigInt(counter)}}]},
				data:{lastTotpCounter:BigInt(counter)},
			});
			return updated.count===1;
		}
	}

	const recoveryCodes=await tx.securityRecoveryCode.findMany({where:{userId:input.userId,usedAt:null},select:{id:true,codeHash:true}});
	for(const recoveryCode of recoveryCodes){
		if(!await verifyRecoveryCode(input.code,recoveryCode.codeHash))continue;
		const consumed=await tx.securityRecoveryCode.updateMany({where:{id:recoveryCode.id,usedAt:null},data:{usedAt:new Date()}});
		if(consumed.count!==1)return false;
		await tx.auditLog.create({data:{actorId:input.userId,action:'SECURITY_RECOVERY_CODE_USED',entity:'USER',entityId:input.userId,metadata:{method:'one-time-recovery-code'}}});
		await createNotification(tx,{
			userId:input.userId,
			type:NotificationType.SECURITY,
			title:'Two-factor recovery code used',
			message:'A one-time recovery code was used to verify a sign-in or security change. If this was not you, secure your account immediately.',
			dedupeKey:`security:${input.userId}:recovery-used:${recoveryCode.id}`,
			actionUrl:'/settings#security',
		});
		return true;
	}
	return false;
}

export async function verifyAccountCredentials(input:{
	userId:string;
	password:string;
	sessionHash?:string;
	markRecentForWithdrawal?:boolean;
}){
	if(input.sessionHash&&(await dbSessionReauthenticated(input.userId,input.sessionHash,false))!==1)return false;
	const rateLimitKey=`security-reauth:${input.userId}`;
	try{await persistentRateLimit(rateLimitKey,8,15*60_000)}catch(error){
		if(error instanceof RateLimitError)await recordRateLimitNotification(input.userId);
		throw error;
	}
	const account=await dbUserForVerification(input.userId);
	if(!account||account.status!=='ACTIVE'||!await bcrypt.compare(input.password,account.passwordHash))return false;
	if(input.sessionHash&&input.markRecentForWithdrawal&&await dbSessionReauthenticated(input.userId,input.sessionHash,true)!==1)return false;
	await clearPersistentRateLimit(rateLimitKey);
	return true;
}

async function recordRateLimitNotification(userId:string){
	await createNotification(db,{
		userId,type:NotificationType.SECURITY,title:'Repeated security verification failures',
		message:'Repeated unsuccessful security verification attempts were detected. If you do not recognize this activity, change your password and review active sessions.',
		dedupeKey:`security:${userId}:reauth-rate-limited:${Math.floor(Date.now()/900_000)}`,
		actionUrl:'/settings#security',
	});
}

async function dbUserForVerification(userId:string){
	return db.user.findUnique({where:{id:userId},select:{
		id:true,status:true,passwordHash:true,
	}});
}

async function dbSessionReauthenticated(userId:string,sessionHash:string,markRecent:boolean){
	const updated=await db.securitySession.updateMany({
		where:{userId,sessionHash,revokedAt:null,expiresAt:{gt:new Date()}},
		data:{reauthenticatedAt:markRecent?new Date():null},
	});
	return updated.count;
}
