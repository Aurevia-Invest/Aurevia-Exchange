import Bottleneck from 'bottleneck';
import {createHash} from 'node:crypto';
import {LRUCache} from 'lru-cache';
import type {LiveMarketAsset,MarketCandle,MarketQuote,TimeframeId} from '@/lib/live-market';
import {TIMEFRAMES} from '@/lib/live-market';
import {AlphaVantageMarketProvider} from '@/lib/providers/alpha-vantage-market-data';
import {FmpMarketProvider} from '@/lib/providers/fmp-market-data';
import {TwelveDataMarketProvider} from '@/lib/providers/twelve-data-market-data';
import type {MarketProviderHttpError} from '@/lib/providers/market-data-http';

export type MarketProviderKeys={
	twelveDataApiKey:string;
	alphaVantageApiKey:string;
	fmpApiKey:string;
	productionLicenseConfirmed:boolean;
};

type ProviderId='twelveData'|'alphaVantage'|'fmp';
type ProviderState={fingerprint:string;status:'CONNECTED'|'ERROR';checkedAt:string;failureUntil?:number;errorCode?:string};
type Adapter={
	id:ProviderId;
	name:string;
	key:string;
	categories:readonly LiveMarketAsset['type'][];
	historyIntervals?:readonly string[];
	getQuote:(asset:LiveMarketAsset)=>Promise<MarketQuote>;
	getHistory?:(asset:LiveMarketAsset,from:string,to:string,interval:string)=>Promise<MarketCandle[]>;
};

const providerHealth=new LRUCache<ProviderId,ProviderState>({max:3,ttl:10*60_000});
const quoteCache=new LRUCache<string,Promise<MarketQuote>>({max:400,ttl:15_000});
const historyCache=new LRUCache<string,Promise<MarketCandle[]>>({max:200,ttl:60_000});
const limiters={
	twelveData:new Bottleneck({maxConcurrent:1,minTime:8_000,highWater:5,strategy:Bottleneck.strategy.OVERFLOW}),
	fmp:new Bottleneck({maxConcurrent:1,minTime:12_000,highWater:5,strategy:Bottleneck.strategy.OVERFLOW}),
	alphaVantage:new Bottleneck({maxConcurrent:1,minTime:60*60_000,highWater:1,strategy:Bottleneck.strategy.OVERFLOW}),
};

function fingerprint(key:string){return createHash('sha256').update(key).digest('hex')}
function adapters(keys:MarketProviderKeys):Adapter[]{
	return [
		...(keys.fmpApiKey?[{
			id:'fmp' as const,name:'Financial Modeling Prep',key:keys.fmpApiKey,categories:['STOCK'] as const,historyIntervals:['1d'],
			getQuote:(asset:LiveMarketAsset)=>new FmpMarketProvider({apiKey:keys.fmpApiKey}).getQuote(asset),
			getHistory:(asset:LiveMarketAsset,from:string,to:string)=>new FmpMarketProvider({apiKey:keys.fmpApiKey}).getHistory(asset,from,to),
		}]:[]),
		...(keys.twelveDataApiKey?[{
			id:'twelveData' as const,name:'Twelve Data',key:keys.twelveDataApiKey,categories:['STOCK','FOREX','CRYPTO'] as const,
			getQuote:(asset:LiveMarketAsset)=>new TwelveDataMarketProvider({apiKey:keys.twelveDataApiKey}).getQuote(asset),
			getHistory:(asset:LiveMarketAsset,from:string,to:string,interval:string)=>new TwelveDataMarketProvider({apiKey:keys.twelveDataApiKey}).getHistory(asset,from,to,interval),
		}]:[]),
		...(keys.alphaVantageApiKey?[{
			id:'alphaVantage' as const,name:'Alpha Vantage',key:keys.alphaVantageApiKey,categories:['STOCK'] as const,historyIntervals:['1d'],
			getQuote:(asset:LiveMarketAsset)=>new AlphaVantageMarketProvider({apiKey:keys.alphaVantageApiKey}).getQuote(asset),
			getHistory:(asset:LiveMarketAsset,from:string,to:string)=>new AlphaVantageMarketProvider({apiKey:keys.alphaVantageApiKey}).getHistory(asset,from,to),
		}]:[]),
	];
}

function recordFailure(adapter:Adapter,error:unknown){
	const now=Date.now();
	const errorCode=error&&typeof error==='object'&&'code'in error&&typeof (error as MarketProviderHttpError).code==='string'
		?(error as MarketProviderHttpError).code:'INVALID_PROVIDER_RESPONSE';
	providerHealth.set(adapter.id,{
		fingerprint:fingerprint(adapter.key),status:'ERROR',checkedAt:new Date(now).toISOString(),
		failureUntil:now+30_000,errorCode,
	});
}

function recordSuccess(adapter:Adapter){
	providerHealth.set(adapter.id,{fingerprint:fingerprint(adapter.key),status:'CONNECTED',checkedAt:new Date().toISOString()});
}

function isCircuitOpen(adapter:Adapter){
	const current=providerHealth.get(adapter.id);
	if(!current||current.fingerprint!==fingerprint(adapter.key)||current.status!=='ERROR')return false;
	return (current.failureUntil??0)>Date.now();
}

async function attempt<T>(adapter:Adapter,operation:()=>Promise<T>):Promise<T>{
	try{
		const result=await limiters[adapter.id].schedule(operation);
		recordSuccess(adapter);
		return result;
	}catch(error){
		recordFailure(adapter,error);
		throw error;
	}
}

export async function getConfiguredMarketQuote(asset:LiveMarketAsset,keys:MarketProviderKeys):Promise<MarketQuote|null>{
	const candidates=adapters(keys).filter(adapter=>adapter.categories.includes(asset.type));
	if(!candidates.length)return null;
	if(process.env.NODE_ENV==='production'&&!keys.productionLicenseConfirmed)return null;
	for(const adapter of candidates){
		if(isCircuitOpen(adapter))continue;
		const cacheKey=`${adapter.id}:${fingerprint(adapter.key)}:${asset.id}`;
		const cached=quoteCache.get(cacheKey);
		if(cached)return cached;
		try{
			const pending=attempt(adapter,()=>adapter.getQuote(asset));
			quoteCache.set(cacheKey,pending);
			try{return await pending}catch(error){quoteCache.delete(cacheKey);throw error}
		}catch(error){
			console.warn('[market-data] Provider quote failed.',{provider:adapter.name,symbol:asset.id,errorCode:errorCode(error)});
		}
	}
	return null;
}

export async function getConfiguredMarketHistory(
	asset:LiveMarketAsset,timeframe:TimeframeId,keys:MarketProviderKeys,
):Promise<{candles:MarketCandle[];source:string}|null>{
	const selection=TIMEFRAMES.find(item=>item.id===timeframe)??TIMEFRAMES[0];
	const end=new Date();
	const days:Record<TimeframeId,number>={'1d':1,'1h':1,'5d':5,'1m':31,'3m':92,'ytd':Math.ceil((end.getTime()-Date.UTC(end.getUTCFullYear(),0,1))/86_400_000),'1y':366,'3y':1097,'5y':1827,'max':3650};
	const start=new Date(end.getTime()-days[timeframe]*86_400_000);
	const candidates=adapters(keys).filter(adapter=>adapter.categories.includes(asset.type)&&adapter.getHistory&&(!adapter.historyIntervals||adapter.historyIntervals.includes(selection.interval)));
	if(!candidates.length)return null;
	if(process.env.NODE_ENV==='production'&&!keys.productionLicenseConfirmed)return null;
	for(const adapter of candidates){
		if(isCircuitOpen(adapter))continue;
		const cacheKey=`${adapter.id}:${fingerprint(adapter.key)}:${asset.id}:${timeframe}`;
		const cached=historyCache.get(cacheKey);
		if(cached)return {candles:await cached,source:adapter.name};
		try{
			const pending=attempt(adapter,()=>adapter.getHistory!(asset,start.toISOString(),end.toISOString(),selection.interval));
			historyCache.set(cacheKey,pending);
			let candles:MarketCandle[];
			try{candles=await pending}catch(error){historyCache.delete(cacheKey);throw error}
			if(!candles.length){historyCache.delete(cacheKey);throw new Error('NO_HISTORICAL_DATA')}
			return {candles,source:adapter.name};
		}catch(error){
			console.warn('[market-data] Provider history failed.',{provider:adapter.name,symbol:asset.id,errorCode:errorCode(error)});
		}
	}
	return null;
}

function errorCode(error:unknown){
	return error&&typeof error==='object'&&'code'in error&&typeof (error as MarketProviderHttpError).code==='string'
		?(error as MarketProviderHttpError).code:'INVALID_PROVIDER_RESPONSE';
}

export async function getMarketProviderReadiness(keys:MarketProviderKeys){
	const configured=adapters(keys);
	const byId=new Map(configured.map(adapter=>[adapter.id,adapter]));
	const specs=[
		{id:'fmp' as const,name:'Financial Modeling Prep',variable:'FMP_API_KEY',categories:['STOCK'],rateLimit:'Conservative pacing: one request per 12 seconds.'},
		{id:'twelveData' as const,name:'Twelve Data',variable:'TWELVE_DATA_API_KEY',categories:['STOCK','FOREX','CRYPTO'],rateLimit:'Conservative pacing: one request per 8 seconds.'},
		{id:'alphaVantage' as const,name:'Alpha Vantage',variable:'ALPHA_VANTAGE_API_KEY',categories:['STOCK'],rateLimit:'Conservative pacing: one request per hour.'},
	];
	return Promise.all(specs.map(async spec=>{
		const adapter=byId.get(spec.id);
		if(!adapter)return {...spec,configured:false,status:'NOT_CONFIGURED' as const,checkedAt:null};
		if(process.env.NODE_ENV==='production'&&!keys.productionLicenseConfirmed){
			return {...spec,configured:true,status:'LICENSE_REVIEW_REQUIRED' as const,checkedAt:null};
		}
		const current=providerHealth.get(spec.id);
		if(current?.fingerprint===fingerprint(adapter.key)&&current.status==='CONNECTED'){
			return {...spec,configured:true,status:'CONNECTED' as const,checkedAt:current.checkedAt};
		}
		if(current?.fingerprint===fingerprint(adapter.key)&&current.status==='ERROR'&&(current.failureUntil??0)>Date.now()){
			return {...spec,configured:true,status:'ERROR' as const,checkedAt:current.checkedAt,errorCode:current.errorCode};
		}
		try{
			await attempt(adapter,()=>adapter.getQuote({
				id:'AAPL',ticker:'AAPL',name:'Apple Inc.',type:'STOCK',currency:'USD',
			}));
			return {...spec,configured:true,status:'CONNECTED' as const,checkedAt:providerHealth.get(spec.id)?.checkedAt??new Date().toISOString()};
		}catch(error){
			return {...spec,configured:true,status:'ERROR' as const,checkedAt:providerHealth.get(spec.id)?.checkedAt??new Date().toISOString(),errorCode:errorCode(error)};
		}
	}));
}
