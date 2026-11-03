import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({instrumentFindFirst:vi.fn(),candleFindFirst:vi.fn()}));
vi.mock('@/lib/db',()=>({db:{instrument:{findFirst:mocks.instrumentFindFirst},candle:{findFirst:mocks.candleFindFirst}}}));

import {getInternalMarketHistory,getInternalMarketQuote,getReferenceMarketHistory} from '@/lib/internal-market-data';

const bitcoin={id:'BTC',ticker:'BTC-USD',name:'Bitcoin USD',type:'CRYPTO' as const,currency:'USD'};

beforeEach(()=>{
	mocks.instrumentFindFirst.mockReset().mockResolvedValue({id:'btc-instrument',price:'101000'});
	mocks.candleFindFirst.mockReset().mockResolvedValue({open:'99000'});
});

describe('internal paper-market quotes',()=>{
	it('uses the internal trading instrument and its current-day candle when present',async()=>{
		const quote=await getInternalMarketQuote(bitcoin);
		expect(quote).toMatchObject({
			price:101000,previousClose:99000,open:99000,source:'Aurevia Internal',isStale:false,volume:null,
		});
		expect(quote.change).toBe(2000);
		expect(quote.changePercent).toBeCloseTo(2000/99000*100);
		expect(quote.dayLow).toBeLessThanOrEqual(quote.price);
		expect(quote.dayHigh).toBeGreaterThanOrEqual(quote.price);
		expect(mocks.candleFindFirst).toHaveBeenCalledOnce();
	});

	it('generates a positive internal reference price when no matching trading instrument exists',async()=>{
		mocks.instrumentFindFirst.mockResolvedValue(null);
		const quote=await getInternalMarketQuote({...bitcoin,id:'AAPL',ticker:'AAPL',name:'Apple Inc.',type:'STOCK'});
		expect(quote.source).toBe('Aurevia Internal');
		expect(quote.price).toBeGreaterThan(0);
		expect(quote.volume).toBeNull();
		expect(mocks.candleFindFirst).not.toHaveBeenCalled();
	});

	it.each([null,'0'])('uses a reference fallback when the instrument price is %s',async price=>{
		mocks.instrumentFindFirst.mockResolvedValue({id:'aapl-instrument',price});
		const asset={...bitcoin,id:'AAPL',ticker:'AAPL',name:'Apple Inc.',type:'STOCK' as const};

		const history=await getInternalMarketHistory(asset,'1d');

		expect(history.source).toBe('Aurevia Internal');
		expect(history.candles).toHaveLength(240);
		expect(history.quote.price).toBeGreaterThan(0);
		expect(history.candles.every(candle=>Number.isFinite(candle.close)&&candle.close>0)).toBe(true);
		expect(mocks.candleFindFirst).not.toHaveBeenCalled();
	});

	it('uses the instrument price when the current-day candle open is invalid',async()=>{
		mocks.instrumentFindFirst.mockResolvedValue({id:'btc-instrument',price:'101000'});
		mocks.candleFindFirst.mockResolvedValue({open:'0'});

		const quote=await getInternalMarketQuote(bitcoin);

		expect(quote).toMatchObject({price:101000,previousClose:101000,change:0,changePercent:0});
	});

	it('builds labeled reference history without querying the database',()=>{
		const asset={...bitcoin,id:'AAPL',ticker:'AAPL',name:'Apple Inc.',type:'STOCK' as const};

		const history=getReferenceMarketHistory(asset,'1d');

		expect(history).toMatchObject({source:'Aurevia Internal',timeframe:'1d',interval:'30m'});
		expect(history.quote.source).toBe('Aurevia Internal');
		expect(history.candles).toHaveLength(240);
		expect(history.candles.every(candle=>Number.isFinite(candle.close)&&candle.close>0)).toBe(true);
		expect(mocks.instrumentFindFirst).not.toHaveBeenCalled();
		expect(mocks.candleFindFirst).not.toHaveBeenCalled();
	});
});
