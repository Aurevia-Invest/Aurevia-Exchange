import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	AkedlyProviderError:class extends Error{
		readonly httpStatus?:number;
		readonly providerCode?:string;
		readonly providerEndpoint='https://api.akedly.io/api/v1/widget-sdk/create-attempt';
		readonly providerAttemptId='attempt_1234567890';
		readonly providerMessage='provider returned [redacted-number]';
		readonly failureTimestamp='2026-11-03T17:00:00.000Z';

		constructor(httpStatus=401,providerCode='INVALID_SIGNATURE'){
			super('AKEDLY_ATTEMPT_REJECTED');
			this.httpStatus=httpStatus;
			this.providerCode=providerCode;
		}
	},
	requireUser:vi.fn(),
	userFindUnique:vi.fn(),
	userUpdate:vi.fn(),
	codeFindUnique:vi.fn(),
	codeCreate:vi.fn(),
	codeUpdateMany:vi.fn(),
	transaction:vi.fn(),
	akedlyConfigured:vi.fn(),
	akedlyReadiness:vi.fn(),
	startAkedly:vi.fn(),
	hasConfiguredTermii:vi.fn(),
	hashCode:vi.fn(),
	sendTermii:vi.fn(),
	rateLimit:vi.fn(),
	synchronizeTier:vi.fn(),
}));

vi.mock('@/lib/auth',()=>({requireUser:mocks.requireUser}));
vi.mock('@/lib/db',()=>({db:{
	user:{findUnique:mocks.userFindUnique,update:mocks.userUpdate},
	verificationCode:{
		findUnique:mocks.codeFindUnique,
		create:mocks.codeCreate,
		updateMany:mocks.codeUpdateMany,
	},
	$transaction:mocks.transaction,
}}));
vi.mock('@/lib/akedly',()=>({
	AkedlyProviderError:mocks.AkedlyProviderError,
	akedlyIsConfigured:mocks.akedlyConfigured,
	akedlyReadiness:mocks.akedlyReadiness,
}));
vi.mock('@/lib/akedly-verification',()=>({startAkedlyVerification:mocks.startAkedly}));
vi.mock('@/lib/verification-delivery',()=>({
	hasConfiguredTermii:mocks.hasConfiguredTermii,
	hashVerificationCode:mocks.hashCode,
	sendTermiiVerificationToken:mocks.sendTermii,
}));
vi.mock('@/lib/rate-limit',()=>({rateLimit:mocks.rateLimit}));
vi.mock('@/lib/tier-progression',()=>({synchronizeCompletedProfileTier:mocks.synchronizeTier}));

import {POST} from '@/app/api/kyc/phone/send/route';

function request(delivery?:'automatic'|'termii'){
	return new Request('https://aurevia.test/api/kyc/phone/send',{
		method:'POST',
		headers:{'content-type':'application/json','x-forwarded-for':'192.0.2.6'},
		body:JSON.stringify({phone:'+12125550123',...(delivery?{delivery}:{})}),
	});
}

describe('phone verification provider fallback',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		mocks.requireUser.mockResolvedValue({id:'user-1'});
		mocks.userFindUnique.mockResolvedValue({
			id:'user-1',phone:null,phoneVerified:false,accountMode:'REAL',status:'ACTIVE',approvedTier:2,kycStatus:'PENDING',
			name:'Test User',country:'US',kyc:{submittedAt:new Date()},kycDocuments:[{kind:'IDENTITY_DOCUMENT'},{kind:'SELFIE'}],
		});
		mocks.userUpdate.mockResolvedValue({});
		mocks.codeFindUnique.mockResolvedValue(null);
		mocks.codeCreate.mockResolvedValue({});
		mocks.codeUpdateMany.mockResolvedValue({count:1});
		mocks.transaction.mockImplementation(async(callback:(tx:unknown)=>Promise<unknown>)=>callback({
			user:{findUnique:mocks.userFindUnique,update:mocks.userUpdate},
			verificationCode:{create:mocks.codeCreate},
		}));
		mocks.synchronizeTier.mockResolvedValue(false);
		mocks.akedlyConfigured.mockReturnValue(true);
		mocks.akedlyReadiness.mockReturnValue({enabled:false,missing:['AKEDLY_API_KEY'],ready:false});
		mocks.startAkedly.mockRejectedValue(new Error('AKEDLY_PROVIDER_UNAVAILABLE'));
		mocks.hasConfiguredTermii.mockReturnValue(true);
		mocks.hashCode.mockReturnValue('hashed-reservation');
		mocks.sendTermii.mockResolvedValue('termii-pin-reference');
	});

	it('sends an OTP after profile completion before KYC details or files are submitted',async()=>{
		mocks.userFindUnique.mockResolvedValue({
			id:'user-1',phone:null,phoneVerified:false,accountMode:'REAL',status:'ACTIVE',approvedTier:2,
			name:'Test User',country:'US',
		});
		const response=await POST(request());

		expect(response.status).toBe(200);
		expect(mocks.startAkedly).toHaveBeenCalledOnce();
		expect(mocks.sendTermii).toHaveBeenCalledWith('+12125550123');
	});

	afterEach(()=>vi.unstubAllEnvs());

	it('falls back to the configured SMS provider when Akedly is unavailable',async()=>{
		const response=await POST(request());

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({message:'A verification code was sent to your phone.'});
		expect(mocks.startAkedly).toHaveBeenCalledOnce();
		expect(mocks.sendTermii).toHaveBeenCalledWith('+12125550123');
		expect(mocks.codeCreate).toHaveBeenCalledWith(expect.objectContaining({
			data:expect.objectContaining({userId:'user-1',channel:'SMS'}),
		}));
	});

	it('does not switch providers while an Akedly attempt is cooling down',async()=>{
		mocks.startAkedly.mockRejectedValue(new Error('AKEDLY_RESEND_COOLDOWN'));
		mocks.codeFindUnique.mockResolvedValue({resendAfter:new Date(Date.now()+60_000)});
		const response=await POST(request());

		expect(response.status).toBe(429);
		expect(mocks.sendTermii).not.toHaveBeenCalled();
	});

	it('offers a configured Termii SMS fallback when Akedly starts successfully',async()=>{
		mocks.startAkedly.mockResolvedValue({
			attemptId:'attempt-12345678',
			iframeUrl:'https://auth.akedly.io/widget?attemptId=attempt-12345678',
			expiresAt:new Date(Date.now()+5*60_000),
		});

		const response=await POST(request());

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			provider:'akedly',
			termiiFallbackAvailable:true,
			resendAfterSeconds:expect.any(Number),
		});
		expect(mocks.sendTermii).not.toHaveBeenCalled();
	});

	it('sends a requested Termii code without starting another Akedly attempt',async()=>{
		const response=await POST(request('termii'));

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({message:'A verification code was sent to your phone.'});
		expect(mocks.startAkedly).not.toHaveBeenCalled();
		expect(mocks.sendTermii).toHaveBeenCalledWith('+12125550123');
	});

	it('explains that no code was sent when neither phone provider is configured',async()=>{
		mocks.akedlyConfigured.mockReturnValue(false);
		mocks.hasConfiguredTermii.mockReturnValue(false);
		const warning=vi.spyOn(console,'warn').mockImplementation(()=>undefined);

		const response=await POST(request());

		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({error:'Phone verification is not configured for this service. No code was sent. Contact support instead of retrying.'});
		expect(mocks.startAkedly).not.toHaveBeenCalled();
		expect(mocks.sendTermii).not.toHaveBeenCalled();
		expect(mocks.userUpdate).not.toHaveBeenCalled();
		expect(warning).toHaveBeenCalledWith('[kyc-phone] No phone verification provider is configured.',expect.objectContaining({missingAkedly:['AKEDLY_API_KEY'],termiiConfigured:false}));
		warning.mockRestore();
	});

	it('logs correlated, sanitized Akedly provider diagnostics when fallback is unavailable',async()=>{
		mocks.hasConfiguredTermii.mockReturnValue(false);
		mocks.startAkedly.mockRejectedValue(new mocks.AkedlyProviderError());
		const warning=vi.spyOn(console,'warn').mockImplementation(()=>undefined);
		const errorLog=vi.spyOn(console,'error').mockImplementation(()=>undefined);

		const response=await POST(request());
		const body=await response.json();

		expect(response.status).toBe(503);
		expect(body).toMatchObject({
			error:'Unable to send a verification code right now.',
			requestId:expect.any(String),
			referenceId:expect.any(String),
		});
		expect(body.referenceId).toBe(body.requestId);
		expect(warning).toHaveBeenCalledWith(
			'[kyc-phone] Akedly verification attempt failed.',
			expect.objectContaining({
				requestId:expect.any(String),
				referenceId:expect.any(String),
				endpoint:'/api/kyc/phone/send',
				failureCode:'AKEDLY_ATTEMPT_REJECTED',
				failureTimestamp:'2026-11-03T17:00:00.000Z',
				providerEndpoint:'https://api.akedly.io/api/v1/widget-sdk/create-attempt',
				providerAttemptId:'attempt_1234567890',
				providerHttpStatus:401,
				providerCode:'INVALID_SIGNATURE',
				providerMessage:'provider returned [redacted-number]',
			}),
		);
		const diagnostic=warning.mock.calls[0]?.[1];
		expect(JSON.stringify(diagnostic)).not.toContain('+12125550123');
		expect(errorLog).toHaveBeenCalledWith('[kyc-phone] Request failed.',expect.objectContaining({requestId:expect.any(String)}));
		warning.mockRestore();
		errorLog.mockRestore();
	});
});
