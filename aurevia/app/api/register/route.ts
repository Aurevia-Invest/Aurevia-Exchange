import {NextResponse} from 'next/server';
import {randomUUID} from 'node:crypto';
import bcrypt from 'bcryptjs';
import {AccountMode,Prisma} from '@prisma/client';
import {z,ZodError} from 'zod';
import {db} from '@/lib/db';
import {rateLimit,RateLimitError} from '@/lib/rate-limit';
import {trustedProxyClientIp} from '@/lib/request-ip';
import {isValidE164,parseDateOfBirth} from '@/lib/registration-validation';
import {createImmediateRegistration} from '@/lib/registration-attempt';
import {verifyRegistrationTurnstile} from '@/lib/turnstile';

const schema=z.object({
	email:z.string().trim().email().max(254),
	password:z.string().min(10).max(128).regex(/[a-z]/).regex(/[A-Z]/).regex(/[0-9]/),
	name:z.string().trim().min(2).max(120),
	country:z.string().trim().min(2).max(80),
	dateOfBirth:z.string().refine(value=>parseDateOfBirth(value)!==null,'Enter a valid date that is not in the future.'),
	phone:z.string().trim().max(16).refine(value=>!value||isValidE164(value),'Enter a valid phone number in international format.').optional().default(''),
	accountMode:z.nativeEnum(AccountMode),
	termsAccepted:z.literal(true),
	captchaToken:z.string().trim().min(1).max(2048),
});

function requestReference(request:Request){
	const clientRequestId=request.headers.get('x-aurevia-request-id')||'';
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientRequestId)
		?clientRequestId.toLowerCase()
		:randomUUID();
}

export async function POST(request:Request){
	const requestId=requestReference(request);
	try{
		const input=schema.parse(await request.json());
		const email=input.email.toLowerCase();

		let captchaValid=false;
		try{
			captchaValid=await verifyRegistrationTurnstile(input.captchaToken,requestId);
		}catch(error){
			if(error instanceof Error&&error.message.startsWith('TURNSTILE_')){
				console.warn('Registration Turnstile verification is unavailable.',{
					requestId,
					referenceId:requestId,
					endpoint:'https://challenges.cloudflare.com/turnstile/v0/siteverify',
					errorCode:error.message,
					failureTimestamp:new Date().toISOString(),
				});
				return NextResponse.json({
					code:'REGISTRATION_SECURITY_UNAVAILABLE',
					error:'Registration security checks are temporarily unavailable. Please try again later.',
					requestId,
					referenceId:requestId,
				},{status:503,headers:{'Cache-Control':'no-store'}});
			}
			throw error;
		}
		const clientIp=trustedProxyClientIp(request);
		if(!captchaValid){
			if(clientIp)rateLimit(`register-captcha-ip:${clientIp}`,10,10*60_000);
			rateLimit(`register-captcha-email:${email}`,5,10*60_000);
			return NextResponse.json({
				code:'REGISTRATION_SECURITY_REJECTED',
				error:'Complete the registration security check and try again.',
				requestId,
				referenceId:requestId,
			},{status:400,headers:{'Cache-Control':'no-store'}});
		}

		if(clientIp)rateLimit(`register:${clientIp}`,5,60*60_000);
		rateLimit(`register-email:${email}`,3,60*60_000);
		const dateOfBirth=parseDateOfBirth(input.dateOfBirth);
		if(!dateOfBirth)return NextResponse.json({error:'Enter a valid date of birth that is not in the future.'},{status:400});
		const existingUser=await db.user.findUnique({where:{email},select:{id:true}});
		if(existingUser)return NextResponse.json({
			code:'ACCOUNT_ALREADY_EXISTS',
			error:'An account already uses this email. Sign in or reset its password to recover access.',
			requestId,
			referenceId:requestId,
		},{status:409,headers:{'Cache-Control':'no-store'}});

		const passwordHash=await bcrypt.hash(input.password,12);
		await db.$transaction(async tx=>createImmediateRegistration(tx,{
			email,
			passwordHash,
			name:input.name.replace(/\s+/g,' ').trim(),
			country:input.country,
			phone:input.phone||null,
			dateOfBirth,
			accountMode:input.accountMode,
			termsAcceptedAt:new Date(),
		}),{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
		return NextResponse.json({
			created:true,
			email,
			message:'Your account has been created. Signing you in…',
			requestId,
		},{status:201,headers:{'Cache-Control':'no-store'}});
	}catch(error){
		if(error instanceof ZodError){
			if(error.issues.some(issue=>issue.path[0]==='dateOfBirth'))return NextResponse.json({error:'Enter a valid date of birth that is not in the future.'},{status:400});
			if(error.issues.some(issue=>issue.path[0]==='phone'))return NextResponse.json({error:'Enter a valid phone number in international format.'},{status:400});
			if(error.issues.some(issue=>issue.path[0]==='captchaToken'))return NextResponse.json({error:'Complete the registration security check and try again.'},{status:400});
			return NextResponse.json({error:'Check your name, email, country, password, and consent details.'},{status:400});
		}
		if(error instanceof Error&&error.message==='REGISTRATION_EMAIL_ALREADY_EXISTS')return NextResponse.json({
			code:'ACCOUNT_ALREADY_EXISTS',
			error:'An account already uses this email. Sign in or reset its password to recover access.',
			requestId,
			referenceId:requestId,
		},{status:409,headers:{'Cache-Control':'no-store'}});
		if(error instanceof Error&&error.message==='REGISTRATION_PHONE_ALREADY_IN_USE')return NextResponse.json({
			code:'PHONE_ALREADY_IN_USE',
			error:'This phone number is already associated with another account. Use a different number.',
			requestId,
			referenceId:requestId,
		},{status:409,headers:{'Cache-Control':'no-store'}});
		if(error instanceof Prisma.PrismaClientKnownRequestError&&error.code==='P2002')return NextResponse.json({
			code:'REGISTRATION_IN_PROGRESS',
			error:'An account is being created for these details. Sign in or retry shortly.',
			requestId,
			referenceId:requestId,
		},{status:409,headers:{'Cache-Control':'no-store'}});
		if(error instanceof RateLimitError)return NextResponse.json(
			{error:'Too many registration attempts. Try again later.',retryAfterSeconds:error.retryAfterSeconds},
			{status:429,headers:{'Retry-After':String(error.retryAfterSeconds),'Cache-Control':'no-store'}},
		);
		if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'Too many registration attempts. Try again later.'},{status:429});
		const rawErrorCode=error&&typeof error==='object'&&'code' in error&&typeof error.code==='string'?error.code:'';
		const errorCode=/^[A-Z0-9_]{2,32}$/.test(rawErrorCode)?rawErrorCode:undefined;
		console.error('Registration request failed.',{requestId,errorName:error instanceof Error?error.name:'UnknownError',errorCode});
		if(error instanceof Prisma.PrismaClientKnownRequestError&&['P2021','P2022'].includes(error.code))return NextResponse.json({error:'The registration service is being updated. Please try again shortly.',requestId},{status:503});
		if(error&&typeof error==='object'&&'code' in error&&['P1001','P1002','P1017'].includes(String(error.code)))return NextResponse.json({error:'The registration service is temporarily unavailable. Please try again shortly.',requestId},{status:503});
		return NextResponse.json({error:'We could not create your account. Please try again or contact support.',requestId},{status:500});
	}
}
