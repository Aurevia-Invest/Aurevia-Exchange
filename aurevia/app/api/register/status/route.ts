import {NextResponse} from 'next/server';
import {z,ZodError} from 'zod';
import {db} from '@/lib/db';
import {rateLimit,RateLimitError} from '@/lib/rate-limit';
import {trustedProxyClientIp} from '@/lib/request-ip';
import {getAkedlyVerificationState,reconcileAkedlyAttempt} from '@/lib/akedly-verification';
import {VerificationChannel} from '@prisma/client';
import {clearRegistrationCookie,hashRegistrationToken,registrationTokenFromRequest} from '@/lib/registration-attempt';

const schema=z.object({
	email:z.string().trim().email().max(254),
	attemptId:z.string().min(8).max(200),
});

export async function POST(request:Request){
	try{
		const {email:rawEmail,attemptId}=schema.parse(await request.json());
		const email=rawEmail.toLowerCase();
		const ip=trustedProxyClientIp(request);
		if(ip)rateLimit(`akedly-register-status-ip:${ip}`,30,60_000);
		rateLimit(`akedly-register-status-attempt:${attemptId}`,30,60_000);
		const token=registrationTokenFromRequest(request);
		const registrationAttempt=token?await db.registrationAttempt.findUnique({
			where:{tokenHash:hashRegistrationToken(token)},
			include:{verification:true},
		}):null;
		if(registrationAttempt&&registrationAttempt.email===email){
			const now=new Date();
			if(registrationAttempt.expiresAt<=now||(registrationAttempt.verification&&registrationAttempt.verification.expiresAt<=now)){
				await db.registrationAttempt.deleteMany({where:{id:registrationAttempt.id}});
				const response=NextResponse.json({verified:false,expired:true},{headers:{'Cache-Control':'no-store'}});
				clearRegistrationCookie(response);
				return response;
			}
			if(registrationAttempt.verification?.providerReference!==`AKEDLY:${attemptId}`){
				return NextResponse.json({error:'Verification attempt not found.'},{status:404});
			}
			const result=await reconcileAkedlyAttempt(attemptId);
			if(result==='verified'||result==='already'){
				const response=NextResponse.json({verified:true},{headers:{'Cache-Control':'no-store'}});
				clearRegistrationCookie(response);
				return response;
			}
			return NextResponse.json({verified:false,expired:false},{headers:{'Cache-Control':'no-store'}});
		}
		const user=await db.user.findUnique({where:{email},select:{id:true,role:true,status:true,emailVerifiedAt:true,verifiedChannel:true}});
		if(!user||user.role!=='USER'||user.status!=='ACTIVE')return NextResponse.json({error:'Verification attempt not found.'},{status:404});
		if(user.emailVerifiedAt&&user.verifiedChannel===VerificationChannel.EMAIL){
			const response=NextResponse.json({verified:true},{headers:{'Cache-Control':'no-store'}});
			if(token)clearRegistrationCookie(response);
			return response;
		}
		const state=await getAkedlyVerificationState(user.id,attemptId,VerificationChannel.EMAIL);
		if(!state)return NextResponse.json({error:'Verification attempt not found.'},{status:404});
		if(state.verified)return NextResponse.json({verified:true});
		return NextResponse.json({verified:false,expired:state.expiresAt<=new Date()});
	}catch(error){
		if(error instanceof ZodError)return NextResponse.json({error:'Invalid verification status request.'},{status:400});
		if(error instanceof RateLimitError)return NextResponse.json(
			{error:'Please wait before checking verification again.',retryAfterSeconds:error.retryAfterSeconds},
			{status:429,headers:{'Retry-After':String(error.retryAfterSeconds),'Cache-Control':'no-store'}},
		);
		if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'Please wait before checking verification again.'},{status:429});
		console.error('[akedly-registration] Unable to check verification status.',{errorType:error instanceof Error?error.name:'UnknownError'});
		return NextResponse.json({error:'Unable to check verification status right now.'},{status:503});
	}
}
