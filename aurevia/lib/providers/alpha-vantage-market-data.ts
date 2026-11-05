import type {LiveMarketAsset,MarketCandle,MarketQuote} from '@/lib/live-market';
import {candlesFromRows,finiteNumber,requestMarketProviderJson} from './market-data-http';

export type AlphaVantageOptions={apiKey:string;fetcher?:typeof fetch};

function checkResponse(data:Record<string,unknown>){
	if(data['Error Message']||data.Note||data.Information)throw new Error('Alpha Vantage rejected or throttled the request.');
}

export class AlphaVantageMarketProvider{
	readonly name='Alpha Vantage';
	constructor(private readonly options:AlphaVantageOptions){}

	async getQuote(asset:LiveMarketAsset):Promise<MarketQuote>{
		const url=new URL('https://www.alphavantage.co/query');
		url.search=new URLSearchParams({function:'GLOBAL_QUOTE',symbol:asset.ticker,apikey:this.options.apiKey}).toString();
		const data=await requestMarketProviderJson(this.name,url.toString(),this.options.fetcher);
		checkResponse(data);
		const row=data['Global Quote'];
		if(!row||typeof row!=='object'||Array.isArray(row))throw new Error('Alpha Vantage returned no quote data.');
		const quote=row as Record<string,unknown>;
		const price=finiteNumber(quote['05. price']);
		if(price===null||price<=0)throw new Error('Alpha Vantage quote has no valid price.');
		const previousClose=finiteNumber(quote['08. previous close']);
		const change=finiteNumber(quote['09. change'])??(previousClose===null?0:price-previousClose);
		const changePercent=finiteNumber(quote['10. change percent'])??(previousClose?change/previousClose*100:0);
		return {
			asset,price,change,changePercent,previousClose,open:finiteNumber(quote['02. open']),volume:finiteNumber(quote['06. volume']),
			dayLow:finiteNumber(quote['04. low']),dayHigh:finiteNumber(quote['03. high']),fiftyTwoWeekLow:null,fiftyTwoWeekHigh:null,
			marketStatus:'UNKNOWN',updatedAt:new Date().toISOString(),isStale:false,sparkline:[],source:this.name,
		};
	}

	async getHistory(asset:LiveMarketAsset,from:string,to:string):Promise<MarketCandle[]>{
		const url=new URL('https://www.alphavantage.co/query');
		url.search=new URLSearchParams({function:'TIME_SERIES_DAILY',symbol:asset.ticker,outputsize:'full',apikey:this.options.apiKey}).toString();
		const data=await requestMarketProviderJson(this.name,url.toString(),this.options.fetcher);
		checkResponse(data);
		const rows=data['Time Series (Daily)'];
		const start=Date.parse(from),end=Date.parse(to);
		const datedRows=rows&&typeof rows==='object'&&!Array.isArray(rows)
			?Object.entries(rows as Record<string,unknown>).map(([date,values])=>({date,...(values&&typeof values==='object'?values:{})}))
			:[];
		return candlesFromRows(datedRows,{time:'date',open:'1. open',high:'2. high',low:'3. low',close:'4. close',volume:'5. volume'})
			.filter(candle=>candle.time*1000>=start&&candle.time*1000<=end)
			.sort((left,right)=>left.time-right.time);
	}
}
