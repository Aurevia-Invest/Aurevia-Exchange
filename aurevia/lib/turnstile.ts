import {randomUUID} from 'node:crypto';
import {getServerConfiguration} from '@/lib/config/env';

type TurnstileResponse={success?:unknown;action?:unknown;hostname?:unknown};

const RENDER_PRODUCTION_HOSTNAME='aurevia-exchange-6hfi.onrender.com';

function configuredTurnstileHostnames(primaryAppUrl:string){
	const hostnames=new Set([RENDER_PRODUCTION_HOSTNAME]);
	for(const value of [
		primaryAppUrl,
		process.env.NEXT_PUBLIC_APP_URL,
		process.env.NEXTAUTH_URL,
		process.env.RENDER_EXTERNAL_URL,
	]){
		if(!value)continue;
		try{
			const url=new URL(value);
			if(['https:','http:'].includes(url.protocol)&&!url.username&&!url.password){
				hostnames.add(url.hostname.toLowerCase());
			}
		}catch{
			continue;
		}
	}
	return hostnames;
}

export async function verifyRegistrationTurnstile(token:string){
	const config=getServerConfiguration();
	const {turnstileSiteKey,turnstileSecretKey}=config.captcha;
	if(!turnstileSiteKey||!turnstileSecretKey)throw new Error('TURNSTILE_NOT_CONFIGURED');
	let allowedHostnames:Set<string>;
	try{
		const appUrl=new URL(config.app.url);
		if(!['https:','http:'].includes(appUrl.protocol)||appUrl.username||appUrl.password)throw new Error('INVALID_APP_URL');
		allowedHostnames=configuredTurnstileHostnames(config.app.url);
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
		&&allowedHostnames.has(result.hostname.toLowerCase());
}
