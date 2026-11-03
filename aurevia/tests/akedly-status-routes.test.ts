import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	findUnique:vi.fn(),
	getState:vi.fn(),
	registrationAttemptFindUnique:vi.fn(),
	registrationAttemptDeleteMany:vi.fn(),
	registrationVerificationDeleteMany:vi.fn(),
	reconcile:vi.fn(),
	requireUser:vi.fn(),
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
	user:{findUnique:mocks.findUnique},
	registrationAttempt:{findUnique:mocks.registrationAttemptFindUnique,deleteMany:mocks.registrationAttemptDeleteMany},
	registrationVerification:{deleteMany:mocks.registrationVerificationDeleteMany},
}}));
vi.mock('@/lib/akedly-verification',()=>({getAkedlyVerificationState:mocks.getState,reconcileAkedlyAttempt:mocks.reconcile}));
vi.mock('@/lib/auth',()=>({requireUser:mocks.requireUser}));
vi.mock('@/lib/rate-limit',()=>({rateLimit:mocks.rateLimit,RateLimitError:mocks.RateLimitError}));

import {POST as registrationStatus} from '@/app/api/register/status/route';
import {POST as phoneStatus} from '@/app/api/kyc/phone/status/route';
import {AkedlyProviderError} from '@/lib/akedly';
import {VerificationChannel} from '@prisma/client';

function request(url:string,body:unknown){
	return new Request(url,{method:'POST',headers:{'content-type':'application/json','x-forwarded-for':'192.0.2.2'},body:JSON.stringify(body)});
}

describe('Akedly verification status routes',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		mocks.findUnique.mockResolvedValue({id:'user-1',role:'USER',status:'ACTIVE'});
		mocks.requireUser.mockResolvedValue({id:'user-1'});
		mocks.getState.mockResolvedValue({verified:false,expiresAt:new Date(Date.now()+60_000)});
		mocks.registrationAttemptFindUnique.mockResolvedValue(null);
		mocks.registrationAttemptDeleteMany.mockResolvedValue({count:1});
		mocks.registrationVerificationDeleteMany.mockResolvedValue({count:1});
		mocks.reconcile.mockResolvedValue('pending');
	});

	afterEach(()=>vi.unstubAllEnvs());

	it('returns only the state of a registration attempt owned by the requested account',async()=>{
		const response=await registrationStatus(request('https://aurevia.test/api/register/status',{
			email:'person@example.invalid',
			attemptId:'attempt_1234567890',
		}));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({verified:false,expired:false});
		expect(mocks.getState).toHaveBeenCalledWith('user-1','attempt_1234567890',VerificationChannel.EMAIL);
	});

	it('reports a missing registration attempt without consulting unowned state',async()=>{
		mocks.findUnique.mockResolvedValue(null);
		const response=await registrationStatus(request('https://aurevia.test/api/register/status',{
			email:'person@example.invalid',
			attemptId:'attempt_1234567890',
		}));

		expect(response.status).toBe(404);
		expect(mocks.getState).not.toHaveBeenCalled();
	});

	it('keeps a registration session resumable when only its provider challenge expired',async()=>{
		const token='a'.repeat(43);
		mocks.registrationAttemptFindUnique.mockResolvedValue({
			id:'registration-1',
			email:'person@example.invalid',
			expiresAt:new Date(Date.now()+60_000),
			verification:{expiresAt:new Date(Date.now()-1000)},
		});
		const sessionRequest=new Request('https://aurevia.test/api/register/status',{
			method:'POST',
			headers:{
				'content-type':'application/json',
				cookie:`aurevia_registration=${token}`,
			},
			body:JSON.stringify({email:'person@example.invalid',attemptId:'attempt_1234567890'}),
		});
		const response=await registrationStatus(sessionRequest);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({verified:false,expired:true,sessionExpired:false});
		expect(mocks.registrationVerificationDeleteMany).toHaveBeenCalledWith({
			where:{registrationAttemptId:'registration-1',expiresAt:{lte:expect.any(Date)}},
		});
		expect(mocks.registrationAttemptDeleteMany).not.toHaveBeenCalled();
	});

	it('reports a phone conflict after Akedly verification without creating an account',async()=>{
		mocks.registrationAttemptFindUnique.mockResolvedValue({
			id:'registration-1',
			email:'person@example.invalid',
			expiresAt:new Date(Date.now()+60_000),
			verification:{expiresAt:new Date(Date.now()+60_000),providerReference:'AKEDLY:attempt_1234567890'},
		});
		mocks.reconcile.mockResolvedValue('phone-conflict');
		const token='a'.repeat(43);
		const response=await registrationStatus(new Request('https://aurevia.test/api/register/status',{
			method:'POST',
			headers:{'content-type':'application/json',cookie:`aurevia_registration=${token}`},
			body:JSON.stringify({email:'person@example.invalid',attemptId:'attempt_1234567890'}),
		}));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({verified:false,phoneConflict:true});
		expect(mocks.reconcile).toHaveBeenCalledWith('attempt_1234567890');
	});

	it('logs sanitized Akedly lookup failures during registration status polling',async()=>{
		mocks.registrationAttemptFindUnique.mockResolvedValue({
			id:'registration-1',
			email:'person@example.invalid',
			expiresAt:new Date(Date.now()+60_000),
			verification:{
				expiresAt:new Date(Date.now()+60_000),
				providerReference:'AKEDLY:attempt_1234567890',
			},
		});
		mocks.reconcile.mockRejectedValue(new AkedlyProviderError(
			'AKEDLY_LOOKUP_FAILED',
			401,
			'INVALID_API_KEY',
			undefined,
			{providerEndpoint:'https://api.akedly.io/api/v1/transactions/status'},
		));
		const warning=vi.spyOn(console,'error').mockImplementation(()=>undefined);
		const token='a'.repeat(43);
		const response=await registrationStatus(new Request('https://aurevia.test/api/register/status',{
			method:'POST',
			headers:{
				'content-type':'application/json',
				cookie:`aurevia_registration=${token}`,
			},
			body:JSON.stringify({email:'person@example.invalid',attemptId:'attempt_1234567890'}),
		}));
		const body=await response.json();

		expect(response.status).toBe(503);
		expect(body).toMatchObject({
			error:'Unable to check verification status right now.',
			requestId:expect.any(String),
			referenceId:expect.any(String),
		});
		expect(body.referenceId).toBe(body.requestId);
		expect(warning).toHaveBeenCalledWith(
			'[akedly-registration] Unable to check verification status.',
			expect.objectContaining({
				requestId:body.referenceId,
				referenceId:body.referenceId,
				endpoint:'/api/register/status',
				failureCode:'AKEDLY_LOOKUP_FAILED',
				providerEndpoint:'https://api.akedly.io/api/v1/transactions/status',
				providerHttpStatus:401,
				providerCode:'INVALID_API_KEY',
			}),
		);
		expect(JSON.stringify(body)).not.toContain('INVALID_API_KEY');
		warning.mockRestore();
	});

	it('requires the authenticated owner for phone status and returns verified state',async()=>{
		mocks.getState.mockResolvedValue({verified:true,expiresAt:new Date(Date.now()+60_000)});
		const response=await phoneStatus(request('https://aurevia.test/api/kyc/phone/status',{
			attemptId:'attempt_1234567890',
		}));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({verified:true});
		expect(mocks.getState).toHaveBeenCalledWith('user-1','attempt_1234567890',VerificationChannel.SMS);
		expect(mocks.reconcile).not.toHaveBeenCalled();
	});

	it('reconciles an unverified phone attempt with Akedly and returns its updated state',async()=>{
		mocks.getState
			.mockResolvedValueOnce({verified:false,expiresAt:new Date(Date.now()+60_000)})
			.mockResolvedValueOnce({verified:true,expiresAt:new Date(Date.now()+60_000)});

		const response=await phoneStatus(request('https://aurevia.test/api/kyc/phone/status',{
			attemptId:'attempt_1234567890',
		}));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({verified:true});
		expect(mocks.reconcile).toHaveBeenCalledWith('attempt_1234567890','user-1');
		expect(mocks.getState).toHaveBeenCalledTimes(2);
	});

	it('does not query Akedly for expired or unknown phone attempts',async()=>{
		mocks.getState
			.mockResolvedValueOnce({verified:false,expiresAt:new Date(Date.now()-1000)})
			.mockResolvedValueOnce(null);

		const expired=await phoneStatus(request('https://aurevia.test/api/kyc/phone/status',{
			attemptId:'attempt_1234567890',
		}));
		const missing=await phoneStatus(request('https://aurevia.test/api/kyc/phone/status',{
			attemptId:'attempt_1234567890',
		}));

		expect(expired.status).toBe(200);
		expect(await expired.json()).toEqual({verified:false,expired:true});
		expect(missing.status).toBe(404);
		expect(mocks.reconcile).not.toHaveBeenCalled();
	});

	it('logs sanitized provider status failures with a client reference ID',async()=>{
		mocks.reconcile.mockRejectedValue(new AkedlyProviderError(
			'AKEDLY_LOOKUP_FAILED',
			401,
			'INVALID_API_KEY',
			undefined,
			{providerEndpoint:'https://api.akedly.io/api/v1/transactions/status'},
		));
		const warning=vi.spyOn(console,'warn').mockImplementation(()=>undefined);

		const response=await phoneStatus(request('https://aurevia.test/api/kyc/phone/status',{
			attemptId:'attempt_1234567890',
		}));
		const body=await response.json();

		expect(response.status).toBe(503);
		expect(body).toMatchObject({
			error:'Unable to check phone verification right now.',
			requestId:expect.any(String),
			referenceId:expect.any(String),
		});
		expect(body.referenceId).toBe(body.requestId);
		expect(warning).toHaveBeenCalledWith(
			'[akedly-phone] Provider status reconciliation failed.',
			expect.objectContaining({
				requestId:body.referenceId,
				referenceId:body.referenceId,
				endpoint:'/api/kyc/phone/status',
				failureCode:'AKEDLY_LOOKUP_FAILED',
				providerEndpoint:'https://api.akedly.io/api/v1/transactions/status',
				providerHttpStatus:401,
				providerCode:'INVALID_API_KEY',
			}),
		);
		expect(JSON.stringify(body)).not.toContain('INVALID_API_KEY');
		warning.mockRestore();
	});
});
