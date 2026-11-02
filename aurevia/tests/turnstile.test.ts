import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	getServerConfiguration:vi.fn(),
	fetch:vi.fn(),
}));

vi.mock('@/lib/config/env',()=>({getServerConfiguration:mocks.getServerConfiguration}));

import {verifyRegistrationTurnstile} from '@/lib/turnstile';

describe('server-side registration Turnstile verification',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		mocks.getServerConfiguration.mockReturnValue({
			app:{url:'https://aurevia.example'},
			captcha:{turnstileSiteKey:'public-site-key',turnstileSecretKey:'private-secret-key'},
		});
		vi.stubGlobal('fetch',mocks.fetch);
	});

	afterEach(()=>{
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it('accepts only a successful register action for the configured hostname',async()=>{
		mocks.fetch.mockResolvedValue(new Response(JSON.stringify({
			success:true,
			action:'register',
			hostname:'aurevia.example',
		}),{status:200}));

		await expect(verifyRegistrationTurnstile('provider-token')).resolves.toBe(true);

		const [url,init]=mocks.fetch.mock.calls[0] as [string,RequestInit];
		expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
		const body=new URLSearchParams(String(init.body));
		expect(body.get('secret')).toBe('private-secret-key');
		expect(body.get('response')).toBe('provider-token');
		expect(body.get('idempotency_key')).toBeTruthy();
		expect(init.redirect).toBe('error');
	});

	it.each([
		['invalid token', {success:false,action:'register',hostname:'aurevia.example'}],
		['expired or reused token', {success:false,action:'register',hostname:'aurevia.example','error-codes':['timeout-or-duplicate']}],
		['wrong action', {success:true,action:'login',hostname:'aurevia.example'}],
		['wrong hostname', {success:true,action:'register',hostname:'attacker.example'}],
		['missing hostname', {success:true,action:'register'}],
	])('rejects a %s',async(_name,result)=>{
		mocks.fetch.mockResolvedValue(new Response(JSON.stringify(result),{status:200}));

		await expect(verifyRegistrationTurnstile('provider-token')).resolves.toBe(false);
	});

	it('fails closed when the provider is unavailable',async()=>{
		mocks.fetch.mockRejectedValue(new Error('network failure'));

		await expect(verifyRegistrationTurnstile('provider-token')).rejects.toThrow('TURNSTILE_PROVIDER_UNAVAILABLE');
	});

	it('fails closed when the provider returns a non-success HTTP response',async()=>{
		mocks.fetch.mockResolvedValue(new Response('',{status:503}));

		await expect(verifyRegistrationTurnstile('provider-token')).rejects.toThrow('TURNSTILE_PROVIDER_UNAVAILABLE');
	});

	it('accepts the Render hostname when a configured custom domain is primary',async()=>{
		mocks.getServerConfiguration.mockReturnValue({
			app:{url:'https://exchange.example'},
			captcha:{turnstileSiteKey:'public-site-key',turnstileSecretKey:'private-secret-key'},
		});
		mocks.fetch.mockResolvedValue(new Response(JSON.stringify({
			success:true,
			action:'register',
			hostname:'aurevia-exchange-6hfi.onrender.com',
		}),{status:200}));

		await expect(verifyRegistrationTurnstile('provider-token')).resolves.toBe(true);
	});

	it('accepts an explicitly configured custom domain when the Render URL is primary',async()=>{
		vi.stubEnv('NEXT_PUBLIC_APP_URL','https://exchange.example');
		mocks.getServerConfiguration.mockReturnValue({
			app:{url:'https://aurevia-exchange-6hfi.onrender.com'},
			captcha:{turnstileSiteKey:'public-site-key',turnstileSecretKey:'private-secret-key'},
		});
		mocks.fetch.mockResolvedValue(new Response(JSON.stringify({
			success:true,
			action:'register',
			hostname:'exchange.example',
		}),{status:200}));

		await expect(verifyRegistrationTurnstile('provider-token')).resolves.toBe(true);
	});

	it.each([
		['public site key', '', 'private-secret-key'],
		['private secret', 'public-site-key', ''],
	])('requires the configured %s',async(_name,siteKey,secretKey)=>{
		mocks.getServerConfiguration.mockReturnValue({
			app:{url:'https://aurevia.example'},
			captcha:{turnstileSiteKey:siteKey,turnstileSecretKey:secretKey},
		});

		await expect(verifyRegistrationTurnstile('provider-token')).rejects.toThrow('TURNSTILE_NOT_CONFIGURED');
		expect(mocks.fetch).not.toHaveBeenCalled();
	});
});
