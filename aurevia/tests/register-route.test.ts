import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {Prisma} from '@prisma/client';

const mocks=vi.hoisted(()=>({
	userFindUnique:vi.fn(),
	userFindFirst:vi.fn(),
	attemptCreate:vi.fn(),
	attemptFindUnique:vi.fn(),
	attemptFindFirst:vi.fn(),
	attemptDeleteMany:vi.fn(),
	attemptUpdateMany:vi.fn(),
	verificationDeleteMany:vi.fn(),
	cleanupExpiredRegistrationAttempts:vi.fn(),
	akedlyConfigured:vi.fn(),
	akedlyReadiness:vi.fn(),
	verifyTurnstile:vi.fn(),
	rateLimit:vi.fn(),
	RateLimitError:class extends Error{
		readonly retryAfterSeconds:number;
		constructor(retryAfterSeconds:number){
			super('RATE_LIMITED');
			this.retryAfterSeconds=retryAfterSeconds;
		}
	},
}));

vi.mock('@/lib/db',()=>({db:{
	user:{findUnique:mocks.userFindUnique,findFirst:mocks.userFindFirst},
	registrationAttempt:{
		create:mocks.attemptCreate,
		findUnique:mocks.attemptFindUnique,
		findFirst:mocks.attemptFindFirst,
		deleteMany:mocks.attemptDeleteMany,
		updateMany:mocks.attemptUpdateMany,
	},
	registrationVerification:{deleteMany:mocks.verificationDeleteMany},
}}));
vi.mock('@/lib/rate-limit',()=>({rateLimit:mocks.rateLimit,RateLimitError:mocks.RateLimitError}));
vi.mock('@/lib/registration-cleanup',()=>({
	cleanupExpiredRegistrationAttempts:mocks.cleanupExpiredRegistrationAttempts,
}));
vi.mock('@/lib/akedly',()=>({
	akedlyIsConfigured:mocks.akedlyConfigured,
	akedlyReadiness:mocks.akedlyReadiness,
}));
vi.mock('@/lib/turnstile',()=>({verifyRegistrationTurnstile:mocks.verifyTurnstile}));

import {POST} from '@/app/api/register/route';

const payload={
	email:'new-user@example.invalid',
	password:'SecureTestPassword1',
	name:'New User',
	country:'United States',
	dateOfBirth:'1990-01-01',
	phone:'+12025550123',
	accountMode:'DEMO',
	termsAccepted:true,
	captchaToken:'verified-turnstile-token',
};

function request(body:unknown=payload,forwardedFor='192.0.2.5',requestId?:string){
	return new Request('https://aurevia.test/api/register',{
		method:'POST',
		headers:{
			'content-type':'application/json',
			'x-forwarded-for':forwardedFor,
			...(requestId?{'x-aurevia-request-id':requestId}:{}),
		},
		body:JSON.stringify(body),
	});
}

describe('registration privacy boundary',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		mocks.akedlyConfigured.mockReturnValue(true);
		mocks.akedlyReadiness.mockReturnValue({enabled:true,missing:[],ready:true});
		mocks.verifyTurnstile.mockResolvedValue(true);
		mocks.userFindUnique.mockResolvedValue(null);
		mocks.userFindFirst.mockResolvedValue(null);
		mocks.attemptCreate.mockImplementation(async({data}:{data:Record<string,unknown>})=>({email:data.email}));
		mocks.attemptFindUnique.mockResolvedValue(null);
		mocks.attemptFindFirst.mockResolvedValue(null);
		mocks.attemptDeleteMany.mockResolvedValue({count:1});
		mocks.attemptUpdateMany.mockResolvedValue({count:1});
		mocks.verificationDeleteMany.mockResolvedValue({count:1});
		mocks.cleanupExpiredRegistrationAttempts.mockResolvedValue({count:0});
	});

	afterEach(()=>vi.unstubAllEnvs());

	it('stores only a short-lived registration attempt until phone verification',async()=>{
		const response=await POST(request());
		const body=await response.json();

		expect(response.status).toBe(201);
		expect(body).toMatchObject({verificationRequired:true,email:payload.email,requestId:expect.stringMatching(/^[0-9a-f-]{36}$/i)});
		expect(JSON.stringify(body)).not.toContain(payload.password);
		expect(mocks.attemptCreate).toHaveBeenCalledWith(expect.objectContaining({
			data:expect.objectContaining({
				email:payload.email,
				passwordHash:expect.any(String),
				phone:payload.phone,
				expiresAt:expect.any(Date),
				tokenHash:expect.any(String),
			}),
		}));
		expect(mocks.attemptCreate.mock.calls[0][0].data).not.toHaveProperty('aureviaExchangeId');
		expect(mocks.attemptCreate.mock.calls[0][0].data.passwordHash).not.toBe(payload.password);
		expect(mocks.userFindUnique).toHaveBeenCalledWith({
			where:{email:payload.email},
			select:{
				role:true,
				status:true,
				emailVerifiedAt:true,
				verifiedChannel:true,
				phoneVerified:true,
				phoneVerifiedAt:true,
				requiresRegistrationVerification:true,
			},
		});
		expect(response.headers.get('set-cookie')).toContain('HttpOnly');
		expect(response.headers.get('set-cookie')).toContain('SameSite=lax');
		expect(response.headers.get('cache-control')).toBe('no-store');
	});

	it('fails closed on CAPTCHA and does not persist registration data',async()=>{
		mocks.verifyTurnstile.mockResolvedValue(false);
		const requestId='e75c6069-6dc9-4de5-8a58-e8257d8f8e03';
		const response=await POST(request(payload,'192.0.2.5',requestId));
		const body=await response.json();

		expect(response.status).toBe(400);
		expect(body).toMatchObject({
			code:'REGISTRATION_SECURITY_REJECTED',
			requestId,
			referenceId:requestId,
		});
		expect(mocks.verifyTurnstile).toHaveBeenCalledWith(payload.captchaToken,requestId);
		expect(mocks.rateLimit.mock.calls).toEqual([
			['register-captcha-ip:192.0.2.5',10,600_000],
			['register-captcha-email:new-user@example.invalid',5,600_000],
		]);
		expect(mocks.attemptCreate).not.toHaveBeenCalled();
		expect(mocks.userFindUnique).not.toHaveBeenCalled();
	});

	it('counts registration quotas only after server-side CAPTCHA succeeds',async()=>{
		await POST(request());

		expect(mocks.rateLimit.mock.calls).toEqual([
			['register:192.0.2.5',5,3_600_000],
			['register-email:new-user@example.invalid',3,3_600_000],
		]);
	});

	it('uses the trusted proxy client address rather than the untrusted leading forwarded value',async()=>{
		await POST(request(payload,'203.0.113.99, 198.51.100.24'));

		expect(mocks.rateLimit).toHaveBeenCalledWith('register:198.51.100.24',5,3_600_000);
	});

	it('returns a Retry-After value when registration quota is exhausted',async()=>{
		mocks.rateLimit.mockImplementationOnce(()=>{throw new mocks.RateLimitError(73)});
		const response=await POST(request());

		expect(response.status).toBe(429);
		expect(response.headers.get('retry-after')).toBe('73');
		expect(await response.json()).toMatchObject({retryAfterSeconds:73});
		expect(mocks.attemptCreate).not.toHaveBeenCalled();
	});

	it('rejects a missing CAPTCHA token before checking accounts or storing registration data',async()=>{
		const {captchaToken:_captchaToken,...payloadWithoutCaptcha}=payload;
		const response=await POST(request(payloadWithoutCaptcha));

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({error:'Complete the registration security check and try again.'});
		expect(mocks.verifyTurnstile).not.toHaveBeenCalled();
		expect(mocks.userFindUnique).not.toHaveBeenCalled();
		expect(mocks.attemptCreate).not.toHaveBeenCalled();
	});

	it('does not retain personal details if Akedly phone verification is not configured',async()=>{
		mocks.akedlyReadiness.mockReturnValue({enabled:false,missing:['AKEDLY_ENABLED=true'],ready:false});
		const warning=vi.spyOn(console,'error').mockImplementation(()=>undefined);
		const response=await POST(request());
		const body=await response.json();

		expect(response.status).toBe(503);
		expect(body).toMatchObject({
			code:'PHONE_VERIFICATION_UNAVAILABLE',
			error:'Phone verification is temporarily unavailable because the verification service is not ready. Your details were not saved; please try again later or contact support.',
			requestId:expect.any(String),
			referenceId:expect.any(String),
			diagnostics:{integrationEnabled:false,missingConfiguration:['AKEDLY_ENABLED=true']},
		});
		expect(body.referenceId).toBe(body.requestId);
		expect(warning).toHaveBeenCalledWith(
			`[registration] AKEDLY_NOT_READY referenceId=${body.referenceId} endpoint=/api/register`,
			expect.objectContaining({
				requestId:body.referenceId,
				referenceId:body.referenceId,
				endpoint:'/api/register',
				failureCode:'AKEDLY_NOT_READY',
				providerCode:'AKEDLY_NOT_READY',
				providerEndpoint:null,
				providerAttemptId:null,
				providerHttpStatus:null,
				failureTimestamp:expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
				enabled:false,
				missing:['AKEDLY_ENABLED=true'],
			}),
		);
		expect(mocks.attemptCreate).not.toHaveBeenCalled();
		warning.mockRestore();
	});

	it('allows registration to recover after Akedly readiness is restored',async()=>{
		mocks.akedlyReadiness.mockReturnValue({enabled:false,missing:['AKEDLY_ENABLED'],ready:false});
		const warning=vi.spyOn(console,'warn').mockImplementation(()=>undefined);
		const unavailable=await POST(request());

		expect(unavailable.status).toBe(503);
		expect(mocks.attemptCreate).not.toHaveBeenCalled();
		expect(mocks.rateLimit).toHaveBeenCalledWith('register:192.0.2.5',5,3_600_000);
		expect(mocks.rateLimit).toHaveBeenCalledWith('register-email:new-user@example.invalid',3,3_600_000);

		mocks.akedlyReadiness.mockReturnValue({enabled:true,missing:[],ready:true});
		const recovered=await POST(request());

		expect(recovered.status).toBe(201);
		expect(mocks.attemptCreate).toHaveBeenCalledTimes(1);
		expect(mocks.verifyTurnstile).toHaveBeenCalledTimes(2);
		warning.mockRestore();
	});

	it('rejects a missing phone number before creating a temporary registration',async()=>{
		const {phone:_phone,...withoutPhone}=payload;
		const response=await POST(request(withoutPhone));

		expect(response.status).toBe(400);
		expect(mocks.attemptCreate).not.toHaveBeenCalled();
	});

	it('does not persist details when server-side CAPTCHA verification is unavailable',async()=>{
		mocks.verifyTurnstile.mockRejectedValue(new Error('TURNSTILE_PROVIDER_UNAVAILABLE'));
		const requestId='8f9bdc70-c3f2-4e1f-b28b-e4e0896cd3e2';
		const warning=vi.spyOn(console,'warn').mockImplementation(()=>undefined);
		const response=await POST(request(payload,'192.0.2.5',requestId));
		const body=await response.json();

		expect(response.status).toBe(503);
		expect(body).toMatchObject({
			code:'REGISTRATION_SECURITY_UNAVAILABLE',
			requestId,
			referenceId:requestId,
		});
		expect(warning).toHaveBeenCalledWith('Registration Turnstile verification is unavailable.',expect.objectContaining({
			requestId,
			referenceId:requestId,
			endpoint:'https://challenges.cloudflare.com/turnstile/v0/siteverify',
			errorCode:'TURNSTILE_PROVIDER_UNAVAILABLE',
			failureTimestamp:expect.any(String),
		}));
		expect(mocks.attemptCreate).not.toHaveBeenCalled();
		warning.mockRestore();
	});

	it('recovers a concurrent pending-attempt collision when the submitted password matches',async()=>{
		const {hash}=await import('bcryptjs');
		const passwordHash=await hash(payload.password,4);
		mocks.attemptCreate.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('unique constraint',{
			code:'P2002',
			clientVersion:'test',
		}));
		mocks.attemptFindUnique
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce({
				id:'pending-registration',
				email:payload.email,
				passwordHash,
				tokenHash:'old-token-hash',
				expiresAt:new Date(Date.now()+60_000),
				verification:null,
			});
		const response=await POST(request());

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({verificationRequired:true,email:payload.email});
		expect(mocks.attemptUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
			where:{id:'pending-registration',tokenHash:'old-token-hash',expiresAt:{gt:expect.any(Date)}},
		}));
		expect(response.headers.get('set-cookie')).toContain('HttpOnly');
		expect(mocks.attemptCreate).toHaveBeenCalledOnce();
	});

	it('offers sign-in and password recovery for an existing verified user without changing it',async()=>{
		mocks.userFindUnique.mockResolvedValue({
			id:'existing-user',
			email:payload.email,
			role:'USER',
			status:'ACTIVE',
			emailVerifiedAt:new Date(),
			requiresRegistrationVerification:false,
		});
		const response=await POST(request());

		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({code:'ACCOUNT_ALREADY_VERIFIED'});
		expect(mocks.attemptCreate).not.toHaveBeenCalled();
		expect(mocks.userFindUnique).toHaveBeenCalledOnce();
	});

	it('routes an existing administrator account to sign-in without treating it as an unverified registration',async()=>{
		mocks.userFindUnique.mockResolvedValue({
			id:'existing-administrator',
			role:'ADMIN',
			status:'ACTIVE',
			emailVerifiedAt:null,
			verifiedChannel:null,
			phoneVerified:false,
			phoneVerifiedAt:null,
			requiresRegistrationVerification:false,
		});
		const log=vi.spyOn(console,'info').mockImplementation(()=>undefined);
		const requestId='fc8e8788-217a-4e03-bf88-476426ff1159';
		const response=await POST(request(payload,'192.0.2.5',requestId));
		const body=await response.json();

		expect(response.status).toBe(409);
		expect(body).toMatchObject({
			code:'ACCOUNT_ALREADY_EXISTS',
			requestId,
			referenceId:requestId,
			error:'An account already uses this email. Sign in with the existing account or contact support for access help.',
		});
		expect(log).toHaveBeenCalledWith('[registration] Existing account matched registration request.',expect.objectContaining({
			requestId,
			accountState:'administrator',
		}));
		expect(JSON.stringify(log.mock.calls)).not.toContain(payload.email);
		expect(mocks.attemptCreate).not.toHaveBeenCalled();
		log.mockRestore();
	});

	it('recognizes an existing phone-verified account even when email verification is not used',async()=>{
		mocks.userFindUnique.mockResolvedValue({
			id:'phone-verified-user',
			role:'USER',
			status:'ACTIVE',
			emailVerifiedAt:null,
			verifiedChannel:'SMS',
			phoneVerified:true,
			phoneVerifiedAt:new Date(),
			requiresRegistrationVerification:false,
		});
		const log=vi.spyOn(console,'info').mockImplementation(()=>undefined);
		const requestId='fc8e8788-217a-4e03-bf88-476426ff1159';
		const response=await POST(request(payload,'192.0.2.5',requestId));
		const body=await response.json();

		expect(response.status).toBe(409);
		expect(body).toMatchObject({
			code:'ACCOUNT_ALREADY_VERIFIED',
			requestId,
			referenceId:requestId,
			error:'An account already uses this email. Sign in or reset its password to recover access.',
		});
		expect(mocks.attemptCreate).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledWith('[registration] Existing account matched registration request.',expect.objectContaining({
			requestId,
			accountState:'verified',
			verifiedChannel:'SMS',
			emailVerified:false,
			phoneVerified:true,
		}));
		expect(JSON.stringify(log.mock.calls)).not.toContain(payload.email);
		log.mockRestore();
	});

	it('does not offer sign-in recovery for an existing account with no verification proof',async()=>{
		mocks.userFindUnique.mockResolvedValue({
			id:'incomplete-user',
			role:'USER',
			status:'ACTIVE',
			emailVerifiedAt:null,
			verifiedChannel:null,
			phoneVerified:false,
			phoneVerifiedAt:null,
			requiresRegistrationVerification:false,
		});
		const response=await POST(request());

		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			code:'ACCOUNT_VERIFICATION_INCOMPLETE',
			error:'An existing account has not completed registration verification. Sign-in is unavailable; contact support to recover this account safely.',
		});
		expect(mocks.attemptCreate).not.toHaveBeenCalled();
	});

	it('does not classify a phone-verified account with a stale registration gate as sign-in ready',async()=>{
		mocks.userFindUnique.mockResolvedValue({
			id:'phone-verified-but-gated-user',
			role:'USER',
			status:'ACTIVE',
			emailVerifiedAt:null,
			verifiedChannel:'SMS',
			phoneVerified:true,
			phoneVerifiedAt:new Date(),
			requiresRegistrationVerification:true,
		});
		const response=await POST(request());

		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({code:'ACCOUNT_VERIFICATION_INCOMPLETE'});
		expect(mocks.attemptCreate).not.toHaveBeenCalled();
	});

	it('routes an existing active unverified user to the existing verification flow',async()=>{
		mocks.userFindUnique.mockResolvedValue({
			id:'pending-user',
			role:'USER',
			status:'ACTIVE',
			emailVerifiedAt:null,
			requiresRegistrationVerification:true,
		});
		const response=await POST(request());

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({existingVerification:true,verificationRequired:true,email:payload.email});
		expect(mocks.attemptCreate).not.toHaveBeenCalled();
	});

	it.each(['FROZEN','CLOSED'] as const)('does not reactivate an existing %s account',async status=>{
		mocks.userFindUnique.mockResolvedValue({
			id:'existing-user',
			role:'USER',
			status,
			emailVerifiedAt:new Date(),
			requiresRegistrationVerification:false,
		});
		const response=await POST(request());

		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({code:'ACCOUNT_UNAVAILABLE'});
		expect(mocks.attemptCreate).not.toHaveBeenCalled();
	});

	it('resumes a matching temporary registration by its original password',async()=>{
		const {hash}=await import('bcryptjs');
		const passwordHash=await hash(payload.password,4);
		mocks.attemptFindUnique.mockResolvedValue({
			id:'pending-registration',
			email:payload.email,
			passwordHash,
			tokenHash:'old-token-hash',
			expiresAt:new Date(Date.now()+60_000),
			verification:null,
		});
		const response=await POST(request());

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({verificationRequired:true,email:payload.email});
		expect(mocks.attemptCreate).not.toHaveBeenCalled();
		expect(mocks.attemptUpdateMany).toHaveBeenCalledOnce();
		expect(response.headers.get('set-cookie')).toContain('HttpOnly');
	});

	it('does not replace a pending registration password when the supplied password differs',async()=>{
		mocks.attemptFindUnique.mockResolvedValue({
			id:'pending-registration',
			email:payload.email,
			passwordHash:'not-a-matching-hash',
			tokenHash:'old-token-hash',
			expiresAt:new Date(Date.now()+60_000),
			verification:null,
		});
		const response=await POST(request());

		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({code:'REGISTRATION_IN_PROGRESS'});
		expect(mocks.attemptCreate).not.toHaveBeenCalled();
		expect(mocks.attemptUpdateMany).not.toHaveBeenCalled();
	});

	it('removes expired pending personal data before starting a replacement attempt',async()=>{
		mocks.attemptFindUnique.mockResolvedValue({
			id:'expired-registration',
			email:payload.email,
			passwordHash:'expired-hash',
			tokenHash:'expired-token-hash',
			expiresAt:new Date(Date.now()-1000),
			verification:null,
		});
		const response=await POST(request());

		expect(response.status).toBe(201);
		expect(mocks.attemptDeleteMany).toHaveBeenCalledWith({
			where:{id:'expired-registration',expiresAt:{lte:expect.any(Date)}},
		});
		expect(mocks.attemptCreate).toHaveBeenCalledOnce();
	});

	it('rejects a phone number already assigned to another user',async()=>{
		mocks.userFindFirst.mockResolvedValue({id:'another-user'});
		const response=await POST(request({...payload,phone:'+12025550123'}));

		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({code:'PHONE_ALREADY_IN_USE'});
		expect(mocks.attemptCreate).not.toHaveBeenCalled();
	});
});
