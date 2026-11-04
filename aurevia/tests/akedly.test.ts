import {createHmac} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {Webhook} from 'svix';
import {
	akedlyAttemptFailureDiagnostics,
	akedlyReadiness,
	createAkedlyAttempt,
	isConfirmedAkedlyAttempt,
	isConfirmedAkedlyLookup,
	logAkedlyReadiness,
	lookupAkedlyAttempt,
	verifyAkedlyWebhook,
} from '@/lib/akedly';

const cryptoFailureState=vi.hoisted(()=>({failCreateHmac:false}));

vi.mock('node:crypto',async importOriginal=>{
	const original=await importOriginal<typeof import('node:crypto')>();
	return {
		...original,
		createHmac:(...args:Parameters<typeof original.createHmac>)=>{
			if(cryptoFailureState.failCreateHmac)throw new Error('private key material');
			return original.createHmac(...args);
		},
	};
});

const akedlyEnvironment={
	AKEDLY_ENABLED:'true',
	AKEDLY_API_KEY:'test-api-key',
	AKEDLY_PIPELINE_ID:'test-pipeline',
	AKEDLY_WIDGET_ID:'test-widget',
	AKEDLY_PUBLIC_KEY:'test-public-key',
	AKEDLY_WIDGET_SECRET:'test-widget-secret',
	AKEDLY_WEBHOOK_SECRET:`whsec_${Buffer.from('test-webhook-secret').toString('base64')}`,
};

function providerResponse(attemptId='attempt_1234567890',iframeUrl=`https://auth.akedly.io/auth?attemptId=${attemptId}`){
	return new Response(JSON.stringify({
		status:'success',
		data:{attemptId,iframeUrl,expiresAt:new Date(Date.now()+4*60_000).toISOString()},
	}),{status:200,headers:{'content-type':'application/json'}});
}

function successfulResult(attemptId='attempt_1234567890'){
	return {
		status:'success',
		widgetAttempt:{
			attemptId,
			widgetId:'test-widget',
			status:'verified',
			isTest:false,
			completedAt:'2026-11-02T00:00:30.000Z',
		},
		transaction:{
			status:'Successful',
			isTest:false,
			pipelineID:'test-pipeline',
			verificationAddress:{email:'person@example.invalid',phoneNumber:'+12125550123'},
			updateDate:'2026-11-02T00:00:30.000Z',
		},
	};
}

describe('Akedly V2 server integration',()=>{
	beforeEach(()=>{
		for(const [name,value] of Object.entries(akedlyEnvironment))vi.stubEnv(name,value);
	});

	afterEach(()=>{
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it('matches a fixed V2 phone-signature regression vector and rejects altered inputs',async()=>{
		const timestamp=1_701_552_354_000;
		const now=vi.spyOn(Date,'now').mockReturnValue(timestamp);
		let requestBody:Record<string,unknown>|undefined;
		vi.stubGlobal('fetch',vi.fn(async(_input:RequestInfo|URL,init?:RequestInit)=>{
			requestBody=JSON.parse(String(init?.body)) as Record<string,unknown>;
			return providerResponse();
		}));

		try{
			await createAkedlyAttempt({phoneNumber:'+12125550123'});
			if(!requestBody)throw new Error('Akedly request was not captured.');
			const body=requestBody;
			const signingMessage=JSON.stringify({
				apiKey:'test-api-key',
				publicKey:'test-public-key',
				timestamp,
				phoneNumber:'+12125550123',
			});
			const wrongSecret=createHmac('sha256','incorrect-widget-secret').update(signingMessage,'utf8').digest('hex');
			const wrongApiKeySecret=createHmac('sha256','test-api-key').update(signingMessage,'utf8').digest('hex');
			const wrongWebhookSecret=createHmac('sha256',akedlyEnvironment.AKEDLY_WEBHOOK_SECRET).update(signingMessage,'utf8').digest('hex');
			const wrongTimestamp=createHmac('sha256','test-widget-secret').update(JSON.stringify({
				apiKey:'test-api-key',
				publicKey:'test-public-key',
				timestamp:timestamp+1,
				phoneNumber:'+12125550123',
			}),'utf8').digest('hex');
			const wrongPhone=createHmac('sha256','test-widget-secret').update(JSON.stringify({
				apiKey:'test-api-key',
				publicKey:'test-public-key',
				timestamp,
				phoneNumber:'+12125550124',
			}),'utf8').digest('hex');

			expect(signingMessage).toBe('{"apiKey":"test-api-key","publicKey":"test-public-key","timestamp":1701552354000,"phoneNumber":"+12125550123"}');
			expect(body).toMatchObject({
				apiKey:'test-api-key',
				publicKey:'test-public-key',
				timestamp,
				signature:'74e2277749d796ae81db8b307d8337a1984fa10966c5e1859cf7cce41763cdb9',
				verificationAddress:{phoneNumber:'+12125550123'},
				digits:6,
			});
			expect(body.signature).toMatch(/^[a-f0-9]{64}$/);
			expect(body.signature).not.toBe(wrongSecret);
			expect(body.signature).not.toBe(wrongApiKeySecret);
			expect(body.signature).not.toBe(wrongWebhookSecret);
			expect(body.signature).not.toBe(wrongTimestamp);
			expect(body.signature).not.toBe(wrongPhone);
		}finally{
			now.mockRestore();
		}
	});

	it('signs the email-only request without adding the email to the HMAC message',async()=>{
		let requestBody:Record<string,unknown>|undefined;
		vi.stubGlobal('fetch',vi.fn(async(_input:RequestInfo|URL,init?:RequestInit)=>{
			requestBody=JSON.parse(String(init?.body)) as Record<string,unknown>;
			return providerResponse();
		}));

		const attempt=await createAkedlyAttempt({email:'person@example.invalid'});
		if(!requestBody)throw new Error('Akedly request was not captured.');
		const body=requestBody;
		const signingMessage=JSON.stringify({
			apiKey:'test-api-key',
			publicKey:'test-public-key',
			timestamp:body.timestamp,
		});
		const expectedSignature=createHmac('sha256','test-widget-secret').update(signingMessage,'utf8').digest('hex');

		expect(body).toMatchObject({
			apiKey:'test-api-key',
			publicKey:'test-public-key',
			verificationAddress:{email:'person@example.invalid'},
			digits:6,
			signature:expectedSignature,
		});
		expect(body.timestamp).toEqual(expect.any(Number));
		expect(Math.abs(Date.now()-Number(body.timestamp))).toBeLessThan(5_000);
		expect(body).not.toHaveProperty('phoneNumber');
		expect(attempt).toMatchObject({attemptId:'attempt_1234567890',iframeUrl:'https://auth.akedly.io/auth?attemptId=attempt_1234567890'});
	});

	it.each([
		['US','+12025550123'],
		['NG','+2348031237250'],
		['GB','+447400123456'],
		['CA','+14165550123'],
		['IN','+919876543210'],
		['DE','+4915112345678'],
		['ZA','+27821234567'],
	])('uses the documented endpoint and preserves the %s E.164 number in its HMAC payload',async(_country,phoneNumber)=>{
		let requestBody:Record<string,unknown>|undefined;
		let requestUrl:string|undefined;
		let requestHeaders:Headers|undefined;
		vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
			requestUrl=String(input);
			requestHeaders=new Headers(init?.headers);
			requestBody=JSON.parse(String(init?.body)) as Record<string,unknown>;
			return providerResponse();
		}));

		await createAkedlyAttempt({phoneNumber});
		if(!requestBody)throw new Error('Akedly request was not captured.');
		const body=requestBody;
		const signingMessage=JSON.stringify({
			apiKey:'test-api-key',
			publicKey:'test-public-key',
			timestamp:body.timestamp,
			phoneNumber,
		});
		expect(requestUrl).toBe('https://api.akedly.io/api/v1/widget-sdk/create-attempt');
		expect(requestHeaders?.get('authorization')).toBeNull();
		expect(body.signature).toBe(createHmac('sha256','test-widget-secret').update(signingMessage,'utf8').digest('hex'));
		expect(body.verificationAddress).toEqual({phoneNumber});
	});

	it('fails closed without credentials and rejects an untrusted widget URL',async()=>{
		vi.stubEnv('AKEDLY_WEBHOOK_SECRET','');
		const fetch=vi.fn();
		vi.stubGlobal('fetch',fetch);
		const configurationFailure=await createAkedlyAttempt({email:'person@example.invalid'}).catch(error=>error);
		expect(configurationFailure).toMatchObject({
			message:'AKEDLY_CONFIGURATION_REQUIRED',
			providerCode:'CONFIGURATION_ERROR',
			failureStage:'configuration',
		});
		expect(fetch).not.toHaveBeenCalled();

		vi.stubEnv('AKEDLY_WEBHOOK_SECRET',akedlyEnvironment.AKEDLY_WEBHOOK_SECRET);
		vi.stubGlobal('fetch',vi.fn(async()=>providerResponse('attempt_1234567890','https://attacker.invalid/auth?attemptId=attempt_1234567890')));
		await expect(createAkedlyAttempt({email:'person@example.invalid'})).rejects.toThrow('AKEDLY_INVALID_WIDGET_URL');
	});

	it('classifies request signing failures without exposing the underlying error message',async()=>{
		cryptoFailureState.failCreateHmac=true;
		try{
			const failure=await createAkedlyAttempt({phoneNumber:'+12125550123'}).catch(error=>error);

			expect(failure).toMatchObject({
				message:'AKEDLY_REQUEST_SIGNING_FAILED',
				providerCode:'SIGNING_ERROR',
				failureStage:'request_signing',
				underlyingErrorType:'Error',
			});
			expect(JSON.stringify(failure)).not.toContain('private key material');
		}finally{
			cryptoFailureState.failCreateHmac=false;
		}
	});

	it('reports only missing configuration variable names and never credential values',()=>{
		vi.stubEnv('AKEDLY_WIDGET_SECRET','');

		const readiness=akedlyReadiness();

		expect(readiness).toEqual({enabled:true,missing:['AKEDLY_WIDGET_SECRET'],ready:false});
		expect(JSON.stringify(readiness)).not.toContain('test-api-key');
		expect(JSON.stringify(readiness)).not.toContain('test-widget-secret');
	});

	it('reports the explicit enable flag as missing when credentials exist but the integration is disabled',()=>{
		vi.stubEnv('AKEDLY_ENABLED','false');

		expect(akedlyReadiness()).toEqual({enabled:false,missing:['AKEDLY_ENABLED=true'],ready:false});
	});

	it('rejects quote-wrapped credentials without exposing their values',()=>{
		vi.stubEnv('AKEDLY_API_KEY','"test-api-key"');

		const readiness=akedlyReadiness();

		expect(readiness).toEqual({enabled:true,missing:['AKEDLY_API_KEY (remove surrounding quotes)'],ready:false});
		expect(JSON.stringify(readiness)).not.toContain('test-api-key');
	});

	it('logs startup readiness without exposing credential values',()=>{
		vi.stubEnv('AKEDLY_WIDGET_SECRET','');
		const info=vi.spyOn(console,'info').mockImplementation(()=>undefined);

		logAkedlyReadiness();

		expect(info).toHaveBeenCalledWith('[startup] Akedly configuration status',{
			enabled:true,
			ready:false,
			missing:['AKEDLY_WIDGET_SECRET'],
		});
		expect(JSON.stringify(info.mock.calls)).not.toContain('test-api-key');
		expect(JSON.stringify(info.mock.calls)).not.toContain('test-widget-secret');
		info.mockRestore();
	});

	it('retains safe timing diagnostics and redacts contact data from provider rejection',async()=>{
		vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({
			status:'error',
			error:{code:'invalid_signature',message:'private provider response for person@example.invalid'},
		}),{status:401,headers:{'content-type':'application/json',date:'Wed, 04 Nov 2026 00:00:00 GMT'}})));

		const failure=await createAkedlyAttempt({email:'person@example.invalid'}).catch(error=>error);
		expect(failure).toMatchObject({
			message:'AKEDLY_ATTEMPT_REJECTED',
			httpStatus:401,
			providerCode:'INVALID_SIGNATURE',
			signedTimestamp:expect.any(Number),
			providerDate:'2026-11-04T00:00:00.000Z',
			responseReceivedAt:expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
		});
		expect(JSON.stringify(failure)).not.toContain('person@example.invalid');
		expect(failure).toMatchObject({
			providerMessage:'private provider response for [redacted-email]',
			providerEndpoint:'https://api.akedly.io/api/v1/widget-sdk/create-attempt',
		});
		expect(akedlyAttemptFailureDiagnostics(failure,'')).toMatchObject({
			providerFailureCategory:'INVALID_SIGNATURE',
			recommendedAction:'Verify AKEDLY_WIDGET_SECRET is the Widget Secret for this widget and check the exact signed payload.',
		});
	});

	it('distinguishes invalid API credentials from an invalid HMAC signature',async()=>{
		vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({
			status:'error',
			error:{code:'invalid_api_key',message:'private provider response'},
		}),{status:401,headers:{'content-type':'application/json'}})));

		const failure=await createAkedlyAttempt({phoneNumber:'+12125550123'}).catch(error=>error);
		const diagnostics=akedlyAttemptFailureDiagnostics(failure,'+12125550123');

		expect(diagnostics).toMatchObject({
			providerCode:'INVALID_API_KEY',
			providerFailureCategory:'INVALID_CREDENTIALS',
			recommendedAction:'Verify the API key is active and authorized for the configured widget and pipeline.',
		});
		expect(JSON.stringify(diagnostics)).not.toContain('test-api-key');
		expect(JSON.stringify(diagnostics)).not.toContain('test-widget-secret');
	});

	it('captures a redacted provider response message and endpoint for support correlation',async()=>{
		vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({
			status:'error',
			data:{attemptId:'attempt_1234567890'},
			error:{
				code:'invalid_phone_number',
				message:'Rejected +2348031234567 for person@example.invalid; OTP 123456. API key=secret-value',
			},
		}),{status:400,headers:{'content-type':'application/json'}})));

		const failure=await createAkedlyAttempt({phoneNumber:'+2348031234567'}).catch(error=>error);

		expect(failure).toMatchObject({
			message:'AKEDLY_ATTEMPT_REJECTED',
			httpStatus:400,
			providerCode:'INVALID_PHONE_NUMBER',
			providerEndpoint:'https://api.akedly.io/api/v1/widget-sdk/create-attempt',
			providerAttemptId:'attempt_1234567890',
			failureTimestamp:expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
			providerMessage:'Rejected [redacted-number] for [redacted-email]; OTP [redacted-code]. API key=[redacted]',
		});
		expect(JSON.stringify(failure)).not.toContain('+2348031234567');
		expect(JSON.stringify(failure)).not.toContain('person@example.invalid');
		expect(failure.providerMessage).not.toMatch(/\b123456\b/);
		expect(JSON.stringify(failure)).not.toContain('secret-value');
	});

	it('retains the failed endpoint and timestamp for provider timeouts',async()=>{
		vi.stubGlobal('fetch',vi.fn(async()=>{
			throw new DOMException('request timed out','TimeoutError');
		}));

		const failure=await createAkedlyAttempt({phoneNumber:'+12125550123'}).catch(error=>error);

		expect(failure).toMatchObject({
			message:'AKEDLY_PROVIDER_UNAVAILABLE',
			providerCode:'PROVIDER_TIMEOUT',
			failureStage:'create_attempt_request',
			underlyingErrorType:'TimeoutError',
			providerEndpoint:'https://api.akedly.io/api/v1/widget-sdk/create-attempt',
			failureTimestamp:expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
		});
	});

	it('classifies network failures without reporting a provider HTTP status or attempt ID',async()=>{
		vi.stubGlobal('fetch',vi.fn(async()=>{
			throw new TypeError('network failure containing private connection details');
		}));

		const failure=await createAkedlyAttempt({phoneNumber:'+12125550123'}).catch(error=>error);
		const diagnostics=akedlyAttemptFailureDiagnostics(failure,'+12125550123');

		expect(diagnostics).toMatchObject({
			failureCode:'AKEDLY_PROVIDER_UNAVAILABLE',
			failureStage:'create_attempt_request',
			failureClassification:'NETWORK_ERROR',
			providerCode:'NETWORK_ERROR',
			underlyingErrorType:'TypeError',
			providerEndpoint:'https://api.akedly.io/api/v1/widget-sdk/create-attempt',
			providerAttemptId:null,
			providerHttpStatus:null,
		});
		expect(JSON.stringify(diagnostics)).not.toContain('+12125550123');
		expect(JSON.stringify(diagnostics)).not.toContain('private connection details');
	});

	it('records malformed provider JSON as a response-parsing failure',async()=>{
		vi.stubGlobal('fetch',vi.fn(async()=>new Response('not-json',{status:200})));

		const failure=await createAkedlyAttempt({phoneNumber:'+12125550123'}).catch(error=>error);

		expect(failure).toMatchObject({
			message:'AKEDLY_INVALID_PROVIDER_RESPONSE',
			providerCode:'INVALID_JSON',
			httpStatus:200,
			failureStage:'response_parsing',
			underlyingErrorType:'SyntaxError',
		});
	});

	it('fills the create-attempt endpoint and a safe classification for unstructured errors',()=>{
		const diagnostics=akedlyAttemptFailureDiagnostics(
			new Error('AKEDLY_PROVIDER_UNAVAILABLE'),
			'+12125550123',
		);

		expect(diagnostics).toMatchObject({
			failureCode:'AKEDLY_PROVIDER_UNAVAILABLE',
			failureStage:'unclassified_create_attempt_failure',
			failureClassification:'UNCLASSIFIED',
			providerEndpoint:'https://api.akedly.io/api/v1/widget-sdk/create-attempt',
			providerAttemptId:null,
			providerHttpStatus:null,
		});
		expect(JSON.stringify(diagnostics)).not.toContain('+12125550123');
	});

	it.each([
		[403,'API_KEY_SCOPE_DENIED'],
		[400,'PIPELINE_NOT_CONFIGURED'],
		[403,'PIPELINE_OWNERSHIP_MISMATCH'],
	])('retains Akedly authorization and pipeline rejection codes (%s %s)',async(httpStatus,code)=>{
		vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({
			status:'error',
			error:{code,message:'private provider details'},
		}),{status:httpStatus,headers:{'content-type':'application/json'}})));

		const failure=await createAkedlyAttempt({phoneNumber:'+2348031234567'}).catch(error=>error);

		expect(failure).toMatchObject({
			message:'AKEDLY_ATTEMPT_REJECTED',
			httpStatus,
			providerCode:code,
		});
		expect(failure.providerMessage).toBe('private provider details');
		expect(JSON.stringify(failure)).not.toContain('+2348031234567');
	});

	it('parses safe retry durations from rate-limit responses',async()=>{
		vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({
			status:'error',
		error:{code:'CHANNEL_QUOTA_EXCEEDED',details:{cooldownSeconds:75},message:'private provider response'},
		}),{status:402,headers:{'content-type':'application/json'}})));

		const failure=await createAkedlyAttempt({phoneNumber:'+2348031234567'}).catch(error=>error);

		expect(failure).toMatchObject({
			message:'AKEDLY_ATTEMPT_REJECTED',
			httpStatus:402,
			providerCode:'CHANNEL_QUOTA_EXCEEDED',
			retryAfterSeconds:75,
		});
		expect(failure.providerMessage).toBe('private provider response');
	});

	it('retains a provider error code returned with HTTP success',async()=>{
		vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({
			status:'error',
			error:{code:'CAPTCHA_NOT_VERIFIED',message:'private provider response'},
		}),{status:200,headers:{'content-type':'application/json'}})));

		const failure=await createAkedlyAttempt({phoneNumber:'+2348031234567'}).catch(error=>error);

		expect(failure).toMatchObject({
			message:'AKEDLY_ATTEMPT_REJECTED',
			providerCode:'CAPTCHA_NOT_VERIFIED',
			httpStatus:200,
		});
		expect(failure.providerMessage).toBe('private provider response');
	});

	it('uses an authenticated server-side attempt status lookup',async()=>{
		let requestHeaders:HeadersInit|undefined;
		let requestBody:unknown;
		vi.stubGlobal('fetch',vi.fn(async(_input:RequestInfo|URL,init?:RequestInit)=>{
			requestHeaders=init?.headers;
			requestBody=JSON.parse(String(init?.body));
			return new Response(JSON.stringify({status:'success',data:{status:'pending'}}),{status:200});
		}));

		await lookupAkedlyAttempt('attempt_1234567890');

		expect(requestHeaders).toMatchObject({authorization:'Bearer test-api-key'});
		expect(requestBody).toEqual({attemptId:'attempt_1234567890'});
	});

	it('retains safe status-lookup failure details without provider response text',async()=>{
		vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({
			status:'error',
			error:{code:'invalid_api_key',message:'private detail: person@example.invalid'},
		}),{status:401,headers:{'content-type':'application/json'}})));

		const failure=await lookupAkedlyAttempt('attempt_1234567890').catch(error=>error);

		expect(failure).toMatchObject({
			message:'AKEDLY_LOOKUP_FAILED',
			httpStatus:401,
			providerCode:'INVALID_API_KEY',
			providerEndpoint:'https://api.akedly.io/api/v1/transactions/status',
			failureTimestamp:expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
		});
		expect(JSON.stringify(failure)).not.toContain('person@example.invalid');
		expect(JSON.stringify(failure)).not.toContain('private detail');
	});

	it('verifies raw webhook signatures and rejects tampering and stale deliveries',()=>{
		const rawBody=JSON.stringify(successfulResult());
		const timestamp=new Date();
		const webhook=new Webhook(akedlyEnvironment.AKEDLY_WEBHOOK_SECRET);
		const headers={
			'svix-id':'msg_123456789',
			'svix-timestamp':String(Math.floor(timestamp.getTime()/1000)),
			'svix-signature':webhook.sign('msg_123456789',timestamp,rawBody),
		};

		expect(()=>verifyAkedlyWebhook(rawBody,headers)).not.toThrow();
		expect(()=>verifyAkedlyWebhook(`${rawBody} `,headers)).toThrow();

		const staleTimestamp=new Date(Date.now()-10*60_000);
		expect(()=>verifyAkedlyWebhook(rawBody,{
			'svix-id':'msg_stale',
			'svix-timestamp':String(Math.floor(staleTimestamp.getTime()/1000)),
			'svix-signature':webhook.sign('msg_stale',staleTimestamp,rawBody),
		})).toThrow();
	});

	it('accepts only successful, non-test results bound to the configured widget, pipeline, and contact',()=>{
		const attemptId='attempt_1234567890';
		const result=successfulResult(attemptId);
		expect(isConfirmedAkedlyAttempt(result,attemptId,{email:'person@example.invalid'})).toBe(true);
		expect(isConfirmedAkedlyAttempt(successfulResult(attemptId),attemptId,{phoneNumber:'+12125550123'})).toBe(true);
		expect(isConfirmedAkedlyAttempt(result,attemptId,{email:'person@example.invalid'},new Date('2026-11-02T00:00:31.000Z'))).toBe(true);
		expect(isConfirmedAkedlyAttempt(result,attemptId,{email:'person@example.invalid'},new Date('2026-11-02T00:00:29.000Z'))).toBe(false);
		expect(isConfirmedAkedlyAttempt(successfulResult('attempt_different'),attemptId,{email:'person@example.invalid'})).toBe(false);
		expect(isConfirmedAkedlyAttempt({
			...successfulResult(attemptId),
			transaction:{...successfulResult().transaction,isTest:true},
		},attemptId,{email:'person@example.invalid'})).toBe(false);
		expect(isConfirmedAkedlyAttempt({
			...successfulResult(attemptId),
			widgetAttempt:{...successfulResult().widgetAttempt,isTest:true},
		},attemptId,{email:'person@example.invalid'})).toBe(false);
		expect(isConfirmedAkedlyAttempt({
			...successfulResult(attemptId),
			transaction:{...successfulResult().transaction,pipelineID:'other-pipeline'},
		},attemptId,{email:'person@example.invalid'})).toBe(false);
		expect(isConfirmedAkedlyAttempt(successfulResult(attemptId),attemptId,{email:'other@example.invalid'})).toBe(false);
	});

	it('confirms unsigned callbacks only from a successful authenticated lookup',()=>{
		const lookup={status:'success',transaction:{
			status:'Successful',
			isTest:false,
			pipelineID:'test-pipeline',
			verificationAddress:{email:'person@example.invalid'},
			updateDate:'2026-11-02T00:00:30.000Z',
		}};
		expect(isConfirmedAkedlyLookup(lookup,{email:'person@example.invalid'})).toBe(true);
		expect(isConfirmedAkedlyLookup(lookup,{email:'person@example.invalid'},new Date('2026-11-02T00:00:29.000Z'))).toBe(false);
		expect(isConfirmedAkedlyLookup({...lookup,status:'pending'},{email:'person@example.invalid'})).toBe(false);
		expect(isConfirmedAkedlyLookup({...lookup,transaction:{...lookup.transaction,isTest:true}},{email:'person@example.invalid'})).toBe(false);
		expect(isConfirmedAkedlyLookup({...lookup,transaction:{...lookup.transaction,verificationAddress:{email:'other@example.invalid'}}},{email:'person@example.invalid'})).toBe(false);
	});
});
