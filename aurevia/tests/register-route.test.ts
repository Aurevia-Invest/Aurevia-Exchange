import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {Prisma} from '@prisma/client';
import bcrypt from 'bcryptjs';

const mocks=vi.hoisted(()=>({
	userFindFirst:vi.fn(),
	transaction:vi.fn(),
	createAccount:vi.fn(),
	waitlistUpdateMany:vi.fn(),
	createNotification:vi.fn(),
	notifyActiveAdmins:vi.fn(),
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
	waitlistEntry:{updateMany:mocks.waitlistUpdateMany},
	$transaction:mocks.transaction,
}}));
vi.mock('@/lib/rate-limit',()=>({rateLimit:mocks.rateLimit,RateLimitError:mocks.RateLimitError}));
vi.mock('@/lib/request-ip',()=>({trustedProxyClientIp:mocks.trustedProxyClientIp}));
vi.mock('@/lib/registration-attempt',()=>({createImmediateRegistration:mocks.createAccount}));
vi.mock('@/lib/notifications',()=>({createNotification:mocks.createNotification,notifyActiveAdmins:mocks.notifyActiveAdmins}));

import {POST} from '@/app/api/register/route';

const payload={
	email:'new-user@example.invalid',
	password:'SecureTestPassword1',
	name:'New User',
	country:'United States',
	gender:'PREFER_NOT_TO_SAY',
	dateOfBirth:'1990-01-01',
	phone:'+12025550123',
	accountMode:'DEMO',
	termsAccepted:true,
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
		mocks.userFindFirst.mockResolvedValue(null);
		mocks.trustedProxyClientIp.mockReturnValue('192.0.2.5');
		mocks.rateLimit.mockReturnValue(undefined);
		mocks.createAccount.mockResolvedValue({id:'user-1'});
		mocks.waitlistUpdateMany.mockResolvedValue({count:0});
		mocks.createNotification.mockResolvedValue({});
		mocks.notifyActiveAdmins.mockResolvedValue(undefined);
		mocks.transaction.mockImplementation(async(callback:(tx:unknown)=>Promise<unknown>)=>callback({}));
	});

	afterEach(()=>vi.unstubAllEnvs());

	it('creates an active account without a security token, phone OTP, or trusted-device cookie',async()=>{
		const response=await POST(request(payload,'e75c6069-6dc9-4de5-8a58-e8257d8f8e03'));
		const body=await response.json();

		expect(response.status).toBe(201);
		expect(body).toMatchObject({created:true,email:payload.email,message:'Your account has been created. Signing you in…'});
		expect(body).not.toHaveProperty('verificationRequired');
		expect(JSON.stringify(body)).not.toContain(payload.password);
		expect(mocks.createAccount).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({
			email:payload.email,
			passwordHash:expect.any(String),
			name:payload.name,
			gender:payload.gender,
			phone:payload.phone,
			accountMode:'DEMO',
			dateOfBirth:new Date('1990-01-01T00:00:00.000Z'),
			termsAcceptedAt:expect.any(Date),
		}));
		expect(mocks.createAccount.mock.calls[0][1].passwordHash).not.toBe(payload.password);
		expect(response.headers.get('set-cookie')).toBeNull();
		expect(mocks.rateLimit).toHaveBeenCalledWith('register:192.0.2.5',30,600_000);
		expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function),{
			isolationLevel:Prisma.TransactionIsolationLevel.ReadCommitted,
			maxWait:5_000,
			timeout:15_000,
		});
		expect(mocks.waitlistUpdateMany).toHaveBeenCalledWith(expect.objectContaining({where:{email:payload.email,userId:null}}));
		expect(mocks.createNotification).toHaveBeenCalledOnce();
		expect(mocks.notifyActiveAdmins).toHaveBeenCalledOnce();
	});

	it('normalizes signup email by trimming and lowercasing before persistence',async()=>{
		const response=await POST(request({...payload,email:'  NEW-USER@EXAMPLE.INVALID  '}));

		expect(response.status).toBe(201);
		expect(await response.json()).toMatchObject({created:true,email:'new-user@example.invalid'});
		expect(mocks.createAccount).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({email:'new-user@example.invalid'}));
	});

	it('preserves international names exactly as entered and accepts Nigerian E.164 numbers',async()=>{
		const name='  José Núñez-Sørensen 李 O’Connor  ';
		const response=await POST(request({...payload,name,country:'Nigeria',phone:'+2348031234567'}));

		expect(response.status).toBe(201);
		expect(mocks.createAccount).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({
			name,
			country:'Nigeria',
			phone:'+2348031234567',
		}));
	});

	it('returns a field-specific error for blank names',async()=>{
		const response=await POST(request({...payload,name:'   '}));

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({error:'Enter your name using between 1 and 120 characters.'});
		expect(mocks.createAccount).not.toHaveBeenCalled();
	});

	it('still applies a shared IP limit when the trusted proxy address is unavailable',async()=>{
		mocks.trustedProxyClientIp.mockReturnValue(null);

		const response=await POST(request());

		expect(response.status).toBe(201);
		expect(mocks.rateLimit).toHaveBeenCalledWith('register:unknown',30,600_000);
	});

	it('rejects a filled honeypot without touching account data',async()=>{
		const response=await POST(request({...payload,website:'bot-filled-this'}));

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({error:'Invalid registration request.'});
		expect(mocks.userFindFirst).not.toHaveBeenCalled();
		expect(mocks.transaction).not.toHaveBeenCalled();
		expect(mocks.createAccount).not.toHaveBeenCalled();
		expect(mocks.rateLimit).not.toHaveBeenCalled();
	});

	it('requires a valid gender selection before creating an account',async()=>{
		const response=await POST(request({...payload,gender:undefined}));

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({error:'Check your name, email, country, password, and consent details.'});
		expect(mocks.createAccount).not.toHaveBeenCalled();
		expect(mocks.transaction).not.toHaveBeenCalled();
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
		expect(response.headers.get('set-cookie')).toBeNull();
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

		const requestId='e75c6069-6dc9-4de5-8a58-e8257d8f8e03';
		const response=await POST(request(payload,requestId));
		const logged=JSON.stringify(error.mock.calls);

		expect(response.status).toBe(500);
		expect(await response.json()).not.toMatchObject({code:'ACCOUNT_ACCESS_REQUIRED'});
		expect(logged).toContain(requestId);
		expect(logged).toContain('P2002');
		expect(logged).toContain('phone');
		expect(logged).toContain('errorStack');
		error.mockRestore();
	});

	it('logs a sanitized server-side cause for unexpected signup failures',async()=>{
		const error=vi.spyOn(console,'error').mockImplementation(()=>undefined);
		const info=vi.spyOn(console,'info').mockImplementation(()=>undefined);
		mocks.transaction.mockRejectedValue(new Error(`Write failed for ${payload.email} using ${payload.password}`));

		const requestId='e75c6069-6dc9-4de5-8a58-e8257d8f8e03';
		const response=await POST(request(payload,requestId));
		const logged=JSON.stringify(error.mock.calls);
		const timing=JSON.stringify(info.mock.calls);

		expect(response.status).toBe(500);
		expect(logged).toContain('Write failed');
		expect(logged).toContain(requestId);
		expect(logged).toContain('errorStack');
		expect(logged).not.toContain(payload.email);
		expect(logged).not.toContain(payload.password);
		expect(timing).toContain(requestId);
		expect(timing).toContain('transactionDurationMs');
		expect(timing).toContain('"transactionOutcome":"failed"');
		error.mockRestore();
		info.mockRestore();
	});

	it('keeps post-commit notification failures from turning a committed signup into an API failure',async()=>{
		const error=vi.spyOn(console,'error').mockImplementation(()=>undefined);
		mocks.createNotification.mockRejectedValueOnce(new Error('notification insert unavailable'));

		const response=await POST(request());
		const logged=JSON.stringify(error.mock.calls);

		expect(response.status).toBe(201);
		expect(logged).toContain('Post-registration effect failed');
		expect(logged).toContain('welcome notification');
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
