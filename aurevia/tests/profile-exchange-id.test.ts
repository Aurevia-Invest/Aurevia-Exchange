import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	requireUser:vi.fn(),
	findUnique:vi.fn(),
	userUpdate:vi.fn(),
	transaction:vi.fn(),
}));

vi.mock('@/lib/auth',()=>({requireUser:mocks.requireUser}));
vi.mock('@/lib/db',()=>({db:{user:{findUnique:mocks.findUnique},investmentRequest:{findFirst:vi.fn()},$transaction:mocks.transaction}}));
vi.mock('@/lib/notifications',()=>({createNotification:vi.fn()}));
vi.mock('@/lib/tier-progression',()=>({synchronizeCompletedProfileTier:vi.fn()}));
vi.mock('@/lib/production-policy',()=>({
	getAccountTier:()=>({label:'Tier 1',progress:0,eligibleForRealTrading:false,verified:true}),
	getTierProfileRequirements:()=>({nameComplete:true,countryComplete:true,phoneComplete:false,profileComplete:false}),
}));

import {PATCH} from '@/app/api/profile/route';

const existingExchangeId='AEX-2024-8K7M-4Q9X';

describe('profile Aurevia Exchange ID immutability',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		mocks.requireUser.mockResolvedValue({id:'user-1'});
		mocks.userUpdate.mockResolvedValue({});
		mocks.transaction.mockImplementation((operation:(tx:unknown)=>Promise<unknown>)=>operation({
			user:{findUnique:mocks.findUnique,update:mocks.userUpdate},
			verificationCode:{deleteMany:vi.fn()},
			kycProfile:{upsert:vi.fn()},
		}));
	});

	it('preserves the assigned ID when profile fields are updated',async()=>{
		mocks.findUnique
			.mockResolvedValueOnce({name:'Existing Name',phone:null,country:'Canada',twoFactorEnabled:false,kycStatus:'PENDING',verifiedAt:null,kyc:null})
			.mockResolvedValueOnce({
				id:'user-1',aureviaExchangeId:existingExchangeId,email:'person@example.invalid',name:'Updated Name',phone:null,phoneVerified:false,country:'Canada',
				avatarKey:null,twoFactorEnabled:false,role:'USER',status:'ACTIVE',accountMode:'DEMO',approvedTier:1,kycStatus:'PENDING',
				verifiedAt:null,depositEnabled:true,withdrawalEnabled:true,accountRestricted:false,
				restrictionReason:null,updatedAt:new Date(),kycDocuments:[],kyc:null,
			});

		const response=await PATCH(new Request('https://aurevia.test/api/profile',{
			method:'PATCH',
			headers:{'content-type':'application/json'},
			body:JSON.stringify({firstName:'Updated',lastName:'Name',aureviaExchangeId:'AEX-2099-0000-0000'}),
		}));
		const result=await response.json();

		expect(response.status).toBe(200);
		expect(result.aureviaExchangeId).toBe(existingExchangeId);
		expect(mocks.userUpdate).toHaveBeenCalledWith(expect.objectContaining({
			data:expect.not.objectContaining({aureviaExchangeId:expect.anything()}),
		}));
	});
});
