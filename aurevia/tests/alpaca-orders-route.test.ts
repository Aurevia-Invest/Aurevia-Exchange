import {AccountMode} from '@prisma/client';
import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	requireUser:vi.fn(),
	findUnique:vi.fn(),
	placeOrder:vi.fn(),
	submitAlpacaPaperOrder:vi.fn(),
}));

vi.mock('@/lib/auth',()=>({requireUser:mocks.requireUser}));
vi.mock('@/lib/db',()=>({db:{user:{findUnique:mocks.findUnique}}}));
vi.mock('@/lib/orders',()=>({placeOrder:mocks.placeOrder}));
vi.mock('@/lib/notifications',()=>({createNotification:vi.fn()}));
vi.mock('@/lib/alpaca-paper-orders',()=>({
	cancelAlpacaPaperOrder:vi.fn(),
	submitAlpacaPaperOrder:mocks.submitAlpacaPaperOrder,
	ALPACA_PAPER_PROVIDER:'alpaca-paper',
	AlpacaPaperOrderError:class extends Error{code='';httpStatus=409},
}));

import {POST} from '@/app/api/orders/route';

const payload={instrumentId:'instrument-1',side:'BUY',type:'MARKET',quantity:1,expectedPrice:100,observedAt:new Date().toISOString()};
const request=(accountMode?:AccountMode)=>new Request('http://localhost/api/orders',{method:'POST',headers:{'content-type':'application/json','Idempotency-Key':'route-order-key-001'},body:JSON.stringify({...payload,...(accountMode?{accountMode}:{})})});

describe('order route mode separation',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		mocks.requireUser.mockResolvedValue({id:'user-1',accountMode:AccountMode.DEMO});
		mocks.findUnique.mockResolvedValue({accountMode:AccountMode.DEMO,status:'ACTIVE',role:'USER'});
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
});
