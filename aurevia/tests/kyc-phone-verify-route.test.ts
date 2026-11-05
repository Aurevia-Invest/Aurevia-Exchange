import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	requireUser:vi.fn(),
	userFindUnique:vi.fn(),
	codeFindUnique:vi.fn(),
	codeDeleteMany:vi.fn(),
	userUpdateMany:vi.fn(),
	transaction:vi.fn(),
	codeMatches:vi.fn(),
	verifyTwilio:vi.fn(),
	createNotification:vi.fn(),
	rateLimit:vi.fn(),
	TwilioVerifyProviderError:class extends Error{},
}));

vi.mock('@/lib/auth',()=>({requireUser:mocks.requireUser}));
vi.mock('@/lib/db',()=>({db:{
	user:{findUnique:mocks.userFindUnique,updateMany:mocks.userUpdateMany},
	verificationCode:{findUnique:mocks.codeFindUnique,deleteMany:mocks.codeDeleteMany},
	$transaction:mocks.transaction,
}}));
vi.mock('@/lib/notifications',()=>({createNotification:mocks.createNotification}));
vi.mock('@/lib/rate-limit',()=>({rateLimit:mocks.rateLimit}));
vi.mock('@/lib/config',()=>({verificationConfig:{maxAttempts:6}}));
vi.mock('@/lib/verification-delivery',()=>({
	verificationCodeMatches:mocks.codeMatches,
	verifyTwilioVerificationCode:mocks.verifyTwilio,
	TwilioVerifyProviderError:mocks.TwilioVerifyProviderError,
}));

import {POST} from '@/app/api/kyc/phone/verify/route';

describe('phone verification route rate limits',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		mocks.requireUser.mockResolvedValue({id:'user-1'});
		mocks.userFindUnique.mockResolvedValue({
			id:'user-1',phone:'+2348031234567',phoneVerified:false,accountMode:'REAL',status:'ACTIVE',
			approvedTier:2,name:'Test User',country:'Nigeria',
		});
		mocks.codeFindUnique.mockResolvedValue({
			id:'challenge-1',channel:'SMS',providerReference:'TWILIO',codeHash:'challenge-hash',
			expiresAt:new Date(Date.now()+60_000),attempts:0,
		});
		mocks.codeDeleteMany.mockResolvedValue({count:1});
		mocks.userUpdateMany.mockResolvedValue({count:1});
		mocks.transaction.mockImplementation(async(operation:(tx:unknown)=>Promise<unknown>)=>operation({
			verificationCode:{deleteMany:mocks.codeDeleteMany},
			user:{updateMany:mocks.userUpdateMany},
		}));
		mocks.codeMatches.mockReturnValue(true);
		mocks.verifyTwilio.mockResolvedValue(true);
		mocks.createNotification.mockResolvedValue({});
		mocks.rateLimit.mockImplementation(()=>undefined);
	});

	it('uses trusted client IPs with higher shared-network capacity and per-user limits',async()=>{
		const request=new Request('https://aurevia.test/api/kyc/phone/verify',{
			method:'POST',
			headers:{'content-type':'application/json','x-forwarded-for':'192.0.2.2'},
			body:JSON.stringify({code:'123456'}),
		});

		const response=await POST(request);

		expect(response.status).toBe(200);
		expect(mocks.rateLimit).toHaveBeenCalledWith('kyc-phone-verify-ip:192.0.2.2',60,15*60_000);
		expect(mocks.rateLimit).toHaveBeenCalledWith('kyc-phone-verify-user:user-1',24,60*60_000);
		expect(mocks.verifyTwilio).toHaveBeenCalledWith('+2348031234567','123456');
	});
});
