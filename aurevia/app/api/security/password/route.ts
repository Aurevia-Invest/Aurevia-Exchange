import {NextResponse} from 'next/server';
import {NotificationType,Prisma} from '@prisma/client';
import bcrypt from 'bcryptjs';
import {z,ZodError} from 'zod';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {createNotification} from '@/lib/notifications';
import {verifyAccountCredentials} from '@/lib/security-auth';
import {sendSecurityEmail} from '@/lib/security-notifications';

const schema=z.object({
	currentPassword:z.string().min(1).max(128),
	newPassword:z.string().min(10).max(128).regex(/[a-z]/).regex(/[A-Z]/).regex(/[0-9]/),
	confirmPassword:z.string().min(1).max(128),
});

export async function POST(request:Request){
	try{
		const user=await requireUser();
		const parsed=schema.safeParse(await request.json());
		if(!parsed.success)return NextResponse.json({error:'Use a password of at least 10 characters with uppercase, lowercase, and a number.'},{status:400});
		const {currentPassword,newPassword,confirmPassword}=parsed.data;
		if(newPassword!==confirmPassword)return NextResponse.json({error:'New password and confirmation do not match.'},{status:400});
		if(newPassword===currentPassword)return NextResponse.json({error:'Choose a new password different from your current password.'},{status:400});
		if(!await verifyAccountCredentials({userId:user.id,password:currentPassword,sessionHash:user.sessionHash}))return NextResponse.json({error:'Current password is incorrect.'},{status:401});
		const passwordHash=await bcrypt.hash(newPassword,12);
		const currentSessionHash=user.sessionHash;
		await db.$transaction(async tx=>{
			const now=new Date();
			await tx.user.update({where:{id:user.id},data:{passwordHash,activeSessionId:null,activeSessionUpdatedAt:null}});
			await tx.securitySession.updateMany({where:{userId:user.id,revokedAt:null,sessionHash:{not:currentSessionHash}},data:{revokedAt:now}});
			await tx.securitySession.updateMany({where:{userId:user.id,sessionHash:currentSessionHash,revokedAt:null},data:{rotationRequired:true,reauthenticatedAt:null,lastActivityAt:now}});
			await createNotification(tx,{
				userId:user.id,
				type:NotificationType.SECURITY,
				title:'Password changed',
				message:'Your Aurevia account password was changed. Other active sessions were signed out. If you did not make this change, contact support immediately.',
				dedupeKey:`security:${user.id}:password-changed:${now.toISOString()}`,
				actionUrl:'/settings#security',
			});
			await tx.auditLog.create({data:{actorId:user.id,action:'PASSWORD_CHANGED',entity:'USER',entityId:user.id,metadata:{activeSessionsRevoked:true}}});
		},{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
		await sendSecurityEmail(user.id,{subject:'Your Aurevia Exchange password was changed',text:'The password for your Aurevia Exchange account was changed. Other active sessions were signed out. If you did not make this change, secure your account and contact support immediately.'});
		return NextResponse.json({ok:true,message:'Password changed. Your current secure session has been rotated; other sessions were signed out.'});
	}catch(error){
		if(error instanceof ZodError)return NextResponse.json({error:'Password change details are invalid.'},{status:400});
		if(error instanceof SyntaxError)return NextResponse.json({error:'Password change details must be valid JSON.'},{status:400});
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'Forbidden'},{status:403});
		if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'Too many security verification attempts. Wait and try again.'},{status:429});
		console.error('[security] Password change failed.',error instanceof Error?error.name:'UnknownError');
		return NextResponse.json({error:'Unable to change your password right now.'},{status:503});
	}
}
