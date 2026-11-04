import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	findFirst:vi.fn(),
	reconcile:vi.fn(),
}));

vi.mock('@/lib/db',()=>({db:{
	verificationCode:{findFirst:mocks.findFirst},
}}));
vi.mock('@/lib/akedly-verification',()=>({reconcileAkedlyAttempt:mocks.reconcile}));
vi.mock('@/lib/rate-limit',()=>({rateLimit:vi.fn()}));
vi.mock('@/lib/akedly',()=>({akedlyIsConfigured:vi.fn(()=>true)}));

import {VerificationChannel} from '@prisma/client';
import {POST} from '@/app/api/auth/akedly/callback/route';

function request(body:unknown){
	return new Request('https://aurevia.test/api/auth/akedly/callback',{
		method:'POST',
		headers:{'content-type':'application/json','x-forwarded-for':'192.0.2.1'},
		body:JSON.stringify(body),
	});
}

describe('Akedly callback route',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		mocks.findFirst.mockResolvedValue({channel:VerificationChannel.SMS});
		mocks.reconcile.mockResolvedValue('verified');
	});

	afterEach(()=>vi.unstubAllEnvs());

	it('treats the redirect as a hint and confirms successful results through Akedly lookup',async()=>{
		const response=await POST(request({attemptId:'attempt_1234567890',status:'success'}));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({verified:true,channel:VerificationChannel.SMS});
		expect(mocks.reconcile).toHaveBeenCalledWith('attempt_1234567890');
	});

	it('does not perform provider lookup for a failed redirect',async()=>{
		const response=await POST(request({attemptId:'attempt_1234567890',status:'failed'}));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({verified:false});
		expect(mocks.findFirst).not.toHaveBeenCalled();
		expect(mocks.reconcile).not.toHaveBeenCalled();
	});

	it('rejects unknown attempts and invalid callback payloads',async()=>{
		mocks.findFirst.mockResolvedValue(null);
		const unknown=await POST(request({attemptId:'attempt_1234567890',status:'success'}));
		const invalid=await POST(request({attemptId:'short',status:'success'}));

		expect(unknown.status).toBe(404);
		expect(invalid.status).toBe(400);
		expect(mocks.reconcile).not.toHaveBeenCalled();
	});

	it('does not claim a result when trusted provider reconciliation ignores it',async()=>{
		mocks.findFirst.mockResolvedValue({channel:VerificationChannel.SMS});
		mocks.reconcile.mockResolvedValue('ignored');
		const response=await POST(request({attemptId:'attempt_1234567890',status:'success'}));

		expect(await response.json()).toEqual({verified:false});
	});
});
