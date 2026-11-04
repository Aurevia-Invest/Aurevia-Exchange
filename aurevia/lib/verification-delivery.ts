import {randomInt,createHmac,timingSafeEqual} from 'node:crypto';
import {verificationConfig} from './config';
import {getServerConfiguration} from './config/env';

export function hasConfiguredTermii(){
	return getServerConfiguration().verification.termiiConfigured;
}

export function hasConfiguredTwilio(){
	return getServerConfiguration().verification.twilioConfigured;
}

export function hasConfiguredSmsProvider(){
	const config=getServerConfiguration().verification;
	return config.twilioConfigured||config.termiiConfigured;
}

export function generateVerificationCode(){
	return randomInt(100000,1000000).toString();
}

export function hashVerificationCode(userId:string,code:string){
	const secret=getServerConfiguration().verification.codeSecret;
	if(!secret)throw new Error('VERIFICATION_SECRET_UNAVAILABLE');
	return createHmac('sha256',secret).update(`${userId}:${code}`).digest('hex');
}

export function verificationCodeMatches(userId:string,code:string,hash:string){
	const actual=Buffer.from(hashVerificationCode(userId,code),'hex');
	const expected=Buffer.from(hash,'hex');
	return actual.length===expected.length&&timingSafeEqual(actual,expected);
}

export class TermiiProviderError extends Error{
	constructor(
		message:'PHONE_VERIFICATION_PROVIDER_UNAVAILABLE'|'PHONE_VERIFICATION_PROVIDER_FAILED',
		readonly failureStage:'transport'|'provider_response'|'invalid_response',
		readonly httpStatus:number|null,
		readonly underlyingErrorType:string|null=null,
	){
		super(message);
		this.name='TermiiProviderError';
	}
}

export class TwilioVerifyProviderError extends Error{
	constructor(
		message:'PHONE_VERIFICATION_PROVIDER_UNAVAILABLE'|'PHONE_VERIFICATION_PROVIDER_FAILED',
		readonly failureStage:'transport'|'provider_response'|'invalid_response',
		readonly httpStatus:number|null,
		readonly underlyingErrorType:string|null=null,
	){
		super(message);
		this.name='TwilioVerifyProviderError';
	}
}

function twilioAuthorization(accountSid:string,authToken:string){
	return `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`;
}

export async function sendTwilioVerificationCode(phone:string){
	const config=getServerConfiguration().verification;
	if(!config.twilioConfigured)throw new Error('PHONE_VERIFICATION_DELIVERY_UNAVAILABLE');
	let response:Response;
	try{
		response=await fetch(`https://verify.twilio.com/v2/Services/${config.twilioVerifyServiceSid}/Verifications`,{
			method:'POST',
			headers:{authorization:twilioAuthorization(config.twilioAccountSid,config.twilioAuthToken),'content-type':'application/x-www-form-urlencoded'},
			body:new URLSearchParams({To:phone,Channel:'sms'}),
			signal:AbortSignal.timeout(8000),
			redirect:'error',
		});
	}catch(error){
		throw new TwilioVerifyProviderError('PHONE_VERIFICATION_PROVIDER_UNAVAILABLE','transport',null,error instanceof Error?error.name:'UnknownError');
	}
	const result=await response.json().catch(()=>null) as {sid?:unknown;status?:unknown}|null;
	if(!response.ok)throw new TwilioVerifyProviderError('PHONE_VERIFICATION_PROVIDER_FAILED','provider_response',response.status);
	if(typeof result?.sid!=='string'||!/^VE[0-9a-f]{32}$/i.test(result.sid)||result.status!=='pending'){
		throw new TwilioVerifyProviderError('PHONE_VERIFICATION_PROVIDER_FAILED','invalid_response',response.status);
	}
	return 'TWILIO';
}

export async function verifyTwilioVerificationCode(phone:string,code:string){
	const config=getServerConfiguration().verification;
	if(!config.twilioConfigured)throw new Error('PHONE_VERIFICATION_DELIVERY_UNAVAILABLE');
	let response:Response;
	try{
		response=await fetch(`https://verify.twilio.com/v2/Services/${config.twilioVerifyServiceSid}/VerificationCheck`,{
			method:'POST',
			headers:{authorization:twilioAuthorization(config.twilioAccountSid,config.twilioAuthToken),'content-type':'application/x-www-form-urlencoded'},
			body:new URLSearchParams({To:phone,Code:code}),
			signal:AbortSignal.timeout(8000),
			redirect:'error',
		});
	}catch(error){
		throw new TwilioVerifyProviderError('PHONE_VERIFICATION_PROVIDER_UNAVAILABLE','transport',null,error instanceof Error?error.name:'UnknownError');
	}
	const result=await response.json().catch(()=>null) as {status?:unknown}|null;
	if(!response.ok)throw new TwilioVerifyProviderError('PHONE_VERIFICATION_PROVIDER_FAILED','provider_response',response.status);
	if(typeof result?.status!=='string'||!['approved','pending','canceled','max_attempts_reached','expired','failed','deleted'].includes(result.status)){
		throw new TwilioVerifyProviderError('PHONE_VERIFICATION_PROVIDER_FAILED','invalid_response',response.status);
	}
	return result.status==='approved';
}

export async function sendTermiiVerificationToken(phone:string){
	const config=getServerConfiguration().verification;
	if(!config.termiiConfigured)throw new Error('PHONE_VERIFICATION_DELIVERY_UNAVAILABLE');
	let response:Response;
	try{
		response=await fetch(`${config.termiiBaseUrl}/api/sms/otp/send`,{
			method:'POST',
			headers:{'content-type':'application/json'},
			body:JSON.stringify({
				api_key:config.termiiApiKey,
				message_type:'NUMERIC',
				to:phone,
				from:config.termiiSenderId,
				channel:'generic',
				pin_attempts:verificationConfig.maxAttempts,
				pin_time_to_live:verificationConfig.expiresInMinutes,
				pin_length:6,
				pin_type:'NUMERIC',
				pin_placeholder:'< 123456 >',
				message:'Your Aurevia Exchange phone verification code is < 123456 >.',
			}),
			signal:AbortSignal.timeout(8000),
			redirect:'error',
		});
	}catch(error){
		throw new TermiiProviderError('PHONE_VERIFICATION_PROVIDER_UNAVAILABLE','transport',null,error instanceof Error?error.name:'UnknownError');
	}
	const result=await response.json().catch(()=>null) as {pin_id?:unknown}|null;
	if(!response.ok)throw new TermiiProviderError('PHONE_VERIFICATION_PROVIDER_FAILED','provider_response',response.status);
	if(typeof result?.pin_id!=='string'||!result.pin_id)throw new TermiiProviderError('PHONE_VERIFICATION_PROVIDER_FAILED','invalid_response',response.status);
	return result.pin_id;
}

export async function verifyTermiiVerificationToken(pinId:string,code:string){
	const config=getServerConfiguration().verification;
	if(!config.termiiConfigured)throw new Error('PHONE_VERIFICATION_DELIVERY_UNAVAILABLE');
	const response=await fetch(`${config.termiiBaseUrl}/api/sms/otp/verify`,{
		method:'POST',
		headers:{'content-type':'application/json'},
		body:JSON.stringify({api_key:config.termiiApiKey,pin_id:pinId,pin:code}),
		signal:AbortSignal.timeout(8000),
		redirect:'error',
	});
	const result=await response.json().catch(()=>null) as {verified?:unknown}|null;
	if(!response.ok||!result||!['true','false'].includes(String(result.verified).toLowerCase()))throw new Error('PHONE_VERIFICATION_PROVIDER_FAILED');
	return String(result.verified).toLowerCase()==='true';
}
