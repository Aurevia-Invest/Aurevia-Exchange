import {NextResponse} from 'next/server';
import {requireAdmin} from '@/lib/auth';
import {getLiveMarketProviderStatus,getMarketAsset,getMarketHistory,isExternalMarketDataSource,MarketDataError} from '@/lib/live-market';
import {getAlpacaMarketDataOptions} from '@/lib/market-data-service';
import {getServerConfiguration} from '@/lib/config/env';
import {getInternalSimulationHealth} from '@/lib/providers/simulation-health';
import {getAlpacaPaperAccountHealth} from '@/lib/providers/alpaca-crypto-provider';
import {getAdditionalMarketProviderKeys} from '@/lib/market-data-service';
import {getMarketProviderReadiness} from '@/lib/market-data/provider-manager';

export const dynamic='force-dynamic';

async function historicalDataHealth(finnhubApiKey:string,alpacaData:ReturnType<typeof getAlpacaMarketDataOptions>){
	const asset=getMarketAsset('AAPL')!;
	const configured=!!finnhubApiKey||!!alpacaData?.apiKey&&!!alpacaData.apiSecret;
	try{
		const history=await getMarketHistory(asset,'1d',finnhubApiKey,alpacaData);
		const external=isExternalMarketDataSource(history.source);
		return {
			status:external?'AVAILABLE':'NO_EXTERNAL_PROVIDER_CONFIGURED',
			symbol:asset.id,
			timeframe:'1d',
			provider:external?history.source:null,
			diagnostics:('diagnostics'in history&&history.diagnostics)?history.diagnostics:{
				selectedProvider:external?history.source:'Aurevia Internal',
				alpaca:{status:alpacaData?'skipped':'not_configured',...(alpacaData?{reason:'not_required'}:{reason:'credentials_missing'})},
				finnhub:{status:finnhubApiKey?'skipped':'not_configured',...(finnhubApiKey?{reason:'not_required'}:{reason:'credentials_missing'})},
			},
		};
	}catch(error){
		return {
			status:'UNAVAILABLE',
			symbol:asset.id,
			timeframe:'1d',
			provider:null,
			diagnostics:error instanceof MarketDataError?error.diagnostics:{
				selectedProvider:'none',
				alpaca:{status:alpacaData?'failed':'not_configured',reason:configured?'provider_error':'credentials_missing'},
				finnhub:{status:finnhubApiKey?'failed':'not_configured',reason:configured?'provider_error':'credentials_missing'},
			},
		};
	}
}

export async function GET(){
	try{
		await requireAdmin();
		const configuration=getServerConfiguration();
		const alpacaData=getAlpacaMarketDataOptions(configuration.execution);
		const [health,marketProvider,alpacaPaperAccount,historicalData,additionalProviders]=await Promise.all([
			getInternalSimulationHealth(true),
			getLiveMarketProviderStatus(configuration.marketData.finnhubApiKey,alpacaData),
			getAlpacaPaperAccountHealth(),
			historicalDataHealth(configuration.marketData.finnhubApiKey,alpacaData),
			getMarketProviderReadiness(getAdditionalMarketProviderKeys(configuration.marketData)),
		]);
		return NextResponse.json({
			checkedAt:health.checkedAt,
			internalSimulation:health,
			alpacaPaperAccount,
			marketData:{
				status:marketProvider.status,
				provider:marketProvider.provider,
				finnhubStatus:marketProvider.finnhubStatus,
				alpacaStatus:marketProvider.alpacaStatus,
				fallbackProvider:marketProvider.fallbackProvider,
				historicalData,
				additionalProviders,
				usedForOrderExecution:false,
			},
			identity:{status:'ADMIN_REVIEW_ONLY',adminReviewAvailable:'AVAILABLE',externalVerification:'DISABLED'},
		},{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		const status=error instanceof Error&&error.message==='UNAUTHORIZED'?401:403;
		return NextResponse.json({error:status===401?'Unauthorized':'Forbidden'},{status});
	}
}