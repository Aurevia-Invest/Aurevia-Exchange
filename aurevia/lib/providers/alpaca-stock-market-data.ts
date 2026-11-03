import {readMarketProviderErrorDetails,type MarketProviderErrorDetails} from './market-data-error';

export type AlpacaStockDataOptions={apiKey:string;apiSecret:string;fetcher?:typeof fetch};

type AlpacaQuote={bp?:number;ap?:number;t?:string};
type AlpacaTrade={p?:number;t?:string};
type AlpacaBar={t?:string;o?:number;h?:number;l?:number;c?:number;v?:number};

export type AlpacaStockQuote={
	symbol:string;price:number;bid:number|null;ask:number|null;previousClose:number|null;
	open:number|null;high:number|null;low:number|null;volume:number|null;updatedAt:string;
};

export type AlpacaStockBar={time:string;open:number;high:number;low:number;close:number;volume:number|null};
export type AlpacaStockBarTimeframe='1Min'|'5Min'|'15Min'|'1Hour'|'1Day';

export class AlpacaStockMarketDataError extends Error{
	readonly provider='Alpaca';
	constructor(
		message:string,
		readonly httpStatus?:number,
		readonly providerCode?:string,
		readonly providerMessage?:string,
		readonly providerEndpoint='/v2/stocks/{symbol}/bars',
	){
		super(message);
		this.name='AlpacaStockMarketDataError';
	}
}

const retryDelayMs=250;
const maxRetries=1;

function retryAfterMs(response:Response){
	const value=response.headers.get('retry-after');
	if(!value)return retryDelayMs;
	const seconds=Number(value);
	const delay=Number.isFinite(seconds)?seconds*1000:Date.parse(value)-Date.now();
	return Math.max(0,Math.min(Number.isFinite(delay)?delay:retryDelayMs,1_000));
}

function wait(ms:number){return new Promise(resolve=>setTimeout(resolve,ms))}

function isRecord(value:unknown):value is Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value)}
function finite(value:unknown):number|null{return typeof value==='number'&&Number.isFinite(value)?value:null}
function asTimestamp(value:unknown):string|null{if(typeof value!=='string')return null;const time=Date.parse(value);return Number.isFinite(time)?new Date(time).toISOString():null}

export class AlpacaStockMarketDataProvider{
	readonly name='Alpaca';
	private readonly options:AlpacaStockDataOptions;
	constructor(options:AlpacaStockDataOptions){this.options=options}

	async getQuote(symbol:string):Promise<AlpacaStockQuote>{
		const encoded=encodeURIComponent(symbol.toUpperCase());
		const [quotePayload,tradePayload,barsPayload]=await Promise.all([
			this.request(`/v2/stocks/${encoded}/quotes/latest?feed=iex`),
			this.request(`/v2/stocks/${encoded}/trades/latest?feed=iex`),
			this.request(`/v2/stocks/${encoded}/bars?timeframe=1Day&limit=2&feed=iex`),
		]);
		const quote=isRecord(quotePayload)&&isRecord(quotePayload.quote)?quotePayload.quote as AlpacaQuote:null;
		const trade=isRecord(tradePayload)&&isRecord(tradePayload.trade)?tradePayload.trade as AlpacaTrade:null;
		const bars=isRecord(barsPayload)&&Array.isArray(barsPayload.bars)?barsPayload.bars as AlpacaBar[]:[];
		const latest=bars.at(-1);
		const previous=bars.length>1?bars.at(-2):undefined;
		const price=finite(trade?.p);
		const updatedAt=asTimestamp(trade?.t);
		if(price===null||price<=0||!updatedAt)throw new Error('ALPACA_STOCK_MARKET_DATA_INVALID_TRADE');
		return {
			symbol:symbol.toUpperCase(),price,bid:finite(quote?.bp),ask:finite(quote?.ap),
			previousClose:finite(previous?.c),open:finite(latest?.o),high:finite(latest?.h),low:finite(latest?.l),
			volume:finite(latest?.v),updatedAt,
		};
	}

	async getBars(symbol:string,start:string,end:string,timeframe:AlpacaStockBarTimeframe):Promise<AlpacaStockBar[]>{
		const encoded=encodeURIComponent(symbol.toUpperCase());
		const result:AlpacaStockBar[]=[];
		let pageToken:string|undefined;
		for(let page=0;page<25;page++){
			const params=new URLSearchParams({start,end,timeframe,feed:'iex',limit:'1000',sort:'asc'});
			if(pageToken)params.set('page_token',pageToken);
			const barsPayload=await this.request(`/v2/stocks/${encoded}/bars?${params}`);
			if(!isRecord(barsPayload)||!Array.isArray(barsPayload.bars))throw new Error('ALPACA_STOCK_MARKET_DATA_INVALID_BARS');
			result.push(...(barsPayload.bars as AlpacaBar[]).flatMap(bar=>{
				const time=asTimestamp(bar.t),open=finite(bar.o),high=finite(bar.h),low=finite(bar.l),close=finite(bar.c);
				if(!time||open===null||high===null||low===null||close===null)return [];
				return [{time,open,high,low,close,volume:finite(bar.v)}];
			}));
			const nextToken=barsPayload.next_page_token;
			if(typeof nextToken!=='string'||!nextToken)break;
			pageToken=nextToken;
		}
		if(!result.length){
			throw new AlpacaStockMarketDataError(
				'ALPACA_STOCK_MARKET_DATA_NO_BARS',
				200,
				'NO_DATA',
			);
		}
		return result;
	}

	async healthCheck(){
		await this.getQuote('AAPL');
		return {connected:true,checkedAt:new Date().toISOString()};
	}

	private async request(path:string):Promise<unknown>{
		for(let attempt=0;attempt<=maxRetries;attempt++){
			let response:Response;
			try{
				response=await (this.options.fetcher??fetch)(`https://data.alpaca.markets${path}`,{
					headers:{'APCA-API-KEY-ID':this.options.apiKey,'APCA-API-SECRET-KEY':this.options.apiSecret},
					signal:AbortSignal.timeout(10_000),
				});
			}catch{
				if(attempt<maxRetries){await wait(retryDelayMs);continue}
				throw new AlpacaStockMarketDataError(
					'ALPACA_STOCK_MARKET_DATA_UNAVAILABLE',
					undefined,
					'NETWORK_OR_TIMEOUT',
					undefined,
					path.split('?')[0],
				);
			}
			if((response.status===429||response.status>=500)&&attempt<maxRetries){
				await wait(retryAfterMs(response));
				continue;
			}
			if(!response.ok){
				const details:MarketProviderErrorDetails=await readMarketProviderErrorDetails(response);
				throw new AlpacaStockMarketDataError(
					`ALPACA_STOCK_MARKET_DATA_ERROR:${response.status}`,
					response.status,
					details.providerCode,
					details.providerMessage,
					path.split('?')[0],
				);
			}
			try{return await response.json() as unknown}catch{
				throw new AlpacaStockMarketDataError(
					'ALPACA_STOCK_MARKET_DATA_INVALID_RESPONSE',
					response.status,
					'INVALID_JSON',
					undefined,
					path.split('?')[0],
				);
			}
		}
		throw new AlpacaStockMarketDataError(
			'ALPACA_STOCK_MARKET_DATA_UNAVAILABLE',
			undefined,
			'NETWORK_OR_TIMEOUT',
			undefined,
			path.split('?')[0],
		);
	}
}