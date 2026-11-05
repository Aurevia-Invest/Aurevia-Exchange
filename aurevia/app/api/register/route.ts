import {NextResponse} from 'next/server';
import {randomUUID} from 'node:crypto';
import bcrypt from 'bcryptjs';
import {AccountMode,NotificationType,Prisma} from '@prisma/client';
import {z,ZodError} from 'zod';
import {db} from '@/lib/db';
import {rateLimit,RateLimitError} from '@/lib/rate-limit';
import {trustedProxyClientIp} from '@/lib/request-ip';
import {isValidE164,parseDateOfBirth} from '@/lib/registration-validation';
import {createImmediateRegistration} from '@/lib/registration-attempt';
import {createNotification,notifyActiveAdmins} from '@/lib/notifications';

const schema=z.object({
	email:z.string().trim().email().max(254),
	password:z.string().min(10).max(128).regex(/[a-z]/).regex(/[A-Z]/).regex(/[0-9]/),
	name:z.string().min(1).max(120).refine(value=>value.trim().length>0,'Enter your name.'),
	country:z.string().trim().min(2).max(80),
	gender:z.enum(['FEMALE','MALE','NON_BINARY','PREFER_NOT_TO_SAY']),
	dateOfBirth:z.string().refine(value=>parseDateOfBirth(value)!==null,'Enter a valid date that is not in the future.'),
	phone:z.string().trim().max(16).refine(value=>!value||isValidE164(value),'Enter a valid phone number in international format.').optional().default(''),
	accountMode:z.nativeEnum(AccountMode),
	termsAccepted:z.literal(true),
	website:z.string().max(0).optional().default(''),
});

function requestReference(request:Request){
	const clientRequestId=request.headers.get('x-aurevia-request-id')||'';
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientRequestId)
		?clientRequestId.toLowerCase()
		:randomUUID();
}

function emailUniqueConstraint(error:Prisma.PrismaClientKnownRequestError){
	const target=error.meta?.target;
	return Array.isArray(target)
		?target.includes('email')
		:target==='email'||target==='User_email_key';
}

function registrationDiagnosticText(value:string,input:z.infer<typeof schema>|null,passwordHash:string){
	let redacted=value;
	for(const sensitiveValue of [input?.email,input?.password,passwordHash,input?.phone,input?.name,input?.country,input?.dateOfBirth]){
		if(sensitiveValue&&sensitiveValue.length>=4)redacted=redacted.replaceAll(sensitiveValue,'[REDACTED]');
	}
	return redacted
		.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,'[email]')
		.replace(/(?:postgres(?:ql)?:\/\/)[^\s"'`]+/gi,'[database-url]');
}

function accountAccessRequired(requestId:string){
	return NextResponse.json({
		code:'ACCOUNT_ACCESS_REQUIRED',
		error:'Sign in or reset your password if you already have an account.',
		requestId,
		referenceId:requestId,
	},{status:409,headers:{'Cache-Control':'no-store'}});
}

async function matchExistingAccount(email:string,password:string,requestId:string){
	const existingUser=await db.user.findFirst({
		where:{email:{equals:email,mode:'insensitive'}},
		select:{email:true,passwordHash:true,status:true},
	});
	if(!existingUser)return null;
	if(existingUser.status==='ACTIVE'&&await bcrypt.compare(password,existingUser.passwordHash)){
		return NextResponse.json({
			created:false,
			accountMatched:true,
			email:existingUser.email,
			message:'Signing you in…',
			requestId,
		},{status:200,headers:{'Cache-Control':'no-store'}});
	}
	return accountAccessRequired(requestId);
}

async function writePostRegistrationEffects(userId:string,email:string,requestId:string,input:z.infer<typeof schema>,passwordHash:string){
	const effects=await Promise.allSettled([
		db.waitlistEntry.updateMany({
			where:{email,userId:null},
			data:{userId,status:'REGISTERED',updatedAt:new Date()},
		}),
		createNotification(db,{
			userId,
			type:NotificationType.ACCOUNT,
			title:'Welcome to Aurevia Exchange',
			message:'Your account is active. Identity verification is only required for eligible account services.',
			dedupeKey:`registration:${userId}:created`,
			actionUrl:'/dashboard',
		}),
		notifyActiveAdmins(db,{
			type:NotificationType.ACCOUNT,
			title:'New account registration',
			message:'A new customer account was created.',
			dedupeKey:`registration:${userId}:admin`,
			relatedEntity:'USER',
			relatedId:userId,
			actionUrl:'/admin',
		}),
	]);
	const effectNames=['waitlist update','welcome notification','admin notification'];
	effects.forEach((effect,index)=>{
		if(effect.status==='rejected'){
			const error=effect.reason;
			const errorCode=error&&typeof error==='object'&&'code' in error&&typeof error.code==='string'?error.code:undefined;
			console.error('[signup] Post-registration effect failed.',{
				referenceId:requestId,
				effect:effectNames[index],
				errorName:error instanceof Error?error.name:'UnknownError',
				...(errorCode?{errorCode}:{}),
				errorMessage:registrationDiagnosticText(error instanceof Error?error.message:'Unknown error',input,passwordHash).slice(0,1000),
				...(error instanceof Error&&error.stack?{errorStack:registrationDiagnosticText(error.stack,input,passwordHash).slice(0,12000)}:{}),
			});
		}
	});
}

export async function POST(request:Request){
	const requestId=requestReference(request);
	const requestStartedAt=Date.now();
	let parsedInput:z.infer<typeof schema>|null=null;
	let passwordHashForRedaction='';
	let transactionDurationMs:number|null=null;
	let transactionOutcome:'not_started'|'succeeded'|'failed'='not_started';
	try{
		const input=schema.parse(await request.json());
		parsedInput=input;
		if(input.website)return NextResponse.json({error:'Invalid registration request.'},{status:400,headers:{'Cache-Control':'no-store'}});
		const email=input.email.trim().toLowerCase();

		rateLimit(`register:${trustedProxyClientIp(request)||'unknown'}`,30,10*60_000);
		rateLimit(`register-email:${email}`,3,60*60_000);
		const dateOfBirth=parseDateOfBirth(input.dateOfBirth);
		if(!dateOfBirth)return NextResponse.json({error:'Enter a valid date of birth that is not in the future.'},{status:400});
		const existingResponse=await matchExistingAccount(email,input.password,requestId);
		if(existingResponse)return existingResponse;

		const passwordHash=await bcrypt.hash(input.password,12);
		passwordHashForRedaction=passwordHash;
		try{
			const transactionStartedAt=Date.now();
			let user:Awaited<ReturnType<typeof createImmediateRegistration>>;
			try{
				user=await db.$transaction(async tx=>createImmediateRegistration(tx,{
					email,
					passwordHash,
					name:input.name,
					country:input.country,
					gender:input.gender,
					phone:input.phone||null,
					dateOfBirth,
					accountMode:input.accountMode,
					termsAcceptedAt:new Date(),
				}),{isolationLevel:Prisma.TransactionIsolationLevel.ReadCommitted,maxWait:5_000,timeout:15_000});
				transactionOutcome='succeeded';
			}catch(error){
				transactionOutcome='failed';
				throw error;
			}finally{
				transactionDurationMs=Date.now()-transactionStartedAt;
			}
			await writePostRegistrationEffects(user.id,email,requestId,input,passwordHash);
		}catch(error){
			const recoveredAccount=await matchExistingAccount(email,input.password,requestId);
			if(recoveredAccount)return recoveredAccount;
			throw error;
		}
		const response=NextResponse.json({
			created:true,
			email,
			message:'Your account has been created. Signing you in…',
			requestId,
		},{status:201,headers:{'Cache-Control':'no-store'}});
		return response;
	}catch(error){
		if(error instanceof ZodError){
			if(error.issues.some(issue=>issue.path[0]==='name'))return NextResponse.json({error:'Enter your name using between 1 and 120 characters.'},{status:400});
			if(error.issues.some(issue=>issue.path[0]==='dateOfBirth'))return NextResponse.json({error:'Enter a valid date of birth that is not in the future.'},{status:400});
			if(error.issues.some(issue=>issue.path[0]==='phone'))return NextResponse.json({error:'Enter a valid phone number in international format.'},{status:400});
			if(error.issues.some(issue=>issue.path[0]==='website'))return NextResponse.json({error:'Invalid registration request.'},{status:400});
			return NextResponse.json({error:'Check your name, email, country, password, and consent details.'},{status:400});
		}
		if(error instanceof Error&&error.message==='REGISTRATION_EMAIL_ALREADY_EXISTS'){
			const existingResponse=parsedInput
				?await matchExistingAccount(parsedInput.email.trim().toLowerCase(),parsedInput.password,requestId)
				:null;
			if(existingResponse)return existingResponse;
			return accountAccessRequired(requestId);
		}
		if(error instanceof Error&&error.message==='REGISTRATION_PHONE_ALREADY_IN_USE')return NextResponse.json({
			code:'PHONE_ALREADY_IN_USE',
			error:'Phone number already in use. Try another number.',
			requestId,
			referenceId:requestId,
		},{status:409,headers:{'Cache-Control':'no-store'}});
		if(error instanceof Prisma.PrismaClientKnownRequestError&&error.code==='P2002'&&emailUniqueConstraint(error)){
			if(parsedInput){
				const existingResponse=await matchExistingAccount(parsedInput.email.trim().toLowerCase(),parsedInput.password,requestId);
				if(existingResponse)return existingResponse;
			}
			return accountAccessRequired(requestId);
		}
		if(error instanceof RateLimitError)return NextResponse.json(
			{error:'Too many registration attempts. Try again later.',retryAfterSeconds:error.retryAfterSeconds},
			{status:429,headers:{'Retry-After':String(error.retryAfterSeconds),'Cache-Control':'no-store'}},
		);
		if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'Too many registration attempts. Try again later.'},{status:429});
		const rawErrorCode=error&&typeof error==='object'&&'code' in error&&typeof error.code==='string'?error.code:'';
		const errorCode=/^[A-Z0-9_]{2,32}$/.test(rawErrorCode)?rawErrorCode:undefined;
		const prismaMeta=error instanceof Prisma.PrismaClientKnownRequestError?{
			...(typeof error.meta?.modelName==='string'?{modelName:error.meta.modelName}:{}),
			...(Array.isArray(error.meta?.target)?{target:error.meta.target.filter((value):value is string=>typeof value==='string')}:typeof error.meta?.target==='string'?{target:error.meta.target}:{}),
		}:undefined;
		console.error('[signup] Registration request failed.',{
			referenceId:requestId,
			errorName:error instanceof Error?error.name:'UnknownError',
			...(errorCode?{errorCode}:{}),
			...(prismaMeta&&Object.keys(prismaMeta).length?{prismaMeta}:{}),
			errorMessage:registrationDiagnosticText(error instanceof Error?error.message:'Unknown registration error',parsedInput,passwordHashForRedaction).slice(0,1000),
			...(error instanceof Error&&error.stack?{errorStack:registrationDiagnosticText(error.stack,parsedInput,passwordHashForRedaction).slice(0,12000)}:{}),
		});
		if(error instanceof Prisma.PrismaClientKnownRequestError&&['P2021','P2022'].includes(error.code))return NextResponse.json({error:'Registration service update in progress. Try again shortly.',requestId},{status:503});
		if(error&&typeof error==='object'&&'code' in error&&['P1001','P1002','P1017'].includes(String(error.code)))return NextResponse.json({error:'Registration service unavailable. Try again shortly.',requestId},{status:503});
		return NextResponse.json({error:'Account creation failed. Try again or contact support.',requestId},{status:500});
	}finally{
		console.info('[signup] Registration attempt completed.',{
			referenceId:requestId,
			durationMs:Date.now()-requestStartedAt,
			transactionDurationMs,
			transactionOutcome,
		});
	}
}
