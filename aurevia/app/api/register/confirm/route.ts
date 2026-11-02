import {NextResponse} from 'next/server';
import {z,ZodError} from 'zod';
import {db} from '@/lib/db';
import {rateLimit,RateLimitError} from '@/lib/rate-limit';
import {trustedProxyClientIp} from '@/lib/request-ip';
import {reconcileAkedlyAttempt} from '@/lib/akedly-verification';
import {clearRegistrationCookie,hashRegistrationToken,registrationTokenFromRequest} from '@/lib/registration-attempt';
import {establishRegistrationSession} from '@/lib/registration-session';

const schema=z.object({
	email:z.string().trim().email().max(254),
	attemptId:z.string().min(8).max(200),
});

export async function POST(request:Request){
	try{
		const {email:rawEmail,attemptId}=schema.parse(await request.json());
		const email=rawEmail.toLowerCase();
		const ip=trustedProxyClientIp(request);
		if(ip)rateLimit(`akedly-register-confirm-ip:${ip}`,5,60_000);
		rateLimit(`akedly-register-confirm-attempt:${attemptId}`,5,60_000);
		const token=registrationTokenFromRequest(request);
		const registrationAttempt=token?await db.registrationAttempt.findUnique({
			where:{tokenHash:hashRegistrationToken(token)},
			include:{verification:true},
		}):null;
		if(registrationAttempt&&registrationAttempt.email===email){
			const now=new Date();
			if(registrationAttempt.expiresAt<=now){
				await db.registrationAttempt.deleteMany({where:{id:registrationAttempt.id}});
				const response=NextResponse.json({error:'This registration session expired. Start registration again.'},{status:410});
				clearRegistrationCookie(response);
				return response;
			}
			if(registrationAttempt.verification&&registrationAttempt.verification.expiresAt<=now){
				await db.registrationVerification.deleteMany({
					where:{registrationAttemptId:registrationAttempt.id,expiresAt:{lte:now}},
				});
				return NextResponse.json({verified:false,expired:true},{headers:{'Cache-Control':'no-store'}});
			}
			if(registrationAttempt.verification?.providerReference!==`AKEDLY:${attemptId}`){
				return NextResponse.json({error:'Verification attempt not found.'},{status:404});
			}
			const result=await reconcileAkedlyAttempt(attemptId);
			if(result==='phone-conflict'){
				const response=NextResponse.json({
					verified:false,
					phoneConflict:true,
					error:'This phone number is already associated with another account. Start a new registration without it or use a different number.',
				},{headers:{'Cache-Control':'no-store'}});
				clearRegistrationCookie(response);
				return response;
			}
			const verified=result==='verified'||result==='already';
			const response=NextResponse.json({verified,authenticated:verified},{headers:{'Cache-Control':'no-store'}});
			if(verified){
				await establishRegistrationSession(response,email);
				clearRegistrationCookie(response);
			}
			return response;
		}
		const user=await db.user.findUnique({where:{email},select:{id:true,role:true,status:true,emailVerifiedAt:true,verifiedChannel:true}});
		if(!user||user.role!=='USER'||user.status!=='ACTIVE')return NextResponse.json({error:'Verification attempt not found.'},{status:404});
		if(user.emailVerifiedAt&&user.verifiedChannel==='EMAIL'){
			const response=NextResponse.json({verified:true},{headers:{'Cache-Control':'no-store'}});
			if(token)clearRegistrationCookie(response);
			return response;
		}
		const result=await reconcileAkedlyAttempt(attemptId,user.id);
		return NextResponse.json({verified:result==='verified'||result==='already'});
	}catch(error){
		if(error instanceof ZodError)return NextResponse.json({error:'Invalid verification confirmation request.'},{status:400});
		if(error instanceof RateLimitError)return NextResponse.json(
			{error:'Please wait before checking verification again.',retryAfterSeconds:error.retryAfterSeconds},
			{status:429,headers:{'Retry-After':String(error.retryAfterSeconds),'Cache-Control':'no-store'}},
		);
		if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'Please wait before checking verification again.'},{status:429});
		if(error instanceof Error&&error.message.startsWith('AKEDLY_'))return NextResponse.json({error:'Akedly could not confirm this attempt yet. Please try again shortly.'},{status:503});
		console.error('[akedly-registration] Unable to confirm verification.',{errorType:error instanceof Error?error.name:'UnknownError'});
		return NextResponse.json({error:'Unable to confirm verification right now.'},{status:503});
	}
}
