import {AccountMode} from '@prisma/client';
import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	requireUser:vi.fn(),
	findUnique:vi.fn(),
	orderFindMany:vi.fn(),
	placeOrder:vi.fn(),
	submitAlpacaPaperOrder:vi.fn(),
}));

vi.mock('@/lib/auth',()=>({requireUser:mocks.requireUser}));
vi.mock('@/lib/db',()=>({db:{user:{findUnique:mocks.findUnique},order:{findMany:mocks.orderFindMany}}}));
vi.mock('@/lib/orders',()=>({placeOrder:mocks.placeOrder}));
vi.mock('@/lib/notifications',()=>({createNotification:vi.fn()}));
vi.mock('@/lib/alpaca-paper-orders',()=>({
	cancelAlpacaPaperOrder:vi.fn(),
	submitAlpacaPaperOrder:mocks.submitAlpacaPaperOrder,
	ALPACA_PAPER_PROVIDER:'alpaca-paper',
	AlpacaPaperOrderError:class extends Error{code='';httpStatus=409},
}));

import {GET,POST} from '@/app/api/orders/route';

const payload={instrumentId:'instrument-1',side:'BUY',type:'MARKET',quantity:1,expectedPrice:100,observedAt:new Date().toISOString()};
const request=(accountMode?:AccountMode)=>new Request('http://localhost/api/orders',{method:'POST',headers:{'content-type':'application/json','Idempotency-Key':'route-order-key-001'},body:JSON.stringify({...payload,...(accountMode?{accountMode}:{})})});

describe('order route mode separation',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		mocks.requireUser.mockResolvedValue({id:'user-1',accountMode:AccountMode.DEMO});
		mocks.findUnique.mockResolvedValue({accountMode:AccountMode.DEMO,status:'ACTIVE',role:'USER'});
		mocks.orderFindMany.mockResolvedValue([]);
		mocks.placeOrder.mockResolvedValue({id:'demo-order'});
		mocks.submitAlpacaPaperOrder.mockResolvedValue({id:'paper-order'});
	});

	it('keeps DEMO orders on Aurevia simulated execution',async()=>{
		const response=await POST(request());

		expect(response.status).toBe(201);
		expect(mocks.placeOrder).toHaveBeenCalledWith('user-1',AccountMode.DEMO,expect.objectContaining({instrumentId:'instrument-1'}),'route-order-key-001');
	});

	it('rejects a forged REAL mode request while the database account is in DEMO mode',async()=>{
		const response=await POST(request(AccountMode.REAL));

		expect(response.status).toBe(409);
		expect(mocks.placeOrder).not.toHaveBeenCalled();
		expect(mocks.submitAlpacaPaperOrder).not.toHaveBeenCalled();
	});

	it('routes the database-confirmed REAL mode to Alpaca Paper execution',async()=>{
		mocks.requireUser.mockResolvedValue({id:'user-1',accountMode:AccountMode.DEMO});
		mocks.findUnique.mockResolvedValue({accountMode:AccountMode.REAL,status:'ACTIVE',role:'USER'});

		const response=await POST(request());

		expect(response.status).toBe(201);
		expect(mocks.submitAlpacaPaperOrder).toHaveBeenCalledWith('user-1',expect.objectContaining({instrumentId:'instrument-1'}),'route-order-key-001');
		expect(mocks.placeOrder).not.toHaveBeenCalled();
	});

	it('keeps provider account and execution identifiers out of customer order responses',async()=>{
		mocks.findUnique.mockResolvedValue({accountMode:AccountMode.REAL,status:'ACTIVE',role:'USER'});
		mocks.orderFindMany.mockResolvedValue([{
			id:'order-1',userId:'user-1',accountMode:AccountMode.REAL,providerName:'alpaca-paper',providerAccountId:'paper-account-secret',
			providerOrderId:'broker-order-id',providerClientOrderId:'client-order-id',providerStatus:'filled',providerReservedAmount:'100',
			reconciliationStatus:'CONFIRMED_BY_ALPACA_PAPER',reconciledAt:new Date(),idempotencyKey:'private-idempotency-key',
			status:'FILLED',instrument:{symbol:'AAPL'},executions:[{id:'execution-1',providerExecutionId:'provider-execution-id',providerOrderId:'broker-order-id',quantity:'1'}],
		}]);

		const response=await GET();
		const orders=await response.json();

		expect(response.status).toBe(200);
		expect(orders[0]).not.toHaveProperty('providerName');
		expect(orders[0]).not.toHaveProperty('providerAccountId');
		expect(orders[0]).not.toHaveProperty('providerOrderId');
		expect(orders[0]).not.toHaveProperty('idempotencyKey');
		expect(orders[0].executions[0]).not.toHaveProperty('providerExecutionId');
		expect(JSON.stringify(orders)).not.toContain('paper-account-secret');
	});

	it('marks an unposted confirmed fill as requiring review without exposing reconciliation metadata',async()=>{
		mocks.findUnique.mockResolvedValue({accountMode:AccountMode.REAL,status:'ACTIVE',role:'USER'});
		mocks.orderFindMany.mockResolvedValue([{
			id:'order-1',userId:'user-1',accountMode:AccountMode.REAL,status:'FILLED',filledQuantity:'0',
			reconciliationStatus:'RECONCILIATION_REQUIRED',providerStatus:'filled',instrument:{symbol:'AAPL'},executions:[],
		}]);

		const response=await GET();
		const orders=await response.json();

		expect(orders[0]).toMatchObject({status:'REQUIRES_REVIEW',reviewRequired:true});
		expect(orders[0]).not.toHaveProperty('reconciliationStatus');
		expect(orders[0]).not.toHaveProperty('providerStatus');
	});
});
