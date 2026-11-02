import {afterEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({getServerConfiguration:vi.fn()}));

vi.mock('@/lib/config/env',()=>({getServerConfiguration:mocks.getServerConfiguration}));

import {GET} from '@/app/api/register/security/route';

describe('registration security configuration endpoint',()=>{
	afterEach(()=>vi.clearAllMocks());

	it('serves only the public site key at runtime and disables caching',async()=>{
		mocks.getServerConfiguration.mockReturnValue({
			captcha:{
				turnstileSiteKey:'public-site-key',
				turnstileSecretKey:'private-secret-key',
				turnstileConfigured:true,
			},
		});

		const response=await GET();
		const body=await response.json();

		expect(response.status).toBe(200);
		expect(body).toEqual({available:true,siteKey:'public-site-key'});
		expect(JSON.stringify(body)).not.toContain('private-secret-key');
		expect(response.headers.get('cache-control')).toContain('no-store');
	});

	it('does not expose a site key when either Turnstile key is missing',async()=>{
		mocks.getServerConfiguration.mockReturnValue({
			captcha:{
				turnstileSiteKey:'public-site-key',
				turnstileSecretKey:'',
				turnstileConfigured:false,
			},
		});

		const response=await GET();

		expect(await response.json()).toEqual({available:false,siteKey:null});
	});
});
