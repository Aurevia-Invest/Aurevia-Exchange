import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	userFindUnique:vi.fn(),
	transaction:vi.fn(),
	createAccount:vi.fn(),
	verifyTurnstile:vi.fn(),
	trustedProxyClientIp:vi.fn(),
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
	user:{findUnique:mocks.userFindUnique},
	$transaction:mocks.transaction,
}}));
vi.mock('@/lib/rate-limit',()=>({rateLimit:mocks.rateLimit,RateLimitError:mocks.RateLimitError}));
vi.mock('@/lib/request-ip',()=>({trustedProxyClientIp:mocks.trustedProxyClientIp}));
vi.mock('@/lib/registration-attempt',()=>({createImmediateRegistration:mocks.createAccount}));
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

function request(body:unknown=payload,requestId?:string){
	return new Request('https://aurevia.test/api/register',{
		method:'POST',
		headers:{
			'content-type':'application/json',
			'x-forwarded-for':'192.0.2.5',
			...(requestId?{'x-aurevia-request-id':requestId}:{}),
		},
		body:JSON.stringify(body),
	});
}

describe('immediate registration',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		mocks.verifyTurnstile.mockResolvedValue(true);
		mocks.userFindUnique.mockResolvedValue(null);
		mocks.trustedProxyClientIp.mockReturnValue('192.0.2.5');
		mocks.rateLimit.mockReturnValue(undefined);
		mocks.createAccount.mockResolvedValue({id:'user-1'});
		mocks.transaction.mockImplementation(async(callback:(tx:unknown)=>Promise<unknown>)=>callback({}));
	});

	afterEach(()=>vi.unstubAllEnvs());

	it('creates an active account after server-side Turnstile validation without an OTP',async()=>{
		const response=await POST(request(payload,'e75c6069-6dc9-4de5-8a58-e8257d8f8e03'));
		const body=await response.json();

		expect(response.status).toBe(201);
		expect(body).toMatchObject({created:true,email:payload.email,message:'Your account has been created. Signing you in…'});
		expect(body).not.toHaveProperty('verificationRequired');
		expect(JSON.stringify(body)).not.toContain(payload.password);
		expect(mocks.verifyTurnstile).toHaveBeenCalledWith(payload.captchaToken,'e75c6069-6dc9-4de5-8a58-e8257d8f8e03');
		expect(mocks.createAccount).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({
			email:payload.email,
			passwordHash:expect.any(String),
			name:payload.name,
			phone:payload.phone,
			accountMode:'DEMO',
			dateOfBirth:new Date('1990-01-01T00:00:00.000Z'),
			termsAcceptedAt:expect.any(Date),
		}));
		expect(mocks.createAccount.mock.calls[0][1].passwordHash).not.toBe(payload.password);
		expect(response.headers.get('set-cookie')).toBeNull();
		expect(mocks.rateLimit).toHaveBeenCalledWith('register:192.0.2.5',5,3_600_000);
	});

	it('fails closed on a rejected Turnstile challenge without touching account data',async()=>{
		mocks.verifyTurnstile.mockResolvedValue(false);
		const response=await POST(request());

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({code:'REGISTRATION_SECURITY_REJECTED'});
		expect(mocks.userFindUnique).not.toHaveBeenCalled();
		expect(mocks.transaction).not.toHaveBeenCalled();
		expect(mocks.createAccount).not.toHaveBeenCalled();
	});

	it('returns a service error when Turnstile cannot be validated',async()=>{
		mocks.verifyTurnstile.mockRejectedValue(new Error('TURNSTILE_PROVIDER_UNAVAILABLE'));
		const warning=vi.spyOn(console,'warn').mockImplementation(()=>undefined);

		const response=await POST(request());

		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({code:'REGISTRATION_SECURITY_UNAVAILABLE'});
		expect(mocks.userFindUnique).not.toHaveBeenCalled();
		expect(mocks.createAccount).not.toHaveBeenCalled();
		expect(warning).toHaveBeenCalledOnce();
		warning.mockRestore();
	});

	it('does not replace an existing account',async()=>{
		mocks.userFindUnique.mockResolvedValue({id:'existing-user'});
		const response=await POST(request());

		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({code:'ACCOUNT_ALREADY_EXISTS'});
		expect(mocks.createAccount).not.toHaveBeenCalled();
		expect(mocks.transaction).not.toHaveBeenCalled();
	});

	it('maps a phone number collision to a safe user-facing error',async()=>{
		mocks.createAccount.mockRejectedValue(new Error('REGISTRATION_PHONE_ALREADY_IN_USE'));
		const response=await POST(request());

		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({code:'PHONE_ALREADY_IN_USE'});
	});

	it('rejects invalid international phone numbers before persisting data',async()=>{
		const response=await POST(request({...payload,phone:'2025550123'}));

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({error:'Enter a valid phone number in international format.'});
		expect(mocks.createAccount).not.toHaveBeenCalled();
	});

	it('returns Retry-After when a registration quota is exhausted',async()=>{
		mocks.rateLimit.mockImplementationOnce(()=>{throw new mocks.RateLimitError(73)});
		const response=await POST(request());

		expect(response.status).toBe(429);
		expect(response.headers.get('retry-after')).toBe('73');
		expect(mocks.createAccount).not.toHaveBeenCalled();
	});
});
