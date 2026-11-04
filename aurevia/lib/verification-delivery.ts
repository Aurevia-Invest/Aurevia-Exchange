import {randomInt,createHmac,timingSafeEqual} from 'node:crypto';
import {verificationConfig} from './config';
import {getServerConfiguration} from './config/env';

export function hasConfiguredTermii(){
	const config=getServerConfiguration().verification;
	return Boolean(config.termiiApiKey&&config.termiiSenderId);
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

export async function sendTermiiVerificationToken(phone:string){
	const config=getServerConfiguration().verification;
	if(!config.termiiApiKey||!config.termiiSenderId)throw new Error('PHONE_VERIFICATION_DELIVERY_UNAVAILABLE');
	const response=await fetch('https://api.ng.termii.com/api/sms/otp/send',{
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
	});
	const result=await response.json().catch(()=>null) as {pin_id?:unknown}|null;
	if(!response.ok||typeof result?.pin_id!=='string'||!result.pin_id)throw new Error('PHONE_VERIFICATION_DELIVERY_FAILED');
	return result.pin_id;
}

export async function verifyTermiiVerificationToken(pinId:string,code:string){
	const apiKey=getServerConfiguration().verification.termiiApiKey;
	if(!apiKey)throw new Error('PHONE_VERIFICATION_DELIVERY_UNAVAILABLE');
	const response=await fetch('https://api.ng.termii.com/api/sms/otp/verify',{
		method:'POST',
		headers:{'content-type':'application/json'},
		body:JSON.stringify({api_key:apiKey,pin_id:pinId,pin:code}),
		signal:AbortSignal.timeout(8000),
	});
	const result=await response.json().catch(()=>null) as {verified?:unknown}|null;
	if(!response.ok||!result||!['true','false'].includes(String(result.verified).toLowerCase()))throw new Error('PHONE_VERIFICATION_PROVIDER_FAILED');
	return String(result.verified).toLowerCase()==='true';
}
