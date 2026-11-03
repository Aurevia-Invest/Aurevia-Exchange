import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {filterSupportedMarketAssets,getLiveMarketProviderStatus,getMarketAsset,getMarketHistory,getMarketQuote,type TimeframeId} from '../lib/live-market';
import {getFinnhubHistory} from '../lib/providers/finnhub-market-data';

afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.unstubAllEnvs()});

describe('Finnhub market service',()=>{
	beforeEach(()=>vi.stubEnv('FINNHUB_API_KEY',''));

	it('reports the internal market feed when no live provider is configured',async()=>{
		await expect(getLiveMarketProviderStatus()).resolves.toMatchObject({
			status:'AVAILABLE',
			provider:'Aurevia Internal',
			finnhubStatus:'NOT_CONFIGURED',
			fallbackProvider:'Aurevia Internal',
		});
	});

	it('parses Finnhub quotes and historical OHLCV candles',async()=>{
		const now=Math.floor(Date.now()/1000);
		const fetcher=vi.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify({c:41000,d:1000,dp:2.5,o:40500,h:41500,l:40400,pc:40000,t:now}),{status:200}))
			.mockResolvedValueOnce(new Response(JSON.stringify({s:'ok',t:[now-60,now],o:[40000,40500],h:[40500,41500],l:[39900,40400],c:[40400,41000],v:[12,34]}),{status:200}));
		vi.stubGlobal('fetch',fetcher);
		const asset=getMarketAsset('DJI')!;
		const quote=await getMarketQuote(asset,'test-finnhub-key');
		expect(quote).toMatchObject({price:41000,change:1000,changePercent:2.5,source:'Finnhub'});
		const history=await getMarketHistory(asset,'1d','test-finnhub-key');
		expect(history.candles).toHaveLength(2);
		expect(history.candles[1]).toMatchObject({open:40500,high:41500,low:40400,close:41000,volume:34});
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it('uses internal prices when Finnhub throttles',async()=>{
		vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('{}',{status:429})));
		await expect(getMarketQuote(getMarketAsset('MERV')!,'test-finnhub-key')).resolves.toMatchObject({source:'Aurevia Internal',price:expect.any(Number)});
	});

	it('returns its last successful provider quote with an explicit stale marker after a failure',async()=>{
		const asset={id:'STALE_CACHE_TEST',ticker:'STALE_CACHE_TEST',name:'Stale cache test',type:'STOCK' as const,currency:'USD'};
		const payload={c:123,d:1,dp:0.8,o:122,h:124,l:121,pc:122,t:Math.floor(Date.now()/1000)};
		const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(payload),{status:200})).mockRejectedValue(new Error('offline'));
		vi.stubGlobal('fetch',fetcher);
		const current=await getMarketQuote(asset,'test-finnhub-key');
		vi.useFakeTimers();
		await vi.advanceTimersByTimeAsync(9_000);
		const stalePromise=getMarketQuote(asset,'test-finnhub-key');
		await vi.advanceTimersByTimeAsync(500);
		const stale=await stalePromise;
		expect(stale.price).toBe(current.price);
		expect(stale.isStale).toBe(true);
		expect(stale.staleReason).toContain('unreachable');
	});

	it('prefers a fresh internal quote over a stale cached provider quote',async()=>{
		const asset=getMarketAsset('MSFT')!;
		const payload={c:123,d:1,dp:0.8,o:122,h:124,l:121,pc:122,t:Math.floor(Date.now()/1000)};
		const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(payload),{status:200})).mockRejectedValue(new Error('offline'));
		vi.stubGlobal('fetch',fetcher);
		await getMarketQuote(asset,'test-finnhub-key');
		vi.useFakeTimers();
		await vi.advanceTimersByTimeAsync(9_000);
		const fallbackPromise=getMarketQuote(asset,'test-finnhub-key');
		await vi.advanceTimersByTimeAsync(500);
		const fallback=await fallbackPromise;
		expect(fallback.source).toBe('Aurevia Internal');
		expect(fallback.isStale).toBe(false);
		expect(Date.now()-Date.parse(fallback.updatedAt)).toBeLessThan(5_000);
	});

	it('marks provider quotes stale when their quote timestamp is old',async()=>{
		const asset={id:'OLD_PROVIDER_QUOTE_TEST',ticker:'OLD_PROVIDER_QUOTE_TEST',name:'Old provider quote test',type:'STOCK' as const,currency:'USD'};
		const payload={c:123,d:1,dp:0.8,o:122,h:124,l:121,pc:122,t:Math.floor(Date.now()/1000)-6*60};
		vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify(payload),{status:200})));
		const quote=await getMarketQuote(asset,'test-finnhub-key');
		expect(quote.isStale).toBe(true);
		expect(quote.staleReason).toContain('older than five minutes');
	});

	it('rejects unknown symbols at lookup',()=>{
		expect(getMarketAsset('NOT-A-REAL-SYMBOL')).toBeUndefined();
	});

	it('filters synthetic trading symbols from a market asset batch',()=>{
		expect(filterSupportedMarketAssets([{symbol:'DJI'},{symbol:'E2E917F9FA/USD'}])).toEqual([{symbol:'DJI'}]);
	});

	it('uses the server-only key for Finnhub and identifies its quote source',async()=>{
		const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({c:190,d:2,dp:1.06,o:188,h:192,l:187,pc:188,t:Math.floor(Date.now()/1000)}),{status:200}));
		vi.stubGlobal('fetch',fetcher);
		const quote=await getMarketQuote(getMarketAsset('AAPL')!,'server-only-finnhub-test-key');
		expect(quote).toMatchObject({price:190,source:'Finnhub',change:2});
		expect(fetcher.mock.calls[0][1].headers['X-Finnhub-Token']).toBe('server-only-finnhub-test-key');
		expect(fetcher.mock.calls[0][0]).toContain('/quote?symbol=AAPL');
	});

	it('uses Alpaca crypto trades, quotes, and bars instead of simulated marks',async()=>{
		const now=new Date();
		const fetcher=vi.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify({quotes:{'BTC/USD':{bp:41990,ap:42010,t:now.toISOString()}}}),{status:200}))
			.mockResolvedValueOnce(new Response(JSON.stringify({trades:{'BTC/USD':{p:42000,t:now.toISOString()}}}),{status:200}))
			.mockResolvedValueOnce(new Response(JSON.stringify({bars:{'BTC/USD':[
				{t:new Date(now.getTime()-86_400_000).toISOString(),o:40000,h:41000,l:39500,c:40500,v:100},
				{t:now.toISOString(),o:40500,h:42500,l:40200,c:42000,v:125},
			]}}),{status:200}))
			.mockResolvedValueOnce(new Response(JSON.stringify({bars:{'BTC/USD':[
				{t:new Date(now.getTime()-60_000).toISOString(),o:41900,h:42000,l:41800,c:42000,v:5},
			]}}),{status:200}));
		const options={apiKey:'alpaca-market-key',apiSecret:'alpaca-market-secret',fetcher};
		const asset=getMarketAsset('BTC')!;

		const quote=await getMarketQuote(asset,'',options);
		expect(quote).toMatchObject({price:42000,bid:41990,ask:42010,previousClose:40500,change:1500,source:'Alpaca Crypto'});
		const history=await getMarketHistory(asset,'1d','',options);
		expect(history.source).toBe('Alpaca Crypto');
		expect(history.candles[0]).toMatchObject({open:41900,high:42000,low:41800,close:42000,volume:5});
		expect(fetcher).toHaveBeenCalledTimes(4);
		expect(fetcher.mock.calls[0][1].headers).toMatchObject({'x-api-key':'alpaca-market-key'});
	});

	it('does not call a separate external provider after Finnhub fails',async()=>{
		const fetcher=vi.fn().mockResolvedValue(new Response('{}',{status:401}));
		vi.stubGlobal('fetch',fetcher);
		const asset={id:'FINNHUB_FALLBACK_TEST',ticker:'AAPL',name:'Finnhub fallback test',type:'STOCK' as const,currency:'USD'};
		await expect(getMarketQuote(asset,'invalid-test-key')).rejects.toMatchObject({status:401});
		expect(fetcher).toHaveBeenCalledOnce();
	});

	it('rejects Finnhub quotes that contain no valid price',async()=>{
		vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({c:0,d:0,dp:0,t:Math.floor(Date.now()/1000)}),{status:200})));
		await expect(getMarketQuote({id:'NO_PRICE_TEST',ticker:'NO_PRICE_TEST',name:'No price test',type:'STOCK',currency:'USD'},'test-key')).rejects.toMatchObject({status:503});
	});

	it('rejects provider quotes without required metadata rather than inventing it',async()=>{
		vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({c:42,o:41,h:43,l:40}),{status:200})));
		await expect(getMarketQuote({id:'INCOMPLETE_QUOTE_TEST',ticker:'INCOMPLETE_QUOTE_TEST',name:'Incomplete quote test',type:'STOCK',currency:'USD'},'test-key')).rejects.toMatchObject({status:502});
	});

	it('keeps missing historical volume unavailable rather than reporting zero',async()=>{
		const now=Math.floor(Date.now()/1000);
		vi.stubGlobal('fetch',vi.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify({s:'ok',t:[now-60],o:[40],h:[43],l:[39],c:[42],v:[null]}),{status:200}))
			.mockResolvedValueOnce(new Response(JSON.stringify({c:42,d:1,dp:2.4,o:41,h:43,l:39,pc:41,t:now}),{status:200})));
		const history=await getMarketHistory({id:'NO_VOLUME_TEST',ticker:'NO_VOLUME_TEST',name:'No volume test',type:'STOCK',currency:'USD'},'1d','test-finnhub-key');
		expect(history.candles[0].volume).toBeNull();
	});

	it('reads Finnhub historical candles without inventing missing bars',async()=>{
		const now=Math.floor(Date.now()/1000);
		const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({s:'ok',t:[now-60,now],o:[188,189],h:[190,192],l:[187,188],c:[189,191],v:[10,20]}),{status:200}));
		vi.stubGlobal('fetch',fetcher);
		const history=await getMarketHistory(getMarketAsset('AAPL')!,'1h','test-finnhub-key');
		expect(history.source).toBe('Finnhub');
		expect(history.candles).toHaveLength(2);
		expect(history.candles[1]).toMatchObject({open:189,high:192,low:188,close:191,volume:20});
		expect(fetcher.mock.calls[0][0]).toContain('resolution=60');
		expect(history.quote).toBeNull();
	});

	it('retains the Finnhub HTTP status and redacted provider response for history failures',async()=>{
		const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({
			error:'API key: private-finnhub-key',
		}),{status:403}));

		await expect(getFinnhubHistory(getMarketAsset('AAPL')!,'1d','1m','test-finnhub-key',fetcher)).rejects.toMatchObject({
			name:'FinnhubMarketDataError',
			status:403,
			providerHttpStatus:403,
			providerMessage:'API key: [REDACTED]',
			providerEndpoint:'/api/v1/stock/candle',
		});
	});

	it('uses Alpaca IEX history for AAPL, MSFT, TSLA, and NVDA without changing OHLCV',async()=>{
		const fetcher=vi.fn((input:URL|string|Request)=>{
			const url=String(input);
			const symbol=url.match(/stocks\/([A-Z]+)\/bars/)?.[1]||'';
			const price={AAPL:190,MSFT:510,TSLA:340,NVDA:140}[symbol as 'AAPL'|'MSFT'|'TSLA'|'NVDA'];
			return Promise.resolve(new Response(JSON.stringify({bars:[{
				t:'2026-10-15T14:00:00Z',o:price-1,h:price+2,l:price-3,c:price,v:1234,
			}]}),{status:200}));
		});
		const options={apiKey:'alpaca-key',apiSecret:'alpaca-secret',fetcher};
		for(const symbol of ['AAPL','MSFT','TSLA','NVDA']){
			const history=await getMarketHistory(getMarketAsset(symbol)!, '1d','',options);
			const price={AAPL:190,MSFT:510,TSLA:340,NVDA:140}[symbol as 'AAPL'|'MSFT'|'TSLA'|'NVDA'];
			expect(history).toMatchObject({source:'Alpaca',quote:null,diagnostics:{selectedProvider:'Alpaca',alpaca:{status:'succeeded'}}});
			expect(history.candles[0]).toEqual({
				time:Date.parse('2026-10-15T14:00:00Z')/1000,open:price-1,high:price+2,low:price-3,close:price,volume:1234,
			});
		}
		expect(fetcher).toHaveBeenCalledTimes(4);
		expect(fetcher.mock.calls.every(([url])=>String(url).includes('feed=iex'))).toBe(true);
		expect(fetcher.mock.calls.every(([url])=>String(url).includes('timeframe=1Min'))).toBe(true);
	});

	it('maps all requested chart intervals to Alpaca bar timeframes',async()=>{
		const fetcher=vi.fn().mockImplementation(()=>Promise.resolve(new Response(JSON.stringify({
			bars:[{t:'2026-10-15T14:00:00Z',o:188,h:192,l:187,c:190,v:10}],
		}),{status:200})));
		const asset={id:'ALPACA_INTERVAL_TEST',ticker:'AAPL',name:'Apple interval test',type:'STOCK' as const,currency:'USD'};
		const options={apiKey:'alpaca-interval-key',apiSecret:'alpaca-interval-secret',fetcher};
		const expected:Array<[TimeframeId,string]>=[
			['1d','1Min'],['5d','5Min'],['1m','15Min'],['1h','1Hour'],['3m','1Day'],
		];
		for(const [timeframe] of expected)await getMarketHistory(asset,timeframe,'',options);
		const timeframes=fetcher.mock.calls.map(([url])=>new URL(String(url)).searchParams.get('timeframe'));
		expect(timeframes).toEqual(expected.map(([,value])=>value));
	});

	it('maps Finnhub minute, hourly, and daily resolutions consistently',async()=>{
		const fetcher=vi.fn().mockImplementation(()=>Promise.resolve(new Response(JSON.stringify({
			s:'ok',t:[Math.floor(Date.now()/1000)],o:[188],h:[192],l:[187],c:[190],v:[10],
		}),{status:200})));
		vi.stubGlobal('fetch',fetcher);
		const asset={id:'FINNHUB_INTERVAL_TEST',ticker:'AAPL',name:'Apple interval test',type:'STOCK' as const,currency:'USD'};
		const expected:Array<[TimeframeId,string]>=[
			['1d','1'],['5d','5'],['1m','15'],['1h','60'],['3m','D'],
		];
		for(const [timeframe] of expected)await getMarketHistory(asset,timeframe,'finnhub-interval-key');
		const resolutions=fetcher.mock.calls.map(([url])=>new URL(String(url)).searchParams.get('resolution'));
		expect(resolutions).toEqual(expected.map(([,value])=>value));
	});

	it('falls back from failed Alpaca history to Finnhub and exposes both provider results',async()=>{
		const now=Math.floor(Date.now()/1000);
		const fetcher=vi.fn((input:URL|string|Request)=>{
			const url=String(input);
			if(url.includes('data.alpaca.markets'))return Promise.resolve(new Response('{}',{status:503}));
			return Promise.resolve(new Response(JSON.stringify({s:'ok',t:[now],o:[189],h:[192],l:[187],c:[191],v:[42]}),{status:200}));
		});
		const options={apiKey:'alpaca-fallback-key',apiSecret:'alpaca-fallback-secret',fetcher};
		const asset={id:'AAPL_FALLBACK_TEST',ticker:'AAPL',name:'Apple fallback test',type:'STOCK' as const,currency:'USD'};
		const history=await getMarketHistory(asset,'1h','finnhub-fallback-key',options);
		expect(history).toMatchObject({
			source:'Finnhub',
			diagnostics:{
				selectedProvider:'Finnhub',
				alpaca:{status:'failed',reason:'provider_server_error',httpStatus:503},
				finnhub:{status:'succeeded'},
			},
		});
		expect(fetcher).toHaveBeenCalledTimes(3);
		expect(String(fetcher.mock.calls[2][0])).toContain('resolution=60');
	});

	it('does not fabricate stock history when both configured providers fail',async()=>{
		const fetcher=vi.fn((input:URL|string|Request)=>{
			const url=String(input);
			if(url.includes('data.alpaca.markets'))return Promise.resolve(new Response('{}',{status:503}));
			return Promise.resolve(new Response('{}',{status:401}));
		});
		const asset={id:'NO_FABRICATED_HISTORY_TEST',ticker:'AAPL',name:'Apple failure test',type:'STOCK' as const,currency:'USD'};
		await expect(getMarketHistory(asset,'5d','finnhub-invalid-key',{
			apiKey:'alpaca-failure-key',apiSecret:'alpaca-failure-secret',fetcher,
		})).rejects.toMatchObject({
			status:503,
			diagnostics:{
				selectedProvider:'none',
				alpaca:{status:'failed',httpStatus:503},
				finnhub:{status:'failed',httpStatus:401},
			},
		});
		expect(fetcher).toHaveBeenCalledTimes(3);
	});
});
