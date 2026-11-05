import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
vi.mock('server-only',()=>({}));
import {AlpacaCryptoProvider,IndividualAlpacaTradingProvider,buildAlpacaCryptoClient,createIndividualTradingApiProviderFromEnvironment,getAlpacaPaperAccountHealth} from '../lib/providers/alpaca-crypto-provider';
import {AlpacaCryptoMarketDataProvider} from '../lib/providers/alpaca-crypto.market-data';

beforeEach(()=>vi.stubEnv('ALPACA_PAPER_ORDERS_ENABLED','false'));
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals()});

describe('Alpaca crypto provider safety',()=>{
	it('selects the Individual Trading API from ALPACA_PROVIDER and rejects unsafe URLs',()=>{
		for(const [name,value] of Object.entries({ALPACA_PROVIDER:'alpaca',ALPACA_TRADING_BASE_URL:'https://paper-api.alpaca.markets/',ALPACA_API_KEY:'test-key',ALPACA_SECRET_KEY:'test-secret',REAL_EXECUTION_ENABLED:'false'}))vi.stubEnv(name,value);
		const provider=createIndividualTradingApiProviderFromEnvironment();
		expect(provider?.name).toBe('individual-alpaca-trading');
		expect(provider?.executionMode).toBe('PAPER');
		vi.stubEnv('ALPACA_TRADING_BASE_URL','http://paper-api.alpaca.markets');
		expect(createIndividualTradingApiProviderFromEnvironment()).toBeNull();
		vi.stubEnv('ALPACA_TRADING_BASE_URL','https://api.alpaca.markets');
		expect(createIndividualTradingApiProviderFromEnvironment()).toBeNull();
		expect(()=>new IndividualAlpacaTradingProvider({baseUrl:'https://api.alpaca.markets',apiKey:'test-key',apiSecret:'test-secret'})).toThrow('ALPACA_PAPER_ENDPOINT_REQUIRED');
	});

	it('recognizes ALPACA_BASE_URL and ALPACA_API_SECRET but remains paper-only',()=>{
		for(const [name,value] of Object.entries({
			ALPACA_PROVIDER:'alpaca',
			ALPACA_BASE_URL:'https://paper-api.alpaca.markets/v2',
			ALPACA_API_KEY:'test-key',
			ALPACA_SECRET_KEY:'',
			ALPACA_API_SECRET:'test-secret',
			REAL_EXECUTION_ENABLED:'false',
		}))vi.stubEnv(name,value);

		const provider=createIndividualTradingApiProviderFromEnvironment();

		expect(provider?.executionMode).toBe('PAPER');
		expect(provider?.name).toBe('individual-alpaca-trading');
		expect(provider?.executionMode).not.toBe('LIVE');
	});

	it('uses the paper Trading API fields and preserves provider-confirmed order state',async()=>{
		const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({id:'provider-order-id',client_order_id:'order-key-123456',status:'accepted',created_at:'2026-10-15T12:00:00Z',updated_at:'2026-10-15T12:00:00Z',filled_qty:'0',filled_avg_price:null}),{status:201}));
		const provider=new IndividualAlpacaTradingProvider({baseUrl:'https://paper-api.alpaca.markets',apiKey:'paper-key',apiSecret:'paper-secret',fetcher});
		const result=await provider.submitOrder({clientOrderId:'ignored-client-id',accountId:'',symbol:'AAPL',side:'BUY',type:'LIMIT',quantity:'2',limitPrice:'100',timeInForce:'day'},'order-key-123456');
		expect(result).toMatchObject({providerOrderId:'provider-order-id',clientOrderId:'order-key-123456',state:'ACCEPTED',filledQuantity:'0'});
		expect(fetcher.mock.calls[0][0]).toBe('https://paper-api.alpaca.markets/v2/orders');
		expect(fetcher.mock.calls[0][1].headers).toMatchObject({'APCA-API-KEY-ID':'paper-key','APCA-API-SECRET-KEY':'paper-secret'});
		expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({symbol:'AAPL',side:'buy',type:'limit',time_in_force:'day',client_order_id:'order-key-123456',qty:'2',limit_price:'100'});
	});

	it('reads paper account values and stock positions without an account ID URL',async()=>{
		const fetcher=vi.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify({id:'paper-account',status:'ACTIVE',currency:'USD',cash:'1000',buying_power:'2500',equity:'3000',portfolio_value:'3000',pattern_day_trader:false,trade_suspended_by_user:false,trading_blocked:false,account_blocked:false}),{status:200}))
			.mockResolvedValueOnce(new Response(JSON.stringify([{symbol:'AAPL',qty:'2',avg_entry_price:'150',market_value:'320',unrealized_pl:'20'}]),{status:200}));
		const provider=new IndividualAlpacaTradingProvider({baseUrl:'https://paper-api.alpaca.markets',apiKey:'paper-key',apiSecret:'paper-secret',fetcher});
		await expect(provider.getAccount()).resolves.toMatchObject({buying_power:'2500',cash:'1000'});
		await expect(provider.getPositions('unused')).resolves.toMatchObject([{symbol:'AAPL',quantity:'2',averagePrice:'150',marketValue:'320',unrealizedPnl:'20'}]);
		expect(fetcher.mock.calls.map(([url])=>url)).toEqual(['https://paper-api.alpaca.markets/v2/account','https://paper-api.alpaca.markets/v2/positions']);
	});

	it('reports paper account connectivity and paper-only account information without enabling live execution',async()=>{
		for(const [name,value] of Object.entries({ALPACA_PROVIDER:'alpaca',ALPACA_TRADING_BASE_URL:'https://paper-api.alpaca.markets/v2',ALPACA_API_KEY:'test-key',ALPACA_SECRET_KEY:'test-secret',REAL_EXECUTION_ENABLED:'false'}))vi.stubEnv(name,value);
		const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({id:'private-paper-account',status:'ACTIVE',currency:'USD',cash:'987654321',buying_power:'987654321',equity:'987654321',portfolio_value:'987654321',pattern_day_trader:false,trade_suspended_by_user:false,trading_blocked:false,account_blocked:false}),{status:200}));
		vi.stubGlobal('fetch',fetcher);

		const health=await getAlpacaPaperAccountHealth();

		expect(health).toMatchObject({status:'AVAILABLE',connected:true,configured:true,selected:true,mode:'PAPER',executionEnabled:false,paperOrdersEnabled:false,liveTradingEnabled:false,account:{accountId:'private-paper-account',cash:'987654321',equity:'987654321',buyingPower:'987654321'}});
		expect(fetcher).toHaveBeenCalledOnce();
		expect(fetcher.mock.calls[0][0]).toBe('https://paper-api.alpaca.markets/v2/account');
		expect(fetcher.mock.calls[0][1].method).toBeUndefined();
	});

	it('performs the read-only paper connectivity check with compatible environment aliases',async()=>{
		for(const [name,value] of Object.entries({
			ALPACA_PROVIDER:'alpaca',
			ALPACA_BASE_URL:'https://paper-api.alpaca.markets/v2',
			ALPACA_API_KEY:'test-key',
			ALPACA_SECRET_KEY:'',
			ALPACA_API_SECRET:'test-secret',
			REAL_EXECUTION_ENABLED:'false',
		}))vi.stubEnv(name,value);
		const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({
			id:'paper-account',status:'ACTIVE',currency:'USD',cash:'1000',buying_power:'1000',
			equity:'1000',portfolio_value:'1000',trade_suspended_by_user:false,
			trading_blocked:false,account_blocked:false,
		}),{status:200}));
		vi.stubGlobal('fetch',fetcher);

		const health=await getAlpacaPaperAccountHealth();

		expect(health).toMatchObject({
			status:'AVAILABLE',mode:'PAPER',configured:true,connected:true,
			liveTradingEnabled:false,paperOrdersEnabled:false,
		});
		expect(fetcher.mock.calls[0][0]).toBe('https://paper-api.alpaca.markets/v2/account');
		expect(fetcher.mock.calls[0][1].headers).toMatchObject({
			'APCA-API-KEY-ID':'test-key',
			'APCA-API-SECRET-KEY':'test-secret',
		});
	});

	it('distinguishes invalid paper credentials and incomplete configuration without order requests',async()=>{
		for(const [name,value] of Object.entries({ALPACA_PROVIDER:'alpaca',ALPACA_TRADING_BASE_URL:'https://paper-api.alpaca.markets',ALPACA_API_KEY:'test-key',ALPACA_SECRET_KEY:'test-secret'}))vi.stubEnv(name,value);
		vi.stubEnv('ALPACA_PAPER_ORDERS_ENABLED','true');
		const fetcher=vi.fn().mockResolvedValue(new Response('{}',{status:401}));
		vi.stubGlobal('fetch',fetcher);
		await expect(getAlpacaPaperAccountHealth()).resolves.toMatchObject({
			status:'AUTHENTICATION_FAILED',
			connected:false,
			paperOrdersEnabled:true,
			executionEnabled:false,
		});

		vi.stubEnv('ALPACA_TRADING_BASE_URL','https://api.alpaca.markets');
		await expect(getAlpacaPaperAccountHealth()).resolves.toMatchObject({status:'MISCONFIGURED',configured:false,mode:null});
		expect(fetcher).toHaveBeenCalledOnce();

		vi.stubEnv('ALPACA_TRADING_BASE_URL','');
		vi.stubEnv('ALPACA_API_KEY','');
		vi.stubEnv('ALPACA_SECRET_KEY','');
		await expect(getAlpacaPaperAccountHealth()).resolves.toMatchObject({status:'NOT_CONFIGURED',connected:false,executionEnabled:false});
		expect(fetcher).toHaveBeenCalledOnce();
	});

	it('handles the no-content cancellation response by reading final order state',async()=>{
		const fetcher=vi.fn()
			.mockResolvedValueOnce(new Response(null,{status:204}))
			.mockResolvedValueOnce(new Response(JSON.stringify({id:'provider-order-id',client_order_id:'order-key-123456',status:'canceled',filled_qty:'0',created_at:'2026-10-15T12:00:00Z',updated_at:'2026-10-15T12:01:00Z'}),{status:200}));
		const provider=new IndividualAlpacaTradingProvider({baseUrl:'https://paper-api.alpaca.markets',apiKey:'paper-key',apiSecret:'paper-secret',fetcher});
		await expect(provider.cancelOrder('provider-order-id','order-key-123456')).resolves.toMatchObject({state:'CANCELLED'});
		expect(fetcher.mock.calls.map(([,init])=>init.method)).toEqual(['DELETE',undefined]);
	});

	it('preserves provider rejection and rate-limit responses without simulating success',async()=>{
		const rejected=new IndividualAlpacaTradingProvider({baseUrl:'https://paper-api.alpaca.markets',apiKey:'paper-key',apiSecret:'paper-secret',fetcher:vi.fn().mockResolvedValue(new Response('{}',{status:422}))});
		await expect(rejected.submitOrder({clientOrderId:'client',accountId:'',symbol:'AAPL',side:'BUY',type:'MARKET',quantity:'1'},'reject-key-123456')).rejects.toThrow('ALPACA_TRADING_API_ERROR:422');
		const limited=new IndividualAlpacaTradingProvider({baseUrl:'https://paper-api.alpaca.markets',apiKey:'paper-key',apiSecret:'paper-secret',fetcher:vi.fn().mockResolvedValue(new Response('{}',{status:429}))});
		await expect(limited.healthCheck()).resolves.toMatchObject({connected:false,status:'UNAVAILABLE'});
	});

	it('recovers a duplicate submission by Alpaca client order ID',async()=>{
		const fetcher=vi.fn()
			.mockResolvedValueOnce(new Response('{}',{status:422}))
			.mockResolvedValueOnce(new Response(JSON.stringify({id:'provider-order-id',client_order_id:'retry-key-123456',status:'partially_filled',filled_qty:'0.5',filled_avg_price:'190',created_at:'2026-10-15T12:00:00Z',updated_at:'2026-10-15T12:01:00Z'}),{status:200}));
		const provider=new IndividualAlpacaTradingProvider({baseUrl:'https://paper-api.alpaca.markets',apiKey:'paper-key',apiSecret:'paper-secret',fetcher});
		await expect(provider.submitOrder({clientOrderId:'client',accountId:'',symbol:'AAPL',side:'BUY',type:'MARKET',quantity:'1'},'retry-key-123456')).resolves.toMatchObject({state:'PARTIALLY_FILLED',filledQuantity:'0.5',averageFillPrice:'190'});
		expect(fetcher.mock.calls[1][0]).toBe('https://paper-api.alpaca.markets/v2/orders:by_client_order_id?client_order_id=retry-key-123456');
	});

	it('normalizes later provider status and cancellation transitions',async()=>{
		const fetcher=vi.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify({id:'provider-order-id',client_order_id:'client',status:'filled',filled_qty:'2',filled_avg_price:'190',created_at:'2026-10-15T12:00:00Z',updated_at:'2026-10-15T12:01:00Z'}),{status:200}))
			.mockResolvedValueOnce(new Response(JSON.stringify({id:'provider-order-id',client_order_id:'client',status:'rejected',filled_qty:'0',created_at:'2026-10-15T12:00:00Z',updated_at:'2026-10-15T12:02:00Z'}),{status:200}));
		const provider=new IndividualAlpacaTradingProvider({baseUrl:'https://paper-api.alpaca.markets',apiKey:'paper-key',apiSecret:'paper-secret',fetcher});
		await expect(provider.getOrderStatus('provider-order-id')).resolves.toMatchObject({state:'FILLED',filledQuantity:'2',averageFillPrice:'190'});
		await expect(provider.getOrderStatus('provider-order-id')).resolves.toMatchObject({state:'REJECTED'});
	});

	it('accepts only sandbox broker endpoints for non-authorized execution',()=>{
		expect(()=>new AlpacaCryptoProvider({
			baseUrl:'https://broker-api.sandbox.alpaca.markets',
			clientId:'test-id',
			clientSecret:'test-secret',
			accountId:'00000000-0000-0000-0000-000000000001',
			webhookSecret:'test-webhook-secret',
		})).not.toThrow();
		expect(()=>new AlpacaCryptoProvider({
			baseUrl:'https://broker-api.alpaca.markets',
			clientId:'test-id',
			clientSecret:'test-secret',
			accountId:'00000000-0000-0000-0000-000000000001',
			webhookSecret:'test-webhook-secret',
		})).toThrow('SANDBOX_ONLY');
	});

	it('normalizes broker responses and preserves idempotency metadata',async()=>{
		const fetcher=vi.fn().mockResolvedValue({
			ok:true,
			status:200,
			json:async()=>({
				id:'11111111-1111-1111-1111-111111111111',
				client_order_id:'client-order',
				asset_id:'22222222-2222-2222-2222-222222222222',
				symbol:'BTCUSD',
				status:'accepted',
				filled_qty:'0',
				filled_at:null,
				created_at:'2026-01-01T00:00:00Z',
				updated_at:'2026-01-01T00:00:00Z',
				qty:'0.25',
			}),
		});
		const client=buildAlpacaCryptoClient({
			baseUrl:'https://broker-api.sandbox.alpaca.markets',
			clientId:'test-id',
			clientSecret:'test-secret',
			accountId:'00000000-0000-0000-0000-000000000001',
			fetcher,
		});
		const result=await client.submitOrder({
			clientOrderId:'client-order',
			assetId:'22222222-2222-2222-2222-222222222222',
			symbol:'BTCUSD',
			side:'buy',
			type:'market',
			timeInForce:'gtc',
			qty:'0.25',
		});
		expect(result.id).toBe('11111111-1111-1111-1111-111111111111');
		expect(result.clientOrderId).toBe('client-order');
		expect(result.status).toBe('accepted');
		expect(fetcher).toHaveBeenCalledOnce();
	});

	it('normalizes the documented quote map and preserves unavailable fields as null',async()=>{
		const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({quotes:{'BTC/USD':{bp:60000,ap:60010,t:'2026-10-09T01:00:00Z'}}}),{status:200}));
		const provider=new AlpacaCryptoMarketDataProvider({baseUrl:'https://data.alpaca.markets',apiKey:'test-key',fetcher});
		const quote=await provider.getQuote('BTC/USD');
		expect(quote).toEqual({symbol:'BTC/USD',price:null,bid:60000,ask:60010,open:null,high:null,low:null,previousClose:null,volume:null,marketStatus:'UNKNOWN',source:'Alpaca Crypto',asOf:'2026-10-09T01:00:00.000Z'});
		expect(fetcher.mock.calls[0][0]).toContain('symbols=BTC%2FUSD');
	});

	it('rejects incomplete quote payloads and reports provider health only after a valid response',async()=>{
		const fetcher=vi.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify({quotes:{'BTC/USD':{bp:0,ap:null}}}),{status:200}))
			.mockResolvedValueOnce(new Response(JSON.stringify({quotes:{'BTC/USD':{bp:60000,ap:60010,t:'2026-10-09T01:00:00Z'}}}),{status:200}));
		const provider=new AlpacaCryptoMarketDataProvider({baseUrl:'https://data.alpaca.markets',apiKey:'test-key',fetcher});
		await expect(provider.getQuote('BTC/USD')).rejects.toThrow('ALPACA_MARKET_DATA_INVALID_QUOTE');
		await expect(provider.healthCheck()).resolves.toMatchObject({connected:true});
	});

	it('normalizes documented historical bars and does not invent volume',async()=>{
		const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({bars:{'BTC/USD':[{t:'2026-10-09T01:00:00Z',o:60000,h:60200,l:59900,c:60100}]}}),{status:200}));
		const provider=new AlpacaCryptoMarketDataProvider({baseUrl:'https://data.alpaca.markets',apiKey:'test-key',fetcher});
		await expect(provider.getBars('BTC/USD','2026-10-09','2026-10-10','1Min')).resolves.toEqual([{time:'2026-10-09T01:00:00.000Z',open:60000,high:60200,low:59900,close:60100,volume:null}]);
	});
});
