import {randomInt,createHmac,timingSafeEqual} from 'node:crypto';
import {VerificationChannel} from '@prisma/client';
import {verificationConfig} from './config';
import {getServerConfiguration} from './config/env';
import {isEmailConfigured,sendEmail} from './email';
import {renderAureviaEmail} from './email-template';

type Contact={email:string;phone:string|null;name:string|null};
type VerificationDeliveryFailure={
	provider:'smtp'|'resend'|'configured-email-api'|'none';
	reason:'unsupported-channel'|'missing-email'|'invalid-registration-token'|'invalid-url'|'provider-not-configured'|'failed'|'timeout'|'network-error'|'provider-rejected';
	httpStatus?:number;
	providerCode?:string;
};
type VerificationDeliveryOptions={
	registrationToken?:string;
	onFailure?:(failure:VerificationDeliveryFailure)=>void;
};

function legacyProvider(channel:VerificationChannel){
	const config=getServerConfiguration();
	const url=channel===VerificationChannel.EMAIL?config.verification.emailApiUrl:config.verification.smsApiUrl;
	const key=channel===VerificationChannel.EMAIL?config.verification.emailApiKey:config.verification.smsApiKey;
	if(!url||!key)return null;
	try{
		const parsed=new URL(url);
		const host=parsed.hostname.replace(/^\[|\]$/g,'').toLowerCase();
		const isLoopback=['localhost','127.0.0.1','::1'].includes(host);
		const localTestHttp=parsed.protocol==='http:'&&isLoopback&&process.env.AUREVIA_E2E_ALLOW_HTTP_PROVIDER==='1';
		if((parsed.protocol!=='https:'&&!localTestHttp)||parsed.username||parsed.password)return null;
		return {url:parsed.toString(),key};
	}catch{
		return null;
	}
}

function providerErrorCode(value:unknown){
	if(typeof value!=='object'||value===null||Array.isArray(value))return undefined;
	const record=value as Record<string,unknown>;
	const nested=typeof record.error==='object'&&record.error!==null&&!Array.isArray(record.error)
		?record.error as Record<string,unknown>
		:null;
	const candidate=record.code??record.errorCode??record.error_code
		??nested?.code??nested?.errorCode??nested?.error_code;
	if(typeof candidate!=='string'||!/^[A-Za-z][A-Za-z0-9_.-]{1,63}$/.test(candidate))return undefined;
	return candidate.toUpperCase();
}

export function hasConfiguredVerificationProvider(channel?:VerificationChannel){
	const emailConfigured=isEmailConfigured()||Boolean(legacyProvider(VerificationChannel.EMAIL));
	const smsConfigured=hasConfiguredTermii()||Boolean(legacyProvider(VerificationChannel.SMS));
	return channel===VerificationChannel.EMAIL?emailConfigured:channel===VerificationChannel.SMS?smsConfigured:emailConfigured||smsConfigured;
}

export function hasConfiguredTermii(){
	const config=getServerConfiguration().verification;
	return Boolean(config.termiiApiKey&&config.termiiSenderId);
}

export function availableVerificationChannel(phone:string|null){
	if(hasConfiguredVerificationProvider(VerificationChannel.EMAIL))return VerificationChannel.EMAIL;
	if(phone&&hasConfiguredVerificationProvider(VerificationChannel.SMS))return VerificationChannel.SMS;
	return null;
}

export function registrationVerificationChannel(){
	return hasConfiguredVerificationProvider(VerificationChannel.EMAIL)?VerificationChannel.EMAIL:null;
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

export async function deliverVerificationCode(channel:VerificationChannel,contact:Contact,code:string,options:VerificationDeliveryOptions={}){
	if(channel!==VerificationChannel.EMAIL){
		options.onFailure?.({provider:'none',reason:'unsupported-channel'});
		return false;
	}
	const config=getServerConfiguration().verification;
	if(!contact.email){
		options.onFailure?.({provider:'none',reason:'missing-email'});
		return false;
	}
	const subject='Verify your Aurevia Exchange account';
	let text:string;
	let html:string;
	try{
		const verificationUrl=new URL('/verify-email',config.appUrl);
		verificationUrl.searchParams.set('email',contact.email);
		if(options.registrationToken){
			if(!/^[A-Za-z0-9_-]{40,60}$/.test(options.registrationToken)){
				options.onFailure?.({provider:'none',reason:'invalid-registration-token'});
				return false;
			}
			verificationUrl.hash=new URLSearchParams({registrationToken:options.registrationToken}).toString();
		}
		text=`Your Aurevia Exchange verification code is ${code}. This code expires in ${verificationConfig.expiresInMinutes} minutes. Do not share it with anyone.\n\nEnter it at ${verificationUrl.toString()}\n\nIf you did not request it, you can ignore this message.`;
		html=renderAureviaEmail({
			preheader:'Your Aurevia Exchange verification code.',
			title:'Verify your email address',
			paragraphs:[
				`Your Aurevia Exchange verification code is ${code}. This code expires in ${verificationConfig.expiresInMinutes} minutes. Do not share it with anyone.`,
				`Enter the code at ${verificationUrl.toString()}.`,
			],
			code,
		});
	}catch{
		options.onFailure?.({provider:'none',reason:'invalid-url'});
		return false;
	}

	if(isEmailConfigured()){
		const email=await sendEmail({
			to:contact.email,
			subject,
			text,
			html,
		});
		if(!email.sent){
			options.onFailure?.({
				provider:email.provider==='smtp'||email.provider==='resend'?email.provider:'none',
				reason:email.reason==='timeout'||email.reason==='network-error'||email.reason==='provider-rejected'
					?email.reason
					:email.reason==='not-configured'?'provider-not-configured':'failed',
				...(email.httpStatus?{httpStatus:email.httpStatus}:{}),
				...(email.providerCode?{providerCode:email.providerCode}:{}),
			});
		}
		return email.sent;
	}

	const configured=legacyProvider(channel);
	if(!configured){
		options.onFailure?.({provider:'none',reason:'provider-not-configured'});
		return false;
	}
	try{
		const response=await fetch(configured.url,{method:'POST',headers:{authorization:`Bearer ${configured.key}`,'content-type':'application/json'},body:JSON.stringify({channel:channel.toLowerCase(),to:contact.email,name:contact.name,subject,text,html}),signal:AbortSignal.timeout(8000)});
		if(!response.ok){
			const body=await response.clone().json().catch(()=>null) as unknown;
			options.onFailure?.({provider:'configured-email-api',reason:'provider-rejected',httpStatus:response.status,providerCode:providerErrorCode(body)});
		}
		return response.ok;
	}catch(error){
		options.onFailure?.({
			provider:'configured-email-api',
			reason:error instanceof Error&&error.name==='TimeoutError'?'timeout':'network-error',
		});
		return false;
	}
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
