import {AccountMode,FundingStatus,FundingType,Prisma} from '@prisma/client';
import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	requireAdmin:vi.fn(),transaction:vi.fn(),ensureUserLedger:vi.fn(),ensureSystemAccount:vi.fn(),
	postDoubleEntry:vi.fn(),postWithdrawalDebitWithFee:vi.fn(),balance:vi.fn(),createNotification:vi.fn(),rateLimit:vi.fn(),
	decryptWithdrawalDestination:vi.fn(),getRealWithdrawableBalance:vi.fn(),
}));

vi.mock('@/lib/auth',()=>({requireAdmin:mocks.requireAdmin}));
vi.mock('@/lib/db',()=>({db:{$transaction:mocks.transaction}}));
vi.mock('@/lib/ledger',()=>({ensureUserLedger:mocks.ensureUserLedger,ensureSystemAccount:mocks.ensureSystemAccount,postDoubleEntry:mocks.postDoubleEntry,postWithdrawalDebitWithFee:mocks.postWithdrawalDebitWithFee,balance:mocks.balance}));
vi.mock('@/lib/notifications',()=>({createNotification:mocks.createNotification}));
vi.mock('@/lib/rate-limit',()=>({rateLimit:mocks.rateLimit}));
vi.mock('@/lib/serializers',()=>({jsonSafe:(value:unknown)=>value}));
vi.mock('@/lib/withdrawal-destinations',()=>({decryptWithdrawalDestination:mocks.decryptWithdrawalDestination}));
vi.mock('@/lib/real-withdrawals',()=>({getRealWithdrawableBalance:mocks.getRealWithdrawableBalance}));

import {POST} from '@/app/api/admin/funding/withdrawal/route';

const withdrawalId='withdrawal-1';
const destination={id:'destination-1',type:'BANK_TRANSFER',network:null,ciphertext:'cipher',iv:'iv',authTag:'tag'};
let current:Record<string,unknown>;
let tx:Record<string,Record<string,ReturnType<typeof vi.fn>>>;
const newKey=()=>crypto.randomUUID();

function request(action:string,extra:Record<string,unknown>={},key=newKey()){
	return new Request('https://aurevia.test/api/admin/funding/withdrawal',{method:'POST',headers:{'content-type':'application/json','Idempotency-Key':key},body:JSON.stringify({id:withdrawalId,action,...extra})});
}

beforeEach(()=>{
	vi.clearAllMocks();
	current={
		id:withdrawalId,userId:'user-1',type:FundingType.WITHDRAWAL,accountMode:AccountMode.REAL,
		status:FundingStatus.PENDING_REVIEW,currency:'USD',amount:new Prisma.Decimal('30000.00'),
		feeAmount:new Prisma.Decimal('3000.00'),feePercent:new Prisma.Decimal('10'),
		creditedAmount:new Prisma.Decimal('27000.00'),creditedCurrency:'USD',
		withdrawalDestinationId:'destination-1',adminNote:null,
	};
	const auditedActions=new Map<string,string>();
	tx={
		auditLog:{
			findFirst:vi.fn(async({where}:{where:{metadata:{path:string[];equals:string}}})=>{
				const action=auditedActions.get(where.metadata.equals);
				return action?{id:'audit-1',action}:null;
			}),
			create:vi.fn(async({data}:{data:{action:string;metadata:{idempotencyKey:string}}})=>{
				auditedActions.set(data.metadata.idempotencyKey,data.action);
				return {};
			}),
		},
		fundingRequest:{
			findUnique:vi.fn(async()=>({...current})),
			findUniqueOrThrow:vi.fn(async()=>({...current})),
			updateMany:vi.fn(async({where,data}:{where:{status:string};data:Record<string,unknown>})=>{
				if(current.status!==where.status)return {count:0};
				current={...current,...data};return {count:1};
			}),
			aggregate:vi.fn().mockResolvedValue({_sum:{amount:new Prisma.Decimal(0)}}),
		},
		withdrawalDestination:{findFirst:vi.fn().mockResolvedValue(destination)},
		user:{findUnique:vi.fn().mockResolvedValue({withdrawalEnabled:true,accountRestricted:false,status:'ACTIVE'})},
	};
	mocks.requireAdmin.mockResolvedValue({id:'admin-1'});
	mocks.transaction.mockImplementation(async(callback:(value:unknown)=>Promise<unknown>)=>callback(tx));
	mocks.ensureUserLedger.mockResolvedValue({id:'user-ledger',currency:'USD'});
	mocks.ensureSystemAccount.mockImplementation(async(_tx:unknown,code:string)=>({id:code.includes('FEE')?'withdrawal-fee':'withdrawal-clearing',currency:'USD'}));
	mocks.postDoubleEntry.mockResolvedValue(undefined);
	mocks.postWithdrawalDebitWithFee.mockResolvedValue(undefined);
	mocks.balance.mockResolvedValue(new Prisma.Decimal('100000.00'));
	mocks.createNotification.mockResolvedValue(undefined);
	mocks.getRealWithdrawableBalance.mockResolvedValue(new Prisma.Decimal('100000.00'));
	mocks.decryptWithdrawalDestination.mockReturnValue({type:'BANK_TRANSFER',network:null});
});

describe('administrator withdrawal lifecycle',()=>{
	it('approves and starts processing without debiting the ledger',async()=>{
		const approved=await POST(request('APPROVE'));
		expect(approved.status).toBe(200);
		expect(current.status).toBe(FundingStatus.APPROVED);
		expect(mocks.postDoubleEntry).not.toHaveBeenCalled();
		const processing=await POST(request('PROCESS'));
		expect(processing.status).toBe(200);
		expect(current.status).toBe(FundingStatus.PROCESSING);
		expect(mocks.postDoubleEntry).not.toHaveBeenCalled();
	});

	it('requires real processing evidence before a single ledger debit',async()=>{
		current.status=FundingStatus.PROCESSING;
		const invalid=await POST(request('COMPLETE',{processingReference:'bank-ref-123'}));
		expect(invalid.status).toBe(400);
		expect(mocks.postDoubleEntry).not.toHaveBeenCalled();
		const completed=await POST(request('COMPLETE',{processingReference:'bank-ref-123',confirmExternalProcessing:true}));
		const body=await completed.json();
		expect(completed.status).toBe(200);
		expect(body.status).toBe(FundingStatus.COMPLETED);
		expect(body.processingReference).toBe('bank-ref-123');
		expect(mocks.postWithdrawalDebitWithFee).toHaveBeenCalledTimes(1);
		expect(mocks.postWithdrawalDebitWithFee).toHaveBeenCalledWith(tx,expect.objectContaining({
			reference:`FUNDING:${withdrawalId}:EXTERNAL_WITHDRAWAL`,userAccountId:'user-ledger',
			payoutAccountId:'withdrawal-clearing',feeAccountId:'withdrawal-fee',
			grossAmount:new Prisma.Decimal('30000.00'),netPayout:new Prisma.Decimal('27000.00'),feeAmount:new Prisma.Decimal('3000.00'),
		}));
		expect(mocks.getRealWithdrawableBalance).toHaveBeenCalledWith(tx,'user-1',new Prisma.Decimal('100000.00'),withdrawalId);
	});

	it('does not complete a withdrawal that would consume paper-trading collateral',async()=>{
		current.status=FundingStatus.PROCESSING;
		mocks.getRealWithdrawableBalance.mockResolvedValue(new Prisma.Decimal('10.00'));

		const response=await POST(request('COMPLETE',{processingReference:'bank-ref-123',confirmExternalProcessing:true}));

		expect(response.status).toBe(409);
		expect(mocks.postWithdrawalDebitWithFee).not.toHaveBeenCalled();
	});

	it('requires the $300 reserve to remain available after the completed payout',async()=>{
		current.status=FundingStatus.PROCESSING;
		mocks.getRealWithdrawableBalance.mockResolvedValue(new Prisma.Decimal('30299.99'));

		const blocked=await POST(request('COMPLETE',{processingReference:'bank-ref-123',confirmExternalProcessing:true}));
		expect(blocked.status).toBe(409);
		expect(mocks.postWithdrawalDebitWithFee).not.toHaveBeenCalled();

		mocks.getRealWithdrawableBalance.mockResolvedValue(new Prisma.Decimal('30300.00'));
		const completed=await POST(request('COMPLETE',{processingReference:'bank-ref-123',confirmExternalProcessing:true}));
		expect(completed.status).toBe(200);
		expect(mocks.postWithdrawalDebitWithFee).toHaveBeenCalledTimes(1);
	});

	it('blocks legacy requests outside the configured payout range at completion',async()=>{
		current.status=FundingStatus.PROCESSING;
		current.amount=new Prisma.Decimal('29999.99');
		const belowMinimum=await POST(request('COMPLETE',{processingReference:'bank-ref-123',confirmExternalProcessing:true}));
		expect(belowMinimum.status).toBe(409);
		expect((await belowMinimum.json()).error).toContain('$30,000');
		expect(mocks.postWithdrawalDebitWithFee).not.toHaveBeenCalled();

		current.amount=new Prisma.Decimal('300000.01');
		const aboveMaximum=await POST(request('COMPLETE',{processingReference:'bank-ref-123',confirmExternalProcessing:true}));
		expect(aboveMaximum.status).toBe(409);
		expect((await aboveMaximum.json()).error).toContain('$300,000');
		expect(mocks.postWithdrawalDebitWithFee).not.toHaveBeenCalled();
	});

	it('rejects invalid state transitions and crypto confirmations without a transaction hash',async()=>{
		const processPending=await POST(request('PROCESS'));
		expect(processPending.status).toBe(409);
		current.status=FundingStatus.PROCESSING;
		mocks.decryptWithdrawalDestination.mockReturnValue({type:'CRYPTOCURRENCY',network:'BITCOIN_MAINNET'});
		const invalidHash=await POST(request('COMPLETE',{processingReference:'bank-ref-123',confirmExternalProcessing:true}));
		expect(invalidHash.status).toBe(409);
		expect(mocks.postWithdrawalDebitWithFee).not.toHaveBeenCalled();
	});

	it('releases rejected and failed reservations without ledger changes',async()=>{
		const rejected=await POST(request('REJECT',{note:'Destination details do not meet policy'}));
		expect(rejected.status).toBe(200);
		expect(current.status).toBe(FundingStatus.REJECTED);
		expect(mocks.postWithdrawalDebitWithFee).not.toHaveBeenCalled();
		current.status=FundingStatus.PROCESSING;
		const failed=await POST(request('FAIL',{note:'Transfer was not accepted by the receiving institution'}));
		expect(failed.status).toBe(200);
		expect(current.status).toBe(FundingStatus.FAILED);
		expect(mocks.postWithdrawalDebitWithFee).not.toHaveBeenCalled();
	});

	it('uses a serializable transaction and prevents completion when other reservations consume the balance',async()=>{
		current.status=FundingStatus.PROCESSING;
		mocks.getRealWithdrawableBalance.mockResolvedValue(new Prisma.Decimal('10.00'));
		const response=await POST(request('COMPLETE',{processingReference:'bank-ref-123',confirmExternalProcessing:true}));
		expect(response.status).toBe(409);
		expect(mocks.postDoubleEntry).not.toHaveBeenCalled();
		expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function),expect.objectContaining({isolationLevel:Prisma.TransactionIsolationLevel.Serializable}));
	});
});
