import {createHash} from 'node:crypto';
import {AccountMode,NotificationType,OrderSide,OrderStatus,OrderType,Prisma} from '@prisma/client';
import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	providerFactory:vi.fn(),
	ensureUserLedger:vi.fn(),
	ensureSystemAccount:vi.fn(),
	balance:vi.fn(),
	reservedWithdrawalAmount:vi.fn(),
	postDoubleEntry:vi.fn(),
	marketQuote:vi.fn(),
	positionCreate:vi.fn(),
	executionCreate:vi.fn(),
}));

vi.mock('@/lib/db',()=>({db:{
	$orderTransaction:vi.fn(),
	order:{findUnique:vi.fn(),findUniqueOrThrow:vi.fn(),create:vi.fn(),update:vi.fn()},
	user:{findUnique:vi.fn()},
	instrument:{findUnique:vi.fn()},
	auditLog:{create:vi.fn()},
	ledgerEntry:{create:vi.fn()},
	position:{create:mocks.positionCreate},
	execution:{create:mocks.executionCreate},
}}));
vi.mock('@/lib/notifications',()=>({createNotification:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('@/lib/live-market',async importOriginal=>{
	const original=await importOriginal<typeof import('@/lib/live-market')>();
	return {...original,getMarketQuote:mocks.marketQuote};
});
vi.mock('@/lib/ledger',async importOriginal=>{
	const original=await importOriginal<typeof import('@/lib/ledger')>();
	return {
		...original,
		ensureUserLedger:mocks.ensureUserLedger,
		ensureSystemAccount:mocks.ensureSystemAccount,
		balance:mocks.balance,
		reservedWithdrawalAmount:mocks.reservedWithdrawalAmount,
		postDoubleEntry:mocks.postDoubleEntry,
	};
});
vi.mock('@/lib/providers/alpaca-crypto-provider',async importOriginal=>{
	const original=await importOriginal<typeof import('@/lib/providers/alpaca-crypto-provider')>();
	return {...original,createIndividualTradingApiProviderFromEnvironment:mocks.providerFactory};
});

import {db} from '@/lib/db';
import {createNotification} from '@/lib/notifications';
import {submitAlpacaPaperOrder,syncAlpacaPaperOrder} from '@/lib/alpaca-paper-orders';
import type {ProviderOrder} from '@/lib/providers/contracts';

const now=new Date();
const instrument={id:'instrument-1',symbol:'AAPL',enabled:true,price:new Prisma.Decimal(100),updatedAt:now,quoteAsset:'USD',takerFee:new Prisma.Decimal('0.01')};
const request={instrumentId:instrument.id,side:OrderSide.BUY,type:OrderType.MARKET,quantity:2,expectedPrice:100,observedAt:now.toISOString()};
const idempotencyKey='paper-order-key-001';
const providerClientOrderId=`au_${createHash('sha256').update(`user-1\0${idempotencyKey}`).digest('hex').slice(0,40)}`;
type MockOrder={
	[key:string]:unknown;
	id:string;
	idempotencyKey:string;
	quantity:Prisma.Decimal;
	filledQuantity:Prisma.Decimal;
	price:Prisma.Decimal|null;
	stopPrice:Prisma.Decimal|null;
	averageFillPrice:Prisma.Decimal|null;
	executions:unknown[];
	instrument:typeof instrument;
};
type MockProvider={
	getAccount:ReturnType<typeof vi.fn>;
	getAsset:ReturnType<typeof vi.fn>;
	submitOrder:ReturnType<typeof vi.fn>;
	getOrderStatus:ReturnType<typeof vi.fn>;
	getOrderByClientId:ReturnType<typeof vi.fn>;
	cancelOrder:ReturnType<typeof vi.fn>;
};
let storedOrder:MockOrder|null=null;
let storedPosition:{id:string;quantity:Prisma.Decimal;entryPrice:Prisma.Decimal;realizedPnl:Prisma.Decimal;status:string}|null=null;
let providerExecutionIds=new Set<string>();
let provider:MockProvider;

function decimal(value:unknown):Prisma.Decimal{
	if(value instanceof Prisma.Decimal)return value;
	if(typeof value==='number'||typeof value==='string')return new Prisma.Decimal(value);
	throw new Error('Expected a decimal mock value.');
}

function nullableDecimal(value:unknown):Prisma.Decimal|null{
	return value===null||value===undefined?null:decimal(value);
}

function updateStoredOrder(existing:MockOrder,data:Record<string,unknown>):MockOrder{
	return {
		...existing,
		...data,
		id:existing.id,
		idempotencyKey:typeof data.idempotencyKey==='string'?data.idempotencyKey:existing.idempotencyKey,
		quantity:data.quantity===undefined?existing.quantity:decimal(data.quantity),
		filledQuantity:data.filledQuantity===undefined?existing.filledQuantity:decimal(data.filledQuantity),
		price:data.price===undefined?existing.price:nullableDecimal(data.price),
		stopPrice:data.stopPrice===undefined?existing.stopPrice:nullableDecimal(data.stopPrice),
		averageFillPrice:data.averageFillPrice===undefined?existing.averageFillPrice:nullableDecimal(data.averageFillPrice),
		executions:Array.isArray(data.executions)?data.executions:existing.executions,
		instrument:existing.instrument,
	};
}

function providerOrder(state:ProviderOrder['state'],filledQuantity='0'):ProviderOrder{
	return {
		providerOrderId:'alpaca-order-1',
		clientOrderId:providerClientOrderId,
		state,
		providerStatus:state.toLowerCase(),
		acceptedAt:now.toISOString(),
		updatedAt:now.toISOString(),
		executions:[],
		filledQuantity,
		...(Number(filledQuantity)>0?{averageFillPrice:'101.25'}:{}),
	};
}

function matches(where:Record<string,unknown>){
	if(typeof where.idempotencyKey==='string')return storedOrder?.idempotencyKey===where.idempotencyKey?storedOrder:null;
	if(where.id)return storedOrder?.id===where.id?storedOrder:null;
	return null;
}

beforeEach(()=>{
	vi.clearAllMocks();
	vi.stubEnv('ALPACA_PAPER_ORDERS_ENABLED','true');
	storedOrder=null;
	storedPosition=null;
	providerExecutionIds=new Set();
	mocks.positionCreate.mockImplementation(async({data}:{data:Record<string,unknown>})=>{
		storedPosition={id:'paper-position-1',quantity:decimal(data.quantity),entryPrice:decimal(data.entryPrice),realizedPnl:new Prisma.Decimal(0),status:'OPEN'};
		return storedPosition;
	});
	mocks.executionCreate.mockImplementation(async({data}:{data:Record<string,unknown>})=>{
		providerExecutionIds.add(String(data.providerExecutionId));
		return data;
	});
	mocks.ensureUserLedger.mockResolvedValue({id:'real-usd-ledger',currency:'USD'});
	mocks.ensureSystemAccount.mockResolvedValue({id:'real-trading-clearing',currency:'USD'});
	mocks.postDoubleEntry.mockResolvedValue(undefined);
	mocks.balance.mockResolvedValue(new Prisma.Decimal(1000));
	mocks.reservedWithdrawalAmount.mockResolvedValue(new Prisma.Decimal(0));
	mocks.marketQuote.mockResolvedValue({price:100,updatedAt:now.toISOString(),isStale:false});
	provider={
		getAccount:vi.fn().mockResolvedValue({id:'paper-account-1',status:'ACTIVE',account_blocked:false,trading_blocked:false,trade_suspended_by_user:false}),
		getAsset:vi.fn().mockResolvedValue({id:'asset-1',symbol:'AAPL',class:'us_equity',status:'active',tradable:true,fractionable:true}),
		submitOrder:vi.fn().mockResolvedValue(providerOrder('FILLED','2')),
		getOrderStatus:vi.fn(),
		getOrderByClientId:vi.fn(),
		cancelOrder:vi.fn(),
	};
	mocks.providerFactory.mockReturnValue(provider);
	const dbMock=db as unknown as {
		$transaction:ReturnType<typeof vi.fn>;
		order:{
			findUnique:ReturnType<typeof vi.fn>;
			findUniqueOrThrow:ReturnType<typeof vi.fn>;
			update:ReturnType<typeof vi.fn>;
		};
	};
	dbMock.$transaction=vi.fn(async(callback:(tx:unknown)=>Promise<unknown>)=>callback({
		order:{
			findUnique:vi.fn(async({where}: {where:Record<string,unknown>})=>matches(where)),
			findUniqueOrThrow:vi.fn(async({where}: {where:Record<string,unknown>})=>matches(where)),
			findMany:vi.fn().mockResolvedValue([]),
			create:vi.fn(async({data}: {data:Record<string,unknown>})=>{
				storedOrder={
					...data,
					id:'local-order-1',
					idempotencyKey:String(data.idempotencyKey),
					price:nullableDecimal(data.price),
					stopPrice:nullableDecimal(data.stopPrice),
					quantity:decimal(data.quantity),
					filledQuantity:new Prisma.Decimal(0),
					averageFillPrice:null,
					executions:[],
					instrument,
				};
				return storedOrder;
			}),
			update:vi.fn(async({where,data}: {where:{id:string};data:Record<string,unknown>})=>{
				if(!storedOrder||storedOrder.id!==where.id)throw new Error('missing order');
				storedOrder=updateStoredOrder(storedOrder,data);
				return storedOrder;
			}),
		},
		position:{
			findFirst:vi.fn(async()=>storedPosition?.status==='OPEN'?storedPosition:null),
			create:mocks.positionCreate,
			update:vi.fn(async({where,data}:{where:{id:string};data:Record<string,unknown>})=>{
				if(!storedPosition||storedPosition.id!==where.id)throw new Error('missing position');
				if(typeof data.quantity==='object'&&data.quantity!==null&&'increment'in data.quantity)storedPosition.quantity=storedPosition.quantity.plus(decimal((data.quantity as {increment:unknown}).increment));
				else if(data.quantity!==undefined)storedPosition.quantity=decimal(data.quantity);
				if(data.entryPrice!==undefined)storedPosition.entryPrice=decimal(data.entryPrice);
				if(data.realizedPnl&&typeof data.realizedPnl==='object'&&'increment'in data.realizedPnl)storedPosition.realizedPnl=storedPosition.realizedPnl.plus(decimal((data.realizedPnl as {increment:unknown}).increment));
				if(typeof data.status==='string')storedPosition.status=data.status;
				return storedPosition;
			}),
		},
		execution:{
			findUnique:vi.fn(async({where}:{where:{providerExecutionId:string}})=>providerExecutionIds.has(where.providerExecutionId)?{id:where.providerExecutionId}:null),
			create:mocks.executionCreate,
		},
		user:{findUnique:vi.fn().mockResolvedValue({id:'user-1',accountMode:AccountMode.REAL,status:'ACTIVE',accountRestricted:false,role:'USER'})},
		instrument:{findUnique:vi.fn().mockResolvedValue(instrument)},
		auditLog:{create:vi.fn().mockResolvedValue({})},
	}));
	dbMock.order.findUnique.mockImplementation(async({where}: {where:Record<string,unknown>})=>matches(where));
	dbMock.order.findUniqueOrThrow.mockImplementation(async({where}: {where:Record<string,unknown>})=>{
		const order=matches(where);
		if(!order)throw new Error('missing order');
		return order;
	});
	dbMock.order.update.mockImplementation(async({where,data}: {where:{id:string};data:Record<string,unknown>})=>{
		if(!storedOrder||storedOrder.id!==where.id)throw new Error('missing order');
		storedOrder=updateStoredOrder(storedOrder,data);
		return storedOrder;
	});
	(db.instrument.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(instrument);
});

describe('Alpaca Paper order isolation and status handling',()=>{
	it('records confirmed simulated fills in the Aurevia ledger and user-scoped holdings',async()=>{
		const order=await submitAlpacaPaperOrder('user-1',request,idempotencyKey);

		expect(order).toMatchObject({accountMode:AccountMode.REAL,providerName:'alpaca-paper',providerAccountId:'paper-account-1',providerOrderId:'alpaca-order-1',status:OrderStatus.FILLED,providerStatus:'filled',filledQuantity:new Prisma.Decimal(2)});
		expect(order.providerReservedAmount?.toString()).toBe('200');
		expect(order.providerClientOrderId).toBe(providerClientOrderId);
		expect(provider.submitOrder).toHaveBeenCalledTimes(1);
		expect(mocks.postDoubleEntry).toHaveBeenCalledOnce();
		expect(mocks.postDoubleEntry).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({
			reference:expect.stringMatching(/^REAL:SIMULATED_TRADE:BUY:local-order-1:/),
			description:'Simulated buy AAPL',
			debitAccountId:'real-usd-ledger',
			creditAccountId:'real-trading-clearing',
			amount:new Prisma.Decimal('202.50'),
		}));
		expect(mocks.positionCreate).toHaveBeenCalledOnce();
		expect(mocks.executionCreate).toHaveBeenCalledOnce();
		expect(storedPosition).toMatchObject({quantity:new Prisma.Decimal(2),entryPrice:new Prisma.Decimal('101.25'),status:'OPEN'});
		expect(createNotification).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({type:NotificationType.TRADE}));
	});

	it.each([
		['PARTIALLY_FILLED','1',OrderStatus.PARTIALLY_FILLED],
		['PENDING_CANCEL','0',OrderStatus.PENDING_CANCEL],
		['CANCELLED','0',OrderStatus.CANCELLED],
		['REJECTED','0',OrderStatus.REJECTED],
		['EXPIRED','0',OrderStatus.EXPIRED],
	] as const)('maps provider %s status into the local order status',async(state,filled,status)=>{
		provider.submitOrder.mockResolvedValue(providerOrder(state,filled));
		const order=await submitAlpacaPaperOrder('user-1',request,idempotencyKey);
		expect(order.status).toBe(status);
		expect(order.providerStatus).toBe(state.toLowerCase());
	});

	it('returns the existing matching order for a repeated idempotency key without resubmitting',async()=>{
		const first=await submitAlpacaPaperOrder('user-1',request,idempotencyKey);
		const repeated=await submitAlpacaPaperOrder('user-1',request,idempotencyKey);

		expect(repeated.id).toBe(first.id);
		expect(provider.submitOrder).toHaveBeenCalledTimes(1);
	});

	it('does not submit a REAL paper buy when the Aurevia USD ledger lacks collateral',async()=>{
		mocks.balance.mockResolvedValue(new Prisma.Decimal(100));
		await expect(submitAlpacaPaperOrder('user-1',request,idempotencyKey)).rejects.toMatchObject({code:'INSUFFICIENT_REAL_WALLET_COLLATERAL'});
		expect(provider.submitOrder).not.toHaveBeenCalled();
		expect(storedOrder).toBeNull();
	});

	it('does not debit the Aurevia wallet when a confirmed fill exceeds available funds',async()=>{
		mocks.balance.mockResolvedValue(new Prisma.Decimal(201));

		const order=await submitAlpacaPaperOrder('user-1',request,idempotencyKey);

		expect(order).toMatchObject({status:OrderStatus.FILLED,reconciliationStatus:'RECONCILIATION_REQUIRED'});
		expect(order.filledQuantity.toString()).toBe('0');
		expect(mocks.postDoubleEntry).not.toHaveBeenCalled();
		expect(mocks.positionCreate).not.toHaveBeenCalled();
		expect(createNotification).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({
			title:'REAL order requires review',
			message:expect.stringContaining('available wallet funds are insufficient'),
		}));
	});

	it('reserves market-order collateral from the fresh provider quote, not the internal instrument mark',async()=>{
		mocks.marketQuote.mockResolvedValue({price:125,updatedAt:now.toISOString(),isStale:false});
		const order=await submitAlpacaPaperOrder('user-1',request,idempotencyKey);

		expect(order.providerReservedAmount?.toString()).toBe('250');
		expect(mocks.marketQuote).toHaveBeenCalledOnce();
	});

	it('does not create or submit an order when no current provider quote is available',async()=>{
		mocks.marketQuote.mockRejectedValue(new Error('provider unavailable'));

		await expect(submitAlpacaPaperOrder('user-1',request,idempotencyKey)).rejects.toMatchObject({code:'ALPACA_PAPER_MARKET_QUOTE_UNAVAILABLE'});
		expect(provider.submitOrder).not.toHaveBeenCalled();
		expect(storedOrder).toBeNull();
	});

	it('does not resubmit an order whose first provider outcome was ambiguous',async()=>{
		provider.submitOrder.mockRejectedValueOnce(new Error('network unavailable'));
		provider.getOrderByClientId.mockRejectedValue(new Error('not found yet'));
		const first=await submitAlpacaPaperOrder('user-1',request,idempotencyKey);
		const repeated=await submitAlpacaPaperOrder('user-1',request,idempotencyKey);

		expect(first.providerStatus).toBe('SUBMISSION_UNKNOWN');
		expect(repeated.id).toBe(first.id);
		expect(provider.submitOrder).toHaveBeenCalledTimes(1);
	});

	it('applies partial and subsequent fills incrementally and idempotently',async()=>{
		provider.submitOrder.mockResolvedValueOnce(providerOrder('PARTIALLY_FILLED','1'));
		provider.getOrderStatus.mockResolvedValue({...providerOrder('FILLED','2'),averageFillPrice:'102.5'});
		await submitAlpacaPaperOrder('user-1',request,idempotencyKey);
		expect(storedPosition?.quantity.toString()).toBe('1');

		await syncAlpacaPaperOrder('local-order-1','admin-1');
		await syncAlpacaPaperOrder('local-order-1','admin-1');

		expect(storedPosition?.quantity.toString()).toBe('2');
		expect(storedPosition?.entryPrice.toString()).toBe('102.5');
		expect(mocks.executionCreate).toHaveBeenCalledTimes(2);
		expect(providerExecutionIds.size).toBe(2);
		expect(mocks.postDoubleEntry).toHaveBeenCalledTimes(2);
	});
});
