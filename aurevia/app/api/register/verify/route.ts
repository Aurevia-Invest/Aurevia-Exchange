import {NextResponse} from 'next/server';
import {NotificationType,Prisma,VerificationChannel} from '@prisma/client';
import {z,ZodError} from 'zod';
import {db} from '@/lib/db';
import {createNotification} from '@/lib/notifications';
import {rateLimit} from '@/lib/rate-limit';
import {trustedProxyClientIp} from '@/lib/request-ip';
import {verificationConfig} from '@/lib/config';
import {verificationCodeMatches} from '@/lib/verification-delivery';
import {clearRegistrationCookie,createVerifiedRegistration,hashRegistrationToken,registrationTokenFromRequest} from '@/lib/registration-attempt';
import {generateAureviaExchangeId,retryAureviaExchangeIdCollision} from '@/lib/aurevia-exchange-id';

const schema=z.object({email:z.string().trim().email().max(254),code:z.string().regex(/^\d{6}$/)});

export async function POST(request:Request){
	let registrationAttemptId:string|undefined;
	try{
		const body=await request.json();
		const input=schema.parse(body);
		const email=input.email.toLowerCase();
		const ip=trustedProxyClientIp(request);
		if(ip)rateLimit(`verify-ip:${ip}`,15,15*60_000);
		rateLimit(`verify-email:${email}`,verificationConfig.maxAttempts*4,60*60_000);
		const token=registrationTokenFromRequest(request);
		const registrationAttempt=token?await db.registrationAttempt.findUnique({
			where:{tokenHash:hashRegistrationToken(token)},
			include:{verification:true},
		}):null;
		if(registrationAttempt&&registrationAttempt.email===email){
			registrationAttemptId=registrationAttempt.id;
			const now=new Date();
			if(registrationAttempt.expiresAt<=now){
				await db.registrationAttempt.deleteMany({where:{id:registrationAttempt.id}});
				const response=NextResponse.json({error:'This registration session expired. Start registration again.'},{status:410});
				clearRegistrationCookie(response);
				return response;
			}
			const challenge=registrationAttempt.verification;
			if(challenge&&challenge.expiresAt<=now){
				await db.registrationVerification.deleteMany({where:{id:challenge.id,expiresAt:{lte:now}}});
				return NextResponse.json({
					code:'VERIFICATION_CODE_EXPIRED',
					error:'This verification code expired. Request a new code to continue.',
				},{status:410,headers:{'Cache-Control':'no-store'}});
			}
			if(!challenge||challenge.channel!==VerificationChannel.EMAIL)return NextResponse.json({error:'Use the secure phone verification widget for this registration.'},{status:400});
			if(challenge.providerReference?.startsWith('AKEDLY:'))return NextResponse.json({error:'Complete verification in the secure Akedly widget instead.'},{status:409});
			if(challenge.attempts>=verificationConfig.maxAttempts){
				await db.registrationVerification.deleteMany({where:{id:challenge.id,attempts:{gte:verificationConfig.maxAttempts}}});
				return NextResponse.json({
					code:'VERIFICATION_ATTEMPTS_EXHAUSTED',
					error:'Too many incorrect codes. Request a new verification code to continue.',
				},{status:429,headers:{'Cache-Control':'no-store'}});
			}
			if(!verificationCodeMatches(registrationAttempt.id,input.code,challenge.codeHash)){
				const updated=await db.registrationVerification.updateMany({
					where:{id:challenge.id,codeHash:challenge.codeHash,attempts:{lt:verificationConfig.maxAttempts},expiresAt:{gt:now}},
					data:{attempts:{increment:1}},
				});
				if(updated.count!==1)return NextResponse.json({error:'The verification code changed. Request a new code and try again.'},{status:409});
				return NextResponse.json({
					code:'INVALID_VERIFICATION_CODE',
					error:'That verification code is incorrect. Check the email and try again.',
				},{status:400,headers:{'Cache-Control':'no-store'}});
			}
			await db.$transaction(async tx=>{
				const consumed=await tx.registrationVerification.deleteMany({
					where:{id:challenge.id,codeHash:challenge.codeHash,attempts:{lt:verificationConfig.maxAttempts},expiresAt:{gt:now}},
				});
				if(consumed.count!==1)throw new Error('VERIFICATION_CODE_CONSUMED');
				await createVerifiedRegistration(tx,registrationAttempt.id,VerificationChannel.EMAIL,now);
			});
			const response=NextResponse.json({verified:true},{headers:{'Cache-Control':'no-store'}});
			clearRegistrationCookie(response);
			return response;
		}
		const user=await db.user.findUnique({where:{email},select:{id:true,emailVerifiedAt:true,requiresRegistrationVerification:true,aureviaExchangeId:true,createdAt:true}});
		if(!user||user.emailVerifiedAt)return NextResponse.json({error:'The code is invalid or no longer available.'},{status:400});
		const challenge=await db.verificationCode.findUnique({where:{userId:user.id}});
		if(!challenge||challenge.channel!==VerificationChannel.EMAIL)return NextResponse.json({error:'The code is invalid or no longer available.'},{status:400});
		if(user.requiresRegistrationVerification&&challenge.providerReference?.startsWith('AKEDLY:'))return NextResponse.json({error:'Complete verification in the secure Akedly widget instead.'},{status:409});
		const now=new Date();
		if(challenge.expiresAt<=now){
			await db.verificationCode.deleteMany({where:{id:challenge.id,expiresAt:{lte:now}}});
			return NextResponse.json({error:'This code has expired. Request a new code.'},{status:410});
		}
		if(challenge.attempts>=verificationConfig.maxAttempts)return NextResponse.json({error:'Too many attempts. Request a new code.'},{status:429});
		if(!verificationCodeMatches(user.id,input.code,challenge.codeHash)){
			await db.verificationCode.updateMany({where:{id:challenge.id,attempts:{lt:verificationConfig.maxAttempts},expiresAt:{gt:now}},data:{attempts:{increment:1}}});
			const updated=await db.verificationCode.findUnique({where:{id:challenge.id},select:{attempts:true}});
			return NextResponse.json({error:updated&&updated.attempts>=verificationConfig.maxAttempts?'Too many attempts. Request a new code.':'The code is incorrect.'},{status:updated&&updated.attempts>=verificationConfig.maxAttempts?429:400});
		}
		await retryAureviaExchangeIdCollision(()=>db.$transaction(async tx=>{
			const consumed=await tx.verificationCode.deleteMany({where:{id:challenge.id,codeHash:challenge.codeHash,attempts:{lt:verificationConfig.maxAttempts},expiresAt:{gt:now}}});
			if(consumed.count!==1)throw new Error('VERIFICATION_CODE_CONSUMED');
			await tx.user.update({where:{id:user.id},data:{
				emailVerifiedAt:now,
				verifiedChannel:VerificationChannel.EMAIL,
				requiresRegistrationVerification:false,
				...(!user.aureviaExchangeId?{aureviaExchangeId:generateAureviaExchangeId(user.createdAt)}:{}),
			}});
			await createNotification(tx,{userId:user.id,type:NotificationType.ACCOUNT,title:'Email address verified',message:'Your email address was verified through the configured email provider.',dedupeKey:`registration:${user.id}:verified:email`,actionUrl:'/dashboard'});
		}));
		return NextResponse.json({verified:true});
	}catch(error){
		if(error instanceof ZodError){
			return NextResponse.json({error:'Enter the email address and six-digit verification code.'},{status:400});
		}
		if(error instanceof Error&&error.message==='REGISTRATION_PHONE_ALREADY_IN_USE'&&registrationAttemptId){
			await db.registrationAttempt.deleteMany({where:{id:registrationAttemptId}});
			const response=NextResponse.json({
				code:'PHONE_ALREADY_IN_USE',
				error:'This phone number is already associated with another account. Start a new registration without it or use a different number.',
			},{status:409,headers:{'Cache-Control':'no-store'}});
			clearRegistrationCookie(response);
			return response;
		}
		if(error instanceof Prisma.PrismaClientKnownRequestError&&error.code==='P2002'&&registrationAttemptId){
			await db.registrationAttempt.deleteMany({where:{id:registrationAttemptId}});
			const response=NextResponse.json({error:'Registration could not be completed with these details. Start registration again.'},{status:409});
			clearRegistrationCookie(response);
			return response;
		}
		if(error instanceof Prisma.PrismaClientKnownRequestError&&error.code==='P2025')return NextResponse.json({error:'The code is invalid or no longer available.'},{status:400});
		if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'Too many verification attempts. Try again later.'},{status:429});
		if(error instanceof Error&&error.message==='VERIFICATION_CODE_CONSUMED'){
			if(registrationAttemptId){
				await db.registrationAttempt.deleteMany({where:{id:registrationAttemptId}});
				const response=NextResponse.json({error:'The code is invalid or no longer available. Start registration again.'},{status:409});
				clearRegistrationCookie(response);
				return response;
			}
			return NextResponse.json({error:'The code is invalid or no longer available.'},{status:409});
		}
		const rawErrorCode=error&&typeof error==='object'&&'code' in error&&typeof error.code==='string'?error.code:'';
		const errorCode=/^[A-Z0-9_]{2,32}$/.test(rawErrorCode)?rawErrorCode:undefined;
		console.error('Registration email verification failed.',{
			errorName:error instanceof Error?error.name:'UnknownError',
			errorCode,
		});
		return NextResponse.json({error:'Unable to verify this account right now.'},{status:500});
	}
}