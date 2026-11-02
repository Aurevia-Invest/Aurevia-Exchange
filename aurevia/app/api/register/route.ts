import {NextResponse} from 'next/server';
import {randomUUID} from 'node:crypto';
import bcrypt from 'bcryptjs';
import {AccountMode,NotificationType,Prisma,VerificationChannel} from '@prisma/client';
import {z,ZodError} from 'zod';
import {db} from '@/lib/db';
import {ensureSystemAccount,initializePaperAccount} from '@/lib/ledger';
import {rateLimit} from '@/lib/rate-limit';
import {createNotification} from '@/lib/notifications';
import {notifyActiveAdmins} from '@/lib/notifications';
import {isValidE164,parseDateOfBirth} from '@/lib/registration-validation';
import {akedlyIsConfigured} from '@/lib/akedly';
import {hasConfiguredVerificationProvider} from '@/lib/verification-delivery';

const schema=z.object({
	email:z.string().trim().email().max(254),
	password:z.string().min(10).max(128).regex(/[a-z]/).regex(/[A-Z]/).regex(/[0-9]/),
	name:z.string().trim().min(2).max(120),
	country:z.string().trim().min(2).max(80),
	dateOfBirth:z.string().refine(value=>parseDateOfBirth(value)!==null,'Enter a valid date that is not in the future.'),
	phone:z.string().trim().max(16).refine(value=>value===''||isValidE164(value),'Enter a valid phone number with its country code.').optional().or(z.literal('')),
	accountMode:z.nativeEnum(AccountMode),
	termsAccepted:z.literal(true)
});

export async function POST(req:Request){
	const requestId=randomUUID();
	let stage='request-validation';
	try{
		rateLimit(`register:${req.headers.get('x-forwarded-for')||'unknown'}`,5,3600000);
		const p=schema.parse(await req.json());
		const akedlyReady=akedlyIsConfigured();
		const emailVerificationReady=hasConfiguredVerificationProvider(VerificationChannel.EMAIL);
		const email=p.email.toLowerCase();
		rateLimit(`register-email:${email}`,3,3600000);
		const dateOfBirth=parseDateOfBirth(p.dateOfBirth);
		if(!dateOfBirth)return NextResponse.json({error:'Enter a valid date of birth that is not in the future.'},{status:400});
		stage='hash-password';
		const passwordHash=await bcrypt.hash(p.password,12);
		stage='registration-transaction';
		await db.$transaction(async tx=>{
			stage='create-user';
			const created=await tx.user.create({data:{email,passwordHash,name:p.name,country:p.country,phone:p.phone||null,accountMode:p.accountMode,requiresRegistrationVerification:true,termsAcceptedAt:new Date()}});
			stage='link-waitlist';
			await tx.waitlistEntry.updateMany({where:{email, userId:null},data:{userId:created.id,status:'REGISTERED',updatedAt:new Date()}});
			stage='save-kyc-profile';
			await tx.kycProfile.upsert({where:{userId:created.id},update:{dob:dateOfBirth},create:{userId:created.id,dob:dateOfBirth}});
			stage='initialize-paper-accounts';
			await initializePaperAccount(tx,created.id,AccountMode.DEMO);
			await initializePaperAccount(tx,created.id,AccountMode.REAL);
			stage='initialize-system-account';
			await ensureSystemAccount(tx,'SYSTEM:LIABILITY','Customer Funds');
			stage='create-user-notification';
			await createNotification(tx,{userId:created.id,type:NotificationType.ACCOUNT,title:'Welcome to Aurevia Exchange',message:'Your account was created. Verify your email address to sign in; identity review remains separate for eligible account services.',dedupeKey:`registration:${created.id}:created`,actionUrl:'/verify-email'});
			stage='notify-active-admins';
			await notifyActiveAdmins(tx,{type:NotificationType.ACCOUNT,title:'New account registration',message:`A new ${created.accountMode.toLowerCase()} account registration is awaiting email verification.`,dedupeKey:`registration:${created.id}:admin`,relatedEntity:'USER',relatedId:created.id,actionUrl:'/admin'});
			return created;
		},{maxWait:10000,timeout:15000});
		return NextResponse.json({
			message:emailVerificationReady||akedlyReady
				?'Account created. Verify your email address before signing in.'
				:'Account created, but email verification delivery is temporarily unavailable. Your account will remain pending verification.',
			verificationRequired:true,
			authMethod:akedlyReady?'akedly':emailVerificationReady?'email-code':null,
			email,
		},{status:201});
	}catch(error){
		if(error instanceof ZodError){
			if(error.issues.some(issue=>issue.path[0]==='dateOfBirth'))return NextResponse.json({error:'Enter a valid date of birth that is not in the future.'},{status:400});
			if(error.issues.some(issue=>issue.path[0]==='phone'))return NextResponse.json({error:'Enter a valid phone number with its country code.'},{status:400});
			return NextResponse.json({error:'Check your name, email, country, password, and consent details.'},{status:400});
		}
		if(error instanceof Prisma.PrismaClientKnownRequestError&&error.code==='P2002'){
			const target=error.meta?.target;
			const fields=Array.isArray(target)?target.map(String):[String(target||'')];
			if(fields.includes('email'))return NextResponse.json({error:'An account with this email address already exists.'},{status:409});
			if(fields.includes('phone'))return NextResponse.json({error:'An account with this phone number already exists.'},{status:409});
			return NextResponse.json({error:'These registration details are already in use.'},{status:409});
		}
		const rawErrorCode=error&&typeof error==='object'&&'code' in error&&typeof error.code==='string'?error.code:'';
		const errorCode=/^[A-Z0-9_]{2,32}$/.test(rawErrorCode)?rawErrorCode:undefined;
		const errorName=error instanceof Error?error.name:'UnknownError';
		console.error('Registration request failed.',{requestId,stage,errorName,errorCode});
		if(error instanceof Prisma.PrismaClientKnownRequestError&&['P2021','P2022'].includes(error.code))return NextResponse.json({error:'The registration service is being updated. Please try again shortly.',requestId},{status:503});
		if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'Too many registration attempts. Try again later.'},{status:429});
		if(error&&typeof error==='object'&&'code' in error&&['P1001','P1002','P1017'].includes(String(error.code)))return NextResponse.json({error:'The database is temporarily unavailable. Please try again shortly.',requestId},{status:503});
		return NextResponse.json({error:'We could not complete registration. Please try again or contact support.',requestId},{status:500});
	}
}
