import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	requireUser:vi.fn(),
	userFindUnique:vi.fn(),
	notificationFindMany:vi.fn(),
	notificationFindFirst:vi.fn(),
	notificationUpdateMany:vi.fn(),
	notificationDeleteMany:vi.fn(),
	notificationCount:vi.fn(),
	visibilityDeleteMany:vi.fn(),
	transaction:vi.fn(),
}));
vi.mock('@/lib/auth',()=>({requireUser:mocks.requireUser}));
vi.mock('@/lib/db',()=>({db:{
	user:{findUnique:mocks.userFindUnique},
	notification:{findMany:mocks.notificationFindMany,findFirst:mocks.notificationFindFirst,updateMany:mocks.notificationUpdateMany,deleteMany:mocks.notificationDeleteMany,count:mocks.notificationCount},
	activityVisibilityPreference:{deleteMany:mocks.visibilityDeleteMany},
	$transaction:mocks.transaction,
}}));

import {DELETE,GET,PATCH} from '@/app/api/notifications/route';

const req=(method:string,body:unknown)=>new Request('https://aurevia.test/api/notifications',{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});

beforeEach(()=>{
	vi.clearAllMocks();
	mocks.requireUser.mockResolvedValue({id:'owner-1'});
	mocks.userFindUnique.mockResolvedValue({accountMode:'DEMO',status:'ACTIVE'});
	mocks.notificationFindMany.mockResolvedValue([{id:'notice-1',title:'Account update',message:'An update is available.',isRead:false,pushOutbox:[]}]);
	mocks.notificationFindFirst.mockResolvedValue(null);
	mocks.notificationUpdateMany.mockResolvedValue({count:1});
	mocks.notificationDeleteMany.mockResolvedValue({count:1});
	mocks.notificationCount.mockResolvedValue(0);
	mocks.visibilityDeleteMany.mockResolvedValue({count:0});
	mocks.transaction.mockImplementation(async(operation:(tx:unknown)=>unknown)=>operation({
		notification:{findMany:mocks.notificationFindMany,deleteMany:mocks.notificationDeleteMany},
		activityVisibilityPreference:{deleteMany:mocks.visibilityDeleteMany},
	}));
});

describe('notification retention controls',()=>{
	it('returns the active account mode with mode-scoped notification results',async()=>{
		mocks.userFindUnique.mockResolvedValueOnce({accountMode:'REAL',status:'ACTIVE'});
		const response=await GET(new Request('https://aurevia.test/api/notifications?limit=8'));
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({accountMode:'REAL',notifications:[{id:'notice-1'}]});
		expect(mocks.notificationFindMany).toHaveBeenCalledWith(expect.objectContaining({
			where:expect.objectContaining({userId:'owner-1',OR:[{accountMode:'REAL'},{accountMode:null}]}),
		}));
	});

	it('archives a notification only when it belongs to the authenticated user',async()=>{
		const response=await PATCH(req('PATCH',{action:'archive',id:'notice-1'}));
		expect(response.status).toBe(200);
		expect(mocks.notificationUpdateMany).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({id:'notice-1',userId:'owner-1',OR:[{accountMode:'DEMO'},{accountMode:null}]}),data:{archivedAt:expect.any(Date)}}));
	});

	it('permanently deletes only read notifications owned by the user without delivery history',async()=>{
		const response=await DELETE(req('DELETE',{ids:['notice-1']}));
		expect(response.status).toBe(200);
		expect(mocks.notificationFindMany.mock.calls[0]?.[0]).toMatchObject({where:{id:{in:['notice-1']},userId:'owner-1',isRead:true,pushOutbox:null,OR:[{accountMode:'DEMO'},{accountMode:null}]} ,select:{id:true}});
		expect(mocks.notificationDeleteMany.mock.calls[0]?.[0]).toMatchObject({where:{id:{in:['notice-1']},userId:'owner-1',isRead:true,pushOutbox:null,OR:[{accountMode:'DEMO'},{accountMode:null}]}});
	});

	it('refuses deletion when a notification is protected by pending delivery or is not owned',async()=>{
		mocks.notificationFindMany.mockResolvedValueOnce([]);
		const response=await DELETE(req('DELETE',{ids:['foreign-or-not-deliverable']}));
		expect(response.status).toBe(409);
		expect(mocks.notificationDeleteMany).not.toHaveBeenCalled();
	});

	it('does not allow managing a notification scoped to the other account mode',async()=>{
		mocks.userFindUnique.mockResolvedValueOnce({accountMode:'REAL',status:'ACTIVE'});
		mocks.notificationFindMany.mockResolvedValueOnce([]);
		const response=await DELETE(req('DELETE',{ids:['demo-notice']}));
		expect(response.status).toBe(409);
		expect(mocks.notificationFindMany).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({OR:[{accountMode:'REAL'},{accountMode:null}]})}));
		expect(mocks.notificationDeleteMany).not.toHaveBeenCalled();
	});

	it('rejects oversized bulk deletion requests',async()=>{
		const response=await DELETE(req('DELETE',{ids:Array.from({length:101},(_,index)=>`notice-${index}`)}));
		expect(response.status).toBe(400);
		expect(mocks.transaction).not.toHaveBeenCalled();
	});
});
