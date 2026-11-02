import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {Prisma} from '@prisma/client';

const mocks=vi.hoisted(()=>({
	userFindUnique:vi.fn(),
	attemptCreate:vi.fn(),
	akedlyConfigured:vi.fn(),
	emailProviderConfigured:vi.fn(),
	verifyTurnstile:vi.fn(),
	rateLimit:vi.fn(),
}));

vi.mock('@/lib/db',()=>({db:{
	user:{findUnique:mocks.userFindUnique},
	registrationAttempt:{create:mocks.attemptCreate},
}}));
vi.mock('@/lib/rate-limit',()=>({rateLimit:mocks.rateLimit}));
vi.mock('@/lib/akedly',()=>({akedlyIsConfigured:mocks.akedlyConfigured}));
vi.mock('@/lib/verification-delivery',()=>({hasConfiguredVerificationProvider:mocks.emailProviderConfigured}));
vi.mock('@/lib/turnstile',()=>({verifyRegistrationTurnstile:mocks.verifyTurnstile}));

import {POST} from '@/app/api/register/route';

const payload={
	email:'new-user@example.invalid',
	password:'SecureTestPassword1',
	name:'New User',
	country:'United States',
	dateOfBirth:'1990-01-01',
	phone:'',
	accountMode:'DEMO',
	termsAccepted:true,
	captchaToken:'verified-turnstile-token',
};

function request(body:unknown=payload){
	return new Request('https://aurevia.test/api/register',{
		method:'POST',
		headers:{'content-type':'application/json','x-forwarded-for':'192.0.2.5'},
		body:JSON.stringify(body),
	});
}

describe('registration privacy boundary',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		mocks.akedlyConfigured.mockReturnValue(false);
		mocks.emailProviderConfigured.mockReturnValue(true);
		mocks.verifyTurnstile.mockResolvedValue(true);
		mocks.userFindUnique.mockResolvedValue(null);
		mocks.attemptCreate.mockImplementation(async({data}:{data:Record<string,unknown>})=>({email:data.email}));
	});

	afterEach(()=>vi.unstubAllEnvs());

	it('stores only a short-lived registration attempt until email verification',async()=>{
		const response=await POST(request());
		const body=await response.json();

		expect(response.status).toBe(201);
		expect(body).toMatchObject({verificationRequired:true,email:payload.email});
		expect(JSON.stringify(body)).not.toContain(payload.password);
		expect(mocks.attemptCreate).toHaveBeenCalledWith(expect.objectContaining({
			data:expect.objectContaining({
				email:payload.email,
				passwordHash:expect.any(String),
				phone:null,
				expiresAt:expect.any(Date),
				tokenHash:expect.any(String),
			}),
		}));
		expect(mocks.attemptCreate.mock.calls[0][0].data).not.toHaveProperty('aureviaExchangeId');
		expect(mocks.attemptCreate.mock.calls[0][0].data.passwordHash).not.toBe(payload.password);
		expect(mocks.userFindUnique).toHaveBeenCalledWith({where:{email:payload.email},select:{id:true}});
		expect(response.headers.get('set-cookie')).toContain('HttpOnly');
		expect(response.headers.get('set-cookie')).toContain('SameSite=lax');
		expect(response.headers.get('cache-control')).toBe('no-store');
	});

	it('fails closed on CAPTCHA and does not persist registration data',async()=>{
		mocks.verifyTurnstile.mockResolvedValue(false);
		const response=await POST(request());

		expect(response.status).toBe(400);
		expect(mocks.attemptCreate).not.toHaveBeenCalled();
		expect(mocks.userFindUnique).not.toHaveBeenCalled();
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

	it('does not retain personal details if no email verification provider is configured',async()=>{
		mocks.emailProviderConfigured.mockReturnValue(false);
		const response=await POST(request());

		expect(response.status).toBe(503);
		expect(mocks.attemptCreate).not.toHaveBeenCalled();
	});

	it('does not persist details when server-side CAPTCHA verification is unavailable',async()=>{
		mocks.verifyTurnstile.mockRejectedValue(new Error('TURNSTILE_PROVIDER_UNAVAILABLE'));
		const response=await POST(request());

		expect(response.status).toBe(503);
		expect(mocks.attemptCreate).not.toHaveBeenCalled();
	});

	it('does not create another pending attempt for duplicate details',async()=>{
		mocks.attemptCreate.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('unique constraint',{
			code:'P2002',
			clientVersion:'test',
		}));
		const response=await POST(request());

		expect(response.status).toBe(409);
		expect(mocks.attemptCreate).toHaveBeenCalledOnce();
	});

	it('preserves an existing verified user and does not touch account data',async()=>{
		mocks.userFindUnique.mockResolvedValue({
			id:'existing-user',
			email:payload.email,
			emailVerifiedAt:new Date(),
			status:'ACTIVE',
		});
		const response=await POST(request());

		expect(response.status).toBe(409);
		expect(mocks.attemptCreate).not.toHaveBeenCalled();
		expect(mocks.userFindUnique).toHaveBeenCalledOnce();
	});
});
