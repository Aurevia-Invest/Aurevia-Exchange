import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	findUnique:vi.fn(),
	getState:vi.fn(),
	reconcile:vi.fn(),
	requireUser:vi.fn(),
	rateLimit:vi.fn(),
}));

vi.mock('@/lib/db',()=>({db:{user:{findUnique:mocks.findUnique}}}));
vi.mock('@/lib/akedly-verification',()=>({getAkedlyVerificationState:mocks.getState,reconcileAkedlyAttempt:mocks.reconcile}));
vi.mock('@/lib/auth',()=>({requireUser:mocks.requireUser}));
vi.mock('@/lib/rate-limit',()=>({rateLimit:mocks.rateLimit}));

import {VerificationChannel} from '@prisma/client';
import {AkedlyProviderError} from '@/lib/akedly';
import {POST as phoneStatus} from '@/app/api/kyc/phone/status/route';

function request(body:unknown){
	return new Request('https://aurevia.test/api/kyc/phone/status',{
		method:'POST',
		headers:{'content-type':'application/json','x-forwarded-for':'192.0.2.2'},
		body:JSON.stringify(body),
	});
}

describe('Tier 3 Akedly verification status route',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		mocks.findUnique.mockResolvedValue({
			accountMode:'REAL',status:'ACTIVE',approvedTier:2,
			name:'Test User',country:'Nigeria',phone:'+2348031234567',
		});
		mocks.requireUser.mockResolvedValue({id:'user-1'});
		mocks.getState.mockResolvedValue({verified:false,expiresAt:new Date(Date.now()+60_000)});
		mocks.reconcile.mockResolvedValue('pending');
	});

	afterEach(()=>vi.unstubAllEnvs());

	it('requires the authenticated owner and returns the bound phone-verification state',async()=>{
		mocks.getState.mockResolvedValue({verified:true,expiresAt:new Date(Date.now()+60_000)});
		const response=await phoneStatus(request({attemptId:'attempt_1234567890'}));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({verified:true});
		expect(mocks.getState).toHaveBeenCalledWith('user-1','attempt_1234567890',VerificationChannel.SMS);
		expect(mocks.reconcile).not.toHaveBeenCalled();
	});

	it('reconciles an unverified attempt with Akedly and returns its updated state',async()=>{
		mocks.getState
			.mockResolvedValueOnce({verified:false,expiresAt:new Date(Date.now()+60_000)})
			.mockResolvedValueOnce({verified:true,expiresAt:new Date(Date.now()+60_000)});
		const response=await phoneStatus(request({attemptId:'attempt_1234567890'}));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({verified:true});
		expect(mocks.reconcile).toHaveBeenCalledWith('attempt_1234567890','user-1');
		expect(mocks.getState).toHaveBeenCalledTimes(2);
	});

	it('does not query Akedly for expired or unknown attempts',async()=>{
		mocks.getState
			.mockResolvedValueOnce({verified:false,expiresAt:new Date(Date.now()-1000)})
			.mockResolvedValueOnce(null);
		const expired=await phoneStatus(request({attemptId:'attempt_1234567890'}));
		const missing=await phoneStatus(request({attemptId:'attempt_1234567890'}));

		expect(await expired.json()).toEqual({verified:false,expired:true});
		expect(missing.status).toBe(404);
		expect(mocks.reconcile).not.toHaveBeenCalled();
	});

	it('logs sanitized provider failures with a client reference ID',async()=>{
		mocks.reconcile.mockRejectedValue(new AkedlyProviderError(
			'AKEDLY_LOOKUP_FAILED',401,'INVALID_API_KEY',undefined,
			{providerEndpoint:'https://api.akedly.io/api/v1/transactions/status'},
		));
		const warning=vi.spyOn(console,'warn').mockImplementation(()=>undefined);
		const response=await phoneStatus(request({attemptId:'attempt_1234567890'}));
		const body=await response.json();

		expect(response.status).toBe(503);
		expect(body).toMatchObject({error:'Unable to check phone verification right now.',requestId:expect.any(String),referenceId:expect.any(String)});
		expect(body.referenceId).toBe(body.requestId);
		expect(warning).toHaveBeenCalledWith('[akedly-phone] Provider status reconciliation failed.',expect.objectContaining({
			requestId:body.referenceId,referenceId:body.referenceId,endpoint:'/api/kyc/phone/status',
			failureCode:'AKEDLY_LOOKUP_FAILED',providerHttpStatus:401,providerCode:'INVALID_API_KEY',
		}));
		expect(JSON.stringify(body)).not.toContain('INVALID_API_KEY');
		warning.mockRestore();
	});
});
