import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	transaction:vi.fn(),
	findExpiredAttempts:vi.fn(),
	findExistingUsers:vi.fn(),
	deleteMany:vi.fn(),
}));

vi.mock('@/lib/db',()=>({db:{
	$transaction:mocks.transaction,
}}));

import {cleanupExpiredRegistrationAttempts} from '@/lib/registration-cleanup';

const now=new Date('2026-01-01T00:00:00.000Z');
const tx={
	registrationAttempt:{
		findMany:mocks.findExpiredAttempts,
		deleteMany:mocks.deleteMany,
	},
	user:{findMany:mocks.findExistingUsers},
};

describe('expired registration cleanup',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		mocks.transaction.mockImplementation((operation: (client: typeof tx)=>Promise<unknown>)=>operation(tx));
		mocks.findExpiredAttempts.mockResolvedValue([
			{id:'expired-unregistered',email:'expired@example.invalid'},
			{id:'expired-existing-user',email:'EXISTING@example.invalid'},
		]);
		mocks.findExistingUsers.mockResolvedValue([{email:'existing@example.invalid'}]);
		mocks.deleteMany.mockResolvedValue({count:1});
	});

	it('deletes only expired attempts not associated with an existing user',async()=>{
		await expect(cleanupExpiredRegistrationAttempts(now)).resolves.toEqual({count:1});

		expect(mocks.findExpiredAttempts).toHaveBeenCalledWith({
			where:{expiresAt:{lte:now}},
			select:{id:true,email:true},
		});
		expect(mocks.findExistingUsers).toHaveBeenCalledWith({
			where:{email:{in:['expired@example.invalid','EXISTING@example.invalid'],mode:'insensitive'}},
			select:{email:true},
		});
		expect(mocks.deleteMany).toHaveBeenCalledWith({
			where:{id:{in:['expired-unregistered']},expiresAt:{lte:now}},
		});
		expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function),{isolationLevel:'Serializable'});
	});

	it('preserves all attempts when their email belongs to an existing account',async()=>{
		mocks.findExistingUsers.mockResolvedValue([{email:'expired@example.invalid'},{email:'existing@example.invalid'}]);

		await expect(cleanupExpiredRegistrationAttempts(now)).resolves.toEqual({count:0});

		expect(mocks.deleteMany).not.toHaveBeenCalled();
	});

	it('does not inspect users or delete anything when no attempt has expired',async()=>{
		mocks.findExpiredAttempts.mockResolvedValue([]);

		await expect(cleanupExpiredRegistrationAttempts(now)).resolves.toEqual({count:0});

		expect(mocks.findExistingUsers).not.toHaveBeenCalled();
		expect(mocks.deleteMany).not.toHaveBeenCalled();
	});
});
