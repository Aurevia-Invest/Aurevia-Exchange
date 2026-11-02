import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';

const mocks=vi.hoisted(()=>({
	findUnique:vi.fn(),
	deleteMany:vi.fn(),
	verificationDeleteMany:vi.fn(),
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
	registrationAttempt:{findUnique:mocks.findUnique,deleteMany:mocks.deleteMany},
	registrationVerification:{deleteMany:mocks.verificationDeleteMany},
}}));
vi.mock('@/lib/rate-limit',()=>({rateLimit:mocks.rateLimit,RateLimitError:mocks.RateLimitError}));

import {POST} from '@/app/api/register/session/route';

const registrationToken='b'.repeat(43);
const attempt={
	id:'registration-1',
	email:'person@example.invalid',
	expiresAt:new Date(Date.now()+60_000),
	verification:{expiresAt:new Date(Date.now()+60_000)},
};

function request(){
	return new Request('https://aurevia.test/api/register/session',{
		method:'POST',
		headers:{'content-type':'application/json','x-forwarded-for':'192.0.2.9'},
		body:JSON.stringify({email:attempt.email,registrationToken}),
	});
}

describe('registration session restore',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		mocks.findUnique.mockResolvedValue(attempt);
		mocks.deleteMany.mockResolvedValue({count:1});
		mocks.verificationDeleteMany.mockResolvedValue({count:1});
	});

	afterEach(()=>vi.unstubAllEnvs());

	it('restores only the matching short-lived session using a hashed token lookup',async()=>{
		const response=await POST(request());
		const body=await response.json();

		expect(response.status).toBe(200);
		expect(body).toEqual({restored:true});
		expect(JSON.stringify(body)).not.toContain(registrationToken);
		expect(mocks.findUnique).toHaveBeenCalledWith({
			where:{tokenHash:createHash('sha256').update(registrationToken).digest('hex')},
			include:{verification:true},
		});
		expect(response.headers.get('set-cookie')).toContain('HttpOnly');
		expect(response.headers.get('set-cookie')).toContain('SameSite=lax');
	});

	it('invalidates and clears expired sessions',async()=>{
		mocks.findUnique.mockResolvedValue({...attempt,expiresAt:new Date(Date.now()-1000)});
		const response=await POST(request());

		expect(response.status).toBe(410);
		expect(mocks.deleteMany).toHaveBeenCalledWith({where:{id:attempt.id}});
		expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
	});

	it('restores a still-valid registration after deleting only its expired provider challenge',async()=>{
		mocks.findUnique.mockResolvedValue({...attempt,verification:{expiresAt:new Date(Date.now()-1000)}});
		const response=await POST(request());

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({restored:true});
		expect(mocks.deleteMany).not.toHaveBeenCalled();
		expect(mocks.verificationDeleteMany).toHaveBeenCalledWith({
			where:{registrationAttemptId:attempt.id,expiresAt:{lte:expect.any(Date)}},
		});
	});
});
