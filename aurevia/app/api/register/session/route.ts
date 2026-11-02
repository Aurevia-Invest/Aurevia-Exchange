import {NextResponse} from 'next/server';
import {z,ZodError} from 'zod';
import {db} from '@/lib/db';
import {rateLimit,RateLimitError} from '@/lib/rate-limit';
import {trustedProxyClientIp} from '@/lib/request-ip';
import {clearRegistrationCookie,hashRegistrationToken,setRegistrationCookie} from '@/lib/registration-attempt';

const schema=z.object({
	email:z.string().trim().email().max(254),
	registrationToken:z.string().regex(/^[A-Za-z0-9_-]{40,60}$/),
});

export async function POST(request:Request){
	try{
		const {email:rawEmail,registrationToken}=schema.parse(await request.json());
		const email=rawEmail.toLowerCase();
		const ip=trustedProxyClientIp(request);
		if(ip)rateLimit(`registration-session-ip:${ip}`,10,60_000);
		const attempt=await db.registrationAttempt.findUnique({
			where:{tokenHash:hashRegistrationToken(registrationToken)},
			include:{verification:true},
		});
		if(!attempt||attempt.email!==email)return NextResponse.json({error:'This registration session is invalid or expired.'},{status:404});
		const now=new Date();
		if(attempt.expiresAt<=now||(attempt.verification&&attempt.verification.expiresAt<=now)){
			await db.registrationAttempt.deleteMany({where:{id:attempt.id}});
			const response=NextResponse.json({error:'This registration session is invalid or expired.'},{status:410});
			clearRegistrationCookie(response);
			return response;
		}
		const response=NextResponse.json({restored:true},{headers:{'Cache-Control':'no-store'}});
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
