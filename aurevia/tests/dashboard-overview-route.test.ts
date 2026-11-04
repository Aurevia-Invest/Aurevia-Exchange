import {AccountMode,InvestmentStatus} from '@prisma/client';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {Prisma} from '@prisma/client';

const mocks=vi.hoisted(()=>({
	requireUser:vi.fn(),
	userFindUnique:vi.fn(),
	userUpdateMany:vi.fn(),
	transaction:vi.fn(),
	accountFindMany:vi.fn(),
	documentCount:vi.fn(),
	positionFindMany:vi.fn(),
	investmentFindMany:vi.fn(),
	orderFindMany:vi.fn(),
	opportunityFindMany:vi.fn(),
	instrumentFindMany:vi.fn(),
	getActivity:vi.fn(),
	balance:vi.fn(),
	marketQuote:vi.fn(),
	walletBackedPaperInstrumentIds:vi.fn(),
}));

vi.mock('@/lib/auth',()=>({requireUser:mocks.requireUser}));
vi.mock('@/lib/db',()=>({db:{
	user:{findUnique:mocks.userFindUnique},
	$transaction:mocks.transaction,
	ledgerAccount:{findMany:mocks.accountFindMany},
	kycDocument:{count:mocks.documentCount},
	position:{findMany:mocks.positionFindMany},
	investmentRequest:{findMany:mocks.investmentFindMany},
	order:{findMany:mocks.orderFindMany},
	investmentOpportunity:{findMany:mocks.opportunityFindMany},
	instrument:{findMany:mocks.instrumentFindMany},
}}));
vi.mock('@/lib/activity',()=>({getUserActivity:mocks.getActivity}));
vi.mock('@/lib/ledger',()=>({balance:mocks.balance,DEMO_STARTING_BALANCE:'5000.00'}));
vi.mock('@/lib/market-data-service',()=>({getMarketQuoteWithFallback:mocks.marketQuote,getAlpacaMarketDataOptions:vi.fn(()=>undefined)}));
vi.mock('@/lib/config/env',()=>({getServerConfiguration:vi.fn(()=>({execution:{},marketData:{finnhubApiKey:null}}))}));
vi.mock('@/lib/paper-ledger-reconciliation',()=>({getWalletBackedPaperInstrumentIds:mocks.walletBackedPaperInstrumentIds}));

import {GET} from '@/app/api/dashboard/overview/route';

describe('user dashboard overview access and mode separation',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		mocks.requireUser.mockResolvedValue({id:'user-1',accountMode:AccountMode.DEMO});
		mocks.userFindUnique.mockResolvedValue({
			id:'user-1',name:'Aurevia User',role:'USER',status:'ACTIVE',accountMode:AccountMode.REAL,
			approvedTier:1,kycStatus:'PENDING',avatarKey:null,kyc:null,country:null,phone:null,
		});
		mocks.transaction.mockImplementation((operation:(tx:unknown)=>unknown)=>operation({
			user:{findUnique:mocks.userFindUnique,updateMany:mocks.userUpdateMany},
			auditLog:{create:vi.fn()},
		}));
		mocks.accountFindMany.mockResolvedValue([{id:'real-account'}]);
		mocks.documentCount.mockResolvedValue(0);
		mocks.positionFindMany.mockResolvedValue([]);
		mocks.investmentFindMany.mockResolvedValue([]);
		mocks.orderFindMany.mockResolvedValue([]);
		mocks.opportunityFindMany.mockResolvedValue([]);
		mocks.instrumentFindMany.mockResolvedValue([{id:'btc-instrument',symbol:'BTC/USD'}]);
		mocks.getActivity.mockResolvedValue({items:[],total:0,hasMore:false,cursor:null});
		mocks.balance.mockImplementation(async(_db:unknown,id:string)=>new Prisma.Decimal(id==='demo-account'?'125.50':'40.50'));
		mocks.marketQuote.mockResolvedValue({price:12,updatedAt:new Date().toISOString(),source:'Finnhub',isStale:false});
		mocks.walletBackedPaperInstrumentIds.mockResolvedValue(new Set(['btc-instrument']));
	});

	it('requires an authenticated user before reading account data',async()=>{
		mocks.requireUser.mockRejectedValue(new Error('UNAUTHORIZED'));

		const response=await GET();

		expect(response.status).toBe(401);
		expect(mocks.userFindUnique).not.toHaveBeenCalled();
	});

	it('uses database-confirmed REAL mode for portfolio data while keeping both ledgers separate',async()=>{
		mocks.positionFindMany.mockResolvedValue([{
			id:'position-1',side:'BUY',quantity:new Prisma.Decimal(2),entryPrice:new Prisma.Decimal(9),openedAt:new Date('2026-01-01'),
			providerName:null,instrumentId:'btc-instrument',instrument:{symbol:'BTC/USD',name:'Bitcoin',baseAsset:'BTC',quoteAsset:'USD',price:new Prisma.Decimal(10)},
		}]);
		mocks.investmentFindMany.mockResolvedValue([{
			id:'investment-1',amount:new Prisma.Decimal(5),requestedAt:new Date('2026-01-02'),
			opportunity:{title:'Published opportunity',category:'Private markets',assetSymbol:null,riskLevel:'LOW',durationDays:30},
		}]);
		mocks.orderFindMany.mockResolvedValue([{
			id:'order-1',side:'BUY',type:'LIMIT',status:'OPEN',quantity:new Prisma.Decimal(1),filledQuantity:new Prisma.Decimal(0),
			price:new Prisma.Decimal(10),createdAt:new Date('2026-01-03'),instrument:{symbol:'BTC',name:'Bitcoin'},
		}]);

		const response=await GET();
		const result=await response.json();

		expect(response.status).toBe(200);
		expect(response.headers.get('Cache-Control')).toBe('private, no-store');
		expect(result.accountMode).toBe('REAL');
		expect(result.balances).toEqual({REAL:'40.5'});
		expect(result.portfolioSummary).toMatchObject({
			accountMode:'REAL',cashBalance:'40.5',positionValue:'24',investmentValue:'5',totalValue:'69.5',unrealizedPnl:'6',
		});
		expect(mocks.marketQuote).toHaveBeenCalled();
		expect(mocks.accountFindMany).toHaveBeenCalledWith({where:{userId:'user-1',accountMode:AccountMode.REAL,currency:'USD'},select:{id:true}});
		expect(mocks.getActivity).toHaveBeenCalledWith('user-1',AccountMode.REAL,'all',8);
		expect(result.openOrders).toHaveLength(1);
		expect(result.internalMarketInstruments).toEqual([{assetId:'BTC',instrumentId:'btc-instrument'}]);
		expect(result.positions[0]).toMatchObject({currentPrice:'12',marketValue:'24'});
		expect(mocks.positionFindMany).toHaveBeenCalledWith(expect.objectContaining({where:{userId:'user-1',accountMode:AccountMode.REAL,status:'OPEN'}}));
		expect(mocks.investmentFindMany).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({userId:'user-1',accountMode:AccountMode.REAL,status:{in:expect.arrayContaining([InvestmentStatus.ACTIVE])}})}));
		expect(mocks.orderFindMany).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({userId:'user-1',accountMode:AccountMode.REAL})}));
		expect(JSON.stringify(result)).not.toContain('passwordHash');
	});

	it('does not value REAL positions using the internal instrument mark when market data is unavailable',async()=>{
		mocks.positionFindMany.mockResolvedValue([{
			id:'position-1',instrumentId:'btc-instrument',providerName:null,side:'BUY',quantity:new Prisma.Decimal(2),entryPrice:new Prisma.Decimal(9),openedAt:new Date('2026-01-01'),
			instrument:{symbol:'BTC/USD',name:'Bitcoin',baseAsset:'BTC',quoteAsset:'USD',price:new Prisma.Decimal(10)},
		}]);
		mocks.marketQuote.mockRejectedValue(new Error('unavailable'));

		const response=await GET();
		const result=await response.json();

		expect(result.portfolioSummary).toMatchObject({positionValue:null,totalValue:null,unrealizedPnl:null});
		expect(result.positions[0]).toMatchObject({currentPrice:null,marketValue:null});
	});

	it('returns active investment display terms using the recorded target and tier boost',async()=>{
		mocks.investmentFindMany.mockResolvedValue([{
			id:'investment-live',
			accountMode:AccountMode.REAL,
			amount:new Prisma.Decimal(100),
			status:InvestmentStatus.ACTIVE,
			activatedAt:new Date('2026-05-01T00:00:00.000Z'),
			maturesAt:new Date('2026-05-11T00:00:00.000Z'),
			durationDays:10,
			targetReturnPercent:new Prisma.Decimal(12),
			tierBoostPercent:new Prisma.Decimal(3),
			requestedAt:new Date('2026-05-01T00:00:00.000Z'),
			opportunity:{title:'Recorded terms',category:'Private markets',assetSymbol:null,riskLevel:'LOW',durationDays:10},
		}]);

		const response=await GET();
		const result=await response.json();

		expect(response.status).toBe(200);
		expect(result.activeInvestments).toEqual([expect.objectContaining({
			id:'investment-live',accountMode:'REAL',amount:'100',status:'ACTIVE',
			displayTargetPayout:'115',durationDays:10,
		})]);
	});

	it('returns only DEMO balances and activity when DEMO mode is active',async()=>{
		mocks.userFindUnique.mockResolvedValue({
			id:'user-1',name:'Aurevia User',role:'USER',status:'ACTIVE',accountMode:AccountMode.DEMO,
			approvedTier:1,kycStatus:'PENDING',avatarKey:null,kyc:null,
		});
		mocks.accountFindMany.mockResolvedValue([{id:'demo-account'}]);

		const response=await GET();
		const result=await response.json();

		expect(response.status).toBe(200);
		expect(result.accountMode).toBe('DEMO');
		expect(result.balances).toEqual({DEMO:'125.5'});
		expect(mocks.accountFindMany).toHaveBeenCalledWith({where:{userId:'user-1',accountMode:AccountMode.DEMO,currency:'USD'},select:{id:true}});
		expect(mocks.getActivity).toHaveBeenCalledWith('user-1',AccountMode.DEMO,'all',8);
	});

	it('returns truthful empty portfolio data when there are no positions or active investments',async()=>{
		mocks.accountFindMany.mockResolvedValue([]);

		const response=await GET();
		const result=await response.json();

		expect(response.status).toBe(200);
		expect(result.balances).toEqual({REAL:'0'});
		expect(result.portfolioSummary.totalValue).toBe('0');
		expect(result.portfolioSummary.allocations).toEqual([]);
		expect(result.positions).toEqual([]);
		expect(result.openOrders).toEqual([]);
		expect(result.activeInvestments).toEqual([]);
	});
});
