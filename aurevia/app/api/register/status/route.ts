import {NextResponse} from 'next/server';
import {z,ZodError} from 'zod';
import {db} from '@/lib/db';
import {rateLimit} from '@/lib/rate-limit';
import {getAkedlyVerificationState} from '@/lib/akedly-verification';
import {VerificationChannel} from '@prisma/client';

const schema=z.object({
	email:z.string().trim().email().max(254),
	attemptId:z.string().min(8).max(200),
});

export async function POST(request:Request){
	try{
		const {email:rawEmail,attemptId}=schema.parse(await request.json());
		const email=rawEmail.toLowerCase();
		const ip=request.headers.get('x-forwarded-for')||'unknown';
		rateLimit(`akedly-register-status-ip:${ip}`,30,60_000);
		rateLimit(`akedly-register-status-attempt:${attemptId}`,30,60_000);
		const user=await db.user.findUnique({where:{email},select:{id:true,role:true,status:true}});
		if(!user||user.role!=='USER'||user.status!=='ACTIVE')return NextResponse.json({error:'Verification attempt not found.'},{status:404});
		const state=await getAkedlyVerificationState(user.id,attemptId,VerificationChannel.EMAIL);
		if(!state)return NextResponse.json({error:'Verification attempt not found.'},{status:404});
		if(state.verified)return NextResponse.json({verified:true});
		return NextResponse.json({verified:false,expired:state.expiresAt<=new Date()});
	}catch(error){
		if(error instanceof ZodError)return NextResponse.json({error:'Invalid verification status request.'},{status:400});
		if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'Please wait before checking verification again.'},{status:429});
		console.error('[akedly-registration] Unable to check verification status.',{errorType:error instanceof Error?error.name:'UnknownError'});
		return NextResponse.json({error:'Unable to check verification status right now.'},{status:503});
	}
}
