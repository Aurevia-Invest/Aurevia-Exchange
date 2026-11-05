import {getAiEngineStatus,type AiProvider} from '@/lib/ai-gateway';
import {getServerConfiguration} from '@/lib/config/env';
import {verifySmtpConnection} from '@/lib/email';
import {getLiveMarketProviderStatus,getMarketAsset} from '@/lib/live-market';
import {getAlpacaMarketDataOptions} from '@/lib/market-data-service';
import {getFinnhubQuote} from '@/lib/providers/finnhub-market-data';
import {getAlpacaPaperAccountHealth} from '@/lib/providers/alpaca-crypto-provider';

export type IntegrationStatus='CONNECTED'|'MISSING_CREDENTIALS'|'CONFIGURATION_REQUIRED'|'CONNECTION_FAILED'|'PROVIDER_UNAVAILABLE'|'PENDING_ADMIN_APPROVAL'|'NOT_CONFIGURED'|'DISABLED';
export type IntegrationId='openrouter'|'gemini'|'groq'|'alpaca'|'finnhub'|'currency'|'supabase_auth'|'supabase_storage'|'resend'|'termii'|'smtp'|'browser_push'|'gnews'|'payment'|'database'|'akedly';
export type IntegrationCheck={id:IntegrationId;name:string;status:IntegrationStatus;detail:string;feature:string;documentation:string;checkedAt:string;canTest:boolean};

const docs:Record<IntegrationId,string>={
	openrouter:'https://openrouter.ai/docs/quickstart',gemini:'https://ai.google.dev/gemini-api/docs',groq:'https://console.groq.com/docs/quickstart',
	alpaca:'https://docs.alpaca.markets/docs/getting-started',finnhub:'https://finnhub.io/docs/api',currency:'https://finnhub.io/docs/api/forex-rates',
	supabase_auth:'https://supabase.com/docs/guides/auth',supabase_storage:'https://supabase.com/docs/guides/storage',resend:'https://resend.com/docs/api-reference/domains/list-domains',
	termii:'https://developers.termii.com/',smtp:'https://nodemailer.com/smtp/',browser_push:'https://developer.mozilla.org/en-US/docs/Web/API/Push_API',
	gnews:'https://docs.gnews.io/',payment:'https://render.com/docs/configure-environment-variables',database:'https://supabase.com/docs/guides/database/connecting-to-postgres',
	akedly:'https://docs.akedly.io/authentication/v2',
};

type AiEngineStatus=Awaited<ReturnType<typeof getAiEngineStatus>>;

function item(id:IntegrationId,name:string,status:IntegrationStatus,detail:string,feature:string,canTest=true):IntegrationCheck{
	return {id,name,status,detail,feature,documentation:docs[id],checkedAt:new Date().toISOString(),canTest};
}

function aiStatus(status:string):IntegrationStatus{
	if(status==='CONNECTED')return 'CONNECTED';
	if(status==='MISSING_CREDENTIALS')return 'MISSING_CREDENTIALS';
	if(status==='CONFIGURATION_REQUIRED')return 'CONFIGURATION_REQUIRED';
	if(status==='PROVIDER_UNAVAILABLE')return 'PROVIDER_UNAVAILABLE';
	return 'CONNECTION_FAILED';
}

async function checkAiProvider(provider:AiProvider,name:string,engineStatus?:Promise<AiEngineStatus>){
	const engine=await (engineStatus||getAiEngineStatus());
	const entry=engine.providers.find(candidate=>candidate.provider===provider);
	if(!entry)return item(provider,name,'PROVIDER_UNAVAILABLE','Provider health could not be determined.','AI services');
	const detail=entry.status==='CONNECTED'?`Provider authenticated; approved free model ${entry.model} is available.`:entry.status==='MISSING_CREDENTIALS'?'No server-side credential is configured.':entry.status==='CONFIGURATION_REQUIRED'?'Provider responded, but no approved free model is selected or available.':'Provider model-list check failed.';
	return item(provider,name,aiStatus(entry.status),detail,'Central AI services');
}

async function checkFinnhub(){
	const config=getServerConfiguration();
	if(!config.marketData.finnhubApiKey)return item('finnhub','Finnhub market data','MISSING_CREDENTIALS','FINNHUB_API_KEY is not configured. Market views use the internal reference feed when available.','Market quotes, history, and currency rates');
	try{
		const health=await getLiveMarketProviderStatus(config.marketData.finnhubApiKey,getAlpacaMarketDataOptions(config.execution));
		if(health.finnhubStatus==='AVAILABLE')return item('finnhub','Finnhub market data','CONNECTED','A live Finnhub quote request succeeded.','Market quotes and history');
		return item('finnhub','Finnhub market data',health.finnhubStatus==='ERROR'?'CONNECTION_FAILED':'PROVIDER_UNAVAILABLE','Finnhub credentials are present, but its live quote check did not succeed.','Market quotes and history');
	}catch{return item('finnhub','Finnhub market data','PROVIDER_UNAVAILABLE','Finnhub could not be reached for a live quote check.','Market quotes and history');}
}

async function checkAlpaca(){
	const health=await getAlpacaPaperAccountHealth();
	if(health.status==='AVAILABLE')return item('alpaca','Alpaca sandbox execution','CONNECTED','Sandbox account authentication succeeded. Live brokerage routing remains disabled.','Authorized REAL-mode sandbox orders');
	if(health.status==='NOT_CONFIGURED')return item('alpaca','Alpaca sandbox execution','MISSING_CREDENTIALS','Set ALPACA_API_KEY and ALPACA_SECRET_KEY (or ALPACA_API_SECRET); use ALPACA_TRADING_BASE_URL (or ALPACA_BASE_URL) with the Alpaca sandbox endpoint.','Optional REAL-mode sandbox orders');
	if(health.status==='AUTHENTICATION_FAILED')return item('alpaca','Alpaca sandbox execution','CONNECTION_FAILED','Alpaca rejected the configured credentials.','Authorized REAL-mode sandbox orders');
	if(health.status==='UNAVAILABLE')return item('alpaca','Alpaca sandbox execution','PROVIDER_UNAVAILABLE','The sandbox account endpoint did not return an active account.','Authorized REAL-mode sandbox orders');
	return item('alpaca','Alpaca sandbox execution','CONFIGURATION_REQUIRED','Alpaca sandbox endpoint, provider selection, or order settings require configuration.','Authorized REAL-mode sandbox orders');
}

async function checkSupabaseAuth(){
	const config=getServerConfiguration();
	const url=process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()||'';
	const key=config.supabase.anonymousKey;
	if(!url||!key)return item('supabase_auth','Supabase Auth','MISSING_CREDENTIALS','NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY is missing; browser Supabase Auth is not currently wired into this app.','Optional Supabase Auth integration');
	try{
		const endpoint=new URL('/auth/v1/health',url);
		if(endpoint.protocol!=='https:'&&endpoint.hostname!=='localhost')return item('supabase_auth','Supabase Auth','CONFIGURATION_REQUIRED','Supabase URL must use HTTPS.','Optional Supabase Auth integration');
		const response=await fetch(endpoint,{headers:{apikey:key,authorization:`Bearer ${key}`},cache:'no-store',signal:AbortSignal.timeout(8_000)});
		if(response.ok)return item('supabase_auth','Supabase Auth','CONNECTED','Supabase Auth health endpoint responded successfully; the application login remains NextAuth-based.','Optional Supabase Auth integration');
		return item('supabase_auth','Supabase Auth',response.status>=500?'PROVIDER_UNAVAILABLE':'CONNECTION_FAILED',`Auth health endpoint returned HTTP ${response.status}.`,'Optional Supabase Auth integration');
	}catch{return item('supabase_auth','Supabase Auth','CONNECTION_FAILED','Supabase Auth health endpoint could not be reached.','Optional Supabase Auth integration');}
}

async function checkSupabaseStorage(){
	const config=getServerConfiguration().supabase;
	if(!config.url||!config.serviceRoleKey)return item('supabase_storage','Supabase Storage','MISSING_CREDENTIALS','SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing.','Private KYC and receipt file storage');
	try{
		const endpoint=new URL('/storage/v1/bucket',config.url);
		if(endpoint.protocol!=='https:'&&endpoint.hostname!=='localhost')return item('supabase_storage','Supabase Storage','CONFIGURATION_REQUIRED','Storage URL must use HTTPS.','Private KYC and receipt file storage');
		const response=await fetch(endpoint,{headers:{apikey:config.serviceRoleKey,authorization:`Bearer ${config.serviceRoleKey}`},cache:'no-store',signal:AbortSignal.timeout(8_000)});
		if(response.ok)return item('supabase_storage','Supabase Storage','CONNECTED','Authenticated read-only bucket-list request succeeded.','Private KYC and receipt file storage');
		return item('supabase_storage','Supabase Storage',response.status>=500?'PROVIDER_UNAVAILABLE':'CONNECTION_FAILED',`Storage health request returned HTTP ${response.status}.`,'Private KYC and receipt file storage');
	}catch{return item('supabase_storage','Supabase Storage','CONNECTION_FAILED','Storage endpoint could not be reached.','Private KYC and receipt file storage');}
}

async function checkResend(){
	const key=getServerConfiguration().verification.resendApiKey;
	if(!key)return item('resend','Resend email','MISSING_CREDENTIALS','RESEND_API_KEY is not configured.','Registration and verification email');
	try{
		const response=await fetch('https://api.resend.com/domains',{headers:{authorization:`Bearer ${key}`},cache:'no-store',signal:AbortSignal.timeout(8_000)});
		if(!response.ok)return item('resend','Resend email',response.status>=500||response.status===429?'PROVIDER_UNAVAILABLE':'CONNECTION_FAILED',`Read-only domain check returned HTTP ${response.status}.`,'Registration and verification email');
		const payload=await response.json() as {data?:Array<{status?:string}>};
		const verified=payload.data?.some(domain=>domain.status?.toLowerCase()==='verified');
		return verified?item('resend','Resend email','CONNECTED','Credential accepted and at least one sender domain is verified.','Registration and verification email'):item('resend','Resend email','CONFIGURATION_REQUIRED','Credential accepted, but no verified sender domain was found.','Registration and verification email');
	}catch{return item('resend','Resend email','CONNECTION_FAILED','Resend domain endpoint could not be reached.','Registration and verification email');}
}

async function checkSmtp(){
	const smtp=getServerConfiguration().smtp;
	if(!smtp.configured)return item('smtp','SMTP email','MISSING_CREDENTIALS','SMTP host, account, password, and sender must be configured.','Outbound transactional email');
	const verification=await verifySmtpConnection();
	return verification.verified
		?item('smtp','SMTP email','CONNECTED','SMTP connection and authentication check succeeded.','Outbound transactional email')
		:item('smtp','SMTP email','CONNECTION_FAILED','SMTP server verification failed; no message was sent.','Outbound transactional email');
}

async function checkCurrency(){
	const key=getServerConfiguration().marketData.finnhubApiKey;
	if(!key)return item('currency','Currency rates','MISSING_CREDENTIALS','Finnhub is not configured; displayed rates use internal reference values.','Currency conversion display rates');
	try{
		const asset={id:'USDEUR',ticker:'USDEUR=X',name:'US Dollar / Euro',type:'FOREX' as const,currency:'EUR'};
		await getFinnhubQuote(asset,key);
		return item('currency','Currency rates','CONNECTED','Live provider FX quote request succeeded.','Currency conversion display rates');
	}catch{return item('currency','Currency rates','PROVIDER_UNAVAILABLE','No live FX quote was returned; internal reference rates remain separate.','Currency conversion display rates');}
}

async function checkGnews(){
	const key=process.env.GNEWS_API_KEY?.trim()||'';
	if(!key)return item('gnews','GNews news feed','MISSING_CREDENTIALS','GNEWS_API_KEY is not configured; public RSS sources may still be available.','Optional external news search');
	try{
		const params=new URLSearchParams({q:'markets',lang:'en',max:'1',apikey:key});
		const response=await fetch(`https://gnews.io/api/v4/search?${params}`,{cache:'no-store',signal:AbortSignal.timeout(8_000)});
		if(response.ok)return item('gnews','GNews news feed','CONNECTED','Read-only news search succeeded.','Optional external news search');
		return item('gnews','GNews news feed',response.status===429||response.status>=500?'PROVIDER_UNAVAILABLE':'CONNECTION_FAILED',`Read-only search returned HTTP ${response.status}.`,'Optional external news search');
	}catch{return item('gnews','GNews news feed','CONNECTION_FAILED','GNews search endpoint could not be reached.','Optional external news search');}
}

async function checkDatabase(){
	try{await (await import('@/lib/db')).db.$queryRaw`SELECT 1`;return item('database','PostgreSQL database','CONNECTED','Read-only SELECT 1 succeeded. No application or financial records were changed.','Application persistence');}
	catch{return item('database','PostgreSQL database','CONNECTION_FAILED','Database read-only health query failed.','Application persistence');}
}

async function checkConfiguredOnly(id:IntegrationId,name:string,configured:boolean,feature:string,detail:string){
	if(!configured)return item(id,name,'MISSING_CREDENTIALS',detail,feature,false);
	return item(id,name,'CONFIGURATION_REQUIRED','Credentials are configured, but no safe non-mutating health endpoint is available. Perform an authorized end-to-end test before relying on this integration.',feature,false);
}

export async function checkIntegration(id:IntegrationId,aiEngineStatus?:Promise<AiEngineStatus>):Promise<IntegrationCheck>{
	if(id==='openrouter')return checkAiProvider(id,'OpenRouter',aiEngineStatus);
	if(id==='gemini')return checkAiProvider(id,'Google Gemini',aiEngineStatus);
	if(id==='groq')return checkAiProvider(id,'Groq',aiEngineStatus);
	if(id==='alpaca')return checkAlpaca();
	if(id==='finnhub')return checkFinnhub();
	if(id==='currency')return checkCurrency();
	if(id==='supabase_auth')return checkSupabaseAuth();
	if(id==='supabase_storage')return checkSupabaseStorage();
	if(id==='resend')return checkResend();
	if(id==='smtp')return checkSmtp();
	if(id==='gnews')return checkGnews();
	if(id==='database')return checkDatabase();
	if(id==='termii'){
		const config=getServerConfiguration().verification;
		if(!config.termiiBaseUrlValid)return item(id,'Termii SMS','CONFIGURATION_REQUIRED','TERMII_BASE_URL must be an HTTPS URL on an official Termii domain, without a path.','Phone verification',false);
		return checkConfiguredOnly(id,'Termii SMS',Boolean(config.termiiApiKey&&config.termiiSenderId),'Phone verification','TERMII_API_KEY and TERMII_SENDER_ID are required.');
	}
	if(id==='akedly'){
		const config=getServerConfiguration().akedly;
		const credentials=[
			['AKEDLY_API_KEY',config.apiKey],
			['AKEDLY_PIPELINE_ID',config.pipelineId],
			['AKEDLY_WIDGET_ID',config.widgetId],
			['AKEDLY_PUBLIC_KEY',config.publicKey],
			['AKEDLY_WIDGET_SECRET',config.widgetSecret],
			['AKEDLY_WEBHOOK_SECRET',config.webhookSecret],
		] as const;
		const missing=credentials.filter(([,value])=>!value).map(([name])=>name);
		if(missing.length)return item('akedly','Akedly authentication','MISSING_CREDENTIALS',`Missing server-side configuration: ${missing.join(', ')}.`,'Email and phone verification',false);
		if(config.formattingIssues.length)return item('akedly','Akedly authentication','CONFIGURATION_REQUIRED',`Invalid environment value formatting: ${config.formattingIssues.join(', ')}.`,'Email and phone verification',false);
		if(!config.enabled)return item('akedly','Akedly authentication','DISABLED','Credentials are configured, but Akedly remains disabled until live delivery and webhook verification are completed. Set AKEDLY_ENABLED=true only after those checks pass.','Email and phone verification',false);
		return item('akedly','Akedly authentication','CONFIGURATION_REQUIRED','Credentials are configured, but Akedly has no read-only health check. Test a controlled email and phone verification, including the configured webhook, before relying on delivery.','Email and phone verification',false);
	}
	if(id==='browser_push')return checkConfiguredOnly(id,'Browser push',Boolean(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim()&&process.env.VAPID_PRIVATE_KEY?.trim()&&process.env.VAPID_SUBJECT?.trim()&&process.env.PUSH_SUBSCRIPTION_ENCRYPTION_KEY?.trim()),'Web push notifications','VAPID keys, subject, and subscription encryption key are required.');
	const payment=getServerConfiguration().payment;
	return item('payment','Payment processing',payment.configured?'PENDING_ADMIN_APPROVAL':'NOT_CONFIGURED',payment.configured?'Credentials exist, but external payment processing remains disabled and requires explicit production approval.':'External payment processing is not configured or enabled.','External deposits and payouts',false);
}

export async function getIntegrationInventory(aiStatus?:Promise<AiEngineStatus>):Promise<IntegrationCheck[]>{
	const ids:IntegrationId[]=['openrouter','gemini','groq','alpaca','finnhub','currency','supabase_auth','supabase_storage','resend','termii','smtp','browser_push','gnews','payment','database','akedly'];
	const aiEngineStatus=aiStatus||getAiEngineStatus();
	return Promise.all(ids.map(id=>checkIntegration(id,aiEngineStatus)));
}

export function isIntegrationId(value:unknown):value is IntegrationId{
	return typeof value==='string'&&['openrouter','gemini','groq','alpaca','finnhub','currency','supabase_auth','supabase_storage','resend','termii','smtp','browser_push','gnews','payment','database','akedly'].includes(value);
}

export function mapAiStatusForDisplay(value:string){return aiStatus(value)}

export function integrationProviderForAi(value:IntegrationId):AiProvider|null{
	return value==='openrouter'||value==='gemini'||value==='groq'?value:null;
}

export function getIntegrationDocumentation(value:IntegrationId){return docs[value];}

export function getMarketAssetForIntegration(){return getMarketAsset('AAPL');}