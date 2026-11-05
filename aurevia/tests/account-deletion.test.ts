import {beforeEach,describe,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {Prisma} from '@prisma/client';

const mocks=vi.hoisted(()=>({balance:vi.fn()}));
vi.mock('@/lib/ledger',()=>({balance:mocks.balance}));

import {deleteAccountData,inspectAccountDeletion} from '@/lib/account-deletion';

function transaction(overrides:Record<string,unknown>={}){
	return {
		user:{findUnique:vi.fn().mockImplementation(({where}:{where:{id:string}})=>Promise.resolve(where.id==='admin-1'
			?{id:'admin-1',role:'ADMIN',status:'ACTIVE'}
			:{id:'user-1',email:'user@example.invalid',role:'USER',status:'ACTIVE',avatarKey:'user-1/00000000-0000-4000-8000-000000000001.png'})),update:vi.fn().mockResolvedValue({})},
		ledgerAccount:{findMany:vi.fn().mockResolvedValue([])},
		fundingRequest:{count:vi.fn().mockResolvedValue(0)},
		order:{count:vi.fn().mockResolvedValue(0)},
		position:{count:vi.fn().mockResolvedValue(0)},
		investmentRequest:{count:vi.fn().mockResolvedValue(0)},
		communityLoan:{count:vi.fn().mockResolvedValue(0)},
		cardApplication:{count:vi.fn().mockResolvedValue(0)},
		simulatedCard:{count:vi.fn().mockResolvedValue(0)},
		taxCase:{count:vi.fn().mockResolvedValue(0)},
		kycDocument:{count:vi.fn().mockResolvedValue(1)},
		taxCaseDocument:{count:vi.fn().mockResolvedValue(2)},
		passwordResetToken:{deleteMany:vi.fn().mockResolvedValue({count:0})},
		verificationCode:{deleteMany:vi.fn().mockResolvedValue({count:0})},
		pushOutbox:{deleteMany:vi.fn().mockResolvedValue({count:0})},
		pushSubscription:{deleteMany:vi.fn().mockResolvedValue({count:0})},
		pushPreference:{deleteMany:vi.fn().mockResolvedValue({count:0})},
		kycEmailOutbox:{deleteMany:vi.fn().mockResolvedValue({count:0})},
		activityVisibilityPreference:{deleteMany:vi.fn().mockResolvedValue({count:0})},
		securitySession:{updateMany:vi.fn().mockResolvedValue({count:0})},
		twoFactorEnrollment:{deleteMany:vi.fn().mockResolvedValue({count:0})},
		securityRecoveryCode:{deleteMany:vi.fn().mockResolvedValue({count:0})},
		notification:{deleteMany:vi.fn().mockResolvedValue({count:0})},
		auditLog:{findFirst:vi.fn().mockResolvedValue(null),create:vi.fn().mockResolvedValue({})},
		...overrides,
	} as unknown as Prisma.TransactionClient;
}

const deletionInput={userId:'user-1',actorId:'admin-1',confirmationEmail:'user@example.invalid',reason:'User account no longer required',idempotencyKey:'delete-request-0001'};

describe('safe permanent account deactivation',()=>{
	beforeEach(()=>{vi.clearAllMocks();mocks.balance.mockResolvedValue(new Prisma.Decimal(0))});

	it('anonymizes login/profile identity while retaining the financial and regulatory record anchor',async()=>{
		const tx=transaction();
		const result=await deleteAccountData(tx,deletionInput);

		expect(result).toMatchObject({replayed:false,avatar:{area:'avatar',ownerId:'user-1'}});
		expect(tx.user.update).toHaveBeenCalledWith(expect.objectContaining({
			where:{id:'user-1'},
			data:expect.objectContaining({status:'CLOSED',name:null,phone:null,activeSessionId:null,depositEnabled:false,withdrawalEnabled:false}),
		}));
		expect(tx.user).not.toHaveProperty('delete');
		expect(tx.ledgerAccount).not.toHaveProperty('deleteMany');
		expect(tx.investmentRequest).toHaveProperty('count');
		expect(tx.kycDocument).toHaveProperty('count');
		expect(tx.taxCaseDocument).toHaveProperty('count');
		expect(tx.notification.deleteMany).toHaveBeenCalledWith({where:{userId:'user-1'}});
		expect(tx.auditLog.create).toHaveBeenCalledWith({data:expect.objectContaining({
			actorId:'admin-1',action:'ADMIN_ACCOUNT_PERMANENTLY_DELETED',entity:'USER',entityId:'user-1',
			metadata:expect.objectContaining({reason:deletionInput.reason,accountRecordRetained:true,financialAndRegulatoryRecordsRetained:true}),
		})});
	});

	it.each([
		['fundingRequest','ACCOUNT_HAS_UNRESOLVED_OBLIGATIONS'],
		['order','ACCOUNT_HAS_UNRESOLVED_OBLIGATIONS'],
		['position','ACCOUNT_HAS_UNRESOLVED_OBLIGATIONS'],
		['investmentRequest','ACCOUNT_HAS_UNRESOLVED_OBLIGATIONS'],
		['communityLoan','ACCOUNT_HAS_UNRESOLVED_OBLIGATIONS'],
		['cardApplication','ACCOUNT_HAS_UNRESOLVED_OBLIGATIONS'],
		['simulatedCard','ACCOUNT_HAS_UNRESOLVED_OBLIGATIONS'],
		['taxCase','ACCOUNT_HAS_UNRESOLVED_OBLIGATIONS'],
	] as const)('blocks deletion when %s reports outstanding activity',async(model,expected)=>{
		const tx=transaction({[model]:{count:vi.fn().mockResolvedValue(1)}});

		await expect(deleteAccountData(tx,deletionInput)).rejects.toThrow(expected);
		expect(tx.user.update).not.toHaveBeenCalled();
		expect(tx.auditLog.create).not.toHaveBeenCalled();
	});

	it('blocks non-zero balances across either account mode',async()=>{
		const tx=transaction({ledgerAccount:{findMany:vi.fn().mockResolvedValue([{id:'real-usd',accountMode:'REAL',currency:'USD'}])}});
		mocks.balance.mockResolvedValue(new Prisma.Decimal('0.01'));

		const result=await inspectAccountDeletion(tx,'user-1');
		expect(result.deletable).toBe(false);
		expect(result.blockers).toContainEqual({code:'NONZERO_WALLET_BALANCE',count:1});
		await expect(deleteAccountData(tx,deletionInput)).rejects.toThrow('ACCOUNT_HAS_UNRESOLVED_OBLIGATIONS');
		expect(tx.user.update).not.toHaveBeenCalled();
	});

	it('rejects an incorrect typed email and administrator accounts',async()=>{
		await expect(deleteAccountData(transaction(),{...deletionInput,confirmationEmail:'wrong@example.invalid'})).rejects.toThrow('CONFIRMATION_EMAIL_MISMATCH');
		const admin=transaction({user:{findUnique:vi.fn().mockResolvedValue({id:'user-1',email:'admin@example.invalid',role:'ADMIN',status:'ACTIVE',avatarKey:null}),update:vi.fn()}});
		await expect(deleteAccountData(admin,deletionInput)).rejects.toThrow('ADMIN_ACCOUNT_ISOLATED');
		expect(admin.user.update).not.toHaveBeenCalled();
	});

	it('replays a duplicate idempotency key without repeating deactivation',async()=>{
		const requestFingerprint=createHash('sha256')
			.update(JSON.stringify(['user-1','user@example.invalid',deletionInput.confirmationEmail,deletionInput.reason]))
			.digest('hex');
		const tx=transaction({auditLog:{findFirst:vi.fn().mockResolvedValue({metadata:{requestFingerprint}}),create:vi.fn()}});

		await expect(deleteAccountData(tx,deletionInput)).resolves.toEqual({avatar:null,replayed:true});
		expect(tx.user.update).not.toHaveBeenCalled();
		expect(tx.auditLog.create).not.toHaveBeenCalled();
		await expect(deleteAccountData(tx,{...deletionInput,reason:'Different reason under reused key'})).rejects.toThrow('IDEMPOTENCY_KEY_REUSED');
	});
});
