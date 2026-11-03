import type {LiveMarketAsset,MarketCandle,MarketQuote} from '../live-market';
import {readMarketProviderErrorDetails,sanitizeMarketProviderErrorDetails,type MarketProviderErrorDetails} from './market-data-error';

export class FinnhubMarketDataError extends Error {
	constructor(
		message:string,
		readonly status=502,
		readonly providerHttpStatus=status,
		readonly providerCode?:string,
		readonly providerMessage?:string,
		readonly providerEndpoint='/api/v1/stock/candle',
	){super(message);this.name='FinnhubMarketDataError';}
}

function providerSymbol(asset:LiveMarketAsset){
	if(asset.type==='FOREX'){
		const pair=asset.ticker.replace(/=X$/,'');
		return `OANDA:${pair.slice(0,3)}_${pair.slice(3,6)}`;
	}
	if(asset.type==='CRYPTO'){
		const base=asset.ticker.split('-')[0];
		return `BINANCE:${base}USDT`;
	}
	return asset.ticker;
}

async function request(path:string,apiKey:string,fetcher:typeof fetch){
	for(let attempt=0;attempt<2;attempt++){
		let response:Response;
		try{response=await fetcher(`https://finnhub.io/api/v1/${path}`,{headers:{'X-Finnhub-Token':apiKey},cache:'no-store',signal:AbortSignal.timeout(8000)});}
		catch(error){
			if(attempt===0){await new Promise(resolve=>setTimeout(resolve,250));continue}
			throw new FinnhubMarketDataError(
				'Finnhub is unreachable.',
				503,
				undefined,
				error instanceof Error&&error.name==='TimeoutError'?'PROVIDER_TIMEOUT':'NETWORK_ERROR',
				undefined,
				endpointPath(path),
			);
		}
		if((response.status===429||response.status>=500)&&attempt===0){
			const retryAfter=Number(response.headers.get('retry-after'));
			await new Promise(resolve=>setTimeout(resolve,Number.isFinite(retryAfter)?Math.max(0,Math.min(retryAfter*1000,1_000)):250));
			continue;
		}
		if(!response.ok){
			const details:MarketProviderErrorDetails=await readMarketProviderErrorDetails(response);
			throw new FinnhubMarketDataError(
				response.status===429?'Finnhub is rate limited.':'Finnhub request failed.',
				response.status,
				response.status,
				details.providerCode,
				details.providerMessage,
				endpointPath(path),
			);
		}
		try{return await response.json() as Record<string,unknown>;}
		catch{throw new FinnhubMarketDataError('Finnhub returned invalid data.',502,response.status,'INVALID_JSON',undefined,endpointPath(path));}
	}
	throw new FinnhubMarketDataError('Finnhub is unreachable.',503,undefined,'NETWORK_ERROR',undefined,endpointPath(path));
}

function finite(value:unknown){return typeof value==='number'&&Number.isFinite(value)?value:null;}

function endpointPath(path:string){
	const clean=path.split('?')[0];
	return clean.startsWith('/')?clean:`/api/v1/${clean}`;
}

export async function getFinnhubQuote(asset:LiveMarketAsset,apiKey:string,fetcher:typeof fetch=fetch):Promise<MarketQuote>{
	const symbol=providerSymbol(asset);
	const query=new URLSearchParams({symbol});
	const data=await request(`quote?${query}`,apiKey,fetcher);
	const price=finite(data.c);
	if(price===null||price<=0)throw new FinnhubMarketDataError(`Finnhub has no current quote for ${asset.id}.`,503);
	const previousClose=finite(data.pc);
	const change=finite(data.d);
	const changePercent=finite(data.dp);
	const asOf=finite(data.t);
	if(change===null||changePercent===null||asOf===null||asOf<=0)throw new FinnhubMarketDataError(`Finnhub quote data is incomplete for ${asset.id}.`,502);
	return {
		asset,price,change,changePercent,previousClose,open:finite(data.o),volume:null,
		dayLow:finite(data.l),dayHigh:finite(data.h),fiftyTwoWeekLow:null,fiftyTwoWeekHigh:null,
		marketStatus:asset.type==='CRYPTO'?'OPEN':'UNKNOWN',
		updatedAt:new Date(asOf*1000).toISOString(),isStale:false,sparkline:[],source:'Finnhub',
	};
}

const resolutionByInterval:Record<string,string>={'1m':'1','5m':'5','15m':'15','30m':'30','1h':'60','1d':'D','1wk':'W','1mo':'M'};
const daysByRange:Record<string,number>={'1d':1,'5d':5,'1mo':31,'3mo':92,'1y':365,'3y':1096,'5y':1826,max:3650};

export async function getFinnhubHistory(asset:LiveMarketAsset,range:string,interval:string,apiKey:string,fetcher:typeof fetch=fetch){
	const now=Math.floor(Date.now()/1000);
	const start=range==='ytd'?Date.UTC(new Date().getUTCFullYear(),0,1)/1000:now-(daysByRange[range]??1)*86400;
	const symbol=providerSymbol(asset);
	const query=new URLSearchParams({symbol,resolution:resolutionByInterval[interval]??'D',from:String(Math.floor(start)),to:String(now)});
	const data=await request(`stock/candle?${query}`,apiKey,fetcher);
	if(data.s!=='ok'||!Array.isArray(data.t)||!Array.isArray(data.o)||!Array.isArray(data.h)||!Array.isArray(data.l)||!Array.isArray(data.c)){
		const details=sanitizeMarketProviderErrorDetails({code:data.s,message:data.error});
		throw new FinnhubMarketDataError(`Finnhub has no historical data for ${asset.id}.`,503,200,details.providerCode||'INVALID_CANDLE_RESPONSE',details.providerMessage,'/api/v1/stock/candle');
	}
	const candles:MarketCandle[]=[];
	for(let i=0;i<data.t.length;i++){
		const time=finite(data.t[i]),open=finite(data.o[i]),high=finite(data.h[i]),low=finite(data.l[i]),close=finite(data.c[i]);
		if(time===null||open===null||high===null||low===null||close===null||open<=0||high<=0||low<=0||close<=0)continue;
		const volume=Array.isArray(data.v)?finite(data.v[i]):null;
		candles.push({time,open,high,low,close,volume});
	}
	if(!candles.length)throw new FinnhubMarketDataError(`Finnhub has no valid historical data for ${asset.id}.`,503);
	return {quote:null,candles,source:'Finnhub'};
}