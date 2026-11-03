import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	requireUser:vi.fn(),
	userFindUnique:vi.fn(),
	auditCreate:vi.fn(),
	runAiService:vi.fn(),
	rateLimit:vi.fn(),
	getMarketQuote:vi.fn(),
	getMarketHistory:vi.fn(),
	getReferenceMarketHistory:vi.fn(),
}));

vi.mock('@/lib/auth',()=>({requireUser:mocks.requireUser}));
vi.mock('@/lib/db',()=>({db:{
	user:{findUnique:mocks.userFindUnique},
	auditLog:{create:mocks.auditCreate},
}}));
vi.mock('@/lib/ai-services',()=>({runAiService:mocks.runAiService}));
vi.mock('@/lib/ai-gateway',()=>({AiGatewayError:class AiGatewayError extends Error{constructor(message:string,readonly code:string,readonly status=503){super(message)}}}));
vi.mock('@/lib/rate-limit',()=>({rateLimit:mocks.rateLimit}));
vi.mock('@/lib/config/env',()=>({getServerConfiguration:()=>({marketData:{finnhubApiKey:'test-market-key'},execution:{}})}));
vi.mock('@/lib/market-data-service',()=>({
	getAlpacaMarketDataOptions:vi.fn(()=>undefined),
	getMarketQuoteWithFallback:mocks.getMarketQuote,
	getMarketHistoryWithFallback:mocks.getMarketHistory,
}));
vi.mock('@/lib/internal-market-data',()=>({
	getReferenceMarketHistory:mocks.getReferenceMarketHistory,
}));
vi.mock('@/lib/live-market',()=>({
	TIMEFRAMES:[{id:'1d',label:'1d'}],
	getMarketAsset:vi.fn((symbol:string)=>symbol==='AAPL'?{id:'AAPL',name:'Apple Inc.',type:'STOCK',currency:'USD'}:undefined),
	isExternalMarketDataSource:vi.fn((source:string)=>source==='Alpaca'||source==='Alpaca Crypto'||source==='Finnhub'),
	MarketDataError:class MarketDataError extends Error{
		constructor(message:string,readonly status=502,readonly diagnostics?:unknown){super(message)}
	},
}));

import {POST} from '@/app/api/market/data-explanation/route';
import {MarketDataError} from '@/lib/live-market';

const request=(body:unknown)=>new Request('https://aurevia.test/api/market/data-explanation',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});

beforeEach(()=>{
	vi.clearAllMocks();
	mocks.requireUser.mockResolvedValue({id:'user-1'});
	mocks.userFindUnique.mockResolvedValue({status:'ACTIVE'});
	mocks.auditCreate.mockResolvedValue({});
	mocks.getMarketQuote.mockResolvedValue({
		price:200,change:2,changePercent:1,updatedAt:new Date().toISOString(),source:'Aurevia Internal',isStale:false,
	});
	mocks.getMarketHistory.mockResolvedValue({
		source:'Aurevia Internal',quote:{source:'Aurevia Internal',isStale:false},
	});
	mocks.getReferenceMarketHistory.mockReturnValue({
		source:'Aurevia Internal',quote:{source:'Aurevia Internal',isStale:false},candles:[],
	});
	mocks.runAiService.mockResolvedValue({
		content:JSON.stringify({explanation:'Only internal reference data is currently available.',recommendedAction:'configure_market_provider',caveat:'This explanation does not provide live market data or investment advice.'}),
		provider:'openrouter',
		model:'test/free-model',
	});
});

describe('market data availability AI explanation',()=>{
	it('sends only verified source status, never prices, credentials, or account identifiers',async()=>{
		const response=await POST(request({symbol:'AAPL',dataType:'quote'}));
		const body=await response.json();

		expect(response.status).toBe(200);
		expect(body).toMatchObject({symbol:'AAPL',dataType:'quote',status:'internal_reference'});
		expect(mocks.runAiService).toHaveBeenCalledWith('market_information_summary',expect.any(Array),expect.objectContaining({actorId:'user-1'}));
		const messages=mocks.runAiService.mock.calls[0][1] as Array<{role:string;content:string}>;
		const suppliedFacts=messages.find(message=>message.role==='user')?.content||'';
		expect(JSON.parse(suppliedFacts)).toMatchObject({symbol:'AAPL',status:'internal_reference',provider:null});
		expect(suppliedFacts).not.toContain('200');
		expect(suppliedFacts).not.toContain('test-market-key');
		expect(suppliedFacts).not.toContain('user-1');
		expect(mocks.auditCreate).toHaveBeenCalledWith({data:expect.objectContaining({
			actorId:'user-1',action:'AI_MARKET_DATA_STATUS_EXPLAINED',
			metadata:expect.objectContaining({symbol:'AAPL',dataType:'quote',status:'internal_reference',externalAction:false}),
		})});
	});

	it('does not claim reference history after a configured provider fails',async()=>{
		const warning=vi.spyOn(console,'warn').mockImplementation(()=>undefined);
		const providerDiagnostics={
			selectedProvider:'none',
			alpaca:{status:'failed',reason:'invalid_credentials',httpStatus:401},
			finnhub:{status:'failed',reason:'subscription_or_access_denied',httpStatus:403},
		} as const;
		mocks.getMarketHistory.mockRejectedValue(new MarketDataError('Configured historical market-data providers failed.',503,providerDiagnostics));

		const response=await POST(request({symbol:'AAPL',dataType:'history',timeframe:'1d'}));
		const body=await response.json();

		expect(response.status).toBe(200);
		expect(body).toMatchObject({status:'unavailable',provider:null});
		expect(mocks.getReferenceMarketHistory).not.toHaveBeenCalled();
		const messages=mocks.runAiService.mock.calls[0][1] as Array<{role:string;content:string}>;
		expect(JSON.parse(messages.find(message=>message.role==='user')?.content||'{}')).toMatchObject({
			symbol:'AAPL',dataType:'history',timeframe:'1d',status:'unavailable',provider:null,
		});
		expect(messages.map(message=>message.content).join(' ')).not.toContain('private upstream details');
		expect(warning).toHaveBeenCalledWith('Configured market history providers are unavailable.',expect.objectContaining({
			requestId:expect.any(String),
			referenceId:expect.any(String),
			endpoint:'/api/market/data-explanation',
			symbol:'AAPL',
			providerDiagnostics,
		}));
		warning.mockRestore();
	});

	it('marks a fresh provider response accurately',async()=>{
		mocks.getMarketQuote.mockResolvedValue({source:'Finnhub',isStale:false,price:200});
		const response=await POST(request({symbol:'AAPL',dataType:'quote'}));

		expect(response.status).toBe(200);
		expect((await response.json()).status).toBe('current_provider');
	});

	it('marks valid provider history current without requiring a separate quote',async()=>{
		mocks.getMarketHistory.mockResolvedValue({
			source:'Alpaca',
			candles:[{time:1,open:10,high:11,low:9,close:10,volume:null}],
		});
		const warning=vi.spyOn(console,'warn').mockImplementation(()=>undefined);

		const response=await POST(request({symbol:'AAPL',dataType:'history',timeframe:'1d'}));
		const body=await response.json();

		expect(response.status).toBe(200);
		expect(body.status).toBe('current_provider');
		expect(body.provider).toBe('Alpaca');
		expect(warning).not.toHaveBeenCalled();
	});

	it('rejects unsupported symbols and timeframes before invoking AI',async()=>{
		expect((await POST(request({symbol:'UNKNOWN',dataType:'quote'}))).status).toBe(400);
		expect((await POST(request({symbol:'AAPL',dataType:'history',timeframe:'unsupported'}))).status).toBe(400);
		expect(mocks.runAiService).not.toHaveBeenCalled();
	});
});
