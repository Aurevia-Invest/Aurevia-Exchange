import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {Webhook} from 'svix';

const mocks=vi.hoisted(()=>({
	complete:vi.fn(),
	reconcile:vi.fn(),
	rateLimit:vi.fn(),
}));

vi.mock('@/lib/akedly-verification',()=>({
	completeAkedlyVerification:mocks.complete,
	reconcileAkedlyAttempt:mocks.reconcile,
}));
vi.mock('@/lib/rate-limit',()=>({rateLimit:mocks.rateLimit}));

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
		mocks.rateLimit.mockImplementation(()=>undefined);
	});

	afterEach(()=>vi.unstubAllEnvs());

	it('processes signed raw-body results through the idempotent application handler',async()=>{
		const response=await POST(signedRequest(result()));

		expect(response.status).toBe(200);
		expect(mocks.complete).toHaveBeenCalledWith('attempt_1234567890',result(),'webhook');
		expect(mocks.reconcile).not.toHaveBeenCalled();
	});

	it('accepts the Standard Webhooks header aliases supported by Svix',async()=>{
		const request=signedRequest(result());
		const response=await POST(new Request(request.url,{
			method:'POST',
			headers:{
				'content-type':'application/json',
				'webhook-id':request.headers.get('svix-id')!,
				'webhook-timestamp':request.headers.get('svix-timestamp')!,
				'webhook-signature':request.headers.get('svix-signature')!,
			},
			body:JSON.stringify(result()),
		}));

		expect(response.status).toBe(200);
		expect(mocks.complete).toHaveBeenCalledWith('attempt_1234567890',result(),'webhook');
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

	it('rejects unsigned event webhooks',async()=>{
		const response=await POST(new Request('https://aurevia.test/api/webhooks/akedly',{
			method:'POST',
			headers:{'content-type':'application/json'},
			body:JSON.stringify({eventType:'otp.channels.sent'}),
		}));

		expect(response.status).toBe(401);
		expect(mocks.complete).not.toHaveBeenCalled();
		expect(mocks.reconcile).not.toHaveBeenCalled();
	});

	it.each(['svix-id','svix-timestamp','svix-signature'])(
		'reconciles an unsigned result if the %s signature header is missing',
		async missingHeader=>{
			const request=signedRequest(result());
			const headers=new Headers(request.headers);
			headers.delete(missingHeader);
			const partialRequest=new Request(request.url,{method:'POST',headers,body:JSON.stringify(result())});
			const warning=vi.spyOn(console,'warn').mockImplementation(()=>undefined);

			const response=await POST(partialRequest);

			expect(response.status).toBe(200);
			expect(mocks.reconcile).toHaveBeenCalledWith('attempt_1234567890');
			expect(mocks.complete).not.toHaveBeenCalled();
			expect(warning).toHaveBeenCalledWith(
				'[akedly-webhook] Signature headers are incomplete.',
				expect.objectContaining({
					endpoint:'/api/webhooks/akedly',
					failureCode:'INCOMPLETE_SIGNATURE_HEADERS',
					presentHeaders:expect.any(Array),
					missingHeaders:[missingHeader],
				}),
			);
			expect(JSON.stringify(warning.mock.calls)).not.toContain(request.headers.get('svix-signature'));
			warning.mockRestore();
		},
	);

	it('rejects events with incomplete signature headers and logs only header names',async()=>{
		const request=signedRequest({eventType:'otp.channels.sent'});
		const headers=new Headers(request.headers);
		headers.delete('svix-id');
		const partialRequest=new Request(request.url,{method:'POST',headers,body:JSON.stringify({eventType:'otp.channels.sent'})});
		const warning=vi.spyOn(console,'warn').mockImplementation(()=>undefined);

		const response=await POST(partialRequest);

		expect(response.status).toBe(401);
		expect(mocks.complete).not.toHaveBeenCalled();
		expect(mocks.reconcile).not.toHaveBeenCalled();
		expect(warning).toHaveBeenCalledWith(
			'[akedly-webhook] Signature headers are incomplete.',
			expect.objectContaining({
				presentHeaders:['svix-timestamp','svix-signature'],
				missingHeaders:['svix-id'],
			}),
		);
		expect(JSON.stringify(warning.mock.calls)).not.toContain(request.headers.get('svix-signature'));
		warning.mockRestore();
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
