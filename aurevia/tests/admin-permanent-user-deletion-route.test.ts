import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	requireAdmin:vi.fn(),
	passwordCompare:vi.fn(),
	adminFindUnique:vi.fn(),
	targetFindUnique:vi.fn(),
	transaction:vi.fn(),
	deleteAccountData:vi.fn(),
	inspectAccountDeletion:vi.fn(),
	auditFindMany:vi.fn(),
	deletePrivateObject:vi.fn(),
	rateLimit:vi.fn(),
}));

vi.mock('bcryptjs',()=>({default:{compare:mocks.passwordCompare}}));
vi.mock('@/lib/auth',()=>({requireAdmin:mocks.requireAdmin}));
vi.mock('@/lib/db',()=>({db:{
	user:{findUnique:mocks.adminFindUnique},
	auditLog:{findMany:mocks.auditFindMany},
	$transaction:mocks.transaction,
}}));
vi.mock('@/lib/account-deletion',()=>({deleteAccountData:mocks.deleteAccountData,inspectAccountDeletion:mocks.inspectAccountDeletion}));
vi.mock('@/lib/config/env',()=>({getServerConfiguration:()=>({auth:{adminEmail:'root@example.invalid'}})}));
vi.mock('@/lib/private-storage',()=>({deletePrivateObject:mocks.deletePrivateObject}));
vi.mock('@/lib/rate-limit',()=>({rateLimit:mocks.rateLimit}));

import {GET,POST} from '@/app/api/admin/users/delete/route';

const admin={id:'admin-1',role:'ADMIN',status:'ACTIVE',passwordHash:'stored-hash'};
const deletion={userId:'customer-1',confirmationEmail:'customer@example.invalid',confirmationPhrase:'DELETE PERMANENTLY',adminPassword:'admin-password',reason:'Account no longer required'};
const tx={user:{findUnique:mocks.targetFindUnique}};

function post(payload=deletion,headers:Record<string,string>={}){
	return POST(new Request('https://aurevia.test/api/admin/users/delete',{
		method:'POST',
		headers:{origin:'https://aurevia.test','content-type':'application/json','Idempotency-Key':'delete-request-key-0001',...headers},
		body:JSON.stringify(payload),
	}));
}

beforeEach(()=>{
	vi.clearAllMocks();
	mocks.requireAdmin.mockResolvedValue(admin);
	mocks.passwordCompare.mockResolvedValue(true);
	mocks.adminFindUnique.mockResolvedValue(admin);
	mocks.targetFindUnique.mockResolvedValue({id:'customer-1',email:'customer@example.invalid',role:'USER'});
	mocks.transaction.mockImplementation(async(callback:(transaction:typeof tx)=>unknown)=>callback(tx));
	mocks.deleteAccountData.mockResolvedValue({avatar:null,replayed:false});
	mocks.inspectAccountDeletion.mockResolvedValue({user:{id:'customer-1',email:'customer@example.invalid',role:'USER',status:'ACTIVE'},balances:[],blockers:[],deletable:true,retainedRecords:{kycDocuments:0,taxDocuments:0,financialHistory:true,auditHistory:true,supportRecords:true}});
	mocks.auditFindMany.mockResolvedValue([]);
	mocks.deletePrivateObject.mockResolvedValue(true);
	mocks.rateLimit.mockReturnValue(undefined);
});

describe('admin permanent user deactivation endpoint',()=>{
	it('requires the authenticated active administrator password and origin before deactivation',async()=>{
		mocks.passwordCompare.mockResolvedValue(false);
		const response=await post();
		expect(response.status).toBe(403);
		expect(mocks.deleteAccountData).not.toHaveBeenCalled();

		mocks.passwordCompare.mockResolvedValue(true);
		const crossOrigin=await post(deletion,{origin:'https://attacker.example'});
		expect(crossOrigin.status).toBe(403);
		expect(mocks.deleteAccountData).not.toHaveBeenCalled();
	});

	it('rejects a missing confirmation phrase or idempotency key',async()=>{
		const invalidConfirmation=await post({...deletion,confirmationPhrase:'DELETE'});
		expect(invalidConfirmation.status).toBe(400);
		const missingKey=await post(deletion,{'Idempotency-Key':''});
		expect(missingKey.status).toBe(400);
		expect(mocks.deleteAccountData).not.toHaveBeenCalled();
	});

	it('deactivates an eligible account and reports the retained record and storage result',async()=>{
		mocks.deleteAccountData.mockResolvedValue({avatar:{area:'avatar',ownerId:'customer-1',key:'customer-1/avatar.png'},replayed:false});
		const response=await post();
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ok:true,replayed:false,retainedAccountRecord:true,storageCleanup:{attempted:1,deleted:1,pending:0}});
		expect(mocks.deleteAccountData).toHaveBeenCalledWith(tx,expect.objectContaining({actorId:'admin-1',confirmationEmail:deletion.confirmationEmail,reason:deletion.reason,idempotencyKey:'delete-request-key-0001'}));
		expect(mocks.deletePrivateObject).toHaveBeenCalledOnce();
	});

	it('blocks unresolved financial activity and duplicate submissions are idempotent',async()=>{
		mocks.deleteAccountData.mockRejectedValueOnce(new Error('ACCOUNT_HAS_UNRESOLVED_OBLIGATIONS'));
		expect((await post()).status).toBe(409);

		mocks.deleteAccountData.mockResolvedValueOnce({avatar:null,replayed:true});
		expect(await (await post()).json()).toMatchObject({ok:true,replayed:true});
		expect(mocks.deletePrivateObject).not.toHaveBeenCalled();
	});

	it('refuses self and administrator targets',async()=>{
		mocks.adminFindUnique.mockResolvedValue({...admin,id:'customer-1'});
		expect((await post()).status).toBe(409);

		mocks.adminFindUnique.mockResolvedValue(admin);
		mocks.targetFindUnique.mockResolvedValue({id:'customer-1',email:'customer@example.invalid',role:'ADMIN'});
		expect((await post()).status).toBe(409);
		expect(mocks.deleteAccountData).not.toHaveBeenCalled();
	});

	it('returns authorized deletion history and eligibility assessments',async()=>{
		const history=await GET(new Request('https://aurevia.test/api/admin/users/delete?history=true'));
		expect(history.status).toBe(200);
		expect(mocks.auditFindMany).toHaveBeenCalledWith(expect.objectContaining({where:{action:'ADMIN_ACCOUNT_PERMANENTLY_DELETED',entity:'USER'}}));
		const assessment=await GET(new Request('https://aurevia.test/api/admin/users/delete?userId=customer-1'));
		expect(assessment.status).toBe(200);
		expect(mocks.inspectAccountDeletion).toHaveBeenCalledWith(tx,'customer-1');
	});
});
