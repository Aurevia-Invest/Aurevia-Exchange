import {NextResponse} from 'next/server';
import {randomUUID} from 'node:crypto';
import bcrypt from 'bcryptjs';
import {AccountMode,Prisma} from '@prisma/client';
import {z,ZodError} from 'zod';
import {db} from '@/lib/db';
import {rateLimit,RateLimitError} from '@/lib/rate-limit';
import {trustedProxyClientIp} from '@/lib/request-ip';
import {isValidE164,parseDateOfBirth} from '@/lib/registration-validation';
import {akedlyReadiness} from '@/lib/akedly';
import {createRegistrationToken,hashRegistrationToken,REGISTRATION_LIFETIME_MS,registrationTokenFromRequest,setRegistrationCookie} from '@/lib/registration-attempt';
import {verifyRegistrationTurnstile} from '@/lib/turnstile';

type PendingRegistrationAttempt=Prisma.RegistrationAttemptGetPayload<{include:{verification:true}}>;

const schema=z.object({
	email:z.string().trim().email().max(254),
	password:z.string().min(10).max(128).regex(/[a-z]/).regex(/[A-Z]/).regex(/[0-9]/),
	name:z.string().trim().min(2).max(120),
	country:z.string().trim().min(2).max(80),
	dateOfBirth:z.string().refine(value=>parseDateOfBirth(value)!==null,'Enter a valid date that is not in the future.'),
	phone:z.string().trim().min(1).max(16).refine(isValidE164,'Enter a valid phone number in international format.'),
	accountMode:z.nativeEnum(AccountMode),
	termsAccepted:z.literal(true),
	captchaToken:z.string().trim().min(1).max(2048),
});

function registrationResponse(
	email:string,
	token:string,
	expiresAt:Date,
	status:200|201,
	authMethod?:'akedly'|'email-code',
){
	const response=NextResponse.json({
		message:authMethod==='akedly'
			?'Complete phone verification to create your account.'
			:authMethod==='email-code'
				?'Continue the existing email verification to create your account.'
				:'Continue verification to create your account.',
		verificationRequired:true,
		...(authMethod?{authMethod}:{}),
		email,
	},{status,headers:{'Cache-Control':'no-store'}});
	setRegistrationCookie(response,token,expiresAt);
	return response;
}

async function resumePendingAttempt(attempt:PendingRegistrationAttempt,password:string,request:Request){
	const currentToken=registrationTokenFromRequest(request);
	const ownsSession=currentToken!==null&&hashRegistrationToken(currentToken)===attempt.tokenHash;
	if(!ownsSession&&!await bcrypt.compare(password,attempt.passwordHash)){
		return NextResponse.json({
			code:'REGISTRATION_IN_PROGRESS',
			error:'A registration is already in progress for this email. Enter the original registration password or use the verification link sent to your email.',
		},{status:409,headers:{'Cache-Control':'no-store'}});
	}

	const now=new Date();
	if(attempt.verification&&attempt.verification.expiresAt<=now){
		await db.registrationVerification.deleteMany({
			where:{registrationAttemptId:attempt.id,expiresAt:{lte:now}},
		});
	}

	const token=ownsSession?currentToken:createRegistrationToken();
	if(!ownsSession){
		const rotated=await db.registrationAttempt.updateMany({
			where:{id:attempt.id,tokenHash:attempt.tokenHash,expiresAt:{gt:now}},
			data:{tokenHash:hashRegistrationToken(token)},
		});
		if(rotated.count!==1)return NextResponse.json({
			code:'REGISTRATION_IN_PROGRESS',
			error:'This registration session changed. Retry with your registration details.',
		},{status:409,headers:{'Cache-Control':'no-store'}});
	}
	const authMethod=attempt.verification?.providerReference?.startsWith('AKEDLY:')?'akedly'
	:attempt.verification?.channel==='EMAIL'?'email-code':undefined;
	return registrationResponse(attempt.email,token,attempt.expiresAt,200,authMethod);
}

export async function POST(request:Request){
	const requestId=randomUUID();
	try{
		const input=schema.parse(await request.json());
		const email=input.email.toLowerCase();

		let captchaValid=false;
		try{
			captchaValid=await verifyRegistrationTurnstile(input.captchaToken,requestId);
		}catch(error){
			if(error instanceof Error&&error.message.startsWith('TURNSTILE_')){
				console.warn('Registration Turnstile verification is unavailable.',{requestId,errorCode:error.message});
				return NextResponse.json({error:'Registration security checks are temporarily unavailable. Please try again later.'},{status:503});
			}
			throw error;
		}
		const clientIp=trustedProxyClientIp(request);
		if(!captchaValid){
			if(clientIp)rateLimit(`register-captcha-ip:${clientIp}`,10,10*60_000);
			rateLimit(`register-captcha-email:${email}`,5,10*60_000);
			return NextResponse.json({error:'Complete the registration security check and try again.'},{status:400});
		}

		if(clientIp)rateLimit(`register:${clientIp}`,5,60*60_000);
		rateLimit(`register-email:${email}`,3,60*60_000);

		const dateOfBirth=parseDateOfBirth(input.dateOfBirth);
		if(!dateOfBirth)return NextResponse.json({error:'Enter a valid date of birth that is not in the future.'},{status:400});
		const existingUser=await db.user.findUnique({
			where:{email},
			select:{id:true,role:true,status:true,emailVerifiedAt:true,requiresRegistrationVerification:true},
		});
		if(existingUser){
			if(existingUser.role==='USER'&&existingUser.status==='ACTIVE'&&!existingUser.emailVerifiedAt&&existingUser.requiresRegistrationVerification){
				return NextResponse.json({
					message:'An existing unverified account was found. Continue its current verification; your original password remains unchanged.',
					verificationRequired:true,
					existingVerification:true,
					email,
				},{status:200,headers:{'Cache-Control':'no-store'}});
			}
			if(existingUser.status==='FROZEN'||existingUser.status==='SUSPENDED'||existingUser.status==='CLOSED'||existingUser.status==='DELETED'){
				return NextResponse.json({
					code:'ACCOUNT_UNAVAILABLE',
					error:'An account with this email cannot be registered again. Contact support for help with the existing account.',
				},{status:409,headers:{'Cache-Control':'no-store'}});
			}
			return NextResponse.json(existingUser.emailVerifiedAt?{
				code:'ACCOUNT_ALREADY_VERIFIED',
				error:'An account already uses this email. Sign in or reset its password to recover access.',
			}:{
				code:'ACCOUNT_ALREADY_EXISTS',
				error:'An account already uses this email. Sign in with its existing password or reset it to recover access.',
			},{status:409,headers:{'Cache-Control':'no-store'}});
		}

		const now=new Date();
		const existingAttempt=await db.registrationAttempt.findUnique({
			where:{email},
			include:{verification:true},
		});
		if(existingAttempt&&existingAttempt.expiresAt<=now){
			await db.registrationAttempt.deleteMany({where:{id:existingAttempt.id,expiresAt:{lte:now}}});
		}else if(existingAttempt){
			return await resumePendingAttempt(existingAttempt,input.password,request);
		}

		const akedly=akedlyReadiness();
		if(!akedly.ready){
			console.warn('Registration phone verification is not configured.',{
				requestId,
				enabled:akedly.enabled,
				missing:akedly.missing,
			});
			return NextResponse.json({
				error:'Phone verification is unavailable right now. Your details were not saved. Please try again later; if this continues, contact support.',
				requestId,
			},{status:503,headers:{'Cache-Control':'no-store'}});
		}
		const [existingPhoneUser,existingPhoneAttempt]=await Promise.all([
			db.user.findFirst({where:{phone:input.phone},select:{id:true}}),
			db.registrationAttempt.findFirst({where:{phone:input.phone,email:{not:email},expiresAt:{gt:now}},select:{id:true}}),
		]);
		if(existingPhoneUser||existingPhoneAttempt)return NextResponse.json({
			code:'PHONE_ALREADY_IN_USE',
			error:'This phone number is already associated with another account or pending registration. Use a different number.',
		},{status:409,headers:{'Cache-Control':'no-store'}});

		const passwordHash=await bcrypt.hash(input.password,12);
		const token=createRegistrationToken();
		const expiresAt=new Date(now.getTime()+REGISTRATION_LIFETIME_MS);
		try{
			await db.registrationAttempt.create({data:{
			email,
			passwordHash,
			name:input.name,
			country:input.country,
			phone:input.phone,
			dateOfBirth,
			accountMode:input.accountMode,
			termsAcceptedAt:new Date(),
			tokenHash:hashRegistrationToken(token),
			expiresAt,
			}});
		}catch(error){
			if(error instanceof Prisma.PrismaClientKnownRequestError&&error.code==='P2002'){
				const racedAttempt=await db.registrationAttempt.findUnique({where:{email},include:{verification:true}});
				if(racedAttempt&&racedAttempt.expiresAt>new Date())return await resumePendingAttempt(racedAttempt,input.password,request);
			}
			throw error;
		}
		return registrationResponse(email,token,expiresAt,201);
	}catch(error){
		if(error instanceof ZodError){
			if(error.issues.some(issue=>issue.path[0]==='dateOfBirth'))return NextResponse.json({error:'Enter a valid date of birth that is not in the future.'},{status:400});
			if(error.issues.some(issue=>issue.path[0]==='phone'))return NextResponse.json({error:'Enter a valid phone number in international format.'},{status:400});
			if(error.issues.some(issue=>issue.path[0]==='captchaToken'))return NextResponse.json({error:'Complete the registration security check and try again.'},{status:400});
			return NextResponse.json({error:'Check your name, email, country, password, and consent details.'},{status:400});
		}
		if(error instanceof Prisma.PrismaClientKnownRequestError&&error.code==='P2002'){
			return NextResponse.json({
				code:'REGISTRATION_IN_PROGRESS',
				error:'A registration is already in progress for these details. Continue its existing verification session or retry shortly.',
			},{status:409,headers:{'Cache-Control':'no-store'}});
		}
		if(error instanceof RateLimitError){
			return NextResponse.json(
				{error:'Too many registration attempts. Try again later.',retryAfterSeconds:error.retryAfterSeconds},
				{status:429,headers:{'Retry-After':String(error.retryAfterSeconds),'Cache-Control':'no-store'}},
			);
		}
		const rawErrorCode=error&&typeof error==='object'&&'code' in error&&typeof error.code==='string'?error.code:'';
		const errorCode=/^[A-Z0-9_]{2,32}$/.test(rawErrorCode)?rawErrorCode:undefined;
		console.error('Registration request failed.',{requestId,errorName:error instanceof Error?error.name:'UnknownError',errorCode});
		if(error instanceof Prisma.PrismaClientKnownRequestError&&['P2021','P2022'].includes(error.code))return NextResponse.json({error:'The registration service is being updated. Please try again shortly.',requestId},{status:503});
		if(error&&typeof error==='object'&&'code' in error&&['P1001','P1002','P1017'].includes(String(error.code)))return NextResponse.json({error:'The registration service is temporarily unavailable. Please try again shortly.',requestId},{status:503});
		return NextResponse.json({error:'We could not start registration. Please try again or contact support.',requestId},{status:500});
	}
}
