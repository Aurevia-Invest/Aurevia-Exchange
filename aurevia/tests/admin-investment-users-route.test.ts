import {beforeEach,describe,expect,it,vi} from 'vitest';
import {Prisma} from '@prisma/client';

const mocks=vi.hoisted(()=>({
	requireAdmin:vi.fn(),
	userFindMany:vi.fn(),
	ledgerAccountFindMany:vi.fn(),
	fundingRequestGroupBy:vi.fn(),
	ledgerEntryGroupBy:vi.fn(),
}));

vi.mock('@/lib/auth',()=>({requireAdmin:mocks.requireAdmin}));
vi.mock('@/lib/db',()=>({db:{
	user:{findMany:mocks.userFindMany},
	ledgerAccount:{findMany:mocks.ledgerAccountFindMany},
	fundingRequest:{groupBy:mocks.fundingRequestGroupBy},
	ledgerEntry:{groupBy:mocks.ledgerEntryGroupBy},
}}));

import {GET} from '@/app/api/admin/investments/users/route';

beforeEach(()=>{
	vi.clearAllMocks();
	mocks.requireAdmin.mockResolvedValue({id:'admin-1'});
	mocks.userFindMany.mockResolvedValue([{
		id:'user-1',name:'Investor',email:'investor@example.invalid',status:'ACTIVE',accountMode:'REAL',
		approvedTier:1,accountRestricted:false,depositEnabled:true,withdrawalEnabled:true,
	}]);
	mocks.ledgerAccountFindMany.mockResolvedValue([
		{userId:'user-1',accountMode:'REAL',id:'real-account'},
	]);
	mocks.fundingRequestGroupBy.mockResolvedValue([{
		userId:'user-1',accountMode:'REAL',_sum:{amount:new Prisma.Decimal(100)},
	}]);
	mocks.ledgerEntryGroupBy.mockResolvedValue([
		{accountId:'real-account',type:'CREDIT',_sum:{amount:new Prisma.Decimal(300)}},
	]);
});

describe('admin investment user balances',()=>{
	it('aggregates only REAL account ledger entries and subtracts REAL withdrawal reservations',async()=>{
		const response=await GET(new Request('http://localhost/api/admin/investments/users'));
		const result=await response.json();

		expect(response.status).toBe(200);
		expect(Number(result.items[0].availableBalances.REAL)).toBe(200);
		expect(result.items[0].availableBalances).not.toHaveProperty('DEMO');
		expect(mocks.ledgerEntryGroupBy).toHaveBeenCalledTimes(1);
		expect(mocks.ledgerEntryGroupBy).toHaveBeenCalledWith(expect.objectContaining({
			by:['accountId','type'],
			where:{accountId:{in:['real-account']}},
		}));
		expect(mocks.userFindMany).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({accountMode:'REAL'})}));
	});

	it('avoids the ledger query when there are no matching users',async()=>{
		mocks.userFindMany.mockResolvedValue([]);

		const response=await GET(new Request('http://localhost/api/admin/investments/users'));

		expect(response.status).toBe(200);
		expect(mocks.ledgerEntryGroupBy).not.toHaveBeenCalled();
	});
});
