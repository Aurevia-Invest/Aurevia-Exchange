import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	userFindUnique:vi.fn(),
	codeFindUnique:vi.fn(),
	codeDeleteMany:vi.fn(),
	codeUpdateMany:vi.fn(),
	matches:vi.fn(),
	transaction:vi.fn(),
	txDeleteMany:vi.fn(),
	txUserUpdate:vi.fn(),
	createNotification:vi.fn(),
	rateLimit:vi.fn(),
}));

vi.mock('@/lib/db',()=>({db:{
	user:{findUnique:mocks.userFindUnique},
	verificationCode:{
		findUnique:mocks.codeFindUnique,
		deleteMany:mocks.codeDeleteMany,
		updateMany:mocks.codeUpdateMany,
	},
	$transaction:mocks.transaction,
}}));
vi.mock('@/lib/verification-delivery',()=>({verificationCodeMatches:mocks.matches}));
vi.mock('@/lib/notifications',()=>({createNotification:mocks.createNotification}));
vi.mock('@/lib/rate-limit',()=>({rateLimit:mocks.rateLimit}));

import {POST} from '@/app/api/register/verify/route';
import {VerificationChannel} from '@prisma/client';

const user={id:'user-1',emailVerifiedAt:null,requiresRegistrationVerification:true};
const challenge={
	id:'challenge-1',
	userId:user.id,
	channel:VerificationChannel.EMAIL,
	providerReference:null,
	codeHash:'secure-hash',
	expiresAt:new Date(Date.now()+60_000),
	attempts:0,
};

function request(code='123456'){
	return new Request('https://aurevia.test/api/register/verify',{
		method:'POST',
		headers:{'content-type':'application/json','x-forwarded-for':'192.0.2.4'},
		body:JSON.stringify({email:'person@example.invalid',code}),
	});
}

describe('registration email-code verification',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		mocks.userFindUnique.mockResolvedValue(user);
		mocks.codeFindUnique.mockResolvedValue(challenge);
		mocks.codeDeleteMany.mockResolvedValue({count:1});
		mocks.codeUpdateMany.mockResolvedValue({count:1});
		mocks.matches.mockReturnValue(true);
		mocks.txDeleteMany.mockResolvedValue({count:1});
		mocks.txUserUpdate.mockResolvedValue({});
		mocks.createNotification.mockResolvedValue({});
		mocks.transaction.mockImplementation(async(callback:(tx:unknown)=>Promise<unknown>)=>callback({
			verificationCode:{deleteMany:mocks.txDeleteMany},
			user:{update:mocks.txUserUpdate},
		}));
	});

	afterEach(()=>vi.unstubAllEnvs());

	it('consumes a valid email-bound code and verifies the account atomically',async()=>{
		const response=await POST(request());

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({verified:true});
		expect(mocks.matches).toHaveBeenCalledWith(user.id,'123456',challenge.codeHash);
		expect(mocks.txDeleteMany).toHaveBeenCalledWith(expect.objectContaining({
			where:expect.objectContaining({id:challenge.id,codeHash:challenge.codeHash}),
		}));
		expect(mocks.txUserUpdate).toHaveBeenCalledWith(expect.objectContaining({
			where:{id:user.id},
			data:expect.objectContaining({requiresRegistrationVerification:false,verifiedChannel:VerificationChannel.EMAIL}),
		}));
	});

	it('rejects expired codes and deletes only the expired challenge',async()=>{
		mocks.codeFindUnique.mockResolvedValue({...challenge,expiresAt:new Date(Date.now()-1000)});
		const response=await POST(request());

		expect(response.status).toBe(410);
		expect(mocks.codeDeleteMany).toHaveBeenCalledWith({where:{id:challenge.id,expiresAt:{lte:expect.any(Date)}}});
		expect(mocks.matches).not.toHaveBeenCalled();
	});

	it('counts incorrect codes and stops once the configured attempt limit is reached',async()=>{
		mocks.matches.mockReturnValue(false);
		mocks.codeFindUnique.mockResolvedValueOnce(challenge).mockResolvedValueOnce({attempts:1});
		const response=await POST(request('000000'));

		expect(response.status).toBe(400);
		expect(mocks.codeUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
			where:expect.objectContaining({id:challenge.id,attempts:{lt:5}}),
			data:{attempts:{increment:1}},
		}));

		vi.clearAllMocks();
		mocks.userFindUnique.mockResolvedValue(user);
		mocks.codeFindUnique.mockResolvedValue({...challenge,attempts:5});
		const exhausted=await POST(request('000000'));
		expect(exhausted.status).toBe(429);
		expect(mocks.matches).not.toHaveBeenCalled();
	});

	it('does not accept an email code while an Akedly attempt is current',async()=>{
		mocks.codeFindUnique.mockResolvedValue({...challenge,providerReference:'AKEDLY:attempt_1234567890'});
		const response=await POST(request());

		expect(response.status).toBe(409);
		expect(mocks.matches).not.toHaveBeenCalled();
		expect(mocks.transaction).not.toHaveBeenCalled();
	});

	it('prevents concurrent reuse when the challenge was already consumed',async()=>{
		mocks.txDeleteMany.mockResolvedValue({count:0});
		const response=await POST(request());

		expect(response.status).toBe(409);
		expect(mocks.txUserUpdate).not.toHaveBeenCalled();
	});
});
