import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	requireUser:vi.fn(),
	findUnique:vi.fn(),
	investmentFindFirst:vi.fn(),
	transaction:vi.fn(),
	synchronizeTier:vi.fn(),
}));

vi.mock('@/lib/auth',()=>({requireUser:mocks.requireUser}));
vi.mock('@/lib/db',()=>({db:{user:{findUnique:mocks.findUnique},investmentRequest:{findFirst:mocks.investmentFindFirst},$transaction:mocks.transaction}}));
vi.mock('@/lib/notifications',()=>({createNotification:vi.fn()}));
vi.mock('@/lib/tier-progression',()=>({synchronizeCompletedProfileTier:mocks.synchronizeTier}));

import {GET,PATCH} from '../app/api/profile/route';

describe('profile two-factor status',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		mocks.requireUser.mockResolvedValue({id:'user-1'});
		mocks.investmentFindFirst.mockResolvedValue(null);
		mocks.synchronizeTier.mockResolvedValue(false);
		mocks.transaction.mockImplementation((operation:(tx:unknown)=>unknown)=>operation({
			user:{findUnique:mocks.findUnique,updateMany:vi.fn().mockResolvedValue({count:0})},
			auditLog:{create:vi.fn()},
		}));
	});

	it('reports two-factor as unavailable even if the legacy database flag is set',async()=>{
		mocks.findUnique.mockResolvedValue({
			id:'user-1',
			email:'user@example.invalid',
			name:'Test User',
			phone:null,
			phoneVerified:false,
			country:'Test',
			approvedTier:1,
			avatarKey:null,
			twoFactorEnabled:true,
			totpSecretEncrypted:null,
			role:'USER',
			status:'ACTIVE',
			accountMode:'REAL',
			kycStatus:'PENDING',
			verifiedAt:null,
			withdrawalEnabled:true,
			accountRestricted:false,
			restrictionReason:null,
			kycDocuments:[],
			kyc:null,
		});

		const response=await GET();
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({twoFactorEnabled:false,twoFactorAvailable:false,canWithdraw:true});
		expect(mocks.synchronizeTier).not.toHaveBeenCalled();
		expect(mocks.investmentFindFirst).not.toHaveBeenCalled();
	});

	it('does not allow profile updates to change the server-side two-factor state',async()=>{
		const userUpdate=vi.fn().mockResolvedValue({});
		mocks.findUnique.mockResolvedValue({
			id:'user-1',email:'user@example.invalid',name:'Test User',phone:null,phoneVerified:false,country:'Test',
			approvedTier:1,avatarKey:null,twoFactorEnabled:false,totpSecretEncrypted:null,role:'USER',status:'ACTIVE',
			accountMode:'DEMO',kycStatus:'PENDING',verifiedAt:null,withdrawalEnabled:true,accountRestricted:false,
			restrictionReason:null,kycDocuments:[],kyc:null,depositEnabled:true,
		});
		mocks.transaction.mockImplementation((operation:(tx:unknown)=>unknown)=>operation({
			user:{findUnique:mocks.findUnique,update:userUpdate,updateMany:vi.fn().mockResolvedValue({count:0})},
			auditLog:{create:vi.fn()},
			kycProfile:{upsert:vi.fn()},
		}));
		const response=await PATCH(new Request('http://localhost/api/profile',{
			method:'PATCH',
			headers:{'content-type':'application/json'},
			body:JSON.stringify({name:'Test User',country:'Test',twoFactorEnabled:true}),
		}));

		expect(response.status).toBe(200);
		expect(userUpdate).toHaveBeenCalledWith(expect.objectContaining({data:expect.not.objectContaining({twoFactorEnabled:true})}));
	});
});
