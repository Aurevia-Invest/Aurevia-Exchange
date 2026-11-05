import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	requireAdmin:vi.fn(),
	auditFindMany:vi.fn(),
	auditCreate:vi.fn(),
	transaction:vi.fn(),
	queryRaw:vi.fn(),
	userFindMany:vi.fn(),
}));

vi.mock('@/lib/auth',()=>({requireAdmin:mocks.requireAdmin}));
vi.mock('@/lib/db',()=>({db:{
	auditLog:{findMany:mocks.auditFindMany,create:mocks.auditCreate},
	$queryRaw:mocks.queryRaw,
	$transaction:mocks.transaction,
	user:{findMany:mocks.userFindMany},
}}));
vi.mock('@/lib/serializers',()=>({jsonSafe:(value:unknown)=>value}));
vi.mock('@/lib/display-copy',()=>({removeSimulatedLabels:(value:string)=>value}));

import {GET} from '../app/api/admin/audit/route';

describe('admin audit log pagination',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		mocks.requireAdmin.mockResolvedValue({id:'admin-1'});
		mocks.auditFindMany.mockResolvedValue([]);
		mocks.auditCreate.mockResolvedValue({});
		mocks.transaction.mockImplementation(async callback=>callback({auditLog:{findMany:mocks.auditFindMany,create:mocks.auditCreate}}));
		mocks.queryRaw.mockImplementation(query=>query.sql.includes('COUNT(*)')?[{total:0n}]:[]);
		mocks.userFindMany.mockResolvedValue([]);
	});

	it('audits every targeted login-history read',async()=>{
		const response=await GET(new Request('https://aurevia.test/api/admin/audit?loginUserId=user-1'));

		expect(response.status).toBe(200);
		expect(mocks.auditFindMany).toHaveBeenCalledWith(expect.objectContaining({where:{entity:'LOGIN',actorId:'user-1'},orderBy:[{createdAt:'desc'},{id:'desc'}]}));
		expect(mocks.auditCreate).toHaveBeenCalledWith({data:{actorId:'admin-1',action:'ADMIN_LOGIN_HISTORY_VIEWED',entity:'LOGIN_HISTORY',entityId:'user-1',metadata:{recordCount:0}}});
	});

	it('uses database pagination and returns exact result metadata',async()=>{
		const pageRows=Array.from({length:10},(_,index)=>({
			source:'audit',
			sourceId:`event-${index+11}`,
			sortId:`event-${index+11}`,
			actorId:'user-1',
			action:'USER_UPDATED',
			entity:'USER',
			entityId:'user-1',
			metadata:{ip:'192.0.2.1'},
			summary:null,
			createdAt:new Date(`2026-11-05T11:${String(index).padStart(2,'0')}:00Z`),
		}));
		mocks.queryRaw.mockImplementation(query=>query.sql.includes('COUNT(*)')
			?[{total:21n}]
			:pageRows);
		mocks.userFindMany.mockResolvedValue([{id:'user-1',name:'Administrator'}]);

		const response=await GET(new Request('https://aurevia.test/api/admin/audit?page=2'));
		const result=await response.json();

		expect(response.status).toBe(200);
		expect(result).toMatchObject({total:21,page:2,pageSize:10,totalPages:3});
		expect(result.items[0]).toMatchObject({id:'event-11',actorName:'Administrator'});
		expect(result.items).toHaveLength(10);
		expect(mocks.queryRaw).toHaveBeenCalledTimes(2);
		expect(mocks.queryRaw.mock.calls[1][0].sql).toContain('LIMIT ? OFFSET ?');
		expect(mocks.queryRaw.mock.calls[1][0].values).toEqual([10,10]);
		expect(mocks.queryRaw.mock.calls[1][0].sql).toContain('"AuditLog"');
		expect(mocks.queryRaw.mock.calls[1][0].sql).toContain('"Notification"');
		expect(mocks.queryRaw.mock.calls[1][0].sql).toContain('ORDER BY "createdAt" DESC,"sortId" DESC');
	});

	it('returns only the remaining records on the final page',async()=>{
		mocks.queryRaw.mockImplementation(query=>query.sql.includes('COUNT(*)')
			?[{total:21n}]
			:[{source:'audit',sourceId:'event-21',sortId:'event-21',actorId:null,action:'FINAL_EVENT',entity:'USER',entityId:'user-21',metadata:null,summary:null,createdAt:new Date('2026-11-05T10:00:00Z')}]);

		const response=await GET(new Request('https://aurevia.test/api/admin/audit?page=3'));
		const result=await response.json();

		expect(response.status).toBe(200);
		expect(result).toMatchObject({total:21,page:3,pageSize:10,totalPages:3,items:[{id:'event-21'}]});
		expect(result.items).toHaveLength(1);
		expect(mocks.queryRaw.mock.calls[1][0].values).toEqual([10,20]);
	});

	it('filters both feed sources by the selected UTC day in the database',async()=>{
		const response=await GET(new Request('https://aurevia.test/api/admin/audit?date=2026-11-05'));

		expect(response.status).toBe(200);
		for(const [query] of mocks.queryRaw.mock.calls){
			expect(query.sql.match(/"createdAt">=/g)).toHaveLength(2);
			expect(query.sql.match(/"createdAt"</g)).toHaveLength(2);
			expect(query.values).toContainEqual(new Date('2026-11-05T00:00:00.000Z'));
			expect(query.values).toContainEqual(new Date('2026-11-06T00:00:00.000Z'));
		}
	});

	it('rejects invalid dates and oversized login-history identifiers before querying',async()=>{
		const invalidDate=await GET(new Request('https://aurevia.test/api/admin/audit?date=2026-02-30'));
		const oversizedLogin=await GET(new Request(`https://aurevia.test/api/admin/audit?loginUserId=${'x'.repeat(129)}`));

		expect(invalidDate.status).toBe(400);
		expect(oversizedLogin.status).toBe(400);
		expect(mocks.queryRaw).not.toHaveBeenCalled();
		expect(mocks.auditFindMany).not.toHaveBeenCalled();
	});

	it('requires administrator authentication',async()=>{
		mocks.requireAdmin.mockRejectedValue(new Error('FORBIDDEN'));
		const response=await GET(new Request('https://aurevia.test/api/admin/audit'));

		expect(response.status).toBe(403);
		expect(mocks.queryRaw).not.toHaveBeenCalled();
	});
});
