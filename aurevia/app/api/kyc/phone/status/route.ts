import {NextResponse} from 'next/server';
import {z,ZodError} from 'zod';
import {requireUser} from '@/lib/auth';
import {rateLimit} from '@/lib/rate-limit';
import {getAkedlyVerificationState} from '@/lib/akedly-verification';
import {VerificationChannel} from '@prisma/client';

const schema=z.object({attemptId:z.string().min(8).max(200)});

export async function POST(request:Request){
	try{
		const user=await requireUser();
		const {attemptId}=schema.parse(await request.json());
		rateLimit(`akedly-phone-status-ip:${request.headers.get('x-forwarded-for')||'unknown'}`,30,60_000);
		rateLimit(`akedly-phone-status-user:${user.id}`,30,60_000);
		const state=await getAkedlyVerificationState(user.id,attemptId,VerificationChannel.SMS);
		if(!state)return NextResponse.json({error:'Verification attempt not found.'},{status:404});
		if(state.verified)return NextResponse.json({verified:true});
		return NextResponse.json({verified:false,expired:state.expiresAt<=new Date()});
	}catch(error){
		if(error instanceof ZodError)return NextResponse.json({error:'Invalid phone verification status request.'},{status:400});
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Sign in to check phone verification.'},{status:401});
		if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'Please wait before checking verification again.'},{status:429});
		console.error('[akedly-phone] Unable to check verification status.',{errorType:error instanceof Error?error.name:'UnknownError'});
		return NextResponse.json({error:'Unable to check phone verification right now.'},{status:503});
	}
}
