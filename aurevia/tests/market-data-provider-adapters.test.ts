import {describe,expect,it,vi} from 'vitest';
import {AlphaVantageMarketProvider} from '@/lib/providers/alpha-vantage-market-data';
import {FmpMarketProvider} from '@/lib/providers/fmp-market-data';
import {TwelveDataMarketProvider} from '@/lib/providers/twelve-data-market-data';

const asset={id:'AAPL',ticker:'AAPL',name:'Apple Inc.',type:'STOCK' as const,currency:'USD'};

describe('market-data provider adapters',()=>{
	it('normalizes Twelve Data quote and history responses without returning credentials',async()=>{
		const fetcher=vi.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify({
				close:'192.5',previous_close:'190',change:'2.5',percent_change:'1.3158',datetime:'2026-11-05 10:30:00',
				open:'191',high:'193',low:'190',volume:'1000',
			}),{status:200}))
			.mockResolvedValueOnce(new Response(JSON.stringify({values:[{
				datetime:'2026-11-04',open:'190',high:'193',low:'189',close:'192.5',volume:'1000',
			}]}),{status:200}));
		const provider=new TwelveDataMarketProvider({apiKey:'twelve-test-secret',fetcher});

		await expect(provider.getQuote(asset)).resolves.toMatchObject({price:192.5,changePercent:1.3158,source:'Twelve Data'});
		await expect(provider.getHistory(asset,'2026-11-01','2026-11-05','1d')).resolves.toEqual([
			{time:expect.any(Number),open:190,high:193,low:189,close:192.5,volume:1000},
		]);
		expect(fetcher.mock.calls[0][0]).toContain('apikey=twelve-test-secret');
	});

	it('normalizes Alpha Vantage stock quotes and daily candles',async()=>{
		const fetcher=vi.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify({'Global Quote':{
				'05. price':'190','08. previous close':'188','09. change':'2','10. change percent':'1.06%',
				'02. open':'189','03. high':'191','04. low':'187','06. volume':'20',
			}}),{status:200}))
			.mockResolvedValueOnce(new Response(JSON.stringify({'Time Series (Daily)':{
				'2026-11-04':{'1. open':'188','2. high':'190','3. low':'187','4. close':'189','5. volume':'10'},
			}}),{status:200}));
		const provider=new AlphaVantageMarketProvider({apiKey:'alpha-test-secret',fetcher});

		await expect(provider.getQuote(asset)).resolves.toMatchObject({price:190,change:2,source:'Alpha Vantage'});
		await expect(provider.getHistory(asset,'2026-11-01','2026-11-05')).resolves.toHaveLength(1);
	});

	it('normalizes Financial Modeling Prep quote and history responses',async()=>{
		const fetcher=vi.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify([{
				symbol:'AAPL',price:190,previousClose:188,change:2,changePercentage:1.06,open:189,dayHigh:191,dayLow:187,volume:20,
			}]),{status:200}))
			.mockResolvedValueOnce(new Response(JSON.stringify([{
				date:'2026-11-04',open:188,high:190,low:187,close:189,volume:10,
			}]),{status:200}));
		const provider=new FmpMarketProvider({apiKey:'fmp-test-secret',fetcher});

		await expect(provider.getQuote(asset)).resolves.toMatchObject({price:190,change:2,source:'Financial Modeling Prep'});
		await expect(provider.getHistory(asset,'2026-11-01','2026-11-05')).resolves.toHaveLength(1);
		expect(fetcher.mock.calls.every(([url])=>String(url).startsWith('https://financialmodelingprep.com/'))).toBe(true);
	});

	it('never includes API keys in provider HTTP error messages',async()=>{
		const provider=new FmpMarketProvider({
			apiKey:'secret-that-must-not-leak',
			fetcher:vi.fn().mockResolvedValue(new Response('invalid key',{status:401})),
		});
		await expect(provider.getQuote(asset)).rejects.toThrow('Financial Modeling Prep market-data request failed.');
	});
});
