import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	userFindUnique:vi.fn(),
	registrationAttemptFindUnique:vi.fn(),
	registrationAttemptDeleteMany:vi.fn(),
	registrationVerificationFindUnique:vi.fn(),
	registrationVerificationCreate:vi.fn(),
	registrationVerificationUpdateMany:vi.fn(),
	registrationVerificationDeleteMany:vi.fn(),
	codeFindUnique:vi.fn(),
	codeCreate:vi.fn(),
	codeUpdateMany:vi.fn(),
	codeDeleteMany:vi.fn(),
	akedlyConfigured:vi.fn(),
	startAkedly:vi.fn(),
	startAkedlyRegistration:vi.fn(),
	hasEmailProvider:vi.fn(),
	deliverCode:vi.fn(),
	generateCode:vi.fn(),
	hashCode:vi.fn(),
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
	registrationAttempt:{findUnique:mocks.registrationAttemptFindUnique,deleteMany:mocks.registrationAttemptDeleteMany},
	registrationVerification:{
		findUnique:mocks.registrationVerificationFindUnique,
		create:mocks.registrationVerificationCreate,
		updateMany:mocks.registrationVerificationUpdateMany,
		deleteMany:mocks.registrationVerificationDeleteMany,
	},
	verificationCode:{
		findUnique:mocks.codeFindUnique,
		create:mocks.codeCreate,
		updateMany:mocks.codeUpdateMany,
		deleteMany:mocks.codeDeleteMany,
	},
}}));
vi.mock('@/lib/akedly',()=>({akedlyIsConfigured:mocks.akedlyConfigured}));
vi.mock('@/lib/akedly-verification',()=>({
	startAkedlyVerification:mocks.startAkedly,
	startAkedlyRegistrationVerification:mocks.startAkedlyRegistration,
}));
vi.mock('@/lib/verification-delivery',()=>({
	hasConfiguredVerificationProvider:mocks.hasEmailProvider,
	deliverVerificationCode:mocks.deliverCode,
	generateVerificationCode:mocks.generateCode,
	hashVerificationCode:mocks.hashCode,
}));
vi.mock('@/lib/rate-limit',()=>({rateLimit:mocks.rateLimit,RateLimitError:mocks.RateLimitError}));

import {POST} from '@/app/api/register/resend/route';
import {VerificationChannel} from '@prisma/client';

const user={
	id:'user-1',
	email:'person@example.invalid',
	name:'Aurevia User',
	phone:null,
	emailVerifiedAt:null,
	requiresRegistrationVerification:true,
	role:'USER',
	status:'ACTIVE',
};

function request(){
	return new Request('https://aurevia.test/api/register/resend',{
		method:'POST',
		headers:{'content-type':'application/json','x-forwarded-for':'192.0.2.3'},
		body:JSON.stringify({email:user.email}),
	});
}

function registrationRequest(){
	return new Request('https://aurevia.test/api/register/resend',{
		method:'POST',
		headers:{
			'content-type':'application/json',
			'x-forwarded-for':'192.0.2.3',
			cookie:`aurevia_registration=${'a'.repeat(43)}`,
		},
		body:JSON.stringify({email:'new-registration@example.invalid'}),
	});
}

describe('registration verification resend',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		mocks.userFindUnique.mockResolvedValue(user);
		mocks.registrationAttemptFindUnique.mockResolvedValue(null);
		mocks.registrationAttemptDeleteMany.mockResolvedValue({count:1});
		mocks.registrationVerificationFindUnique.mockResolvedValue(null);
		mocks.registrationVerificationCreate.mockResolvedValue({id:'registration-verification-1'});
		mocks.registrationVerificationUpdateMany.mockResolvedValue({count:1});
		mocks.registrationVerificationDeleteMany.mockResolvedValue({count:1});
		mocks.codeFindUnique.mockResolvedValue(null);
		mocks.codeCreate.mockResolvedValue({id:'challenge-1'});
		mocks.codeUpdateMany.mockResolvedValue({count:1});
		mocks.codeDeleteMany.mockResolvedValue({count:1});
		mocks.akedlyConfigured.mockReturnValue(false);
		mocks.startAkedly.mockResolvedValue({attemptId:'attempt_1234567890',iframeUrl:'https://auth.akedly.io/widget',expiresAt:new Date(Date.now()+60_000)});
		mocks.startAkedlyRegistration.mockResolvedValue({attemptId:'attempt_1234567890',iframeUrl:'https://auth.akedly.io/widget',expiresAt:new Date(Date.now()+60_000)});
		mocks.hasEmailProvider.mockReturnValue(true);
		mocks.deliverCode.mockResolvedValue(true);
		mocks.generateCode.mockReturnValue('123456');
		mocks.hashCode.mockReturnValue('hashed-value');
	});

	afterEach(()=>vi.unstubAllEnvs());

	it('sends an email code when Akedly is disabled and email delivery is configured',async()=>{
		const response=await POST(request());

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({method:'email-code'});
		expect(mocks.deliverCode).toHaveBeenCalledWith('EMAIL',user,'123456');
		expect(mocks.codeCreate).toHaveBeenCalledOnce();
		expect(mocks.startAkedly).not.toHaveBeenCalled();
	});

	it('uses Akedly when explicitly enabled and configured',async()=>{
		mocks.akedlyConfigured.mockReturnValue(true);
		const response=await POST(request());

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({method:'akedly',attemptId:'attempt_1234567890'});
		expect(mocks.startAkedly).toHaveBeenCalledOnce();
		expect(mocks.deliverCode).not.toHaveBeenCalled();
	});

	it('falls back to email code when Akedly is enabled but the provider is unavailable',async()=>{
		mocks.akedlyConfigured.mockReturnValue(true);
		mocks.startAkedly.mockRejectedValue(new Error('AKEDLY_PROVIDER_UNAVAILABLE'));
		const response=await POST(request());

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({method:'email-code'});
		expect(mocks.startAkedly).toHaveBeenCalledOnce();
		expect(mocks.deliverCode).toHaveBeenCalledOnce();
	});

	it('replaces an expired Akedly challenge with the email-code challenge',async()=>{
		mocks.akedlyConfigured.mockReturnValue(true);
		mocks.startAkedly.mockRejectedValue(new Error('AKEDLY_PROVIDER_UNAVAILABLE'));
		mocks.codeFindUnique.mockResolvedValue({
			id:'previous-akedly-challenge',
			codeHash:'old-hash',
			channel:'EMAIL',
			providerReference:'AKEDLY:old_attempt_12345',
			expiresAt:new Date(Date.now()-1000),
			resendAfter:new Date(Date.now()-1000),
			attempts:0,
		});
		const response=await POST(request());

		expect(response.status).toBe(200);
		expect(mocks.codeUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
			where:{id:'previous-akedly-challenge',resendAfter:{lte:expect.any(Date)}},
			data:expect.objectContaining({channel:'EMAIL',providerReference:null,codeHash:'hashed-value'}),
		}));
	});

	it('resumes an active email-code challenge without exposing or resending its code',async()=>{
		mocks.codeFindUnique.mockResolvedValue({
			id:'active-email-challenge',
			channel:'EMAIL',
			providerReference:null,
			expiresAt:new Date(Date.now()+60_000),
			resendAfter:new Date(Date.now()+30_000),
		});
		const response=await POST(request());

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({method:'email-code'});
		expect(mocks.deliverCode).not.toHaveBeenCalled();
		expect(mocks.codeCreate).not.toHaveBeenCalled();
	});

	it('does not switch providers when an Akedly resend is still cooling down',async()=>{
		mocks.akedlyConfigured.mockReturnValue(true);
		mocks.startAkedly.mockRejectedValue(new Error('AKEDLY_RESEND_COOLDOWN'));
		const response=await POST(request());

		expect(response.status).toBe(429);
		expect(mocks.deliverCode).not.toHaveBeenCalled();
	});

	it('returns an accurate retry duration when a temporary Akedly attempt is cooling down',async()=>{
		mocks.registrationAttemptFindUnique.mockResolvedValue({
			id:'registration-1',
			email:'new-registration@example.invalid',
			expiresAt:new Date(Date.now()+60_000),
			verification:{resendAfter:new Date(Date.now()+25_000),expiresAt:new Date(Date.now()+60_000)},
		});
		mocks.akedlyConfigured.mockReturnValue(true);
		mocks.startAkedlyRegistration.mockRejectedValue(new Error('AKEDLY_RESEND_COOLDOWN'));
		const response=await POST(registrationRequest());

		expect(response.status).toBe(429);
		expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0);
		expect(await response.json()).toMatchObject({retryAfterSeconds:expect.any(Number)});
	});

	it('replaces only an expired temporary challenge and retains the registration attempt',async()=>{
		mocks.registrationAttemptFindUnique.mockResolvedValue({
			id:'registration-1',
			email:'new-registration@example.invalid',
			name:'New User',
			phone:null,
			expiresAt:new Date(Date.now()+60_000),
			verification:{
				id:'expired-verification',
				expiresAt:new Date(Date.now()-1000),
				resendAfter:new Date(Date.now()-1000),
			},
		});
		const response=await POST(registrationRequest());

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({method:'email-code'});
		expect(mocks.registrationVerificationDeleteMany).toHaveBeenCalledWith({
			where:{registrationAttemptId:'registration-1',expiresAt:{lte:expect.any(Date)}},
		});
		expect(mocks.registrationAttemptDeleteMany).not.toHaveBeenCalled();
		expect(mocks.registrationVerificationCreate).toHaveBeenCalledOnce();
	});

	it('does not send a code or start Akedly when no delivery provider is configured',async()=>{
		mocks.hasEmailProvider.mockReturnValue(false);
		const response=await POST(request());

		expect(response.status).toBe(503);
		expect(mocks.codeCreate).not.toHaveBeenCalled();
		expect(mocks.startAkedly).not.toHaveBeenCalled();
	});

	it('restores a prior challenge if email delivery fails',async()=>{
		mocks.codeFindUnique.mockResolvedValue({
			id:'previous-challenge',
			codeHash:'previous-hash',
			channel:'EMAIL',
			providerReference:null,
			expiresAt:new Date(Date.now()+60_000),
			resendAfter:new Date(Date.now()-1000),
			attempts:1,
		});
		mocks.deliverCode.mockResolvedValue(false);
		const response=await POST(request());

		expect(response.status).toBe(502);
		expect(mocks.codeUpdateMany).toHaveBeenLastCalledWith(expect.objectContaining({
			where:{id:'previous-challenge',codeHash:'hashed-value'},
			data:expect.objectContaining({codeHash:'previous-hash',attempts:1}),
		}));
	});

	it('sends an email code to a temporary registration without creating a user',async()=>{
		mocks.registrationAttemptFindUnique.mockResolvedValue({
			id:'registration-1',
			email:'new-registration@example.invalid',
			name:'New User',
			phone:null,
			expiresAt:new Date(Date.now()+60_000),
			verification:null,
		});
		const response=await POST(registrationRequest());

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({method:'email-code'});
		expect(mocks.registrationVerificationCreate).toHaveBeenCalledOnce();
		expect(mocks.deliverCode).toHaveBeenCalledWith(
			VerificationChannel.EMAIL,
			expect.objectContaining({email:'new-registration@example.invalid'}),
			'123456',
			{registrationToken:'a'.repeat(43)},
		);
		expect(mocks.userFindUnique).not.toHaveBeenCalled();
	});

	it('deletes the temporary registration if OTP delivery fails',async()=>{
		mocks.registrationAttemptFindUnique.mockResolvedValue({
			id:'registration-1',
			email:'new-registration@example.invalid',
			name:'New User',
			phone:null,
			expiresAt:new Date(Date.now()+60_000),
			verification:null,
		});
		mocks.deliverCode.mockResolvedValue(false);
		const response=await POST(registrationRequest());

		expect(response.status).toBe(502);
		expect(mocks.registrationAttemptDeleteMany).toHaveBeenCalledWith({where:{id:'registration-1'}});
		expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
		expect(mocks.userFindUnique).not.toHaveBeenCalled();
	});
});
