import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({getServerSession:vi.fn()}));

vi.mock('next-auth',()=>({getServerSession:mocks.getServerSession}));
vi.mock('@/lib/auth-options',()=>({authOptions:{}}));

import {requireAdmin,requireUser} from '../lib/auth';

describe('administrator and customer session boundaries',()=>{
	beforeEach(()=>vi.resetAllMocks());

	it('allows a customer session only through the customer guard',async()=>{
		const customer={id:'customer-1',role:'USER',sessionHash:'a'.repeat(64)};
		mocks.getServerSession.mockResolvedValue({user:customer});
		await expect(requireUser()).resolves.toMatchObject(customer);
		await expect(requireAdmin()).rejects.toThrow('FORBIDDEN');
	});

	it('allows an administrator session only through the administrator guard',async()=>{
		const admin={id:'admin-1',role:'ADMIN',sessionHash:'b'.repeat(64)};
		mocks.getServerSession.mockResolvedValue({user:admin});
		await expect(requireAdmin()).resolves.toMatchObject(admin);
		await expect(requireUser()).rejects.toThrow('FORBIDDEN');
	});

	it('rejects signed-out sessions from both guards',async()=>{
		mocks.getServerSession.mockResolvedValue(null);
		await expect(requireUser()).rejects.toThrow('UNAUTHORIZED');
		await expect(requireAdmin()).rejects.toThrow('UNAUTHORIZED');
	});
});
