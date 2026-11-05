import {createHash} from 'node:crypto';
import bcrypt from 'bcryptjs';
import {NextResponse} from 'next/server';
import {NotificationType,Prisma} from '@prisma/client';
import {z,ZodError} from 'zod';
import {db} from '@/lib/db';
import {sendEmail} from '@/lib/email';
import {notifyActiveAdmins,createNotification} from '@/lib/notifications';
import {rateLimit} from '@/lib/rate-limit';

export const dynamic='force-dynamic';

const schema=z.object({
	token:z.string().min(32).max(128),
	password:z.string().min(10).max(128).regex(/[a-z]/).regex(/[A-Z]/).regex(/[0-9]/),
});

export async function POST(request:Request){
	try{
		const input=schema.parse(await request.json());
		const tokenHash=createHash('sha256').update(input.token).digest('hex');
		rateLimit(`password-reset-confirm:${tokenHash.slice(0,20)}`,5,60*60_000);
		const candidate=await db.passwordResetToken.findUnique({where:{tokenHash},select:{id:true,userId:true,expiresAt:true,consumedAt:true,user:{select:{email:true}}}});
		if(!candidate||candidate.consumedAt||candidate.expiresAt<=new Date())return NextResponse.json({error:'This recovery link is invalid or expired. Request a new link.'},{status:400});
		const passwordHash=await bcrypt.hash(input.password,12);
		const now=new Date();
		await db.$transaction(async tx=>{
			const claim=await tx.passwordResetToken.updateMany({where:{id:candidate.id,tokenHash,consumedAt:null,expiresAt:{gt:now}},data:{consumedAt:now}});
			if(claim.count!==1)throw new Error('RESET_TOKEN_USED');
			const user=await tx.user.update({where:{id:candidate.userId},data:{passwordHash,activeSessionId:null,activeSessionUpdatedAt:null},select:{id:true}});
			await tx.securitySession.updateMany({where:{userId:user.id,revokedAt:null},data:{revokedAt:new Date()}});
			await tx.passwordResetToken.updateMany({where:{userId:user.id,id:{not:candidate.id},consumedAt:null},data:{consumedAt:now}});
			await tx.auditLog.create({data:{actorId:user.id,action:'PASSWORD_RESET_COMPLETED',entity:'SECURITY',entityId:user.id,metadata:{method:'email-token'}}});
			await createNotification(tx,{userId:user.id,type:NotificationType.SECURITY,title:'Password changed',message:'Your password was changed. Other active sessions were signed out.',dedupeKey:`security:${user.id}:password-reset:${candidate.id}`,actionUrl:'/settings'});
			await notifyActiveAdmins(tx,{type:NotificationType.SECURITY,title:'Account password reset',message:'A user completed an email password recovery.',dedupeKey:`security:password-reset:${candidate.id}`,relatedEntity:'USER',relatedId:user.id,actionUrl:'/admin'});
			return user;
		},{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
		try{
			const delivery=await sendEmail({
				to:candidate.user.email,
				subject:'Your Aurevia Exchange password was changed',
				text:'The password for your Aurevia Exchange account was changed. Other active sessions were signed out. If you did not make this change, contact support immediately.',
			});
			if(!delivery.sent)console.warn('Password change notification could not be delivered.',{reason:delivery.reason||'failed',provider:delivery.provider||'none'});
		}catch{
			console.warn('Password change notification could not be delivered.');
		}
		return NextResponse.json({ok:true});
	}catch(error){
		if(error instanceof ZodError)return NextResponse.json({error:'Use a password with at least 10 characters, a lowercase letter, an uppercase letter, and a number.'},{status:400});
		if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'Too many attempts. Request a new recovery link.'},{status:429});
		if(error instanceof Error&&error.message==='RESET_TOKEN_USED')return NextResponse.json({error:'This recovery link has already been used or expired.'},{status:400});
		const code=error&&typeof error==='object'&&'code' in error?String(error.code):'';
		if(['P1001','P1002','P1017','P2021'].includes(code))return NextResponse.json({error:'Password recovery is temporarily unavailable.'},{status:503});
		return NextResponse.json({error:'Unable to reset the password. Request a new recovery link.'},{status:400});
	}
}