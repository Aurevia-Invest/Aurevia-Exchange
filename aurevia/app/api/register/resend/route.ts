import {NextResponse} from 'next/server';
import {randomUUID} from 'node:crypto';
import {z,ZodError} from 'zod';
import {Prisma,VerificationChannel} from '@prisma/client';
import {db} from '@/lib/db';
import {AkedlyProviderError,akedlyIsConfigured} from '@/lib/akedly';
import {startAkedlyRegistrationVerification,startAkedlyVerification} from '@/lib/akedly-verification';
import {rateLimit,RateLimitError} from '@/lib/rate-limit';
import {trustedProxyClientIp} from '@/lib/request-ip';
import {deliverVerificationCode,generateVerificationCode,hashVerificationCode,hasConfiguredVerificationProvider} from '@/lib/verification-delivery';
import {verificationConfig} from '@/lib/config';
import {clearRegistrationCookie,hashRegistrationToken,registrationTokenFromRequest} from '@/lib/registration-attempt';

const schema=z.object({email:z.string().trim().email().max(254)});
const genericResponse={message:'If the account is eligible, email verification can continue after the resend cooldown.'};

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
	};
}

export async function POST(request:Request){
	try{
		const {email:rawEmail}=schema.parse(await request.json());
		const email=rawEmail.toLowerCase();
		const ip=trustedProxyClientIp(request);
		if(ip)rateLimit(`akedly-register-ip:${ip}`,5,60*60_000);
		rateLimit(`akedly-register-email:${email}`,3,60*60_000);
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
			if(akedlyIsConfigured()){
				try{
					const attempt=await startAkedlyRegistrationVerification(registrationAttempt.id,registrationAttempt.email);
					return NextResponse.json({method:'akedly',message:'Complete the secure email verification widget.',...attempt},{status:200,headers:{'Cache-Control':'no-store'}});
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
			const existing=await db.registrationVerification.findUnique({where:{registrationAttemptId:registrationAttempt.id}});
			if(existing&&existing.resendAfter>now){
				if(existing.channel===VerificationChannel.EMAIL&&existing.providerReference==='EMAIL_STATUS_UNKNOWN'&&existing.expiresAt>now){
					return NextResponse.json({
						method:'email-code',
						message:'We could not confirm delivery. If the code arrived, enter it here; otherwise request another code after the cooldown.',
						resendAfterSeconds:Math.ceil((existing.resendAfter.getTime()-now.getTime())/1000),
					},{status:200,headers:{'Cache-Control':'no-store'}});
				}
				if(existing.channel===VerificationChannel.EMAIL&&!existing.providerReference&&existing.expiresAt>now){
					return NextResponse.json({method:'email-code',message:'A verification code was already requested. Check your email.',resendAfterSeconds:Math.ceil((existing.resendAfter.getTime()-now.getTime())/1000)},{status:200});
				}
				return cooldownResponse('Please wait before requesting another verification attempt.',existing.resendAfter);
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
			let deliveryFailure:{reason:string;httpStatus?:number}|undefined;
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
		const now=new Date();
		const existing=await db.verificationCode.findUnique({where:{userId:user.id}});
		if(existing&&existing.resendAfter>now){
			if(existing.channel===VerificationChannel.EMAIL&&existing.providerReference==='EMAIL_STATUS_UNKNOWN'&&existing.expiresAt>now){
				return NextResponse.json({
					method:'email-code',
					message:'We could not confirm delivery. If the code arrived, enter it here; otherwise request another code after the cooldown.',
					resendAfterSeconds:Math.ceil((existing.resendAfter.getTime()-now.getTime())/1000),
				},{status:200,headers:{'Cache-Control':'no-store'}});
			}
			if(existing.channel===VerificationChannel.EMAIL&&!existing.providerReference&&existing.expiresAt>now){
				return NextResponse.json({method:'email-code',message:'A verification code was already requested. Check your email.',resendAfterSeconds:Math.ceil((existing.resendAfter.getTime()-now.getTime())/1000)},{status:200});
			}
			return cooldownResponse('Please wait before requesting another verification code.',existing.resendAfter);
		}
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
		console.error('[akedly-registration] Unable to create verification attempt.',{errorType:error instanceof Error?error.name:'UnknownError'});
		return NextResponse.json({error:'Unable to start email verification right now.'},{status:503});
	}
}
