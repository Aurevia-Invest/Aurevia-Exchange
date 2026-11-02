import {NextResponse} from 'next/server';
import {randomUUID} from 'node:crypto';
import bcrypt from 'bcryptjs';
import {AccountMode,Prisma,VerificationChannel} from '@prisma/client';
import {z,ZodError} from 'zod';
import {db} from '@/lib/db';
import {rateLimit} from '@/lib/rate-limit';
import {isValidE164,parseDateOfBirth} from '@/lib/registration-validation';
import {akedlyIsConfigured} from '@/lib/akedly';
import {hasConfiguredVerificationProvider} from '@/lib/verification-delivery';
import {createRegistrationToken,hashRegistrationToken,REGISTRATION_LIFETIME_MS,setRegistrationCookie} from '@/lib/registration-attempt';
import {verifyRegistrationTurnstile} from '@/lib/turnstile';

const schema=z.object({
	email:z.string().trim().email().max(254),
	password:z.string().min(10).max(128).regex(/[a-z]/).regex(/[A-Z]/).regex(/[0-9]/),
	name:z.string().trim().min(2).max(120),
	country:z.string().trim().min(2).max(80),
	dateOfBirth:z.string().refine(value=>parseDateOfBirth(value)!==null,'Enter a valid date that is not in the future.'),
	phone:z.string().trim().max(16).refine(value=>value===''||isValidE164(value),'Enter a valid phone number with its country code.').optional().or(z.literal('')),
	accountMode:z.nativeEnum(AccountMode),
	termsAccepted:z.literal(true),
	captchaToken:z.string().min(1).max(4096),
});

export async function POST(request:Request){
	const requestId=randomUUID();
	try{
		rateLimit(`register:${request.headers.get('x-forwarded-for')||'unknown'}`,5,3600000);
		const input=schema.parse(await request.json());
		const email=input.email.toLowerCase();
		rateLimit(`register-email:${email}`,3,3600000);

		let captchaValid=false;
		try{
			captchaValid=await verifyRegistrationTurnstile(input.captchaToken);
		}catch(error){
			if(error instanceof Error&&error.message.startsWith('TURNSTILE_')){
				return NextResponse.json({error:'Registration security checks are temporarily unavailable. Please try again later.'},{status:503});
			}
			throw error;
		}
		if(!captchaValid)return NextResponse.json({error:'Complete the registration security check and try again.'},{status:400});

		const dateOfBirth=parseDateOfBirth(input.dateOfBirth);
		if(!dateOfBirth)return NextResponse.json({error:'Enter a valid date of birth that is not in the future.'},{status:400});
		if(!akedlyIsConfigured()&&!hasConfiguredVerificationProvider(VerificationChannel.EMAIL))return NextResponse.json({error:'Email verification is temporarily unavailable. Please try again later.'},{status:503});
		const existingUser=await db.user.findUnique({where:{email},select:{id:true}});
		if(existingUser)return NextResponse.json({error:'Registration cannot be started for these details. If this is your email, sign in or use the existing verification session.'},{status:409});

		const passwordHash=await bcrypt.hash(input.password,12);
		const token=createRegistrationToken();
		const expiresAt=new Date(Date.now()+REGISTRATION_LIFETIME_MS);
		const attempt=await db.registrationAttempt.create({data:{
			email,
			passwordHash,
			name:input.name,
			country:input.country,
			phone:input.phone||null,
			dateOfBirth,
			accountMode:input.accountMode,
			termsAcceptedAt:new Date(),
			tokenHash:hashRegistrationToken(token),
			expiresAt,
		},select:{email:true}});
		const response=NextResponse.json({
			message:'Complete email verification to create your account.',
			verificationRequired:true,
			authMethod:akedlyIsConfigured()?'akedly':'email-code',
			email:attempt.email,
		},{status:201,headers:{'Cache-Control':'no-store'}});
		setRegistrationCookie(response,token,expiresAt);
		return response;
	}catch(error){
		if(error instanceof ZodError){
			if(error.issues.some(issue=>issue.path[0]==='dateOfBirth'))return NextResponse.json({error:'Enter a valid date of birth that is not in the future.'},{status:400});
			if(error.issues.some(issue=>issue.path[0]==='phone'))return NextResponse.json({error:'Enter a valid phone number with its country code.'},{status:400});
			return NextResponse.json({error:'Check your name, email, country, password, and consent details.'},{status:400});
		}
		if(error instanceof Prisma.PrismaClientKnownRequestError&&error.code==='P2002'){
			return NextResponse.json({error:'Registration cannot be started for these details. If this is your email, sign in or use the existing verification session.'},{status:409});
		}
		if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'Too many registration attempts. Try again later.'},{status:429});
		const rawErrorCode=error&&typeof error==='object'&&'code' in error&&typeof error.code==='string'?error.code:'';
		const errorCode=/^[A-Z0-9_]{2,32}$/.test(rawErrorCode)?rawErrorCode:undefined;
		console.error('Registration request failed.',{requestId,errorName:error instanceof Error?error.name:'UnknownError',errorCode});
		if(error instanceof Prisma.PrismaClientKnownRequestError&&['P2021','P2022'].includes(error.code))return NextResponse.json({error:'The registration service is being updated. Please try again shortly.',requestId},{status:503});
		if(error&&typeof error==='object'&&'code' in error&&['P1001','P1002','P1017'].includes(String(error.code)))return NextResponse.json({error:'The registration service is temporarily unavailable. Please try again shortly.',requestId},{status:503});
		return NextResponse.json({error:'We could not start registration. Please try again or contact support.',requestId},{status:500});
	}
}
