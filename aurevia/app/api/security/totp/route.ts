import {randomUUID} from 'node:crypto';
import {NextResponse} from 'next/server';
import {NotificationType,Prisma} from '@prisma/client';
import bcrypt from 'bcryptjs';
import {generateSecret,generateURI} from 'otplib';
import QRCode from 'qrcode';
import {z,ZodError} from 'zod';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {createNotification} from '@/lib/notifications';
import {verifyAccountCredentials} from '@/lib/security-auth';
import {createRecoveryCode,decryptTotpSecret,encryptTotpSecret,verifyTotp} from '@/lib/security';
import {sendSecurityEmail} from '@/lib/security-notifications';
import {clearPersistentRateLimit,persistentRateLimit} from '@/lib/security-rate-limit';

const schema=z.object({
	action:z.enum(['start','confirm','disable']),
	password:z.string().min(1).max(128),
	secondFactorCode:z.string().max(64).optional().default(''),
});

export async function POST(request:Request){
	try{
		const user=await requireUser();
		const parsed=schema.safeParse(await request.json());
		if(!parsed.success)return NextResponse.json({error:'Two-factor security request is invalid.'},{status:400});
		const {action,password,secondFactorCode}=parsed.data;
		const currentAccount=await db.user.findUnique({where:{id:user.id},select:{twoFactorEnabled:true}});
		if(!currentAccount)return NextResponse.json({error:'Account not found.'},{status:404});
		if(action==='start'&&currentAccount.twoFactorEnabled)return NextResponse.json({error:'Two-factor authentication is already enabled.'},{status:409});
		if(action==='confirm'&&currentAccount.twoFactorEnabled)return NextResponse.json({error:'Two-factor authentication is already enabled.'},{status:409});
		if(action==='disable'&&!currentAccount.twoFactorEnabled)return NextResponse.json({error:'Two-factor authentication is not enabled.'},{status:409});
		if(!await verifyAccountCredentials({userId:user.id,password,sessionHash:user.sessionHash}))return NextResponse.json({error:'Current password is incorrect.'},{status:401});

		if(action==='start'){
			const account=await db.user.findUnique({where:{id:user.id},select:{email:true}});
			if(!account)return NextResponse.json({error:'Account not found.'},{status:404});
			const secret=generateSecret();
			const uri=generateURI({issuer:'Aurevia Exchange',label:account.email,secret,digits:6,period:30,algorithm:'sha1'});
			const qrCode=await QRCode.toDataURL(uri,{errorCorrectionLevel:'M',margin:1,width:220});
			const secretEncrypted=encryptTotpSecret(secret);
			await db.twoFactorEnrollment.upsert({
				where:{userId:user.id},
				update:{secretEncrypted,expiresAt:new Date(Date.now()+10*60_000)},
				create:{userId:user.id,secretEncrypted,expiresAt:new Date(Date.now()+10*60_000)},
			});
			return NextResponse.json({qrCode,manualKey:secret,expiresInSeconds:600},{headers:{'Cache-Control':'no-store'}});
		}

		if(action==='confirm'){
			const setup=await db.twoFactorEnrollment.findUnique({where:{userId:user.id}});
			if(!setup||setup.expiresAt<=new Date())return NextResponse.json({error:'Two-factor setup expired. Start enrollment again.'},{status:410});
			const enrollmentAttemptKey=`totp-enrollment:${user.id}:${setup.id}`;
			await persistentRateLimit(enrollmentAttemptKey,5,10*60_000);
			const secret=decryptTotpSecret(setup.secretEncrypted);
			const counter=await verifyTotp(secret,secondFactorCode);
			if(counter===null)return NextResponse.json({error:'That verification code is not valid. Check your authenticator app and try again.'},{status:400});
			const recoveryCodes=Array.from({length:10},createRecoveryCode);
			const recoveryHashes=await Promise.all(recoveryCodes.map(code=>bcrypt.hash(code.replace(/-/g,'').trim().toUpperCase(),12)));
			await db.$transaction(async tx=>{
				const setupStillValid=await tx.twoFactorEnrollment.findFirst({where:{userId:user.id,expiresAt:{gt:new Date()},secretEncrypted:setup.secretEncrypted},select:{id:true}});
				if(!setupStillValid)throw new Error('TWO_FACTOR_SETUP_EXPIRED');
				await tx.user.update({where:{id:user.id},data:{twoFactorEnabled:true,totpSecretEncrypted:setup.secretEncrypted,lastTotpCounter:BigInt(counter)}});
				await tx.securityRecoveryCode.deleteMany({where:{userId:user.id}});
				await tx.securityRecoveryCode.createMany({data:recoveryHashes.map(codeHash=>({userId:user.id,codeHash}))});
				await tx.twoFactorEnrollment.delete({where:{userId:user.id}});
				const now=new Date();
				const currentHash=user.sessionHash;
				await tx.securitySession.updateMany({where:{userId:user.id,revokedAt:null,sessionHash:{not:currentHash}},data:{revokedAt:now}});
				await tx.securitySession.updateMany({where:{userId:user.id,sessionHash:currentHash,revokedAt:null},data:{rotationRequired:true,reauthenticatedAt:null,lastActivityAt:now}});
				await createNotification(tx,{
					userId:user.id,type:NotificationType.SECURITY,title:'Two-factor authentication enabled',
					message:'Authenticator settings were enabled for your Aurevia account. If you did not make this change, secure your account immediately.',
					dedupeKey:`security:${user.id}:two-factor-enabled:${randomUUID()}`,actionUrl:'/settings#security',
				});
				await tx.auditLog.create({data:{actorId:user.id,action:'TWO_FACTOR_ENABLED',entity:'USER',entityId:user.id,metadata:{recoveryCodeCount:recoveryCodes.length}}});
			},{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
			await clearPersistentRateLimit(enrollmentAttemptKey);
			await sendSecurityEmail(user.id,{subject:'Two-factor authentication enabled',text:'Authenticator settings were enabled for your Aurevia Exchange account. Recovery codes were displayed once in the application and are not included in this email. If you did not enable this setting, secure your account immediately.'});
			return NextResponse.json({enabled:true,recoveryCodes},{headers:{'Cache-Control':'no-store'}});
		}

		await db.$transaction(async tx=>{
			await tx.user.update({where:{id:user.id},data:{twoFactorEnabled:false,totpSecretEncrypted:null,lastTotpCounter:null,activeSessionId:null,activeSessionUpdatedAt:null}});
			await tx.securityRecoveryCode.deleteMany({where:{userId:user.id}});
			await tx.twoFactorEnrollment.deleteMany({where:{userId:user.id}});
			const now=new Date();
			const currentHash=user.sessionHash;
			await tx.securitySession.updateMany({where:{userId:user.id,revokedAt:null,sessionHash:{not:currentHash}},data:{revokedAt:now}});
			await tx.securitySession.updateMany({where:{userId:user.id,sessionHash:currentHash,revokedAt:null},data:{rotationRequired:true,reauthenticatedAt:null,lastActivityAt:now}});
			await createNotification(tx,{
				userId:user.id,type:NotificationType.SECURITY,title:'Two-factor authentication disabled',
				message:'Authenticator settings were disabled for your Aurevia account. If you did not make this change, secure your account immediately.',
				dedupeKey:`security:${user.id}:two-factor-disabled:${randomUUID()}`,actionUrl:'/settings#security',
			});
			await tx.auditLog.create({data:{actorId:user.id,action:'TWO_FACTOR_DISABLED',entity:'USER',entityId:user.id,metadata:{activeSessionsRevoked:true}}});
		},{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
		await sendSecurityEmail(user.id,{subject:'Two-factor authentication disabled',text:'Authenticator settings were disabled for your Aurevia Exchange account. If you did not make this change, secure your account immediately.'});
		return NextResponse.json({enabled:false});
	}catch(error){
		if(error instanceof ZodError)return NextResponse.json({error:'Two-factor security request is invalid.'},{status:400});
		if(error instanceof SyntaxError)return NextResponse.json({error:'Two-factor security request must be valid JSON.'},{status:400});
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'Forbidden'},{status:403});
		if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'Too many security verification attempts. Wait and try again.'},{status:429});
		if(error instanceof Error&&error.message==='SECURITY_RATE_LIMIT_UNAVAILABLE')return NextResponse.json({error:'Security verification is temporarily unavailable.'},{status:503});
		if(error instanceof Error&&error.message==='TOTP_ENCRYPTION_KEY_MISSING')return NextResponse.json({error:'Two-factor enrollment is unavailable until the server security-encryption key is configured.'},{status:503});
		if(error instanceof Error&&error.message==='TWO_FACTOR_SETUP_EXPIRED')return NextResponse.json({error:'Two-factor setup expired. Start enrollment again.'},{status:410});
		console.error('[security] Two-factor operation failed.',error instanceof Error?error.name:'UnknownError');
		return NextResponse.json({error:'Unable to update two-factor security right now.'},{status:503});
	}
}
