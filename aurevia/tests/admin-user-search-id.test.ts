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
});
