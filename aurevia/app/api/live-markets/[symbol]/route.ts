import {NextResponse} from 'next/server';
import {getMarketAsset,MarketDataError,TIMEFRAMES,type TimeframeId} from '@/lib/live-market';
import {getServerConfiguration} from '@/lib/config/env';
import {getAlpacaMarketDataOptions,getMarketHistoryWithFallback} from '@/lib/market-data-service';

export const dynamic='force-dynamic';
export const revalidate=0;

export async function GET(request:Request,{params}:{params:Promise<{symbol:string}>}){
  const {symbol}=await params;
  const asset=getMarketAsset(decodeURIComponent(symbol));
  if(!asset)return NextResponse.json({error:'Unsupported market symbol.'},{status:404});
  const requested=new URL(request.url).searchParams.get('timeframe')||'1d';
  if(!TIMEFRAMES.some(timeframe=>timeframe.id===requested))return NextResponse.json({error:'Unsupported timeframe.'},{status:400});
  try{
    const config=getServerConfiguration();
    const history=await getMarketHistoryWithFallback(asset,requested as TimeframeId,config.marketData.finnhubApiKey,getAlpacaMarketDataOptions(config.execution));
    return NextResponse.json(history,{headers:{'Cache-Control':'public, s-maxage=15, stale-while-revalidate=30'}});
  }catch(error){
    const status=error instanceof MarketDataError?error.status:502;
    return NextResponse.json({
      error:error instanceof Error?error.message:'Historical market data is unavailable.',
      ...(error instanceof MarketDataError&&error.diagnostics?{diagnostics:error.diagnostics}:{}),
    },{status,headers:{'Cache-Control':'private, no-store'}});
  }
}