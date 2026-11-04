import {AccountMode} from '@prisma/client';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {Prisma} from '@prisma/client';

const mocks=vi.hoisted(()=>({
	requireUser:vi.fn(),
	userFindUnique:vi.fn(),
	accountFindUnique:vi.fn(),
	positionFindMany:vi.fn(),
	positionAggregate:vi.fn(),
	positionGroupBy:vi.fn(),
	investmentFindMany:vi.fn(),
	fundingAggregate:vi.fn(),
	fundingFindMany:vi.fn(),
	opportunityFindMany:vi.fn(),
	orderFindMany:vi.fn(),
	snapshotUpsert:vi.fn(),
	snapshotFindMany:vi.fn(),
	marketQuote:vi.fn(),
	balance:vi.fn(),
	reservedWithdrawalAmount:vi.fn(),
	paperOrderCollateral:vi.fn(),
	walletBackedPaperInstrumentIds:vi.fn(),
}));

vi.mock('@/lib/auth',()=>({requireUser:mocks.requireUser}));
vi.mock('@/lib/db',()=>({db:{
	user:{findUnique:mocks.userFindUnique},
	ledgerAccount:{findUnique:mocks.accountFindUnique},
	position:{findMany:mocks.positionFindMany,aggregate:mocks.positionAggregate,groupBy:mocks.positionGroupBy},
	investmentRequest:{findMany:mocks.investmentFindMany},
	fundingRequest:{aggregate:mocks.fundingAggregate,findMany:mocks.fundingFindMany},
	investmentOpportunity:{findMany:mocks.opportunityFindMany},
	order:{findMany:mocks.orderFindMany},
	portfolioSnapshot:{upsert:mocks.snapshotUpsert,findMany:mocks.snapshotFindMany},
}}));
vi.mock('@/lib/ledger',()=>({balance:mocks.balance,reservedWithdrawalAmount:mocks.reservedWithdrawalAmount}));
vi.mock('@/lib/bitcoin-funding',()=>({ALPACA_PAPER_PROVIDER:'alpaca-paper',BTC_FUNDING_METHOD:'btc',paperOrderCollateral:mocks.paperOrderCollateral}));
vi.mock('@/lib/market-data-service',()=>({
	getMarketQuoteWithFallback:mocks.marketQuote,
	getAlpacaMarketDataOptions:vi.fn(()=>undefined),
}));
vi.mock('@/lib/paper-ledger-reconciliation',()=>({getWalletBackedPaperInstrumentIds:mocks.walletBackedPaperInstrumentIds}));

import {GET} from '@/app/api/portfolio/route';

const paperPosition=(updatedAt:Date)=>({
	id:'paper-position-1',
	instrumentId:'instrument-1',
	side:'BUY',
	quantity:new Prisma.Decimal(2),
	entryPrice:new Prisma.Decimal(100),
	realizedPnl:new Prisma.Decimal(0),
	openedAt:new Date('2026-10-28T08:00:00.000Z'),
	providerName:'alpaca-paper',
	instrument:{
		id:'instrument-1',
		symbol:'AAPL',
		name:'Apple',
		category:'STOCK',
		baseAsset:'AAPL',
		quoteAsset:'USD',
		price:new Prisma.Decimal(110),
		updatedAt,
	},
});

describe('portfolio route provider valuation',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		mocks.requireUser.mockResolvedValue({id:'user-1'});
		mocks.userFindUnique.mockResolvedValue({accountMode:AccountMode.REAL,status:'ACTIVE'});
		mocks.accountFindUnique.mockResolvedValue({id:'real-usd',startingBalance:new Prisma.Decimal(0)});
		mocks.positionFindMany.mockResolvedValue([]);
		mocks.positionAggregate.mockResolvedValue({_sum:{realizedPnl:null}});
		mocks.positionGroupBy.mockResolvedValue([]);
		mocks.investmentFindMany.mockResolvedValue([]);
		mocks.fundingAggregate.mockResolvedValue({_sum:{amount:null,creditedAmount:null}});
		mocks.fundingFindMany.mockResolvedValue([]);
		mocks.opportunityFindMany.mockResolvedValue([]);
		mocks.orderFindMany.mockResolvedValue([]);
		mocks.snapshotUpsert.mockResolvedValue({});
		mocks.snapshotFindMany.mockResolvedValue([]);
		mocks.balance.mockResolvedValue(new Prisma.Decimal(250));
		mocks.reservedWithdrawalAmount.mockResolvedValue(new Prisma.Decimal(0));
		mocks.paperOrderCollateral.mockReturnValue({committed:new Prisma.Decimal(0)});
		mocks.walletBackedPaperInstrumentIds.mockResolvedValue(new Set(['instrument-1']));
		mocks.marketQuote.mockResolvedValue({price:110,updatedAt:new Date().toISOString(),source:'Alpaca',isStale:false});
	});

	it('includes ledger-backed positions in portfolio value without changing wallet cash',async()=>{
		mocks.positionFindMany.mockResolvedValue([paperPosition(new Date(Date.now()-120_000))]);

		const response=await GET();
		const result=await response.json();

		expect(response.status).toBe(200);
		expect(result.paperPositions[0]).toMatchObject({
			currentPrice:'110',
			marketValue:'220',
			unrealizedPnl:'20',
			valuationStatus:'CURRENT',
		});
		expect(result.paperPositionValue).toBe('220');
		expect(result.paperUnrealizedPnl).toBe('20');
		expect(result.paperValuation).toMatchObject({status:'CURRENT',valuedCount:1,openCount:1});
		expect(result.cashBalance).toBe('250');
		expect(result.availableCashBalance).toBe('250');
		expect(result.totalValue).toBe('470');
		expect(result.paperPositions[0].valuationSource).toBe('Market quote');
	});

	it('excludes an unreconciled legacy position from account value without changing its records',async()=>{
		mocks.positionFindMany.mockResolvedValue([paperPosition(new Date())]);
		mocks.walletBackedPaperInstrumentIds.mockResolvedValue(new Set());

		const response=await GET();
		const result=await response.json();

		expect(result.cashBalance).toBe('250');
		expect(result.totalValue).toBe('250');
		expect(result.unreconciledPaperPositionCount).toBe(1);
		expect(result.paperPositions[0]).toMatchObject({walletBacked:false,marketValue:null,valuationStatus:'UNAVAILABLE'});
		expect(mocks.snapshotUpsert).toHaveBeenCalledOnce();
	});

	it('does not present a stale provider mark as a current value',async()=>{
		const quotedAt=new Date(Date.now()-120_000);
		mocks.positionFindMany.mockResolvedValue([paperPosition(quotedAt)]);
		mocks.marketQuote.mockResolvedValue({price:110,updatedAt:quotedAt.toISOString(),source:'Alpaca',isStale:true});

		const response=await GET();
		const result=await response.json();

		expect(response.status).toBe(200);
		expect(result.paperPositions[0]).toMatchObject({
			currentPrice:null,
			marketValue:null,
			unrealizedPnl:null,
			valuationStatus:'STALE',
		});
		expect(result.paperPositionValue).toBeNull();
		expect(result.paperUnrealizedPnl).toBeNull();
		expect(result.paperValuation).toMatchObject({status:'STALE',valuedCount:0,openCount:1});
	});

	it('leaves paper holdings unvalued when there is no recorded quote timestamp',async()=>{
		mocks.positionFindMany.mockResolvedValue([paperPosition(new Date())]);
		mocks.marketQuote.mockRejectedValue(new Error('provider unavailable'));

		const response=await GET();
		const result=await response.json();

		expect(response.status).toBe(200);
		expect(result.paperPositions[0]).toMatchObject({valuationStatus:'UNAVAILABLE',valuationAsOf:null,marketValue:null});
		expect(result.paperValuation).toMatchObject({status:'UNAVAILABLE',valuedCount:0,openCount:1});
	});

	it('uses provider quotes for REAL positions and marks totals unavailable when quotes are missing',async()=>{
		mocks.positionFindMany.mockResolvedValue([{...paperPosition(new Date()),providerName:null}]);
		mocks.marketQuote.mockRejectedValue(new Error('provider unavailable'));

		const response=await GET();
		const result=await response.json();

		expect(response.status).toBe(200);
		expect(result.positions[0]).toMatchObject({currentPrice:null,marketValue:null,unrealizedPnl:null,valuationStatus:'UNAVAILABLE'});
		expect(result.positionValue).toBeNull();
		expect(result.totalValue).toBeNull();
		expect(result.unrealizedPnl).toBeNull();
		expect(result.marketDataMode).toBe('PROVIDER_UNAVAILABLE');
		expect(mocks.snapshotUpsert).not.toHaveBeenCalled();
	});

	it('values REAL position P/L from a fresh provider quote',async()=>{
		mocks.positionFindMany.mockResolvedValue([{...paperPosition(new Date()),providerName:null}]);

		const response=await GET();
		const result=await response.json();

		expect(response.status).toBe(200);
		expect(result.positions[0]).toMatchObject({currentPrice:'110',marketValue:'220',unrealizedPnl:'20',valuationStatus:'CURRENT',valuationSource:'Market quote'});
		expect(result.positionValue).toBe('220');
		expect(result.totalValue).toBe('470');
		expect(result.unrealizedPnl).toBe('20');
		expect(result.marketDataMode).toBe('LIVE_PROVIDER');
		expect(mocks.snapshotUpsert).toHaveBeenCalledOnce();
	});

	it('uses the instrument fee when calculating available cash after Paper reserves',async()=>{
		const takerFee=new Prisma.Decimal('0.02');
		mocks.orderFindMany.mockResolvedValue([{
			instrumentId:'AAPL',side:'BUY',quantity:new Prisma.Decimal(1),filledQuantity:new Prisma.Decimal(0),
			averageFillPrice:null,providerReservedAmount:new Prisma.Decimal(100),status:'OPEN',
			createdAt:new Date(),instrument:{takerFee},
		}]);
		mocks.paperOrderCollateral.mockReturnValue({committed:new Prisma.Decimal(102)});

		const response=await GET();
		const result=await response.json();

		expect(response.status).toBe(200);
		expect(mocks.paperOrderCollateral).toHaveBeenCalledWith([expect.objectContaining({takerFee})]);
		expect(result.paperAvailableBalance).toBe('148');
		expect(result.availableCashBalance).toBe('148');
	});
});
