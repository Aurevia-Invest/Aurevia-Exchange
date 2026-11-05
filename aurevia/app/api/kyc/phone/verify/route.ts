import {NotificationType,Prisma,VerificationChannel} from '@prisma/client';
import {NextResponse} from 'next/server';
import {z,ZodError} from 'zod';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {createNotification} from '@/lib/notifications';
import {rateLimit} from '@/lib/rate-limit';
import {verificationConfig} from '@/lib/config';
import {verificationCodeMatches,verifyTermiiVerificationToken,verifyTwilioVerificationCode,TwilioVerifyProviderError} from '@/lib/verification-delivery';
import {akedlyAttemptIdFromReference} from '@/lib/akedly-verification';
import {trustedProxyClientIp} from '@/lib/request-ip';
import {isTierThreePhoneVerificationEligible,getTierProfileRequirements} from '@/lib/production-policy';

const schema=z.object({code:z.string().regex(/^\d{6}$/)});

export async function POST(request:Request){
	try{
		const user=await requireUser();
		const {code}=schema.parse(await request.json());
		rateLimit(`kyc-phone-verify-ip:${trustedProxyClientIp(request)||'unknown'}`,60,15*60_000);
		rateLimit(`kyc-phone-verify-user:${user.id}`,verificationConfig.maxAttempts*4,60*60_000);

		const account=await db.user.findUnique({where:{id:user.id},select:{
			id:true,phone:true,phoneVerified:true,accountMode:true,status:true,approvedTier:true,name:true,country:true,
		}});
		if(!account||account.status!=='ACTIVE')return NextResponse.json({error:'This account is unavailable.'},{status:403});
		const requirements=getTierProfileRequirements(account);
		if(!isTierThreePhoneVerificationEligible({
			accountMode:account.accountMode,
			accountStatus:account.status,
			approvedTier:account.approvedTier,
			profileComplete:requirements.profileComplete,
		}))return NextResponse.json({error:'Complete your name and country in Profile before verifying your phone.'},{status:403});
		if(!account.phone)return NextResponse.json({error:'Add a phone number and request a code first.'},{status:400});
		if(account.phoneVerified)return NextResponse.json({verified:true,message:'This phone number is already verified.'});

		const challenge=await db.verificationCode.findUnique({where:{userId:user.id}});
		if(!challenge||challenge.channel!==VerificationChannel.SMS||!challenge.providerReference)return NextResponse.json({error:'Request a new phone verification code.'},{status:400});
		if(akedlyAttemptIdFromReference(challenge.providerReference))return NextResponse.json({error:'Complete phone verification in the secure Akedly widget.'},{status:409});
		const now=new Date();
		if(challenge.expiresAt<=now){
			await db.verificationCode.deleteMany({where:{id:challenge.id,expiresAt:{lte:now}}});
			return NextResponse.json({error:'This code has expired. Request a new code.'},{status:410});
		}
		if(challenge.attempts>=verificationConfig.maxAttempts)return NextResponse.json({error:'Too many attempts. Request a new code.'},{status:429});
		if(!verificationCodeMatches(user.id,`${account.phone}:${challenge.providerReference}`,challenge.codeHash))return NextResponse.json({error:'The phone number changed. Request a new code.'},{status:409});

		let verified:boolean;
		try{
			verified=challenge.providerReference==='TWILIO'
				?await verifyTwilioVerificationCode(account.phone,code)
				:await verifyTermiiVerificationToken(challenge.providerReference,code);
		}catch(error){
			console.error('[kyc-phone] SMS provider verification failed.',{
				userId:user.id,
				provider:challenge.providerReference==='TWILIO'?'twilio':'termii',
				failureStage:error instanceof TwilioVerifyProviderError?error.failureStage:'unclassified',
				providerHttpStatus:error instanceof TwilioVerifyProviderError?error.httpStatus:null,
				errorType:error instanceof Error?error.name:'UnknownError',
			});
			return NextResponse.json({error:'Phone verification is temporarily unavailable. Please try again.'},{status:503});
		}
		if(!verified){
			await db.verificationCode.updateMany({where:{id:challenge.id,attempts:{lt:verificationConfig.maxAttempts},expiresAt:{gt:now}},data:{attempts:{increment:1}}});
			const updated=await db.verificationCode.findUnique({where:{id:challenge.id},select:{attempts:true}});
			const exhausted=Boolean(updated&&updated.attempts>=verificationConfig.maxAttempts);
			return NextResponse.json({error:exhausted?'Too many attempts. Request a new code.':'The code is incorrect.'},{status:exhausted?429:400});
		}

		await db.$transaction(async tx=>{
			const consumed=await tx.verificationCode.deleteMany({where:{id:challenge.id,codeHash:challenge.codeHash,attempts:{lt:verificationConfig.maxAttempts},expiresAt:{gt:now}}});
			if(consumed.count!==1)throw new Error('VERIFICATION_CODE_CONSUMED');
			const updated=await tx.user.updateMany({where:{id:user.id,phone:account.phone,phoneVerified:false,status:'ACTIVE'},data:{phoneVerified:true,phoneVerifiedAt:now}});
			if(updated.count!==1)throw new Error('PHONE_NUMBER_CHANGED');
			await createNotification(tx,{userId:user.id,type:NotificationType.ACCOUNT,title:'Phone number verified',message:'Your phone number was verified for KYC using the configured SMS provider.',dedupeKey:`kyc:${user.id}:phone-verified:${now.toISOString()}`,actionUrl:'/kyc'});
		});
		return NextResponse.json({verified:true,message:'Your phone number is verified.'});
	}catch(error){
		if(error instanceof ZodError)return NextResponse.json({error:'Enter the six-digit verification code.'},{status:400});
		if(error instanceof SyntaxError)return NextResponse.json({error:'Phone verification data must be valid JSON.'},{status:400});
		if(error instanceof Prisma.PrismaClientKnownRequestError&&error.code==='P2025')return NextResponse.json({error:'This account is unavailable.'},{status:403});
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Sign in to verify your phone number.'},{status:401});
		if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'Too many verification attempts. Try again later.'},{status:429});
		if(error instanceof Error&&error.message==='VERIFICATION_CODE_CONSUMED')return NextResponse.json({error:'The code is invalid or no longer available.'},{status:409});
		if(error instanceof Error&&error.message==='PHONE_NUMBER_CHANGED')return NextResponse.json({error:'The phone number changed. Request a new code.'},{status:409});
		console.error('[kyc-phone] Verification request failed.',{errorType:error instanceof Error?error.name:'UnknownError'});
		return NextResponse.json({error:'Unable to verify this phone number right now.'},{status:503});
	}
}
