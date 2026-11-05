import type {LiveMarketAsset,MarketCandle,MarketQuote} from '@/lib/live-market';
import {candlesFromRows,finiteNumber,normalizedTimestamp,requestMarketProviderJson} from './market-data-http';

export type FmpOptions={apiKey:string;fetcher?:typeof fetch};

export class FmpMarketProvider{
	readonly name='Financial Modeling Prep';
	constructor(private readonly options:FmpOptions){}

	async getQuote(asset:LiveMarketAsset):Promise<MarketQuote>{
		const url=new URL('https://financialmodelingprep.com/stable/quote');
		url.search=new URLSearchParams({symbol:asset.ticker,apikey:this.options.apiKey}).toString();
		const payload=await requestMarketProviderJson(this.name,url.toString(),this.options.fetcher);
		const row=Array.isArray(payload)?payload[0]:payload;
		if(!row||typeof row!=='object'||Array.isArray(row))throw new Error('Financial Modeling Prep returned no quote data.');
		const quote=row as Record<string,unknown>;
		const price=finiteNumber(quote.price);
		if(price===null||price<=0)throw new Error('Financial Modeling Prep quote has no valid price.');
		const previousClose=finiteNumber(quote.previousClose);
		const change=finiteNumber(quote.change)??(previousClose===null?0:price-previousClose);
		const changePercent=finiteNumber(quote.changePercentage)??(previousClose?change/previousClose*100:0);
		return {
			asset,price,change,changePercent,previousClose,open:finiteNumber(quote.open),volume:finiteNumber(quote.volume),
			dayLow:finiteNumber(quote.dayLow),dayHigh:finiteNumber(quote.dayHigh),
			fiftyTwoWeekLow:finiteNumber(quote.yearLow),fiftyTwoWeekHigh:finiteNumber(quote.yearHigh),
			marketStatus:'UNKNOWN',updatedAt:normalizedTimestamp(quote.timestamp??quote.lastUpdated),isStale:false,sparkline:[],source:this.name,
		};
	}

	async getHistory(asset:LiveMarketAsset,from:string,to:string):Promise<MarketCandle[]>{
		const url=new URL('https://financialmodelingprep.com/stable/historical-price-eod/full');
		url.search=new URLSearchParams({symbol:asset.ticker,from:from.slice(0,10),to:to.slice(0,10),apikey:this.options.apiKey}).toString();
		const payload=await requestMarketProviderJson(this.name,url.toString(),this.options.fetcher);
		const rows=Array.isArray(payload)?payload:Array.isArray(payload.historical)?payload.historical:null;
		return candlesFromRows(rows,{time:'date',open:'open',high:'high',low:'low',close:'close',volume:'volume'})
			.sort((left,right)=>left.time-right.time);
	}
}
