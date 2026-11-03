import {createHmac} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {Webhook} from 'svix';
import {
	akedlyReadiness,
	createAkedlyAttempt,
	isConfirmedAkedlyAttempt,
	isConfirmedAkedlyLookup,
	lookupAkedlyAttempt,
	verifyAkedlyWebhook,
} from '@/lib/akedly';

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

	it('includes the E.164 phone number in the phone HMAC message',async()=>{
		let requestBody:Record<string,unknown>|undefined;
		vi.stubGlobal('fetch',vi.fn(async(_input:RequestInfo|URL,init?:RequestInit)=>{
			requestBody=JSON.parse(String(init?.body)) as Record<string,unknown>;
			return providerResponse();
		}));

		await createAkedlyAttempt({phoneNumber:'+12125550123'});
		if(!requestBody)throw new Error('Akedly request was not captured.');
		const body=requestBody;
		const signingMessage=JSON.stringify({
			apiKey:'test-api-key',
			publicKey:'test-public-key',
			timestamp:body.timestamp,
			phoneNumber:'+12125550123',
		});
		expect(body.signature).toBe(createHmac('sha256','test-widget-secret').update(signingMessage,'utf8').digest('hex'));
		expect(body.verificationAddress).toEqual({phoneNumber:'+12125550123'});
	});

	it('fails closed without credentials and rejects an untrusted widget URL',async()=>{
		vi.stubEnv('AKEDLY_WEBHOOK_SECRET','');
		const fetch=vi.fn();
		vi.stubGlobal('fetch',fetch);
		await expect(createAkedlyAttempt({email:'person@example.invalid'})).rejects.toThrow('AKEDLY_CONFIGURATION_REQUIRED');
		expect(fetch).not.toHaveBeenCalled();

		vi.stubEnv('AKEDLY_WEBHOOK_SECRET',akedlyEnvironment.AKEDLY_WEBHOOK_SECRET);
		vi.stubGlobal('fetch',vi.fn(async()=>providerResponse('attempt_1234567890','https://attacker.invalid/auth?attemptId=attempt_1234567890')));
		await expect(createAkedlyAttempt({email:'person@example.invalid'})).rejects.toThrow('AKEDLY_INVALID_WIDGET_URL');
	});

	it('reports only missing configuration variable names and never credential values',()=>{
		vi.stubEnv('AKEDLY_WIDGET_SECRET','');

		const readiness=akedlyReadiness();

		expect(readiness).toEqual({enabled:true,missing:['AKEDLY_WIDGET_SECRET'],ready:false});
		expect(JSON.stringify(readiness)).not.toContain('test-api-key');
		expect(JSON.stringify(readiness)).not.toContain('test-widget-secret');
	});

	it('retains the HTTP status and only a safe provider code for a rejected attempt',async()=>{
		vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({
			status:'error',
			error:{code:'invalid_signature',message:'private provider response for person@example.invalid'},
		}),{status:401,headers:{'content-type':'application/json'}})));

		const failure=await createAkedlyAttempt({email:'person@example.invalid'}).catch(error=>error);
		expect(failure).toMatchObject({
			message:'AKEDLY_ATTEMPT_REJECTED',
			httpStatus:401,
			providerCode:'INVALID_SIGNATURE',
		});
		expect(JSON.stringify(failure)).not.toContain('private provider response');
		expect(JSON.stringify(failure)).not.toContain('person@example.invalid');
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
		expect(JSON.stringify(failure)).not.toContain('private provider details');
		expect(JSON.stringify(failure)).not.toContain('+2348031234567');
	});

	it('parses safe retry durations from rate-limit responses',async()=>{
		vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({
			status:'error',
			error:{code:'CHANNEL_QUOTA_EXCEEDED',retryAfterSeconds:75,message:'private provider response'},
		}),{status:429,headers:{'content-type':'application/json'}})));

		const failure=await createAkedlyAttempt({phoneNumber:'+2348031234567'}).catch(error=>error);

		expect(failure).toMatchObject({
			message:'AKEDLY_ATTEMPT_REJECTED',
			httpStatus:429,
			providerCode:'CHANNEL_QUOTA_EXCEEDED',
			retryAfterSeconds:75,
		});
		expect(JSON.stringify(failure)).not.toContain('private provider response');
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
		});
		expect(JSON.stringify(failure)).not.toContain('private provider response');
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
