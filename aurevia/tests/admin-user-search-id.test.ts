import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	requireAdmin:vi.fn(),
	userFindMany:vi.fn(),
	getServerConfiguration:vi.fn(),
}));

vi.mock('@/lib/auth',()=>({requireAdmin:mocks.requireAdmin}));
vi.mock('@/lib/db',()=>({db:{user:{findMany:mocks.userFindMany}}}));
vi.mock('@/lib/config/env',()=>({getServerConfiguration:mocks.getServerConfiguration}));

import {GET} from '@/app/api/admin/users/route';

describe('admin Aurevia Exchange ID search',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		mocks.requireAdmin.mockResolvedValue({id:'admin-1'});
		mocks.getServerConfiguration.mockReturnValue({auth:{adminEmail:''}});
		mocks.userFindMany.mockResolvedValue([]);
	});

	it('searches by exact normalized Aurevia Exchange ID without exposing users publicly',async()=>{
		const response=await GET(new Request('https://aurevia.test/api/admin/users?search=aex-2026-8k7m-4q9x'));

		expect(response.status).toBe(200);
		expect(mocks.userFindMany).toHaveBeenCalledWith(expect.objectContaining({
			where:expect.objectContaining({
				role:'USER',
				OR:expect.arrayContaining([{aureviaExchangeId:'AEX-2026-8K7M-4Q9X'}]),
			}),
			select:expect.objectContaining({aureviaExchangeId:true}),
		}));
	});

	it('keeps internal ID and email search available to authorized administrators',async()=>{
		await GET(new Request('https://aurevia.test/api/admin/users?search=user-123'));

		expect(mocks.userFindMany).toHaveBeenCalledWith(expect.objectContaining({
			where:expect.objectContaining({
				OR:expect.arrayContaining([
					{id:{contains:'user-123'}},
					{email:{contains:'user-123',mode:'insensitive'}},
				]),
			}),
		}));
	});

	it('filters active and inactive users without including retained closed accounts',async()=>{
		await GET(new Request('https://aurevia.test/api/admin/users?status=INACTIVE'));

		expect(mocks.userFindMany).toHaveBeenCalledWith(expect.objectContaining({
			where:expect.objectContaining({status:{in:['FROZEN','SUSPENDED']}}),
		}));
	});

	it('uses the same existing tier progression in the admin account list',async()=>{
		mocks.userFindMany.mockResolvedValue([{
			id:'user-1',
			name:'Complete User',
			country:'Nigeria',
			phone:'+2348031234567',
			phoneVerified:true,
			approvedTier:1,
			accountMode:'DEMO',
			kycStatus:'PENDING',
			status:'ACTIVE',
			kyc:null,
			kycDocuments:[],
		}]);

		const response=await GET(new Request('https://aurevia.test/api/admin/users'));

		expect(await response.json()).toMatchObject([{accountTier:'TIER 2'}]);
		expect(mocks.userFindMany).toHaveBeenCalledWith(expect.objectContaining({
			select:expect.objectContaining({phoneVerified:true,approvedTier:true}),
		}));
	});
});
