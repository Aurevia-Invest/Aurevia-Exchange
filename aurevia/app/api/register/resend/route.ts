import {NextResponse} from 'next/server';
import {randomUUID} from 'node:crypto';
import {z,ZodError} from 'zod';
import {Prisma,VerificationChannel} from '@prisma/client';
import {db} from '@/lib/db';
import {AkedlyProviderError,akedlyIsConfigured,akedlyReadiness} from '@/lib/akedly';
import {startAkedlyRegistrationVerification,startAkedlyVerification} from '@/lib/akedly-verification';
import {rateLimit,RateLimitError} from '@/lib/rate-limit';
import {trustedProxyClientIp} from '@/lib/request-ip';
import {deliverVerificationCode,generateVerificationCode,hashVerificationCode,hasConfiguredVerificationProvider} from '@/lib/verification-delivery';
import {verificationConfig} from '@/lib/config';
import {clearRegistrationCookie,hashRegistrationToken,registrationTokenFromRequest} from '@/lib/registration-attempt';

const schema=z.object({email:z.string().trim().email().max(254)});
const genericResponse={message:'If the account is eligible, email verification can continue after the resend cooldown.'};
const RESEND_RATE_LIMIT_WINDOW_MS=10*60_000;

function rateLimitResend(ip:string|null,email:string){
	if(ip)rateLimit(`akedly-register-ip:${ip}`,5,RESEND_RATE_LIMIT_WINDOW_MS);
	rateLimit(`akedly-register-email:${email}`,3,RESEND_RATE_LIMIT_WINDOW_MS);
}

function cooldownResponse(message:string,resendAfter?:Date){
	const retryAfterSeconds=Math.max(1,Math.ceil(((resendAfter?.getTime()||Date.now()+verificationConfig.resendCooldownSeconds*1000)-Date.now())/1000));
	return NextResponse.json(
		{error:message,retryAfterSeconds},
		{status:429,headers:{'Retry-After':String(retryAfterSeconds),'Cache-Control':'no-store'}},
	);
}

function deliveryStatusUnknown(failure:{reason:string;httpStatus?:number}|undefined){
	return failure?.reason==='timeout'
		||failure?.reason==='network-error'
		||(failure?.reason==='provider-rejected'&&(failure.httpStatus??0)>=500);
}

function deliveryStatusUnknownResponse(resendAfter:Date){
	const retryAfterSeconds=Math.max(1,Math.ceil((resendAfter.getTime()-Date.now())/1000));
	return NextResponse.json({
		code:'EMAIL_DELIVERY_STATUS_UNKNOWN',
		error:'We could not confirm whether the email provider accepted the request. Your registration is saved. If the code arrives, enter it here; otherwise retry after the cooldown.',
		retryAfterSeconds,
	},{status:503,headers:{'Retry-After':String(retryAfterSeconds),'Cache-Control':'no-store'}});
}

function akedlyFailureDiagnostic(error:unknown){
	return {
		category:error instanceof Error?error.message:'unknown',
		...(error instanceof AkedlyProviderError&&error.httpStatus?{httpStatus:error.httpStatus}:{}),
		...(error instanceof AkedlyProviderError&&error.providerCode?{providerCode:error.providerCode}:{}),
	};
}

function phoneInitiationFailureResponse(error:unknown,requestId:string){
	const providerCode=error instanceof AkedlyProviderError?error.providerCode:undefined;
	const retryAfterSeconds=error instanceof AkedlyProviderError?error.retryAfterSeconds:undefined;
	let message='Phone verification could not be initiated. Your registration is saved; please retry later.';
	if(['API_KEY_SCOPE_DENIED','INVALID_API_KEY','INVALID_SIGNATURE','PIPELINE_NOT_CONFIGURED','PIPELINE_OWNERSHIP_MISMATCH','WIDGET_INACTIVE'].includes(providerCode||'')){
		message='Phone verification is unavailable because the verification service could not authorize this request. Your registration is saved; please retry later or contact support if this continues.';
	}else if(providerCode==='DESTINATION_COUNTRY_BLOCKED'||providerCode==='NATIONAL_PIPELINE_RESTRICTION'){
		message='The configured verification route is not available for this phone destination. Your registration is saved; contact support or use a supported number.';
	}else if(providerCode==='CHANNEL_QUOTA_EXCEEDED'){
		message='The verification route has temporarily reached its delivery limit. Your registration is saved; wait before retrying and avoid repeated requests.';
	}else if(providerCode==='OTP_SEND_FAILED'){
		message='The code could not be sent. Your registration is saved; if the secure widget offers another channel, try it there, otherwise wait before retrying.';
	}else if(['CAPTCHA_VALIDATION_FAILED','CAPTCHA_API_ERROR','CAPTCHA_NOT_VERIFIED'].includes(providerCode||'')){
		message='The secure verification check could not be completed. Your registration is saved; retry once, and contact support if it fails again.';
	}else if(['CIRCUIT_BREAKER_OPEN','CIRCUIT_BREAKER_TRIGGERED'].includes(providerCode||'')){
		message='Phone verification is temporarily unavailable while the provider recovers. Your registration is saved; wait a few minutes before retrying.';
	}else if([
		'RATE_LIMITED',
		'RATE_LIMIT_EXCEEDED',
		'TOO_MANY_REQUESTS',
		'API_RATE_LIMITED',
		'RATE_LIMIT_WIDGET_ATTEMPTS',
		'RATE_LIMIT_PHONENUMBER_ATTEMPTS',
	].includes(providerCode||'')||(error instanceof AkedlyProviderError&&error.httpStatus===429)){
		message='Too many verification requests were made. Your registration is saved; wait before retrying.';
	}
	const status=error instanceof AkedlyProviderError&&(error.httpStatus===429||[
		'RATE_LIMITED',
		'RATE_LIMIT_EXCEEDED',
		'TOO_MANY_REQUESTS',
		'API_RATE_LIMITED',
		'RATE_LIMIT_WIDGET_ATTEMPTS',
		'RATE_LIMIT_PHONENUMBER_ATTEMPTS',
	].includes(providerCode||''))?429:503;
	return NextResponse.json(
		{error:message,requestId,...(retryAfterSeconds?{retryAfterSeconds}:{})},
		{status,headers:{...(retryAfterSeconds?{'Retry-After':String(retryAfterSeconds)}:{}),'Cache-Control':'no-store'}},
	);
}

export async function POST(request:Request){
	const requestId=randomUUID();
	try{
		const {email:rawEmail}=schema.parse(await request.json());
		const email=rawEmail.toLowerCase();
		const ip=trustedProxyClientIp(request);
		const token=registrationTokenFromRequest(request);
		const registrationAttempt=token?await db.registrationAttempt.findUnique({
			where:{tokenHash:hashRegistrationToken(token)},
			include:{verification:true},
		}):null;
		if(registrationAttempt&&registrationAttempt.email===email&&token){
			const now=new Date();
			let akedlyFallback=false;
			if(registrationAttempt.expiresAt<=now){
				await db.registrationAttempt.deleteMany({where:{id:registrationAttempt.id}});
				const response=NextResponse.json({error:'This registration session expired. Start registration again.'},{status:410});
				clearRegistrationCookie(response);
				return response;
			}
			if(registrationAttempt.verification&&registrationAttempt.verification.expiresAt<=now){
				await db.registrationVerification.deleteMany({
					where:{registrationAttemptId:registrationAttempt.id,expiresAt:{lte:now}},
				});
			}
			const existing=await db.registrationVerification.findUnique({where:{registrationAttemptId:registrationAttempt.id}});
			const registrationChannel=existing?.channel??(registrationAttempt.phone?VerificationChannel.SMS:VerificationChannel.EMAIL);
			if(existing&&existing.resendAfter>now){
				if(existing.channel===VerificationChannel.EMAIL&&existing.expiresAt>now
					&&(existing.providerReference===null||existing.providerReference==='EMAIL_STATUS_UNKNOWN')){
					return NextResponse.json({
						method:'email-code',
						message:existing.providerReference==='EMAIL_STATUS_UNKNOWN'
							?'We could not confirm delivery. If the code arrived, enter it here; otherwise request another code after the cooldown.'
							:'A verification code was already requested. Check your email.',
						resendAfterSeconds:Math.ceil((existing.resendAfter.getTime()-now.getTime())/1000),
					},{status:200,headers:{'Cache-Control':'no-store'}});
				}
				return cooldownResponse('Please wait before requesting another verification attempt.',existing.resendAfter);
			}
			const akedly=akedlyReadiness();
			if(registrationChannel===VerificationChannel.SMS&&!akedly.ready){
				console.warn('[registration-verification] Akedly is unavailable for a pending phone registration.',{
					requestId,
					enabled:akedly.enabled,
					missing:akedly.missing,
				});
				return NextResponse.json({error:'Phone verification is unavailable right now. Your registration is saved. Please try again later; if this continues, contact support.'},{status:503,headers:{'Cache-Control':'no-store'}});
			}
			if(registrationChannel===VerificationChannel.EMAIL&&!akedly.ready&&!hasConfiguredVerificationProvider(VerificationChannel.EMAIL)){
				return NextResponse.json({error:'Email verification is temporarily unavailable. Your registration is saved; please retry later.'},{status:503,headers:{'Cache-Control':'no-store'}});
			}
			rateLimitResend(ip,email);
			if(akedly.ready){
				try{
					const contact=registrationChannel===VerificationChannel.SMS
						?(registrationAttempt.phone?{phoneNumber:registrationAttempt.phone}:null)
						:{email:registrationAttempt.email};
					if(!contact)return NextResponse.json({error:'This registration requires a phone number. Start a new registration to continue.'},{status:409,headers:{'Cache-Control':'no-store'}});
					const attempt=await startAkedlyRegistrationVerification(registrationAttempt.id,registrationChannel,contact);
					return NextResponse.json({
						method:'akedly',
						channel:registrationChannel,
						message:registrationChannel===VerificationChannel.SMS
							?'Complete the secure phone verification widget.'
							:'Complete the secure email verification widget.',
						...attempt,
					},{status:200,headers:{'Cache-Control':'no-store'}});
				}catch(error){
					if(error instanceof Error&&error.message==='AKEDLY_RESEND_COOLDOWN'){
						return cooldownResponse('Please wait before requesting another verification attempt.',registrationAttempt.verification?.resendAfter);
					}
					const providerFailure=error instanceof Error&&[
						'AKEDLY_PROVIDER_UNAVAILABLE',
						'AKEDLY_ATTEMPT_REJECTED',
						'AKEDLY_INVALID_PROVIDER_RESPONSE',
						'AKEDLY_INVALID_WIDGET_URL',
					].includes(error.message);
					if(!providerFailure)throw error;
					if(registrationChannel===VerificationChannel.SMS){
						console.warn('[registration-verification] Akedly phone initiation failed; legacy email delivery is not used for new registrations.',{
							requestId,
							...akedlyFailureDiagnostic(error),
						});
						return phoneInitiationFailureResponse(error,requestId);
					}
					if(!hasConfiguredVerificationProvider(VerificationChannel.EMAIL)){
						console.warn('[registration-verification] Akedly initiation failed and no email fallback is configured.',{
							...akedlyFailureDiagnostic(error),
						});
						return NextResponse.json({error:'Email verification could not be initiated. Your registration is saved; please retry later.'},{status:503,headers:{'Cache-Control':'no-store'}});
					}
					akedlyFallback=true;
					console.warn('[registration-verification] Akedly initiation failed; using the configured email fallback.',{
						...akedlyFailureDiagnostic(error),
					});
				}
			}
			if(!hasConfiguredVerificationProvider(VerificationChannel.EMAIL)){
				return NextResponse.json({error:'Email verification is temporarily unavailable. Your registration is saved; please retry later.'},{status:503,headers:{'Cache-Control':'no-store'}});
			}
			const code=generateVerificationCode();
			const codeHash=hashVerificationCode(registrationAttempt.id,code);
			const reservation=hashVerificationCode(registrationAttempt.id,`reservation:${randomUUID()}`);
			const expiresAt=new Date(now.getTime()+verificationConfig.expiresInMinutes*60_000);
			const resendAfter=new Date(now.getTime()+verificationConfig.resendCooldownSeconds*1000);
			if(existing){
				const reserved=await db.registrationVerification.updateMany({
					where:{id:existing.id,resendAfter:{lte:now}},
					data:{codeHash:reservation,channel:VerificationChannel.EMAIL,providerReference:null,expiresAt,resendAfter,attempts:0},
				});
				if(reserved.count!==1)return NextResponse.json({error:'Please wait before requesting another verification code.'},{status:429});
			}else{
				await db.registrationVerification.create({
					data:{registrationAttemptId:registrationAttempt.id,codeHash:reservation,channel:VerificationChannel.EMAIL,expiresAt,resendAfter},
				});
			}
			let deliveryFailure:{reason:string;httpStatus?:number;providerCode?:string}|undefined;
			const delivered=await deliverVerificationCode(VerificationChannel.EMAIL,{
				email:registrationAttempt.email,
				name:registrationAttempt.name,
				phone:registrationAttempt.phone,
			},code,{
				registrationToken:token,
				onFailure:failure=>{
					deliveryFailure=failure;
					console.warn('[registration-verification] Email delivery failed.',failure);
				},
			});
			if(!delivered){
				if(deliveryStatusUnknown(deliveryFailure)){
					const saved=await db.registrationVerification.updateMany({
						where:{registrationAttemptId:registrationAttempt.id,codeHash:reservation},
						data:{codeHash,channel:VerificationChannel.EMAIL,providerReference:'EMAIL_STATUS_UNKNOWN'},
					});
					if(saved.count!==1)return NextResponse.json({error:'The verification request changed. Please retry verification.'},{status:409,headers:{'Cache-Control':'no-store'}});
					return deliveryStatusUnknownResponse(resendAfter);
				}
				if(existing){
					await db.registrationVerification.updateMany({
						where:{id:existing.id,codeHash:reservation},
						data:{
							codeHash:existing.codeHash,
							channel:existing.channel,
							providerReference:existing.providerReference,
							expiresAt:existing.expiresAt,
							resendAfter:existing.resendAfter,
							attempts:existing.attempts,
						},
					});
				}else{
					await db.registrationVerification.deleteMany({
						where:{registrationAttemptId:registrationAttempt.id,codeHash:reservation},
					});
				}
				return NextResponse.json({
					code:'EMAIL_DELIVERY_FAILED',
					error:'Email verification could not be initiated. Your registration is saved; please retry shortly.',
				},{status:502,headers:{'Cache-Control':'no-store'}});
			}
			const saved=await db.registrationVerification.updateMany({
				where:{registrationAttemptId:registrationAttempt.id,codeHash:reservation},
				data:{codeHash,channel:VerificationChannel.EMAIL,providerReference:null},
			});
			if(saved.count!==1){
				return NextResponse.json({error:'The verification request changed. Please retry verification.'},{status:409,headers:{'Cache-Control':'no-store'}});
			}
			return NextResponse.json({
				method:'email-code',
				message:akedlyFallback
					?'Akedly could not start this attempt. Your configured email provider accepted the verification request; delivery may take a short time.'
					:'The email provider accepted the verification request. Delivery may take a short time.',
				...(akedlyFallback?{fallbackFrom:'akedly'}:{}),
				resendAfterSeconds:verificationConfig.resendCooldownSeconds,
			},{status:200,headers:{'Cache-Control':'no-store'}});
		}
		const user=await db.user.findUnique({where:{email},select:{id:true,email:true,name:true,phone:true,emailVerifiedAt:true,requiresRegistrationVerification:true,role:true,status:true}});
		if(!user||user.role!=='USER'||user.status!=='ACTIVE'||user.emailVerifiedAt||!user.requiresRegistrationVerification)return NextResponse.json(genericResponse,{status:202});
		const now=new Date();
		let existing=await db.verificationCode.findUnique({where:{userId:user.id}});
		if(existing&&existing.expiresAt<=now){
			await db.verificationCode.deleteMany({where:{id:existing.id,expiresAt:{lte:now}}});
			existing=null;
		}
		if(existing&&existing.resendAfter>now){
			if(existing.channel===VerificationChannel.EMAIL&&existing.expiresAt>now
				&&(existing.providerReference===null||existing.providerReference==='EMAIL_STATUS_UNKNOWN')){
				return NextResponse.json({
					method:'email-code',
					message:existing.providerReference==='EMAIL_STATUS_UNKNOWN'
						?'We could not confirm delivery. If the code arrived, enter it here; otherwise request another code after the cooldown.'
						:'A verification code was already requested. Check your email.',
					resendAfterSeconds:Math.ceil((existing.resendAfter.getTime()-now.getTime())/1000),
				},{status:200,headers:{'Cache-Control':'no-store'}});
			}
			return cooldownResponse('Please wait before requesting another verification attempt.',existing.resendAfter);
		}
		if(!akedlyIsConfigured()&&!hasConfiguredVerificationProvider(VerificationChannel.EMAIL))return NextResponse.json({error:'Email verification is temporarily unavailable. Please try again later.'},{status:503});
		rateLimitResend(ip,email);
		let akedlyFallback=false;
		if(akedlyIsConfigured()){
			try{
				const attempt=await startAkedlyVerification(user.id,VerificationChannel.EMAIL,{email:user.email});
				return NextResponse.json({method:'akedly',message:'Complete the secure email verification widget.',...attempt},{status:200});
			}catch(error){
				if(error instanceof Error&&error.message==='AKEDLY_RESEND_COOLDOWN'){
					const challenge=await db.verificationCode.findUnique({where:{userId:user.id},select:{resendAfter:true}});
					return cooldownResponse('Please wait before requesting another verification attempt.',challenge?.resendAfter);
				}
				if(error instanceof Error&&error.message==='AKEDLY_ATTEMPT_RESERVATION_LOST')throw error;
				const providerFailure=error instanceof Error&&[
					'AKEDLY_PROVIDER_UNAVAILABLE',
					'AKEDLY_ATTEMPT_REJECTED',
					'AKEDLY_INVALID_PROVIDER_RESPONSE',
					'AKEDLY_INVALID_WIDGET_URL',
				].includes(error.message);
				if(!providerFailure||!hasConfiguredVerificationProvider(VerificationChannel.EMAIL))throw error;
				akedlyFallback=true;
				console.warn('[registration-verification] Akedly initiation failed; using the configured email fallback.',{
					...akedlyFailureDiagnostic(error),
				});
			}
		}
		if(!hasConfiguredVerificationProvider(VerificationChannel.EMAIL))return NextResponse.json({error:'Email verification is temporarily unavailable. Please try again later.'},{status:503});
		const code=generateVerificationCode();
		const codeHash=hashVerificationCode(user.id,code);
		const reservation=hashVerificationCode(user.id,`reservation:${randomUUID()}`);
		const expiresAt=new Date(now.getTime()+verificationConfig.expiresInMinutes*60_000);
		const resendAfter=new Date(now.getTime()+verificationConfig.resendCooldownSeconds*1000);
		if(existing){
			const reserved=await db.verificationCode.updateMany({
				where:{id:existing.id,resendAfter:{lte:now}},
				data:{codeHash:reservation,channel:VerificationChannel.EMAIL,providerReference:null,expiresAt,resendAfter,attempts:0},
			});
			if(reserved.count!==1)return NextResponse.json({error:'Please wait before requesting another verification code.'},{status:429});
		}else{
			try{
				await db.verificationCode.create({data:{userId:user.id,codeHash:reservation,channel:VerificationChannel.EMAIL,expiresAt,resendAfter}});
			}catch(error){
				if(error instanceof Prisma.PrismaClientKnownRequestError&&error.code==='P2002')return NextResponse.json({error:'Please wait before requesting another verification code.'},{status:429});
				throw error;
			}
		}
		let deliveryFailure:{reason:string;httpStatus?:number}|undefined;
		const delivered=await deliverVerificationCode(VerificationChannel.EMAIL,user,code,{
			onFailure:failure=>{
				deliveryFailure=failure;
				console.warn('[registration-verification] Email delivery failed.',failure);
			},
		});
		if(!delivered){
			if(deliveryStatusUnknown(deliveryFailure)){
				const saved=await db.verificationCode.updateMany({
					where:{userId:user.id,codeHash:reservation},
					data:{codeHash,channel:VerificationChannel.EMAIL,providerReference:'EMAIL_STATUS_UNKNOWN'},
				});
				if(saved.count!==1)return NextResponse.json({error:'The verification request changed. Please retry verification.'},{status:409});
				return deliveryStatusUnknownResponse(resendAfter);
			}
			if(existing){
				await db.verificationCode.updateMany({where:{id:existing.id,codeHash:reservation},data:{
					codeHash:existing.codeHash,channel:existing.channel,providerReference:existing.providerReference,
					expiresAt:existing.expiresAt,resendAfter:existing.resendAfter,attempts:existing.attempts,
				}});
			}else{
				await db.verificationCode.deleteMany({where:{userId:user.id,codeHash:reservation}});
			}
			return NextResponse.json({error:'Email verification delivery failed. Please try again later.'},{status:502});
		}
		const saved=await db.verificationCode.updateMany({where:{userId:user.id,codeHash:reservation},data:{codeHash,channel:VerificationChannel.EMAIL,providerReference:null}});
		if(saved.count!==1)return NextResponse.json({error:'The verification request changed. Please request a new code.'},{status:409});
		return NextResponse.json({
			method:'email-code',
			message:akedlyFallback
				?'Akedly could not start this attempt. Your configured email provider accepted the verification request; delivery may take a short time.'
				:'The email provider accepted the verification request. Delivery may take a short time.',
			...(akedlyFallback?{fallbackFrom:'akedly'}:{}),
			resendAfterSeconds:verificationConfig.resendCooldownSeconds,
		},{status:200});
	}catch(error){
		if(error instanceof ZodError)return NextResponse.json({error:'Enter a valid email address.'},{status:400});
		if(error instanceof RateLimitError)return NextResponse.json(
			{error:'Please wait before requesting another verification code.',retryAfterSeconds:error.retryAfterSeconds},
			{status:429,headers:{'Retry-After':String(error.retryAfterSeconds),'Cache-Control':'no-store'}},
		);
		if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json(genericResponse,{status:202});
		if(error instanceof Error&&error.message==='AKEDLY_RESEND_COOLDOWN')return cooldownResponse('Please wait before requesting another verification attempt.');
		if(error instanceof Error&&error.message.startsWith('AKEDLY_'))return NextResponse.json({error:'Email verification is temporarily unavailable. Please try again shortly.'},{status:503});
		console.error('[akedly-registration] Unable to create verification attempt.',{requestId,errorType:error instanceof Error?error.name:'UnknownError'});
		return NextResponse.json({error:'Unable to start email verification right now.'},{status:503});
	}
}
