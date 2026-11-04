import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {Prisma} from '@prisma/client';
import bcrypt from 'bcryptjs';

const mocks=vi.hoisted(()=>({
	userFindFirst:vi.fn(),
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
	user:{findFirst:mocks.userFindFirst},
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
		mocks.userFindFirst.mockResolvedValue(null);
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
		expect(mocks.verifyTurnstile).toHaveBeenCalledOnce();
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
		expect(mocks.userFindFirst).not.toHaveBeenCalled();
		expect(mocks.transaction).not.toHaveBeenCalled();
		expect(mocks.createAccount).not.toHaveBeenCalled();
	});

	it('returns a service error when Turnstile cannot be validated',async()=>{
		mocks.verifyTurnstile.mockRejectedValue(new Error('TURNSTILE_PROVIDER_UNAVAILABLE'));
		const warning=vi.spyOn(console,'warn').mockImplementation(()=>undefined);

		const response=await POST(request());

		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({code:'REGISTRATION_SECURITY_UNAVAILABLE'});
		expect(mocks.userFindFirst).not.toHaveBeenCalled();
		expect(mocks.createAccount).not.toHaveBeenCalled();
		expect(warning).toHaveBeenCalledOnce();
		warning.mockRestore();
	});

	it('treats a case-variant retry with the correct password as sign-in',async()=>{
		const passwordHash=await bcrypt.hash(payload.password,4);
		mocks.userFindFirst.mockResolvedValue({
			email:payload.email,
			passwordHash,
			status:'ACTIVE',
		});
		const response=await POST(request({...payload,email:'  NEW-USER@EXAMPLE.INVALID  '}));

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({created:false,accountMatched:true,email:payload.email});
		expect(mocks.userFindFirst).toHaveBeenCalledWith({
			where:{email:{equals:payload.email,mode:'insensitive'}},
			select:{email:true,passwordHash:true,status:true},
		});
		expect(mocks.createAccount).not.toHaveBeenCalled();
		expect(mocks.transaction).not.toHaveBeenCalled();
	});

	it('does not reveal an existing email when the supplied password is wrong',async()=>{
		mocks.userFindFirst.mockResolvedValue({
			email:payload.email,
			passwordHash:await bcrypt.hash('AnotherPassword2',4),
			status:'ACTIVE',
		});
		const response=await POST(request());
		const body=await response.json();

		expect(response.status).toBe(409);
		expect(body).toMatchObject({code:'ACCOUNT_ACCESS_REQUIRED'});
		expect(body.error).not.toContain('already uses this email');
		expect(JSON.stringify(body)).not.toContain(payload.email);
		expect(mocks.createAccount).not.toHaveBeenCalled();
		expect(mocks.transaction).not.toHaveBeenCalled();
	});

	it('recovers a matching account after an email unique-constraint race',async()=>{
		const passwordHash=await bcrypt.hash(payload.password,4);
		mocks.userFindFirst
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce({email:payload.email,passwordHash,status:'ACTIVE'});
		mocks.transaction.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('Duplicate email',{
			code:'P2002',clientVersion:'test',meta:{target:['email']},
		}));

		const response=await POST(request());

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({created:false,accountMatched:true,email:payload.email});
	});

	it('does not map unrelated unique constraints to the duplicate-email response',async()=>{
		mocks.transaction.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('Duplicate phone',{
			code:'P2002',clientVersion:'test',meta:{target:['phone']},
		}));
		const error=vi.spyOn(console,'error').mockImplementation(()=>undefined);

		const response=await POST(request());

		expect(response.status).toBe(500);
		expect(await response.json()).not.toMatchObject({code:'ACCOUNT_ACCESS_REQUIRED'});
		error.mockRestore();
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
