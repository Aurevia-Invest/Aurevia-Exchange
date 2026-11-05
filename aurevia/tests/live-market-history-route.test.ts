import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	getHistory:vi.fn(),
	getAlpacaOptions:vi.fn(),
	getConfiguration:vi.fn(),
}));

vi.mock('@/lib/config/env',()=>({getServerConfiguration:mocks.getConfiguration}));
vi.mock('@/lib/market-data-service',()=>({
	getAlpacaMarketDataOptions:mocks.getAlpacaOptions,
	getAdditionalMarketProviderKeys:()=>({twelveDataApiKey:'',alphaVantageApiKey:'',fmpApiKey:'',productionLicenseConfirmed:false}),
	getMarketHistoryWithFallback:mocks.getHistory,
}));

import {GET} from '@/app/api/live-markets/[symbol]/route';
import {MarketDataError} from '@/lib/live-market';

const request=(timeframe='1d')=>new Request(`https://aurevia.test/api/live-markets/AAPL?timeframe=${timeframe}`);
const diagnostics={
	selectedProvider:'none' as const,
	alpaca:{status:'failed' as const,reason:'invalid_credentials',httpStatus:401},
	finnhub:{status:'failed' as const,reason:'provider_server_error',httpStatus:503,providerCode:'UPSTREAM_ERROR'},
};

beforeEach(()=>{
	vi.clearAllMocks();
	mocks.getConfiguration.mockReturnValue({marketData:{finnhubApiKey:'server-key'},execution:{}});
	mocks.getAlpacaOptions.mockReturnValue(undefined);
});

describe('market history route errors',()=>{
	it('returns actionable access guidance without exposing provider response details',async()=>{
		mocks.getHistory.mockRejectedValue(new MarketDataError('Configured historical market-data providers failed.',503,diagnostics));

		const response=await GET(request(),{params:Promise.resolve({symbol:'AAPL'})});
		const body=await response.json();

		expect(response.status).toBe(503);
		expect(body).toMatchObject({
			code:'MARKET_HISTORY_UNAVAILABLE',
			error:'Historical market data is unavailable because a configured provider rejected access. Please contact support.',
			diagnostics,
		});
		expect(JSON.stringify(body)).not.toContain('server-key');
		expect(JSON.stringify(body)).not.toContain('providerMessage');
	});

	it('returns rate-limit guidance and keeps timeframe validation intact',async()=>{
		mocks.getHistory.mockRejectedValue(new MarketDataError('Configured historical market-data providers failed.',503,{
			...diagnostics,
			alpaca:{status:'failed',reason:'rate_limited',httpStatus:429},
		}));

		const response=await GET(request('ytd'),{params:Promise.resolve({symbol:'AAPL'})});
		expect(await response.json()).toMatchObject({
			error:'Historical market data is temporarily rate-limited. Please try again shortly.',
		});
		expect(mocks.getHistory).toHaveBeenCalledWith(
			expect.objectContaining({id:'AAPL'}),
			'ytd',
			'server-key',
			undefined,
			{twelveDataApiKey:'',alphaVantageApiKey:'',fmpApiKey:'',productionLicenseConfirmed:false},
		);
		expect((await GET(request('invalid'),{params:Promise.resolve({symbol:'AAPL'})})).status).toBe(400);
	});

	it('returns no-data guidance when every provider has no candles for the range',async()=>{
		mocks.getHistory.mockRejectedValue(new MarketDataError('Configured historical market-data providers failed.',503,{
			selectedProvider:'none',
			alpaca:{status:'failed',reason:'no_data',httpStatus:200,providerCode:'no_data'},
			finnhub:{status:'failed',reason:'no_data',httpStatus:200,providerCode:'no_data'},
		}));

		const response=await GET(request(),{params:Promise.resolve({symbol:'AAPL'})});
		expect((await response.json()).error).toBe(
			'No historical candles are available from the configured providers for this symbol and timeframe.',
		);
	});
});
