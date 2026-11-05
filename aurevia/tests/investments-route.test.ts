import {beforeEach,describe,expect,it,vi} from 'vitest';
import {Prisma} from '@prisma/client';

const mocks=vi.hoisted(()=>({
	requireUser:vi.fn(),
	userFindUnique:vi.fn(),
	opportunityFindMany:vi.fn(),
	opportunityFindUnique:vi.fn(),
	requestFindMany:vi.fn(),
	requestFindUnique:vi.fn(),
	requestCreate:vi.fn(),
	accountFindUnique:vi.fn(),
	transaction:vi.fn(),
	balance:vi.fn(),
	ensureSystemAccount:vi.fn(),
	ensureUserLedger:vi.fn(),
	initializeDemoAccount:vi.fn(),
	postDoubleEntry:vi.fn(),
	getRealWithdrawableBalance:vi.fn(),
	createNotification:vi.fn(),
	notifyActiveAdmins:vi.fn(),
	configuredTierBoost:vi.fn(),
	getAccountTier:vi.fn(),
	getTierProfileRequirements:vi.fn(),
}));

vi.mock('@/lib/auth',()=>({requireUser:mocks.requireUser}));
vi.mock('@/lib/db',()=>({db:{
	user:{findUnique:mocks.userFindUnique},
	investmentOpportunity:{findMany:mocks.opportunityFindMany},
	investmentRequest:{findMany:mocks.requestFindMany},
	ledgerAccount:{findUnique:mocks.accountFindUnique},
	$transaction:mocks.transaction,
}}));
vi.mock('@/lib/ledger',()=>({
	balance:mocks.balance,
	ensureSystemAccount:mocks.ensureSystemAccount,
	ensureUserLedger:mocks.ensureUserLedger,
	initializeDemoAccount:mocks.initializeDemoAccount,
	postDoubleEntry:mocks.postDoubleEntry,
	roundUsdAmount:(value:Prisma.Decimal|string|number)=>new Prisma.Decimal(value).toDecimalPlaces(2,Prisma.Decimal.ROUND_HALF_UP),
}));
vi.mock('@/lib/real-withdrawals',()=>({getRealWithdrawableBalance:mocks.getRealWithdrawableBalance}));
vi.mock('@/lib/notifications',()=>({createNotification:mocks.createNotification,notifyActiveAdmins:mocks.notifyActiveAdmins}));
vi.mock('@/lib/tier-boosts',()=>({configuredTierBoost:mocks.configuredTierBoost}));
vi.mock('@/lib/production-policy',()=>({
	getAccountTier:mocks.getAccountTier,
	getTierProfileRequirements:mocks.getTierProfileRequirements,
}));

import {GET,POST} from '@/app/api/investments/route';

const opportunity={
	id:'real-opportunity',
	title:'Internal portfolio',
	category:'Equities',
	description:'A REAL-only internal investment opportunity for route tests.',
	assetSymbol:'AAPL',
	minimumAmount:new Prisma.Decimal(10),
	maximumAmount:new Prisma.Decimal(1000),
	targetReturnPercent:new Prisma.Decimal(8),
	durationDays:30,
	startsAt:null,
	maturesAt:null,
	riskLevel:'MODERATE',
	status:'AVAILABLE',
	demoEligible:false,
	realEligible:true,
	requiresApproval:true,
	targetPrice:null,
	stopPrice:null,
};
const profile={
	status:'ACTIVE',role:'USER',accountMode:'REAL',accountRestricted:false,approvedTier:1,name:'Practice user',
	country:'US',phone:null,phoneVerified:false,kycStatus:'NOT_SUBMITTED',kyc:null,kycDocuments:[],
};
const tx={
	user:{findUnique:mocks.userFindUnique},
	investmentOpportunity:{findUnique:mocks.opportunityFindUnique},
	investmentRequest:{findUnique:mocks.requestFindUnique,create:mocks.requestCreate},
	ledgerAccount:{upsert:vi.fn()},
	auditLog:{create:vi.fn()},
};

beforeEach(()=>{
	vi.clearAllMocks();
	mocks.requireUser.mockResolvedValue({id:'real-user',accountMode:'REAL'});
	mocks.userFindUnique.mockResolvedValue(profile);
	mocks.opportunityFindMany.mockResolvedValue([opportunity]);
	mocks.opportunityFindUnique.mockResolvedValue(opportunity);
	mocks.requestFindMany.mockResolvedValue([]);
	mocks.requestFindUnique.mockResolvedValue(null);
	mocks.accountFindUnique.mockResolvedValue({id:'demo-ledger',startingBalance:new Prisma.Decimal(5000)});
	mocks.transaction.mockImplementation(async(callback:(transaction:typeof tx)=>unknown)=>callback(tx));
	mocks.balance.mockResolvedValue(new Prisma.Decimal(5000));
	mocks.ensureSystemAccount.mockResolvedValue({id:'demo-escrow'});
	mocks.ensureUserLedger.mockResolvedValue({id:'demo-ledger'});
	mocks.initializeDemoAccount.mockResolvedValue(undefined);
	mocks.postDoubleEntry.mockResolvedValue(undefined);
	mocks.getRealWithdrawableBalance.mockImplementation(async(_tx:unknown,_userId:string,available:Prisma.Decimal)=>available);
	mocks.createNotification.mockResolvedValue(undefined);
	mocks.notifyActiveAdmins.mockResolvedValue(undefined);
	mocks.configuredTierBoost.mockResolvedValue(new Prisma.Decimal(0));
	mocks.getAccountTier.mockReturnValue({label:'Tier 1'});
	mocks.getTierProfileRequirements.mockReturnValue({profileComplete:true});
	mocks.requestCreate.mockImplementation(({data}:{data:Record<string,unknown>})=>Promise.resolve({
		id:`investment-${mocks.requestCreate.mock.calls.length}`,
		...data,
		requestedAt:new Date(),
		activatedAt:null,
		maturesAt:null,
		settlementReference:null,
		simulatedPayout:null,
		durationDays:30,
	}));
});

describe('REAL-only investment allocations',()=>{
	it('denies DEMO opportunity listing using the current database account mode',async()=>{
		mocks.requireUser.mockResolvedValue({id:'demo-user',accountMode:'DEMO'});
		mocks.userFindUnique.mockResolvedValue({...profile,accountMode:'DEMO'});
		const response=await GET();
		expect(response.status).toBe(403);
		expect(mocks.opportunityFindMany).not.toHaveBeenCalled();
		expect(mocks.requestFindMany).not.toHaveBeenCalled();
	});

	it('rejects a stale session whose mode does not match the database account mode',async()=>{
		mocks.requireUser.mockResolvedValue({id:'real-user',accountMode:'DEMO'});
		const response=await GET();
		expect(response.status).toBe(409);
		expect(mocks.opportunityFindMany).not.toHaveBeenCalled();
	});

	it('denies DEMO submissions before opening a ledger transaction',async()=>{
		mocks.requireUser.mockResolvedValue({id:'demo-user',accountMode:'DEMO'});
		mocks.userFindUnique.mockResolvedValue({...profile,accountMode:'DEMO'});
		const response=await POST(new Request('https://aurevia.test/api/investments',{
			method:'POST',
			headers:{'content-type':'application/json','Idempotency-Key':crypto.randomUUID()},
			body:JSON.stringify({opportunityId:opportunity.id,amount:250}),
		}));
		expect(response.status).toBe(403);
		expect(mocks.transaction).not.toHaveBeenCalled();
		expect(mocks.postDoubleEntry).not.toHaveBeenCalled();
	});

	it('lists REAL-eligible opportunities and the REAL ledger balance',async()=>{
		const response=await GET();
		const result=await response.json();

		expect(response.status).toBe(200);
		expect(result).toMatchObject({accountMode:'REAL',availableBalance:'5000',startingBalance:'5000'});
		expect(result.opportunities).toHaveLength(1);
		expect(mocks.opportunityFindMany).toHaveBeenCalledWith(expect.objectContaining({where:{status:'AVAILABLE',realEligible:true}}));
		expect(mocks.accountFindUnique).toHaveBeenCalledWith({where:{code:'USER:real-user:REAL:USD'},select:{id:true,startingBalance:true}});
	});

	it('excludes pending order and withdrawal reservations from the displayed investment balance',async()=>{
		mocks.balance.mockResolvedValue(new Prisma.Decimal(500));
		mocks.getRealWithdrawableBalance.mockResolvedValue(new Prisma.Decimal(100));

		const response=await GET();

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({availableBalance:'100'});
		expect(mocks.getRealWithdrawableBalance).toHaveBeenCalledWith(expect.anything(),'real-user',new Prisma.Decimal(500));
	});

	it('rejects allocations exceeding the balance after paper-order collateral reservations',async()=>{
		mocks.balance.mockResolvedValue(new Prisma.Decimal(500));
		mocks.getRealWithdrawableBalance.mockResolvedValue(new Prisma.Decimal(100));

		const response=await POST(new Request('https://aurevia.test/api/investments',{
			method:'POST',
			headers:{'content-type':'application/json','Idempotency-Key':crypto.randomUUID()},
			body:JSON.stringify({opportunityId:opportunity.id,amount:200}),
		}));

		expect(response.status).toBe(400);
		expect((await response.json()).error).toContain('Insufficient available REAL account cash');
		expect(mocks.getRealWithdrawableBalance).toHaveBeenCalledWith(tx,'real-user',new Prisma.Decimal(500));
		expect(mocks.postDoubleEntry).not.toHaveBeenCalled();
	});

	it('allows repeat allocations and reserves funds only from the REAL ledger',async()=>{
		const submit=()=>POST(new Request('https://aurevia.test/api/investments',{
			method:'POST',
			headers:{'content-type':'application/json','Idempotency-Key':crypto.randomUUID()},
			body:JSON.stringify({opportunityId:opportunity.id,amount:250}),
		}));
		const first=await submit();
		const second=await submit();

		expect(first.status).toBe(201);
		expect(second.status).toBe(201);
		expect(mocks.requestCreate).toHaveBeenCalledTimes(2);
		expect(mocks.requestCreate).toHaveBeenNthCalledWith(1,expect.objectContaining({data:expect.objectContaining({accountMode:'REAL',opportunityId:opportunity.id})}));
		expect(mocks.ensureUserLedger).toHaveBeenCalledWith(tx,'real-user','REAL','USD');
		expect(mocks.ensureSystemAccount).toHaveBeenCalledWith(tx,'SYSTEM:INVESTMENT_ESCROW:REAL:USD','REAL investment escrow','USD','REAL');
		expect(mocks.postDoubleEntry).toHaveBeenCalledWith(tx,expect.objectContaining({reference:expect.stringMatching(/^INVESTMENT:investment-1:RESERVE$/),amount:expect.any(Prisma.Decimal)}));
	});

	it('rejects allocations that exceed the available REAL balance',async()=>{
		mocks.balance.mockResolvedValue(new Prisma.Decimal(100));

		const response=await POST(new Request('https://aurevia.test/api/investments',{
			method:'POST',
			headers:{'content-type':'application/json','Idempotency-Key':crypto.randomUUID()},
			body:JSON.stringify({opportunityId:opportunity.id,amount:250}),
		}));

		expect(response.status).toBe(400);
		expect((await response.json()).error).toContain('Insufficient available REAL account cash');
		expect(mocks.postDoubleEntry).not.toHaveBeenCalled();
	});
});
