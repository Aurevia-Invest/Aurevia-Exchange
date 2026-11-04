import {describe,expect,it,vi} from 'vitest';
import {createAccountPurgePlan,runAccountPurgeWorkflow,type PurgeUser} from '@/lib/purge-accounts';

const users:PurgeUser[]=[
	{id:'keep',email:'keep@example.invalid',role:'USER'},
	{id:'remove',email:'remove@example.invalid',role:'USER'},
	{id:'admin',email:'admin@example.invalid',role:'ADMIN'},
];

describe('account purge safety checks',()=>{
	it('requires the exact keep email argument',()=>{
		expect(()=>createAccountPurgePlan(users,undefined)).toThrow('KEEP_EMAIL_REQUIRED');
	});

	it('aborts when the exact email matches multiple users',()=>{
		const duplicated=[...users,{id:'duplicate',email:'keep@example.invalid',role:'USER' as const}];
		expect(()=>createAccountPurgePlan(duplicated,'keep@example.invalid')).toThrow('KEEP_EMAIL_MUST_MATCH_EXACTLY_ONE_USER');
	});

	it('dry run plans removals but does not back up or delete users',async()=>{
		const exportBackup=vi.fn(async()=>undefined);
		const deleteUsers=vi.fn(async()=>undefined);
		const plan=await runAccountPurgeWorkflow({users,keepEmail:'keep@example.invalid',execute:false,exportBackup,deleteUsers});

		expect(plan.usersToDelete.map(user=>user.id)).toEqual(['remove']);
		expect(plan.admins.map(user=>user.id)).toEqual(['admin']);
		expect(exportBackup).not.toHaveBeenCalled();
		expect(deleteUsers).not.toHaveBeenCalled();
	});
});
