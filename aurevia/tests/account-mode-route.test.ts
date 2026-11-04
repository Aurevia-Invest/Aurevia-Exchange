import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	requireUser:vi.fn(),
	transaction:vi.fn(),
	findUniqueOrThrow:vi.fn(),
	userUpdate:vi.fn(),
	auditLogCreate:vi.fn(),
	initializePaperAccount:vi.fn(),
	createNotification:vi.fn(),
}));

vi.mock('@/lib/auth',()=>({requireUser:mocks.requireUser}));
vi.mock('@/lib/db',()=>({db:{$transaction:mocks.transaction}}));
vi.mock('@/lib/ledger',()=>({DEMO_STARTING_BALANCE:10000,initializePaperAccount:mocks.initializePaperAccount}));
vi.mock('@/lib/notifications',()=>({createNotification:mocks.createNotification}));

import {PATCH} from '@/app/api/account/mode/route';

function request(accountMode:'DEMO'|'REAL'){
	return new Request('https://aurevia.test/api/account/mode',{
		method:'PATCH',
		headers:{'content-type':'application/json'},
		body:JSON.stringify({accountMode}),
	});
}

describe('account mode changes',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		mocks.requireUser.mockResolvedValue({id:'user-1'});
		mocks.findUniqueOrThrow.mockResolvedValue({accountMode:'DEMO',status:'ACTIVE',role:'USER'});
		mocks.userUpdate.mockImplementation(({data})=>({accountMode:data.accountMode,updatedAt:new Date('2026-01-01T00:00:00.000Z')}));
		mocks.auditLogCreate.mockResolvedValue({});
		mocks.initializePaperAccount.mockResolvedValue(false);
		mocks.createNotification.mockResolvedValue({});
		mocks.transaction.mockImplementation(async(callback:(tx:unknown)=>Promise<unknown>)=>callback({
			user:{findUniqueOrThrow:mocks.findUniqueOrThrow,update:mocks.userUpdate},
			auditLog:{create:mocks.auditLogCreate},
		}));
	});

	it('allows users to switch from DEMO to REAL',async()=>{
		const response=await PATCH(request('REAL'));

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({accountMode:'REAL'});
		expect(mocks.initializePaperAccount).toHaveBeenCalledWith(expect.anything(),'user-1','REAL');
		expect(mocks.userUpdate).toHaveBeenCalledWith(expect.objectContaining({data:{accountMode:'REAL'}}));
	});

	it('allows users to switch from REAL back to DEMO',async()=>{
		mocks.findUniqueOrThrow.mockResolvedValue({accountMode:'REAL',status:'ACTIVE',role:'USER'});

		const response=await PATCH(request('DEMO'));

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({accountMode:'DEMO'});
		expect(mocks.initializePaperAccount).toHaveBeenCalledWith(expect.anything(),'user-1','DEMO');
		expect(mocks.userUpdate).toHaveBeenCalledWith(expect.objectContaining({data:{accountMode:'DEMO'}}));
	});
});
