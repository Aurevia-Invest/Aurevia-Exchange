import {beforeEach,describe,expect,it,vi} from 'vitest';
import {getMarketAsset} from '@/lib/live-market';

vi.mock('bottleneck',()=>({
	default:class{
		static strategy={OVERFLOW:1};
		constructor(){}
		schedule<T>(operation:()=>Promise<T>){return operation()}
	},
}));

import {getConfiguredMarketQuote,getMarketProviderReadiness} from '@/lib/market-data/provider-manager';

beforeEach(()=>vi.unstubAllEnvs());

describe('market-data provider selection and readiness',()=>{
	it('falls through failed providers and returns a normalized quote from the next supported provider',async()=>{
		const fetcher=vi.fn(async(input:RequestInfo|URL)=>{
			const url=String(input);
			if(url.includes('financialmodelingprep.com'))return new Response('denied',{status:403});
			return new Response(JSON.stringify({
				close:'192.5',previous_close:'190',change:'2.5',percent_change:'1.3158',datetime:'2026-11-05 10:30:00',
			}),{status:200});
		});
		vi.stubGlobal('fetch',fetcher);
		const quote=await getConfiguredMarketQuote(getMarketAsset('AAPL')!,{
			fmpApiKey:'fmp-fallback-key',twelveDataApiKey:'twelve-working-key',alphaVantageApiKey:'',productionLicenseConfirmed:false,
		});

		expect(quote).toMatchObject({price:192.5,source:'Twelve Data'});
		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(JSON.stringify(quote)).not.toContain('twelve-working-key');
	});

	it('reports connected only after a successful authenticated provider request and redacts keys',async()=>{
		const key='fmp-readiness-secret';
		vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify([{
			symbol:'AAPL',price:190,previousClose:188,change:2,changePercentage:1.06,
		}]),{status:200})));
		const readiness=await getMarketProviderReadiness({
			fmpApiKey:key,twelveDataApiKey:'',alphaVantageApiKey:'',productionLicenseConfirmed:false,
		});
		const fmp=readiness.find(provider=>provider.id==='fmp');

		expect(fmp).toMatchObject({configured:true,status:'CONNECTED'});
		expect(JSON.stringify(readiness)).not.toContain(key);
	});

	it('requires the production license confirmation before provider requests',async()=>{
		vi.stubEnv('NODE_ENV','production');
		const fetcher=vi.fn();
		vi.stubGlobal('fetch',fetcher);

		await expect(getConfiguredMarketQuote(getMarketAsset('AAPL')!,{
			fmpApiKey:'production-key',twelveDataApiKey:'',alphaVantageApiKey:'',productionLicenseConfirmed:false,
		})).resolves.toBeNull();
		expect(fetcher).not.toHaveBeenCalled();
	});

	it('does not send unsupported instrument categories to stock-only providers',async()=>{
		const fetcher=vi.fn();
		vi.stubGlobal('fetch',fetcher);
		await expect(getConfiguredMarketQuote(getMarketAsset('SPX')!,{
			fmpApiKey:'fmp-key',twelveDataApiKey:'',alphaVantageApiKey:'',productionLicenseConfirmed:false,
		})).resolves.toBeNull();
		expect(fetcher).not.toHaveBeenCalled();
	});
});
