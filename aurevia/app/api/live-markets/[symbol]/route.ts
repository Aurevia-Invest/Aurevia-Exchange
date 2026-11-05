import {NextResponse} from 'next/server';
import {getMarketAsset,MarketDataError,TIMEFRAMES,type MarketHistoryDiagnostics,type TimeframeId} from '@/lib/live-market';
import {getServerConfiguration} from '@/lib/config/env';
import {getAdditionalMarketProviderKeys,getAlpacaMarketDataOptions,getMarketHistoryWithFallback} from '@/lib/market-data-service';

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
    const history=await getMarketHistoryWithFallback(asset,requested as TimeframeId,config.marketData.finnhubApiKey,getAlpacaMarketDataOptions(config.execution),getAdditionalMarketProviderKeys(config.marketData));
    return NextResponse.json(history,{headers:{'Cache-Control':'public, s-maxage=15, stale-while-revalidate=30'}});
  }catch(error){
    const status=error instanceof MarketDataError?error.status:502;
    const diagnostics=error instanceof MarketDataError?error.diagnostics:undefined;
    return NextResponse.json({
      error:historyFailureMessage(diagnostics),
      code:'MARKET_HISTORY_UNAVAILABLE',
      ...(diagnostics?{diagnostics}:{}),
    },{status,headers:{'Cache-Control':'private, no-store'}});
  }
}

function historyFailureMessage(diagnostics?:MarketHistoryDiagnostics){
	const failures=[diagnostics?.alpaca,diagnostics?.finnhub].filter(item=>item?.status==='failed');
	if(failures.some(item=>item?.httpStatus===401||item?.httpStatus===403)){
		return 'Historical market data is unavailable because a configured provider rejected access. Please contact support.';
	}
	if(failures.some(item=>item?.reason==='rate_limited')){
		return 'Historical market data is temporarily rate-limited. Please try again shortly.';
	}
	if(failures.length&&failures.every(item=>item?.reason==='no_data')){
		return 'No historical candles are available from the configured providers for this symbol and timeframe.';
	}
	return 'Historical market data is temporarily unavailable. Please try again shortly.';
}