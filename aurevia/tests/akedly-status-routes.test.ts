import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	findUnique:vi.fn(),
	getState:vi.fn(),
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

vi.mock('@/lib/db',()=>({db:{user:{findUnique:mocks.findUnique}}}));
vi.mock('@/lib/akedly-verification',()=>({getAkedlyVerificationState:mocks.getState}));
vi.mock('@/lib/auth',()=>({requireUser:mocks.requireUser}));
vi.mock('@/lib/rate-limit',()=>({rateLimit:mocks.rateLimit,RateLimitError:mocks.RateLimitError}));

import {POST as registrationStatus} from '@/app/api/register/status/route';
import {POST as phoneStatus} from '@/app/api/kyc/phone/status/route';
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

	it('requires the authenticated owner for phone status and returns verified state',async()=>{
		mocks.getState.mockResolvedValue({verified:true,expiresAt:new Date(Date.now()+60_000)});
		const response=await phoneStatus(request('https://aurevia.test/api/kyc/phone/status',{
			attemptId:'attempt_1234567890',
		}));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({verified:true});
		expect(mocks.getState).toHaveBeenCalledWith('user-1','attempt_1234567890',VerificationChannel.SMS);
	});
});
