import {randomUUID} from 'node:crypto';
import {getServerConfiguration} from '@/lib/config/env';

type TurnstileResponse={success?:unknown;action?:unknown;hostname?:unknown};

export async function verifyRegistrationTurnstile(token:string){
	const config=getServerConfiguration();
	const {turnstileSiteKey,turnstileSecretKey}=config.captcha;
	if(!turnstileSiteKey||!turnstileSecretKey)throw new Error('TURNSTILE_NOT_CONFIGURED');
	let expectedHostname:string;
	try{
		expectedHostname=new URL(config.app.url).hostname.toLowerCase();
	}catch{
		throw new Error('TURNSTILE_CONFIGURATION_INVALID');
	}

	let response:Response;
	try{
		response=await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify',{
			method:'POST',
			headers:{'content-type':'application/x-www-form-urlencoded'},
			body:new URLSearchParams({secret:turnstileSecretKey,response:token,idempotency_key:randomUUID()}),
			signal:AbortSignal.timeout(5000),
			redirect:'error',
		});
	}catch{
		throw new Error('TURNSTILE_PROVIDER_UNAVAILABLE');
	}

	if(!response.ok)throw new Error('TURNSTILE_PROVIDER_UNAVAILABLE');
	const result=await response.json().catch(()=>null) as TurnstileResponse|null;
	if(!result)return false;
	return result.success===true
		&&result.action==='register'
		&&typeof result.hostname==='string'
		&&result.hostname.toLowerCase()===expectedHostname;
}
