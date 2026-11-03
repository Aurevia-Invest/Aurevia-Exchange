import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {Webhook} from 'svix';

const mocks=vi.hoisted(()=>({
	complete:vi.fn(),
	reconcile:vi.fn(),
	rateLimit:vi.fn(),
	registrationFindFirst:vi.fn(),
}));

vi.mock('@/lib/akedly-verification',()=>({
	completeAkedlyVerification:mocks.complete,
	reconcileAkedlyAttempt:mocks.reconcile,
}));
vi.mock('@/lib/rate-limit',()=>({rateLimit:mocks.rateLimit}));
vi.mock('@/lib/db',()=>({db:{registrationVerification:{findFirst:mocks.registrationFindFirst}}}));

import {POST} from '@/app/api/webhooks/akedly/route';

const webhookSecret=`whsec_${Buffer.from('test-webhook-secret').toString('base64')}`;

function env(){
	vi.stubEnv('AKEDLY_ENABLED','true');
	vi.stubEnv('AKEDLY_API_KEY','test-api-key');
	vi.stubEnv('AKEDLY_PIPELINE_ID','test-pipeline');
	vi.stubEnv('AKEDLY_WIDGET_ID','test-widget');
	vi.stubEnv('AKEDLY_PUBLIC_KEY','test-public-key');
	vi.stubEnv('AKEDLY_WIDGET_SECRET','test-widget-secret');
	vi.stubEnv('AKEDLY_WEBHOOK_SECRET',webhookSecret);
}

function signedRequest(body:unknown){
	const rawBody=JSON.stringify(body);
	const id='msg_123456789';
	const timestamp=new Date();
	const signature=new Webhook(webhookSecret).sign(id,timestamp,rawBody);
	return new Request('https://aurevia.test/api/webhooks/akedly',{
		method:'POST',
		headers:{
			'content-type':'application/json',
			'svix-id':id,
			'svix-timestamp':String(Math.floor(timestamp.getTime()/1000)),
			'svix-signature':signature,
		},
		body:rawBody,
	});
}

function result(){
	return {status:'success',widgetAttempt:{attemptId:'attempt_1234567890',status:'verified'}};
}

describe('Akedly webhook route',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		env();
		mocks.complete.mockResolvedValue('verified');
		mocks.reconcile.mockResolvedValue('verified');
		mocks.registrationFindFirst.mockResolvedValue(null);
		mocks.rateLimit.mockImplementation(()=>undefined);
	});

	afterEach(()=>vi.unstubAllEnvs());

	it('processes signed raw-body results through the idempotent application handler',async()=>{
		const response=await POST(signedRequest(result()));

		expect(response.status).toBe(200);
		expect(mocks.complete).toHaveBeenCalledWith('attempt_1234567890',result(),'webhook');
		expect(mocks.reconcile).not.toHaveBeenCalled();
	});

	it('rejects invalid signatures without processing the callback',async()=>{
		const request=signedRequest(result());
		const headers=new Headers(request.headers);
		headers.set('svix-signature','v1,invalid');
		const tampered=new Request(request.url,{method:'POST',headers,body:JSON.stringify(result())});
		const warning=vi.spyOn(console,'warn').mockImplementation(()=>undefined);

		const response=await POST(tampered);

		expect(response.status).toBe(401);
		expect(mocks.complete).not.toHaveBeenCalled();
		expect(warning).toHaveBeenCalledWith(
			'[akedly-webhook] Signature validation failed.',
			expect.objectContaining({
				requestId:expect.any(String),
				referenceId:expect.any(String),
				endpoint:'/api/webhooks/akedly',
				failureCode:'INVALID_WEBHOOK_SIGNATURE',
				failureTimestamp:expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
			}),
		);
		expect(JSON.stringify(warning.mock.calls)).not.toContain('v1,invalid');
		warning.mockRestore();
	});

	it('confirms unsigned verification results through authenticated provider reconciliation',async()=>{
		const response=await POST(new Request('https://aurevia.test/api/webhooks/akedly',{
			method:'POST',
			headers:{'content-type':'application/json'},
			body:JSON.stringify(result()),
		}));

		expect(response.status).toBe(200);
		expect(mocks.reconcile).toHaveBeenCalledWith('attempt_1234567890');
		expect(mocks.complete).not.toHaveBeenCalled();
	});

	it('defers unsigned temporary-registration results to the owner session',async()=>{
		mocks.registrationFindFirst.mockResolvedValue({id:'registration-verification-1'});
		const response=await POST(new Request('https://aurevia.test/api/webhooks/akedly',{
			method:'POST',
			headers:{'content-type':'application/json'},
			body:JSON.stringify(result()),
		}));

		expect(response.status).toBe(200);
		expect(mocks.reconcile).not.toHaveBeenCalled();
		expect(mocks.complete).not.toHaveBeenCalled();
	});

	it('rejects unsigned event webhooks and incomplete signature headers',async()=>{
		const unsignedEvent=await POST(new Request('https://aurevia.test/api/webhooks/akedly',{
			method:'POST',
			headers:{'content-type':'application/json'},
			body:JSON.stringify({eventType:'otp.channels.sent'}),
		}));
		const partialSignature=await POST(new Request('https://aurevia.test/api/webhooks/akedly',{
			method:'POST',
			headers:{'content-type':'application/json','svix-id':'msg_123456789'},
			body:JSON.stringify(result()),
		}));

		expect(unsignedEvent.status).toBe(401);
		expect(partialSignature.status).toBe(401);
		expect(mocks.complete).not.toHaveBeenCalled();
		expect(mocks.reconcile).not.toHaveBeenCalled();
	});
	it('rate limits webhook requests before processing events',async()=>{
		mocks.rateLimit.mockImplementation(()=>{throw new Error('RATE_LIMITED')});
		const response=await POST(signedRequest(result()));

		expect(response.status).toBe(429);
		expect(mocks.complete).not.toHaveBeenCalled();
	});

	it('accepts duplicate signed deliveries for the idempotent persistence handler',async()=>{
		const first=await POST(signedRequest(result()));
		const replay=await POST(signedRequest(result()));

		expect(first.status).toBe(200);
		expect(replay.status).toBe(200);
		expect(mocks.complete).toHaveBeenCalledTimes(2);
	});

	it('fails closed when the provider credentials are absent',async()=>{
		vi.stubEnv('AKEDLY_API_KEY','');
		const response=await POST(signedRequest(result()));
		expect(response.status).toBe(503);
		expect(mocks.complete).not.toHaveBeenCalled();
	});
});
