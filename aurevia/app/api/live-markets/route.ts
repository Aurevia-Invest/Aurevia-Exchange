import {NextResponse} from 'next/server';
import {getMarketAsset,MarketDataError} from '@/lib/live-market';
import {getServerConfiguration} from '@/lib/config/env';
import {getAdditionalMarketProviderKeys,getAlpacaMarketDataOptions,getMarketQuoteWithFallback} from '@/lib/market-data-service';
import {isExternalMarketDataSource} from '@/lib/live-market';

export const dynamic='force-dynamic';
export const revalidate=0;

export async function GET(request:Request){
  const parameters=new URL(request.url).searchParams;
  const requested=(parameters.get('symbols')||'DJI,SPX,NASDAQ,SP100,NDX,DAX,IBEX,NIKKEI,BTC,EURGBP').split(',').map(value=>value.trim().toUpperCase()).filter(Boolean).slice(0,20);
  const assets=requested.map(getMarketAsset).filter((asset):asset is NonNullable<typeof asset>=>!!asset);
  if(!assets.length)return NextResponse.json({quotes:[],source:'Unavailable',marketDataStatus:'UNAVAILABLE'},{headers:{'Cache-Control':'public, s-maxage=5, stale-while-revalidate=10'}});
  const config=getServerConfiguration();
  const apiKey=config.marketData.finnhubApiKey;
  const alpacaData=getAlpacaMarketDataOptions(config.execution);
  const additionalProviders=getAdditionalMarketProviderKeys(config.marketData);
  const quotes=await Promise.all(assets.map(async asset=>{
    try{return await getMarketQuoteWithFallback(asset,apiKey,alpacaData,additionalProviders)}
    catch(error){return {asset,error:error instanceof MarketDataError?error.message:'Live quote unavailable.'}}
  }));
  const sources=[...new Set(quotes.flatMap(quote=>'source'in quote?[quote.source]:[]))];
  const hasInternal=quotes.some(quote=>'source'in quote&&quote.source==='Aurevia Internal');
  const hasLive=quotes.some(quote=>'source'in quote&&isExternalMarketDataSource(quote.source));
  const source=sources.length===1?sources[0]:sources.length?`Mixed providers: ${sources.join(', ')}`:'Unavailable';
  const marketDataStatus=hasInternal&&!hasLive?'INTERNAL':hasLive&&hasInternal?'PARTIAL':quotes.length>0&&quotes.every(quote=>'source'in quote&&!quote.isStale)?'LIVE':sources.length?'PARTIAL':'UNAVAILABLE';
  return NextResponse.json({quotes,source,marketDataStatus}, {headers:{'Cache-Control':'public, s-maxage=5, stale-while-revalidate=10'}});
}