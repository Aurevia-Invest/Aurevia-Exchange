import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	AkedlyProviderError:class extends Error{
		readonly httpStatus?:number;
		readonly providerCode?:string;
		readonly providerEndpoint='https://api.akedly.io/api/v1/widget-sdk/create-attempt';
		readonly providerAttemptId='attempt_1234567890';
		readonly providerMessage='provider returned [redacted-number]';
		readonly failureTimestamp='2026-11-03T17:00:00.000Z';
		readonly failureStage='provider_response';
		readonly underlyingErrorType='Error';

		constructor(httpStatus=401,providerCode='INVALID_SIGNATURE'){
			super('AKEDLY_ATTEMPT_REJECTED');
			this.httpStatus=httpStatus;
			this.providerCode=providerCode;
		}
	},
	TwilioVerifyProviderError:class extends Error{
		constructor(
			message:'PHONE_VERIFICATION_PROVIDER_UNAVAILABLE'|'PHONE_VERIFICATION_PROVIDER_FAILED',
			readonly failureStage:'transport'|'provider_response'|'invalid_response',
			readonly httpStatus:number|null,
			readonly underlyingErrorType:string|null=null,
		){
			super(message);
			this.name='TwilioVerifyProviderError';
		}
	},
	TermiiProviderError:class extends Error{
		constructor(
			message:'PHONE_VERIFICATION_PROVIDER_UNAVAILABLE'|'PHONE_VERIFICATION_PROVIDER_FAILED',
			readonly failureStage:'transport'|'provider_response'|'invalid_response',
			readonly httpStatus:number|null,
			readonly underlyingErrorType:string|null=null,
		){
			super(message);
			this.name='TermiiProviderError';
		}
	},
	requireUser:vi.fn(),
	userFindUnique:vi.fn(),
	userUpdate:vi.fn(),
	codeFindUnique:vi.fn(),
	codeCreate:vi.fn(),
	codeUpdateMany:vi.fn(),
	codeDeleteMany:vi.fn(),
	transaction:vi.fn(),
	akedlyConfigured:vi.fn(),
	akedlyReadiness:vi.fn(),
	akedlyAttemptFailureDiagnostics:vi.fn((_error:unknown,_phoneNumber:string):{
		failureCode:string;failureStage:string;failureClassification:string;providerCode:string;
		underlyingErrorType:string;providerEndpoint:string;providerAttemptId:string|null;
		providerHttpStatus:number|null;providerMessage?:string;
	}=>({
		failureCode:'AKEDLY_ATTEMPT_REJECTED',
		failureStage:'provider_response',
		failureClassification:'INVALID_SIGNATURE',
		providerCode:'INVALID_SIGNATURE',
		underlyingErrorType:'Error',
		providerEndpoint:'https://api.akedly.io/api/v1/widget-sdk/create-attempt',
		providerAttemptId:'attempt_1234567890',
		providerHttpStatus:401,
		providerMessage:'provider returned [redacted-number]',
	})),
	startAkedly:vi.fn(),
	hasConfiguredTermii:vi.fn(),
	hasConfiguredTwilio:vi.fn(),
	hasConfiguredSmsProvider:vi.fn(),
	hashCode:vi.fn(),
	sendTermii:vi.fn(),
	sendTwilio:vi.fn(),
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
		deleteMany:mocks.codeDeleteMany,
	},
	$transaction:mocks.transaction,
}}));
vi.mock('@/lib/akedly',()=>({
	AkedlyProviderError:mocks.AkedlyProviderError,
	akedlyIsConfigured:mocks.akedlyConfigured,
	akedlyReadiness:mocks.akedlyReadiness,
	akedlyAttemptFailureDiagnostics:mocks.akedlyAttemptFailureDiagnostics,
}));
vi.mock('@/lib/akedly-verification',()=>({startAkedlyVerification:mocks.startAkedly}));
vi.mock('@/lib/verification-delivery',()=>({
	hasConfiguredTermii:mocks.hasConfiguredTermii,
	hasConfiguredTwilio:mocks.hasConfiguredTwilio,
	hasConfiguredSmsProvider:mocks.hasConfiguredSmsProvider,
	hashVerificationCode:mocks.hashCode,
	sendTermiiVerificationToken:mocks.sendTermii,
	sendTwilioVerificationCode:mocks.sendTwilio,
	TermiiProviderError:mocks.TermiiProviderError,
	TwilioVerifyProviderError:mocks.TwilioVerifyProviderError,
}));
vi.mock('@/lib/rate-limit',()=>({rateLimit:mocks.rateLimit}));
vi.mock('@/lib/tier-progression',()=>({synchronizeCompletedProfileTier:mocks.synchronizeTier}));

import {POST} from '@/app/api/kyc/phone/send/route';

function request(delivery?:'automatic'|'sms'|'termii'){
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
		mocks.codeDeleteMany.mockResolvedValue({count:1});
		mocks.transaction.mockImplementation(async(callback:(tx:unknown)=>Promise<unknown>)=>callback({
			user:{findUnique:mocks.userFindUnique,update:mocks.userUpdate},
			verificationCode:{create:mocks.codeCreate},
		}));
		mocks.synchronizeTier.mockResolvedValue(false);
		mocks.akedlyConfigured.mockReturnValue(true);
		mocks.akedlyReadiness.mockReturnValue({enabled:false,missing:['AKEDLY_API_KEY'],ready:false});
		mocks.startAkedly.mockRejectedValue(new Error('AKEDLY_PROVIDER_UNAVAILABLE'));
		mocks.hasConfiguredTermii.mockReturnValue(true);
		mocks.hasConfiguredTwilio.mockReturnValue(false);
		mocks.hasConfiguredSmsProvider.mockReturnValue(true);
		mocks.hashCode.mockReturnValue('hashed-reservation');
		mocks.sendTermii.mockResolvedValue('termii-pin-reference');
		mocks.sendTwilio.mockResolvedValue('TWILIO');
	});

	it('sends an OTP after profile completion before KYC details or files are submitted',async()=>{
		mocks.userFindUnique.mockResolvedValue({
			id:'user-1',phone:null,phoneVerified:false,accountMode:'REAL',status:'ACTIVE',approvedTier:2,
			name:'Test User',country:'US',
		});
		const response=await POST(request());

		expect(response.status).toBe(200);
		expect(mocks.rateLimit).toHaveBeenCalledWith('kyc-phone-send-ip:192.0.2.6',30,60*60_000);
		expect(mocks.rateLimit).toHaveBeenCalledWith('kyc-phone-send-user:user-1',3,60*60_000);
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

	it('uses SMS fallback when Akedly is configured but disabled',async()=>{
		mocks.startAkedly.mockRejectedValue(new Error('AKEDLY_INTEGRATION_DISABLED'));

		const response=await POST(request());

		expect(response.status).toBe(200);
		expect(mocks.sendTermii).toHaveBeenCalledWith('+12125550123');
	});

	it('does not switch providers while an Akedly attempt is cooling down',async()=>{
		mocks.startAkedly.mockRejectedValue(new Error('AKEDLY_RESEND_COOLDOWN'));
		mocks.codeFindUnique.mockResolvedValue({resendAfter:new Date(Date.now()+60_000)});
		const response=await POST(request());

		expect(response.status).toBe(429);
		expect(mocks.sendTermii).not.toHaveBeenCalled();
	});

	it('offers a configured SMS fallback when Akedly starts successfully',async()=>{
		mocks.startAkedly.mockResolvedValue({
			attemptId:'attempt-12345678',
			iframeUrl:'https://auth.akedly.io/widget?attemptId=attempt-12345678',
			expiresAt:new Date(Date.now()+5*60_000),
		});

		const response=await POST(request());

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			provider:'akedly',
			smsFallbackAvailable:true,
			resendAfterSeconds:expect.any(Number),
		});
		expect(mocks.sendTermii).not.toHaveBeenCalled();
	});

	it('sends a requested SMS code without starting another Akedly attempt',async()=>{
		mocks.hasConfiguredTwilio.mockReturnValue(true);
		const response=await POST(request('sms'));

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({message:'A verification code was sent to your phone.'});
		expect(mocks.startAkedly).not.toHaveBeenCalled();
		expect(mocks.sendTwilio).toHaveBeenCalledWith('+12125550123');
		expect(mocks.sendTermii).not.toHaveBeenCalled();
		expect(mocks.codeUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
			data:expect.objectContaining({providerReference:'TWILIO'}),
		}));
	});

	it('returns a reference and logs safe Termii diagnostics on provider rejection',async()=>{
		mocks.sendTermii.mockRejectedValue(new mocks.TermiiProviderError('PHONE_VERIFICATION_PROVIDER_FAILED','provider_response',401));
		const errorLog=vi.spyOn(console,'error').mockImplementation(()=>undefined);

		const response=await POST(request('termii'));
		const body=await response.json();
		const details=errorLog.mock.calls[0]?.[1];

		expect(response.status).toBe(502);
		expect(body).toMatchObject({requestId:expect.any(String),referenceId:expect.any(String)});
		expect(details).toMatchObject({
			requestId:body.requestId,
			referenceId:body.requestId,
			endpoint:'/api/sms/otp/send',
			failureStage:'provider_response',
			providerHttpStatus:401,
		});
		expect(JSON.stringify(details)).not.toContain('+12125550123');
		errorLog.mockRestore();
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
		mocks.hasConfiguredSmsProvider.mockReturnValue(false);
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

	it('keeps endpoint and stage diagnostics when an unstructured provider error is thrown',async()=>{
		mocks.hasConfiguredTermii.mockReturnValue(false);
		mocks.hasConfiguredSmsProvider.mockReturnValue(false);
		mocks.startAkedly.mockRejectedValue(new Error('AKEDLY_PROVIDER_UNAVAILABLE'));
		mocks.akedlyAttemptFailureDiagnostics.mockReturnValueOnce({
			failureCode:'AKEDLY_PROVIDER_UNAVAILABLE',
			failureStage:'unclassified_create_attempt_failure',
			failureClassification:'UNCLASSIFIED',
			providerCode:'UNCLASSIFIED',
			underlyingErrorType:'Error',
			providerEndpoint:'https://api.akedly.io/api/v1/widget-sdk/create-attempt',
			providerAttemptId:null,
			providerHttpStatus:null,
		});
		const warning=vi.spyOn(console,'warn').mockImplementation(()=>undefined);

		const response=await POST(request());
		const logDetails=warning.mock.calls[0]?.[1];

		expect(response.status).toBe(503);
		expect(mocks.akedlyAttemptFailureDiagnostics).toHaveBeenCalledWith(
			expect.objectContaining({message:'AKEDLY_PROVIDER_UNAVAILABLE'}),
			'+12125550123',
		);
		expect(logDetails).toMatchObject({
			failureCode:'AKEDLY_PROVIDER_UNAVAILABLE',
			failureStage:'unclassified_create_attempt_failure',
			failureClassification:'UNCLASSIFIED',
			providerEndpoint:'https://api.akedly.io/api/v1/widget-sdk/create-attempt',
			providerAttemptId:null,
			providerHttpStatus:null,
		});
		expect(JSON.stringify(logDetails)).not.toContain('+12125550123');
		warning.mockRestore();
	});
});
