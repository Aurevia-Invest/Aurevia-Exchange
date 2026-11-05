import type {LiveMarketAsset,MarketCandle,MarketQuote} from '@/lib/live-market';
import {candlesFromRows,finiteNumber,normalizedTimestamp,requestMarketProviderJson} from './market-data-http';

export type TwelveDataOptions={apiKey:string;fetcher?:typeof fetch};

function symbolFor(asset:LiveMarketAsset){
	if(asset.type==='FOREX')return asset.ticker.replace(/=X$/,'').replace(/^(.{3})(.{3})$/,'$1/$2');
	if(asset.type==='CRYPTO')return asset.ticker.replace('-','/');
	return asset.ticker;
}

function assertPayload(data:Record<string,unknown>){
	if(data.status==='error'||data.code||data.message&&typeof data.message==='string'&&!('datetime'in data)){
		throw new Error('Twelve Data returned an unsuccessful response.');
	}
}

export class TwelveDataMarketProvider{
	readonly name='Twelve Data';
	constructor(private readonly options:TwelveDataOptions){}

	async getQuote(asset:LiveMarketAsset):Promise<MarketQuote>{
		const url=new URL('https://api.twelvedata.com/quote');
		url.search=new URLSearchParams({symbol:symbolFor(asset),apikey:this.options.apiKey}).toString();
		const data=await requestMarketProviderJson(this.name,url.toString(),this.options.fetcher);
		assertPayload(data);
		const price=finiteNumber(data.close);
		const previousClose=finiteNumber(data.previous_close);
		if(price===null||price<=0)throw new Error('Twelve Data quote has no valid price.');
		const change=finiteNumber(data.change)??(previousClose===null?0:price-previousClose);
		const changePercent=finiteNumber(data.percent_change)??(previousClose?change/previousClose*100:0);
		return {
			asset,price,change,changePercent,previousClose,open:finiteNumber(data.open),volume:finiteNumber(data.volume),
			dayLow:finiteNumber(data.low),dayHigh:finiteNumber(data.high),fiftyTwoWeekLow:null,fiftyTwoWeekHigh:null,
			marketStatus:'UNKNOWN',updatedAt:normalizedTimestamp(data.datetime),isStale:false,sparkline:[],source:this.name,
		};
	}

	async getHistory(asset:LiveMarketAsset,from:string,to:string,interval:string):Promise<MarketCandle[]>{
		const intervalMap:Record<string,string>={'1m':'1min','5m':'5min','15m':'15min','30m':'30min','1h':'1h','1d':'1day','1wk':'1week','1mo':'1month'};
		const url=new URL('https://api.twelvedata.com/time_series');
		url.search=new URLSearchParams({
			symbol:symbolFor(asset),interval:intervalMap[interval]||'1day',
			start_date:from,end_date:to,outputsize:'5000',apikey:this.options.apiKey,
		}).toString();
		const data=await requestMarketProviderJson(this.name,url.toString(),this.options.fetcher);
		assertPayload(data);
		return candlesFromRows(data.values,{time:'datetime',open:'open',high:'high',low:'low',close:'close',volume:'volume'});
	}
}
