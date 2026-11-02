import {randomUUID} from 'node:crypto';
import {getServerConfiguration} from '@/lib/config/env';

type TurnstileResponse={success?:unknown;action?:unknown};

export async function verifyRegistrationTurnstile(token:string){
	const secret=getServerConfiguration().captcha.turnstileSecretKey;
	if(!secret)throw new Error('TURNSTILE_NOT_CONFIGURED');

	let response:Response;
	try{
		response=await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify',{
			method:'POST',
			headers:{'content-type':'application/x-www-form-urlencoded'},
			body:new URLSearchParams({secret,response:token,idempotency_key:randomUUID()}),
			signal:AbortSignal.timeout(5000),
			redirect:'error',
		});
	}catch{
		throw new Error('TURNSTILE_PROVIDER_UNAVAILABLE');
	}

	if(!response.ok)throw new Error('TURNSTILE_PROVIDER_UNAVAILABLE');
	const result=await response.json().catch(()=>null) as TurnstileResponse|null;
	if(!result)return false;
	return result.success===true&&result.action==='register';
}
