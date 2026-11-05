import {randomUUID} from 'node:crypto';
import {Prisma,VerificationChannel} from '@prisma/client';
import {NextResponse} from 'next/server';
import {z,ZodError} from 'zod';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {rateLimit} from '@/lib/rate-limit';
import {verificationConfig} from '@/lib/config';
import {hashVerificationCode,hasConfiguredSmsProvider,hasConfiguredTermii,hasConfiguredTwilio,sendTermiiVerificationToken,sendTwilioVerificationCode,TermiiProviderError,TwilioVerifyProviderError} from '@/lib/verification-delivery';
import {isValidE164} from '@/lib/registration-validation';
import {trustedProxyClientIp} from '@/lib/request-ip';
import {AkedlyProviderError,akedlyAttemptFailureDiagnostics,akedlyIsConfigured,akedlyReadiness} from '@/lib/akedly';
import {startAkedlyVerification} from '@/lib/akedly-verification';
import {isTierThreePhoneVerificationEligible,getTierProfileRequirements} from '@/lib/production-policy';
import {synchronizeCompletedProfileTier} from '@/lib/tier-progression';

const schema=z.object({
	phone:z.string().trim().max(16).refine(isValidE164,'Enter a valid phone number with its country code.'),
	delivery:z.enum(['automatic','sms','termii']).optional(),
});

export async function POST(request:Request){
	const requestId=randomUUID();
	try{
		const user=await requireUser();
		const input=schema.parse(await request.json());
		rateLimit(`kyc-phone-send-ip:${trustedProxyClientIp(request)||'unknown'}`,30,60*60_000);
		rateLimit(`kyc-phone-send-user:${user.id}`,3,60*60_000);
		rateLimit(`kyc-phone-send-number:${input.phone}`,3,60*60_000);
		const current=await db.$transaction(async tx=>{
			await synchronizeCompletedProfileTier(tx,user.id);
			return tx.user.findUnique({where:{id:user.id},select:{
				id:true,phone:true,phoneVerified:true,accountMode:true,status:true,approvedTier:true,name:true,country:true,
			}});
		});
		if(!current||current.status!=='ACTIVE')return NextResponse.json({error:'This account is unavailable.'},{status:403});
		const requirements=getTierProfileRequirements(current);
		const phoneVerificationEligible=isTierThreePhoneVerificationEligible({
			accountMode:current.accountMode,
			accountStatus:current.status,
			approvedTier:current.approvedTier,
			profileComplete:requirements.profileComplete,
		});
		if(!phoneVerificationEligible)return NextResponse.json({error:'Complete your name and country in Profile before verifying your phone.'},{status:403});
		if(current.phone===input.phone&&current.phoneVerified)return NextResponse.json({error:'This phone number is already verified.'},{status:409});

		if(akedlyIsConfigured()&&input.delivery!=='termii'&&input.delivery!=='sms'){
			const existingChallenge=await db.verificationCode.findUnique({where:{userId:user.id},select:{resendAfter:true}});
			if(existingChallenge&&existingChallenge.resendAfter>new Date())return NextResponse.json({error:'Please wait before requesting another verification attempt.'},{status:429});
			try{
				await db.user.update({where:{id:user.id},data:{phone:input.phone,...(current.phone===input.phone?{}:{phoneVerified:false,phoneVerifiedAt:null})}});
			}catch(error){
				if(error instanceof Prisma.PrismaClientKnownRequestError&&error.code==='P2002')return NextResponse.json({error:'This phone number is already associated with another account.'},{status:409});
				throw error;
			}
			try{
				const attempt=await startAkedlyVerification(user.id,VerificationChannel.SMS,{phoneNumber:input.phone});
				return NextResponse.json({
					message:'Complete phone verification in the secure widget. If you cannot receive or complete it, request an SMS code instead.',
					provider:'akedly',
					smsFallbackAvailable:hasConfiguredSmsProvider(),
					resendAfterSeconds:verificationConfig.resendCooldownSeconds,
					...attempt,
				},{status:200});
			}catch(error){
				if(error instanceof Error&&['AKEDLY_RESEND_COOLDOWN','AKEDLY_ATTEMPT_RESERVATION_LOST'].includes(error.message))throw error;
				const akedlyFailure=error instanceof Error&&[
					'AKEDLY_CONFIGURATION_REQUIRED',
					'AKEDLY_INTEGRATION_DISABLED',
					'AKEDLY_CONFIGURATION_FAILED',
					'AKEDLY_REQUEST_SIGNING_FAILED',
					'AKEDLY_PROVIDER_UNAVAILABLE',
					'AKEDLY_ATTEMPT_REJECTED',
					'AKEDLY_INVALID_PROVIDER_RESPONSE',
					'AKEDLY_INVALID_WIDGET_URL',
				].includes(error.message);
				const allowExistingSmsFallback=error instanceof Error&&[
					'AKEDLY_CONFIGURATION_REQUIRED',
					'AKEDLY_INTEGRATION_DISABLED',
					'AKEDLY_CONFIGURATION_FAILED',
					'AKEDLY_REQUEST_SIGNING_FAILED',
					'AKEDLY_PROVIDER_UNAVAILABLE',
					'AKEDLY_ATTEMPT_REJECTED',
					'AKEDLY_INVALID_PROVIDER_RESPONSE',
					'AKEDLY_INVALID_WIDGET_URL',
				].includes(error.message);
				if(akedlyFailure){
					const diagnostics=akedlyAttemptFailureDiagnostics(error,input.phone);
					console.warn('[kyc-phone] Akedly verification attempt failed.',{
						requestId,
						referenceId:requestId,
						endpoint:'/api/kyc/phone/send',
						...diagnostics,
						failureTimestamp:error instanceof AkedlyProviderError?error.failureTimestamp:new Date().toISOString(),
					});
				}
				if(!allowExistingSmsFallback||!hasConfiguredSmsProvider())throw error;
			}
		}
		const smsProvider=input.delivery==='termii'
			?(hasConfiguredTermii()?'termii':null)
			:hasConfiguredTwilio()?'twilio':hasConfiguredTermii()?'termii':null;
		if(!smsProvider){
			if(input.delivery==='termii'){
				console.warn('[kyc-phone] Requested SMS fallback is not configured.');
				return NextResponse.json({error:'The requested SMS provider is not configured. No code was sent. Use the secure verification widget or contact support.'},{status:503});
			}
			const readiness=akedlyReadiness();
			console.warn('[kyc-phone] No phone verification provider is configured.',{
				akedlyEnabled:readiness.enabled,
				missingAkedly:readiness.missing,
				termiiConfigured:false,
			});
			return NextResponse.json({error:'Phone verification is not configured for this service. No code was sent. Contact support instead of retrying.'},{status:503});
		}

		const now=new Date();
		const existing=await db.verificationCode.findUnique({where:{userId:user.id}});
		if(existing&&existing.resendAfter>now)return NextResponse.json({error:'Please wait before requesting another code.'},{status:429});
		const challengeId=existing?.id||randomUUID();
		const reservation=hashVerificationCode(user.id,`${input.phone}:${randomUUID()}`);
		const expiresAt=new Date(now.getTime()+verificationConfig.expiresInMinutes*60_000);
		const resendAfter=new Date(now.getTime()+verificationConfig.resendCooldownSeconds*1000);
		try{
			await db.$transaction(async tx=>{
				if(existing){
					const reserved=await tx.verificationCode.updateMany({
						where:{id:existing.id,resendAfter:{lte:now}},
						data:{codeHash:reservation,channel:VerificationChannel.SMS,providerReference:null,expiresAt,resendAfter,attempts:0},
					});
					if(reserved.count!==1)throw new Error('VERIFICATION_RESEND_COOLDOWN');
				}else{
					await tx.verificationCode.create({data:{id:challengeId,userId:user.id,codeHash:reservation,channel:VerificationChannel.SMS,expiresAt,resendAfter}});
				}
				await tx.user.update({where:{id:user.id},data:{phone:input.phone,...(current.phone===input.phone?{}:{phoneVerified:false,phoneVerifiedAt:null})}});
			});
		}catch(error){
			if(error instanceof Error&&error.message==='VERIFICATION_RESEND_COOLDOWN')return NextResponse.json({error:'Please wait before requesting another code.'},{status:429});
			if(error instanceof Prisma.PrismaClientKnownRequestError&&error.code==='P2002'){
				const target=error.meta?.target;
				const fields=Array.isArray(target)?target.map(String):[String(target||'')];
				if(fields.some(field=>field.toLowerCase().includes('phone')))return NextResponse.json({error:'This phone number is already associated with another account.'},{status:409});
				return NextResponse.json({error:'Please wait before requesting another code.'},{status:429});
			}
			if(error instanceof Prisma.PrismaClientKnownRequestError&&error.code==='P2025')return NextResponse.json({error:'This account is unavailable.'},{status:403});
			throw error;
		}

		let providerReference:string;
		try{
			providerReference=smsProvider==='twilio'
				?await sendTwilioVerificationCode(input.phone)
				:await sendTermiiVerificationToken(input.phone);
		}catch(error){
			await db.verificationCode.deleteMany({where:{id:challengeId,codeHash:reservation}});
			console.error('[kyc-phone] SMS provider send failed.',{
				requestId,
				referenceId:requestId,
				provider:smsProvider,
				endpoint:smsProvider==='twilio'?'/v2/Services/{ServiceSid}/Verifications':'/api/sms/otp/send',
				failureStage:error instanceof TermiiProviderError||error instanceof TwilioVerifyProviderError?error.failureStage:'unclassified',
				providerHttpStatus:error instanceof TermiiProviderError||error instanceof TwilioVerifyProviderError?error.httpStatus:null,
				underlyingErrorType:error instanceof TermiiProviderError||error instanceof TwilioVerifyProviderError?error.underlyingErrorType:error instanceof Error?error.name:'UnknownError',
			});
			return NextResponse.json({error:'We could not send a verification code. Check the phone number and try again.',requestId,referenceId:requestId},{status:502});
		}
		const saved=await db.verificationCode.updateMany({
			where:{id:challengeId,codeHash:reservation},
			data:{providerReference,codeHash:hashVerificationCode(user.id,`${input.phone}:${providerReference}`)},
		});
		if(saved.count!==1)return NextResponse.json({error:'The phone number changed while sending the code. Request a new code.'},{status:409});
		return NextResponse.json({message:'A verification code was sent to your phone.',resendAfterSeconds:verificationConfig.resendCooldownSeconds},{status:200});
	}catch(error){
		if(error instanceof ZodError)return NextResponse.json({error:error.issues[0]?.message||'Enter a valid phone number with its country code.'},{status:400});
		if(error instanceof SyntaxError)return NextResponse.json({error:'Phone verification data must be valid JSON.'},{status:400});
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Sign in to verify your phone number.'},{status:401});
		if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'Too many code requests. Try again later.'},{status:429});
		console.error('[kyc-phone] Request failed.',{requestId,errorType:error instanceof Error?error.name:'UnknownError'});
		return NextResponse.json({
			error:'Unable to send a verification code right now.',
			requestId,
			referenceId:requestId,
		},{status:503});
	}
}
