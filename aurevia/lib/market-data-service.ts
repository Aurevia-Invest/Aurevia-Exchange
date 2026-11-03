import {getMarketHistory,getMarketQuote,MarketDataError,type LiveMarketAsset,type TimeframeId} from '@/lib/live-market';
import {getInternalMarketHistory,getInternalMarketQuote,getReferenceMarketHistory} from '@/lib/internal-market-data';
import type {ServerConfiguration} from '@/lib/config/env';
import type {AlpacaStockDataOptions} from '@/lib/providers/alpaca-stock-market-data';

export function getAlpacaMarketDataOptions(execution:ServerConfiguration['execution']):AlpacaStockDataOptions|undefined{
	if(!execution.alpacaTradingConfigured)return undefined;
	return {apiKey:execution.alpacaTradingApiKey,apiSecret:execution.alpacaTradingApiSecret};
}

export async function getMarketQuoteWithFallback(asset:LiveMarketAsset,apiKey:string,alpacaData?:AlpacaStockDataOptions){
	try{
		return await getMarketQuote(asset,apiKey,alpacaData);
	}
	catch(error){
		console.warn(`Configured market quote providers are unavailable (${error instanceof Error?error.name:'UnknownError'}).`);
		return getInternalMarketQuote(asset);
	}
}

export async function getMarketHistoryWithFallback(asset:LiveMarketAsset,timeframe:TimeframeId,apiKey:string,alpacaData?:AlpacaStockDataOptions){
	try{
		return await getMarketHistory(asset,timeframe,apiKey,alpacaData);
	}catch(error){
		console.warn('Configured market history providers failed.',{
			symbol:asset.id,
			stage:'history-lookup',
			errorName:error instanceof Error?error.name:'UnknownError',
			...(error instanceof MarketDataError&&error.diagnostics?{providerDiagnostics:error.diagnostics}:{}),
			failureTimestamp:new Date().toISOString(),
		});
		if(asset.type==='STOCK'&&(Boolean(apiKey)||Boolean(alpacaData?.apiKey&&alpacaData.apiSecret)))throw error;
		try{
			return await getInternalMarketHistory(asset,timeframe);
		}catch(fallbackError){
			console.warn(`Database-backed market history fallback failed (${fallbackError instanceof Error?fallbackError.name:'UnknownError'}); using reference history.`);
			return getReferenceMarketHistory(asset,timeframe);
		}
	}
}
