import {NextResponse} from 'next/server';
import {NotificationType,Prisma} from '@prisma/client';
import {z,ZodError} from 'zod';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {createNotification} from '@/lib/notifications';
import {verifyAccountCredentials} from '@/lib/security-auth';
import {sendSecurityEmail} from '@/lib/security-notifications';

const schema=z.object({
	action:z.enum(['revoke-session','logout-others','logout-all']),
	sessionId:z.string().optional(),
	password:z.string().min(1).max(128),
});

export async function GET(){
	try{
		const user=await requireUser();
		const currentHash=user.sessionHash;
		const sessions=await db.securitySession.findMany({
			where:{userId:user.id,revokedAt:null,expiresAt:{gt:new Date()}},
			orderBy:{lastActivityAt:'desc'},
			select:{id:true,sessionHash:true,deviceLabel:true,createdAt:true,lastActivityAt:true,expiresAt:true},
		});
		return NextResponse.json({sessions:sessions.map(({sessionHash,...session})=>({...session,current:sessionHash===currentHash}))},{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'Forbidden'},{status:403});
		console.error('[security] Session list failed.',error instanceof Error?error.name:'UnknownError');
		return NextResponse.json({error:'Unable to load active sessions.'},{status:503});
	}
}

export async function POST(request:Request){
	try{
		const user=await requireUser();
		const parsed=schema.safeParse(await request.json());
		if(!parsed.success)return NextResponse.json({error:'Session security request is invalid.'},{status:400});
		const {action,sessionId,password}=parsed.data;
		if(action==='revoke-session'&&!sessionId)return NextResponse.json({error:'Select a session to revoke.'},{status:400});
		if(!await verifyAccountCredentials({userId:user.id,password,sessionHash:user.sessionHash}))return NextResponse.json({error:'Current password is incorrect.'},{status:401});
		const currentHash=user.sessionHash;
		const now=new Date();
		let currentRevoked=false;
		await db.$transaction(async tx=>{
			if(action==='revoke-session'){
				const target=await tx.securitySession.findFirst({where:{id:sessionId,userId:user.id,revokedAt:null},select:{id:true,sessionHash:true}});
				if(!target)throw new Error('SECURITY_SESSION_NOT_FOUND');
				await tx.securitySession.update({where:{id:target.id},data:{revokedAt:now}});
				currentRevoked=target.sessionHash===currentHash;
			}else{
				const where=action==='logout-others'?{userId:user.id,revokedAt:null,sessionHash:{not:currentHash}}:{userId:user.id,revokedAt:null};
				await tx.securitySession.updateMany({where,data:{revokedAt:now}});
				currentRevoked=action==='logout-all';
				if(action==='logout-all')await tx.user.update({where:{id:user.id},data:{activeSessionId:null,activeSessionUpdatedAt:null}});
			}
			await createNotification(tx,{
				userId:user.id,
				type:NotificationType.SECURITY,
				title:action==='logout-all'?'Signed out of all devices':'Active sessions updated',
				message:action==='logout-all'?'Your Aurevia account was signed out of all devices. If you did not make this change, change your password and contact support.':action==='logout-others'?'Other active Aurevia sessions were signed out.':'An active Aurevia session was revoked.',
				dedupeKey:`security:${user.id}:sessions:${action}:${now.toISOString()}`,
				actionUrl:'/settings#security',
			});
			await tx.auditLog.create({data:{actorId:user.id,action:action==='logout-all'?'LOGOUT_ALL_DEVICES':action==='logout-others'?'LOGOUT_OTHER_SESSIONS':'SESSION_REVOKED',entity:'SECURITY_SESSION',entityId:sessionId||user.id,metadata:{currentSessionRevoked:currentRevoked}}});
		},{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
		if(action==='logout-all')await sendSecurityEmail(user.id,{subject:'Your Aurevia account was signed out of all devices',text:'Your Aurevia Exchange account was signed out of all devices. If you did not make this change, change your password and contact support immediately.'});
		return NextResponse.json({ok:true,currentRevoked});
	}catch(error){
		if(error instanceof ZodError)return NextResponse.json({error:'Session security request is invalid.'},{status:400});
		if(error instanceof SyntaxError)return NextResponse.json({error:'Session security request must be valid JSON.'},{status:400});
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'Forbidden'},{status:403});
		if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'Too many security verification attempts. Wait and try again.'},{status:429});
		if(error instanceof Error&&error.message==='SECURITY_SESSION_NOT_FOUND')return NextResponse.json({error:'That session is no longer active.'},{status:404});
		console.error('[security] Session revocation failed.',error instanceof Error?error.name:'UnknownError');
		return NextResponse.json({error:'Unable to update active sessions.'},{status:503});
	}
}
