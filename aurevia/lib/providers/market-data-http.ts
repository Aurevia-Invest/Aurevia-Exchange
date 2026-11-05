import pRetry from 'p-retry';

export class MarketProviderHttpError extends Error{
	constructor(readonly provider:string,readonly status:number|undefined,readonly code:string){
		super(`${provider} market-data request failed.`);
		this.name='MarketProviderHttpError';
	}
}

export async function requestMarketProviderJson(
	provider:string,
	url:string,
	fetcher:typeof fetch=fetch,
	headers:Record<string,string>={},
){
	return pRetry(async()=>{
		let response:Response;
		try{
			response=await fetcher(url,{headers,cache:'no-store',signal:AbortSignal.timeout(10_000)});
		}catch{
			throw new MarketProviderHttpError(provider,undefined,'NETWORK_OR_TIMEOUT');
		}
		if(!response.ok)throw new MarketProviderHttpError(provider,response.status,response.status===429?'RATE_LIMITED':'HTTP_ERROR');
		let payload:unknown;
		try{payload=await response.json()}catch{throw new MarketProviderHttpError(provider,response.status,'INVALID_JSON')}
		if(!payload||typeof payload!=='object')throw new MarketProviderHttpError(provider,response.status,'INVALID_RESPONSE');
		return payload as Record<string,unknown>;
	},{
		retries:1,
		minTimeout:250,
		maxTimeout:1_000,
		shouldRetry:({error})=>error instanceof MarketProviderHttpError&&(
			error.status===undefined||error.status===429||error.status>=500
		),
	});
}

export function finiteNumber(value:unknown){
	if(typeof value==='number'&&Number.isFinite(value))return value;
	if(typeof value==='string'&&value.trim()!==''){
		const parsed=Number(value.replace(/%$/,''));
		if(Number.isFinite(parsed))return parsed;
	}
	return null;
}

export function normalizedTimestamp(value:unknown){
	if(typeof value==='number'&&Number.isFinite(value))return new Date(value>10_000_000_000?value:value*1000).toISOString();
	if(typeof value==='string'){
		const timestamp=Date.parse(value);
		if(Number.isFinite(timestamp))return new Date(timestamp).toISOString();
	}
	return new Date().toISOString();
}

export function candlesFromRows(rows:unknown,keys:{time:string;open:string;high:string;low:string;close:string;volume:string}){
	if(!Array.isArray(rows))return [];
	return rows.flatMap(row=>{
		if(!row||typeof row!=='object')return [];
		const values=row as Record<string,unknown>;
		const time=Date.parse(String(values[keys.time]??''));
		const open=finiteNumber(values[keys.open]),high=finiteNumber(values[keys.high]);
		const low=finiteNumber(values[keys.low]),close=finiteNumber(values[keys.close]);
		if(!Number.isFinite(time)||open===null||high===null||low===null||close===null||open<=0||high<=0||low<=0||close<=0)return [];
		return [{time:Math.floor(time/1000),open,high,low,close,volume:finiteNumber(values[keys.volume])}];
	});
}
