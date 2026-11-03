import {NextResponse} from 'next/server';
import {z,ZodError} from 'zod';
import {db} from '@/lib/db';
import {rateLimit,RateLimitError} from '@/lib/rate-limit';
import {trustedProxyClientIp} from '@/lib/request-ip';
import {clearRegistrationCookie,hashRegistrationToken,registrationTokenFromRequest,setRegistrationCookie} from '@/lib/registration-attempt';

export async function GET(request:Request){
	try{
		const token=registrationTokenFromRequest(request);
		if(!token)return NextResponse.json({error:'Registration session not found.'},{status:404});
		const ip=trustedProxyClientIp(request);
		if(ip)rateLimit(`registration-session-details-ip:${ip}`,30,60_000);
		rateLimit(`registration-session-details-token:${hashRegistrationToken(token)}`,30,60_000);
		const attempt=await db.registrationAttempt.findUnique({
			where:{tokenHash:hashRegistrationToken(token)},
			select:{email:true,phone:true,expiresAt:true},
		});
		if(!attempt)return NextResponse.json({error:'Registration session not found.'},{status:404});
		if(attempt.expiresAt<=new Date()){
			await db.registrationAttempt.deleteMany({where:{tokenHash:hashRegistrationToken(token),expiresAt:{lte:new Date()}}});
			const response=NextResponse.json({error:'This registration session is invalid or expired.'},{status:410,headers:{'Cache-Control':'no-store'}});
			clearRegistrationCookie(response);
			return response;
		}
		return NextResponse.json({restored:true,email:attempt.email,phone:attempt.phone},{headers:{'Cache-Control':'no-store'}});
	}catch(error){
		if(error instanceof RateLimitError)return NextResponse.json(
			{error:'Please wait before restoring this registration session.',retryAfterSeconds:error.retryAfterSeconds},
			{status:429,headers:{'Retry-After':String(error.retryAfterSeconds),'Cache-Control':'no-store'}},
		);
		if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'Please wait before restoring this registration session.'},{status:429});
		console.error('Registration session lookup failed.',{errorType:error instanceof Error?error.name:'UnknownError'});
		return NextResponse.json({error:'Unable to restore this registration session.'},{status:503,headers:{'Cache-Control':'no-store'}});
	}
}

const schema=z.object({
	registrationToken:z.string().regex(/^[A-Za-z0-9_-]{40,60}$/),
});

export async function POST(request:Request){
	try{
		const {registrationToken}=schema.parse(await request.json());
		const ip=trustedProxyClientIp(request);
		if(ip)rateLimit(`registration-session-ip:${ip}`,10,60_000);
		const attempt=await db.registrationAttempt.findUnique({
			where:{tokenHash:hashRegistrationToken(registrationToken)},
			include:{verification:true},
		});
		if(!attempt)return NextResponse.json({error:'This registration session is invalid or expired.'},{status:404});
		const now=new Date();
		if(attempt.expiresAt<=now){
			await db.registrationAttempt.deleteMany({where:{id:attempt.id}});
			const response=NextResponse.json({error:'This registration session is invalid or expired.'},{status:410});
			clearRegistrationCookie(response);
			return response;
		}
		if(attempt.verification&&attempt.verification.expiresAt<=now){
			await db.registrationVerification.deleteMany({
				where:{registrationAttemptId:attempt.id,expiresAt:{lte:now}},
			});
		}
		const response=NextResponse.json(
			{restored:true,email:attempt.email,phone:attempt.phone},
			{headers:{'Cache-Control':'no-store'}},
		);
		setRegistrationCookie(response,registrationToken,attempt.expiresAt);
		return response;
	}catch(error){
		if(error instanceof ZodError)return NextResponse.json({error:'This registration session is invalid or expired.'},{status:400});
		if(error instanceof RateLimitError)return NextResponse.json(
			{error:'Please wait before restoring this registration session.',retryAfterSeconds:error.retryAfterSeconds},
			{status:429,headers:{'Retry-After':String(error.retryAfterSeconds),'Cache-Control':'no-store'}},
		);
		if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'Please wait before restoring this registration session.'},{status:429});
		console.error('Registration session restore failed.',{errorType:error instanceof Error?error.name:'UnknownError'});
		return NextResponse.json({error:'Unable to restore this registration session.'},{status:503});
	}
}
