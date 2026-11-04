import {createHash} from 'node:crypto';
import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	requireAdmin:vi.fn(),
	auditFindMany:vi.fn(),
	auditCreate:vi.fn(),
	userFindUnique:vi.fn(),
	userUpdateMany:vi.fn(),
	transaction:vi.fn(),
	rateLimit:vi.fn(),
}));

vi.mock('@/lib/auth',()=>({requireAdmin:mocks.requireAdmin}));
vi.mock('@/lib/db',()=>({db:{$transaction:mocks.transaction}}));
vi.mock('@/lib/rate-limit',()=>({rateLimit:mocks.rateLimit}));

import {DELETE,GET} from '../app/api/admin/sessions/route';

const activeSessionId='session-token-for-testing';
const sessionRef=createHash('sha256').update(activeSessionId).digest('hex').slice(0,24);

describe('admin account sessions',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		mocks.requireAdmin.mockResolvedValue({id:'admin-1'});
		mocks.auditFindMany.mockResolvedValue([]);
		mocks.auditCreate.mockResolvedValue({});
		mocks.userFindUnique.mockResolvedValue({activeSessionId});
		mocks.userUpdateMany.mockResolvedValue({count:1});
		mocks.transaction.mockImplementation(async(callback,_options)=>callback({
			auditLog:{findMany:mocks.auditFindMany,create:mocks.auditCreate},
			user:{findUnique:mocks.userFindUnique,updateMany:mocks.userUpdateMany},
		}));
	});

	it('shows registered session summaries while excluding raw IP and user-agent values',async()=>{
		const userAgent='Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Version/17.0 Mobile Safari/604.1';
		mocks.auditFindMany.mockResolvedValue([{
			createdAt:new Date(Date.now() - 60_000),
			metadata:{sessionRef,userAgent,clientIp:'203.0.113.9'},
			actor:{id:'user-1',email:'user@example.test',name:'Test User',phone:'+15555550123',country:'United States',avatarKey:'private/avatar.png',activeSessionId,activeSessionUpdatedAt:new Date(Date.now() - 60_000)},
		}]);

		const response=await GET(new Request('https://aurevia.test/api/admin/sessions'));
		const result=await response.json();

		expect(response.status).toBe(200);
		expect(result.sessions[0]).toMatchObject({userId:'user-1',email:'user@example.test',active:true,device:'Mobile',operatingSystem:'iOS',browser:'Safari',hasProfilePhoto:true});
		expect(JSON.stringify(result)).not.toContain('203.0.113.9');
		expect(JSON.stringify(result)).not.toContain(userAgent);
		expect(mocks.auditCreate).toHaveBeenCalledWith({data:{actorId:'admin-1',action:'ADMIN_SESSIONS_VIEWED',entity:'SESSION',metadata:{recordCount:1}}});
	});

	it('revokes only the selected active session and writes an audit event',async()=>{
		const response=await DELETE(new Request('https://aurevia.test/api/admin/sessions',{
			method:'DELETE',
			headers:{'content-type':'application/json'},
			body:JSON.stringify({userId:'user-1',sessionRef}),
		}));

		expect(response.status).toBe(200);
		expect(mocks.userUpdateMany).toHaveBeenCalledWith({where:{id:'user-1',activeSessionId},data:{activeSessionId:null,activeSessionUpdatedAt:null}});
		expect(mocks.auditCreate).toHaveBeenCalledWith({data:{actorId:'admin-1',action:'ADMIN_SESSION_REVOKED',entity:'SESSION',entityId:'user-1',metadata:{sessionRef}}});
	});

	it('rejects a stale session reference without changing the account',async()=>{
		const response=await DELETE(new Request('https://aurevia.test/api/admin/sessions',{
			method:'DELETE',
			headers:{'content-type':'application/json'},
			body:JSON.stringify({userId:'user-1',sessionRef:'0'.repeat(24)}),
		}));

		expect(response.status).toBe(409);
		expect(mocks.userUpdateMany).not.toHaveBeenCalled();
		expect(mocks.auditCreate).not.toHaveBeenCalled();
	});
});
