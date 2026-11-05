import {beforeEach,describe,expect,it,vi} from 'vitest';
import {Prisma} from '@prisma/client';

const mocks=vi.hoisted(()=>({
	getServerSession:vi.fn(),
	requireUser:vi.fn(),
	requireAdmin:vi.fn(),
	userFindUnique:vi.fn(),
	userUpdateMany:vi.fn(),
}));

vi.mock('next-auth',()=>({getServerSession:mocks.getServerSession}));
vi.mock('@/lib/auth-options',()=>({authOptions:{}}));
vi.mock('@/lib/auth',()=>({requireUser:mocks.requireUser,requireAdmin:mocks.requireAdmin}));
vi.mock('@/lib/db',()=>({db:{user:{findUnique:mocks.userFindUnique,updateMany:mocks.userUpdateMany}}}));

import {GET,PATCH} from '@/app/api/theme-preference/route';

const request=(body:unknown)=>new Request('https://aurevia.test/api/theme-preference',{
	method:'PATCH',
	headers:{'content-type':'application/json'},
	body:JSON.stringify(body),
});

beforeEach(()=>{
	vi.clearAllMocks();
	mocks.getServerSession.mockResolvedValue({user:{id:'user-a',role:'USER'}});
	mocks.requireUser.mockResolvedValue({id:'user-a'});
	mocks.requireAdmin.mockResolvedValue({id:'admin-a'});
	mocks.userFindUnique.mockResolvedValue({preferredTheme:'FOREST_GREEN'});
	mocks.userUpdateMany.mockResolvedValue({count:1});
});

describe('account theme preference',()=>{
	it('returns only the authenticated account preference without caching it publicly',async()=>{
		mocks.userFindUnique.mockResolvedValueOnce({preferredTheme:'PREMIUM_DASHBOARD'});
		const response=await GET();
		expect(response.status).toBe(200);
		expect(response.headers.get('Cache-Control')).toBe('private, no-store');
		expect(await response.json()).toEqual({theme:'premium-dashboard'});
		expect(mocks.userFindUnique).toHaveBeenCalledWith({where:{id:'user-a'},select:{preferredTheme:true}});
	});

	it('requires authentication before reading or writing a preference',async()=>{
		mocks.getServerSession.mockResolvedValue(null);
		expect((await GET()).status).toBe(401);
		expect((await PATCH(request({theme:'forest-green'}))).status).toBe(401);
		expect(mocks.userFindUnique).not.toHaveBeenCalled();
		expect(mocks.userUpdateMany).not.toHaveBeenCalled();
	});

	it('routes administrators through admin authorization and their own identity',async()=>{
		mocks.getServerSession.mockResolvedValue({user:{id:'admin-a',role:'ADMIN'}});
		const response=await PATCH(request({theme:'premium-dashboard'}));
		expect(response.status).toBe(200);
		expect(mocks.requireAdmin).toHaveBeenCalledOnce();
		expect(mocks.requireUser).not.toHaveBeenCalled();
		expect(mocks.userUpdateMany).toHaveBeenCalledWith({
			where:{id:'admin-a',preferredTheme:{not:'PREMIUM_DASHBOARD'}},
			data:{preferredTheme:'PREMIUM_DASHBOARD'},
		});
	});

	it('rejects unsupported themes and account-id fields',async()=>{
		expect((await PATCH(request({theme:'blue'}))).status).toBe(400);
		expect((await PATCH(request({theme:'premium-dashboard',userId:'user-b'}))).status).toBe(400);
		expect(mocks.userUpdateMany).not.toHaveBeenCalled();
	});

	it('does not perform an update when the selected preference is already saved',async()=>{
		mocks.userUpdateMany.mockResolvedValueOnce({count:0});
		const response=await PATCH(request({theme:'forest-green'}));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({theme:'forest-green'});
		expect(mocks.userUpdateMany).toHaveBeenCalledWith({
			where:{id:'user-a',preferredTheme:{not:'FOREST_GREEN'}},
			data:{preferredTheme:'FOREST_GREEN'},
		});
	});

	it('returns an explicit service error when persistence fails',async()=>{
		const errorLog=vi.spyOn(console,'error').mockImplementation(()=>{});
		mocks.userUpdateMany.mockRejectedValueOnce(new Error('database unavailable'));
		const response=await PATCH(request({theme:'premium-dashboard'}));
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({error:'Unable to save the theme preference.'});
		expect(errorLog).toHaveBeenCalledOnce();
		errorLog.mockRestore();
	});

	it('explains when account theme persistence needs its additive migration',async()=>{
		mocks.userUpdateMany.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError(
			'The column User.preferredTheme does not exist.',
			{code:'P2022',clientVersion:'5.22.0'},
		));
		const response=await PATCH(request({theme:'premium-dashboard'}));
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			code:'THEME_MIGRATION_REQUIRED',
			error:'Account theme saving is not enabled yet. The account-theme database migration must be applied first.',
		});
	});
});
