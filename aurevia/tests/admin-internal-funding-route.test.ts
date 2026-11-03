import {AccountMode,FundingStatus,FundingType,Prisma} from '@prisma/client';
import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	requireAdmin:vi.fn(),
	transaction:vi.fn(),
	userFindUnique:vi.fn(),
	ensureUserLedger:vi.fn(),
	ensureSystemAccount:vi.fn(),
	postGrossCreditWithFee:vi.fn(),
	balance:vi.fn(),
	roundUsdAmount:vi.fn(),
	createNotification:vi.fn(),
	sendSupportEmail:vi.fn(),
}));

vi.mock('@/lib/auth',()=>({requireAdmin:mocks.requireAdmin}));
vi.mock('@/lib/db',()=>({db:{$transaction:mocks.transaction,user:{findUnique:mocks.userFindUnique}}}));
vi.mock('@/lib/ledger',()=>({
	ensureUserLedger:mocks.ensureUserLedger,
	ensureSystemAccount:mocks.ensureSystemAccount,
	postGrossCreditWithFee:mocks.postGrossCreditWithFee,
	balance:mocks.balance,
	roundUsdAmount:mocks.roundUsdAmount,
}));
vi.mock('@/lib/notifications',()=>({createNotification:mocks.createNotification}));
vi.mock('@/lib/email',()=>({
	emailDeliveryStatus:(delivery:{sent:boolean;reason?:string})=>delivery.sent?'sent':delivery.reason==='not-configured'?'not-configured':'failed',
	sendSupportEmail:mocks.sendSupportEmail,
}));
vi.mock('@/lib/production-policy',()=>({validateDepositApproval:vi.fn()}));

import {PATCH} from '@/app/api/admin/funding/route';

const transactionId='funding-internal-1';
let currentFunding:Record<string,unknown>;
let tx:Record<string,Record<string,ReturnType<typeof vi.fn>>>;

function reviewRequest(decision:string,extra:Record<string,unknown>={}){
	return new Request('https://aurevia.test/api/admin/funding',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({id:transactionId,decision,...extra})});
}

function makeRequest(overrides:Record<string,unknown>={}){
	return {
		id:transactionId,userId:'user-1',type:FundingType.DEPOSIT,method:'Internal REAL deposit request',
		amount:new Prisma.Decimal('42.50'),currency:'USD',network:null,transactionReference:'user-note-123',
		status:FundingStatus.PENDING_REVIEW,accountMode:AccountMode.REAL,receiptKey:null,
		verifiedAt:null,creditedAmount:null,creditedCurrency:null,settlementReference:null,updatedAt:new Date(),
		...overrides,
	};
}

beforeEach(()=>{
	vi.clearAllMocks();
	currentFunding=makeRequest();
	tx={
		fundingRequest:{
			findUnique:vi.fn(async()=>({...currentFunding})),
			findUniqueOrThrow:vi.fn(async()=>({...currentFunding})),
			aggregate:vi.fn().mockResolvedValue({_sum:{amount:new Prisma.Decimal(0)}}),
			updateMany:vi.fn(async({data}:{data:Record<string,unknown>})=>{currentFunding={...currentFunding,...data,updatedAt:new Date()};return {count:1}}),
		},
		auditLog:{create:vi.fn().mockResolvedValue({})},
		user:{findUnique:vi.fn().mockResolvedValue({withdrawalEnabled:true,accountRestricted:false})},
	};
	mocks.requireAdmin.mockResolvedValue({id:'admin-1'});
	mocks.transaction.mockImplementation(async(callback:(transaction:unknown)=>Promise<unknown>)=>{
		const before={...currentFunding};
		try{return await callback(tx)}catch(error){currentFunding=before;throw error}
	});
	mocks.userFindUnique.mockResolvedValue({email:'user@example.test'});
	mocks.ensureUserLedger.mockResolvedValue({id:'real-usd-ledger',currency:'USD'});
	mocks.ensureSystemAccount.mockResolvedValue({id:'real-clearing',currency:'USD'});
	mocks.postGrossCreditWithFee.mockResolvedValue(undefined);
	mocks.balance.mockResolvedValue(new Prisma.Decimal('100.00'));
	mocks.roundUsdAmount.mockImplementation((value:number|string)=>new Prisma.Decimal(value).toDecimalPlaces(2,Prisma.Decimal.ROUND_HALF_UP));
	mocks.createNotification.mockResolvedValue(undefined);
	mocks.sendSupportEmail.mockResolvedValue({sent:false,reason:'not-configured'});
});

describe('administrator-controlled REAL funding route',()=>{
	it('credits the approved USD amount net of the 10% deposit fee and records the allocation',async()=>{
		const submittedBalance=new Prisma.Decimal(0);
		expect(submittedBalance.toFixed(2)).toBe('0.00');

		const response=await PATCH(reviewRequest('APPROVED'));
		const body=await response.json();
		expect(response.status).toBe(200);
		expect(currentFunding).toMatchObject({status:FundingStatus.APPROVED,creditedCurrency:'USD',creditedAmount:new Prisma.Decimal('38.25'),feeAmount:new Prisma.Decimal('4.25'),feePercent:new Prisma.Decimal('10')});
		expect(mocks.ensureUserLedger).toHaveBeenCalledWith(tx,'user-1',AccountMode.REAL,'USD');
		expect(mocks.postGrossCreditWithFee).toHaveBeenCalledTimes(1);
		expect(mocks.postGrossCreditWithFee).toHaveBeenCalledWith(tx,expect.objectContaining({
			reference:`FUNDING:${transactionId}:APPROVED`,
			grossAmount:new Prisma.Decimal('42.50'),
			creditedAmount:new Prisma.Decimal('38.25'),
			feeAmount:new Prisma.Decimal('4.25'),
		}));
		expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({
			actorId:'admin-1',
			action:'FUNDING_APPROVED',
			metadata:expect.objectContaining({userId:'user-1',accountMode:AccountMode.REAL,status:FundingStatus.APPROVED,ledgerTransactionReference:`FUNDING:${transactionId}:APPROVED`}),
		})}));
		expect(body).toMatchObject({creditedCurrency:'USD',accountMode:AccountMode.REAL});
	});

	it('does not permit a client-supplied amount to alter the approved request credit',async()=>{
		const response=await PATCH(reviewRequest('APPROVED',{creditedAmount:1}));
		expect(response.status).toBe(200);
		expect(mocks.postGrossCreditWithFee).toHaveBeenCalledWith(tx,expect.objectContaining({grossAmount:new Prisma.Decimal('42.50'),creditedAmount:new Prisma.Decimal('38.25')}));
	});

	it('uses serializable transactions and returns a conflict when the database detects a concurrent review',async()=>{
		mocks.transaction.mockRejectedValue({code:'P2034'});
		const response=await PATCH(reviewRequest('APPROVED'));
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({error:'The request changed during review. Refresh the funding queue and try again.'});
		expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function),expect.objectContaining({
			isolationLevel:Prisma.TransactionIsolationLevel.Serializable,
		}));
		expect(mocks.postGrossCreditWithFee).not.toHaveBeenCalled();
	});

	it('does not credit on rejection and records the rejection',async()=>{
		const response=await PATCH(reviewRequest('REJECTED',{note:'Request does not meet policy'}));
		expect(response.status).toBe(200);
		expect(currentFunding.status).toBe(FundingStatus.REJECTED);
		expect(mocks.postGrossCreditWithFee).not.toHaveBeenCalled();
		expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({action:'FUNDING_REJECTED'})}));
	});

	it('requires REAL withdrawals to use the separate externally confirmed lifecycle',async()=>{
		currentFunding=makeRequest({type:FundingType.WITHDRAWAL,method:'Internal REAL withdrawal request',amount:new Prisma.Decimal('10.00'),transactionReference:null});
		const response=await PATCH(reviewRequest('APPROVED'));
		const body=await response.json();
		expect(response.status).toBe(409);
		expect(body.error).toContain('approve, process, and externally confirmed');
		expect(mocks.postGrossCreditWithFee).not.toHaveBeenCalled();
	});

	it('requires withdrawal rejection to use the audited lifecycle route',async()=>{
		currentFunding=makeRequest({type:FundingType.WITHDRAWAL,amount:new Prisma.Decimal('10.00'),transactionReference:null});
		const response=await PATCH(reviewRequest('REJECTED'));
		expect(response.status).toBe(409);
		expect(currentFunding.status).toBe(FundingStatus.PENDING_REVIEW);
		expect(mocks.postGrossCreditWithFee).not.toHaveBeenCalled();
	});

	it('does not approve legacy non-USD requests or post credits',async()=>{
		currentFunding=makeRequest({currency:'BTC',amount:new Prisma.Decimal('0.125')});
		const response=await PATCH(reviewRequest('APPROVED'));
		expect(response.status).toBe(409);
		expect(mocks.postGrossCreditWithFee).not.toHaveBeenCalled();
		expect(tx.fundingRequest.updateMany).not.toHaveBeenCalled();
	});

	it('does not approve legacy DEMO funding requests',async()=>{
		currentFunding=makeRequest({accountMode:AccountMode.DEMO});
		const response=await PATCH(reviewRequest('APPROVED'));
		expect(response.status).toBe(409);
		expect(mocks.postGrossCreditWithFee).not.toHaveBeenCalled();
		expect(tx.fundingRequest.updateMany).not.toHaveBeenCalled();
	});
});
