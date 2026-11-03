import {Prisma} from '@prisma/client';
import {db} from '@/lib/db';
import type {LiveMarketAsset,MarketCandle,MarketQuote,TimeframeId} from '@/lib/live-market';

const referencePrices:Record<string,number>={
	DJI:42_000,SPX:5_800,NASDAQ:18_500,SP100:3_400,NDX:20_000,DAX:19_000,IBEX:11_800,
	NIKKEI:39_000,MERV:1_900_000,EURGBP:0.84,BTC:95_000,AAPL:230,MSFT:510,NVDA:140,
	AMZN:220,GOOGL:190,TSLA:340,
};

const instrumentSymbols:Record<string,string[]>={
	BTC:['BTC/USD'],EURGBP:['EUR/GBP'],DJI:['DJI'],SPX:['SPX'],NASDAQ:['NASDAQ'],SP100:['SP100'],NDX:['NDX'],
	DAX:['DAX'],IBEX:['IBEX'],NIKKEI:['NIKKEI'],MERV:['MERV'],AAPL:['AAPL'],MSFT:['MSFT'],
	NVDA:['NVDA'],AMZN:['AMZN'],GOOGL:['GOOGL'],TSLA:['TSLA'],
};

export function getInternalInstrumentSymbols(assetId:string){
	return instrumentSymbols[assetId.toUpperCase()]||[];
}

const timeframeDays:Record<TimeframeId,number>={'1d':1,'1h':1,'5d':5,'1m':30,'3m':90,'ytd':365,'1y':365,'3y':1095,'5y':1825,'max':3650};
const timeframeIntervals:Record<TimeframeId,string>={'1d':'30m','1h':'1h','5d':'2h','1m':'12h','3m':'1d','ytd':'1d','1y':'1d','3y':'1w','5y':'1w','max':'1mo'};

function hash(value:string){
	let result=2166136261;
	for(const character of value){result^=character.charCodeAt(0);result=Math.imul(result,16777619);}
	return result>>>0;
}

function internalPriceAt(asset:LiveMarketAsset,base:number,time:number){
	const phase=(hash(asset.id)%10_000)/10_000*Math.PI*2;
	const shortWave=Math.sin(time/1_800_000+phase)*0.0015;
	const longWave=Math.sin(time/43_200_000+phase/2)*0.004;
	return base*(1+shortWave+longWave);
}

async function currentInternalPrice(asset:LiveMarketAsset,now:number){
	const symbols=instrumentSymbols[asset.id]||[];
	const reference=referencePrices[asset.id];
	if(!Number.isFinite(reference)||reference<=0)throw new Error(`Internal market price is unavailable for ${asset.id}.`);
	const dayStart=Math.floor(now/86_400_000)*86_400_000;
	let instrument:null|{id:string;price: string | number | Prisma.Decimal | null} = null;
	if(symbols.length){
		try{
			instrument=await db.instrument.findFirst({
				where:{symbol:{in:symbols},enabled:true},
				orderBy:{updatedAt:'desc'},
				select:{id:true,price:true},
			});
		}catch{
			instrument=null;
		}
	}
	const referenceFallback=()=>({
		price:internalPriceAt(asset,reference,now),
		reference,
		open:internalPriceAt(asset,reference,dayStart),
	});
	if(!instrument)return referenceFallback();
	const price=instrument.price instanceof Prisma.Decimal?instrument.price.toNumber():Number(instrument.price);
	if(!Number.isFinite(price)||price<=0)return referenceFallback();
	let dayOpen:null|{open:string|number|Prisma.Decimal|null} = null;
	try{
		dayOpen=await db.candle.findFirst({
			where:{instrumentId:instrument.id,ts:{gte:new Date(dayStart)}},
			orderBy:{ts:'asc'},
			select:{open:true},
		});
	}catch{
		dayOpen=null;
	}
	const openValue=dayOpen&&dayOpen.open instanceof Prisma.Decimal?dayOpen.open.toNumber():Number(dayOpen?.open ?? price);
	return {price,reference:price,open:Number.isFinite(openValue)&&openValue>0?openValue:price};
}

export async function getInternalMarketQuote(asset:LiveMarketAsset):Promise<MarketQuote>{
	const now=Date.now();
	const current=await currentInternalPrice(asset,now);
	return buildInternalMarketQuote(asset,current.price,current.reference,current.open,now);
}

function buildInternalMarketQuote(asset:LiveMarketAsset,price:number,reference:number,open:number,now:number):MarketQuote{
	const previousClose=open;
	const change=price-previousClose;
	const sparkline=Array.from({length:28},(_,index)=>internalPriceAt(asset,reference,now-(27-index)*300_000));
	const recent=[...sparkline.slice(-12),price];
	return {
		asset,price,change,changePercent:change/previousClose*100,previousClose,
		open,
		volume:null,
		dayLow:Math.min(...recent),dayHigh:Math.max(...recent),fiftyTwoWeekLow:reference*0.82,
		fiftyTwoWeekHigh:reference*1.18,updatedAt:new Date(now).toISOString(),isStale:false,
		sparkline,source:'Aurevia Internal',
	};
}

function referenceMarketQuote(asset:LiveMarketAsset,now:number):MarketQuote{
	const reference=referencePrices[asset.id];
	if(!Number.isFinite(reference)||reference<=0)throw new Error(`Internal market price is unavailable for ${asset.id}.`);
	const dayStart=Math.floor(now/86_400_000)*86_400_000;
	return buildInternalMarketQuote(
		asset,
		internalPriceAt(asset,reference,now),
		reference,
		internalPriceAt(asset,reference,dayStart),
		now,
	);
}

function marketHistoryFromQuote(asset:LiveMarketAsset,timeframe:TimeframeId,quote:MarketQuote){
	const now=Math.floor(Date.now()/1000);
	const span=timeframeDays[timeframe]*86_400;
	const step=span/239;
	const candles:MarketCandle[]=Array.from({length:240},(_,index)=>{
		const time=Math.floor(now-span+step*index);
		const center=internalPriceAt(asset,quote.price,(now-span+step*index)*1000);
		const next=internalPriceAt(asset,quote.price,(now-span+step*(index+1))*1000);
		const open=index?internalPriceAt(asset,quote.price,(now-span+step*(index-1))*1000):center;
		const close=index===239?quote.price:next;
		return {time,open,high:Math.max(open,close)*1.0008,low:Math.min(open,close)*0.9992,close,volume:null};
	});
	return {quote,candles,timeframe,interval:timeframeIntervals[timeframe],source:'Aurevia Internal'};
}

export async function getInternalMarketHistory(asset:LiveMarketAsset,timeframe:TimeframeId){
	const quote=await getInternalMarketQuote(asset);
	return marketHistoryFromQuote(asset,timeframe,quote);
}

export function getReferenceMarketHistory(asset:LiveMarketAsset,timeframe:TimeframeId){
	const quote=referenceMarketQuote(asset,Date.now());
	return marketHistoryFromQuote(asset,timeframe,quote);
}
