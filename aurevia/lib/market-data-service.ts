import {getMarketHistory,getMarketQuote,MarketDataError,TIMEFRAMES,type LiveMarketAsset,type TimeframeId} from '@/lib/live-market';
import {getInternalMarketHistory,getInternalMarketQuote,getReferenceMarketHistory} from '@/lib/internal-market-data';
import type {ServerConfiguration} from '@/lib/config/env';
import type {AlpacaStockDataOptions} from '@/lib/providers/alpaca-stock-market-data';
import {getConfiguredMarketHistory,getConfiguredMarketQuote,type MarketProviderKeys} from '@/lib/market-data/provider-manager';

export function getAlpacaMarketDataOptions(execution:ServerConfiguration['execution']):AlpacaStockDataOptions|undefined{
	if(!execution.alpacaTradingConfigured)return undefined;
	return {apiKey:execution.alpacaTradingApiKey,apiSecret:execution.alpacaTradingApiSecret};
}

export function getAdditionalMarketProviderKeys(marketData:ServerConfiguration['marketData']):MarketProviderKeys{
	return {
		twelveDataApiKey:marketData.twelveDataApiKey||'',
		alphaVantageApiKey:marketData.alphaVantageApiKey||'',
		fmpApiKey:marketData.fmpApiKey||'',
		productionLicenseConfirmed:marketData.productionLicenseConfirmed===true,
	};
}

export async function getMarketQuoteWithFallback(asset:LiveMarketAsset,apiKey:string,alpacaData?:AlpacaStockDataOptions,additionalProviders?:MarketProviderKeys){
	try{
		const existing=await getMarketQuote(asset,apiKey,alpacaData);
		if(additionalProviders&&(existing.source==='Aurevia Internal'||existing.isStale)){
			const providerQuote=await getConfiguredMarketQuote(asset,additionalProviders);
			if(providerQuote)return providerQuote;
		}
		return existing;
	}
	catch(error){
		console.warn(`Configured market quote providers are unavailable (${error instanceof Error?error.name:'UnknownError'}).`);
		if(additionalProviders){
			try{
				const providerQuote=await getConfiguredMarketQuote(asset,additionalProviders);
				if(providerQuote)return providerQuote;
			}catch(providerError){
				console.warn(`Additional market-data providers are unavailable (${providerError instanceof Error?providerError.name:'UnknownError'}).`);
			}
		}
		return getInternalMarketQuote(asset);
	}
}

export async function getMarketHistoryWithFallback(asset:LiveMarketAsset,timeframe:TimeframeId,apiKey:string,alpacaData?:AlpacaStockDataOptions,additionalProviders?:MarketProviderKeys){
	let existingHistory:Awaited<ReturnType<typeof getMarketHistory>>|undefined;
	let existingError:unknown;
	try{
		existingHistory=await getMarketHistory(asset,timeframe,apiKey,alpacaData);
	}catch(error){
		existingError=error;
	}
	if(additionalProviders){
		try{
			const providerHistory=await getConfiguredMarketHistory(asset,timeframe,additionalProviders);
			if(providerHistory){
				const selected=TIMEFRAMES.find(item=>item.id===timeframe)??TIMEFRAMES[0];
				return {quote:null,candles:providerHistory.candles,timeframe,interval:selected.interval,source:providerHistory.source};
			}
		}catch(error){
			console.warn('[market-history] Additional providers failed.',{symbol:asset.id,errorName:error instanceof Error?error.name:'UnknownError'});
		}
	}
	if(existingHistory&&existingHistory.source!=='Aurevia Internal')return existingHistory;
	if(existingError){
		const error=existingError;
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
	if(existingHistory)return existingHistory;
	return getInternalMarketHistory(asset,timeframe);
}
