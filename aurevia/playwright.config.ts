import {randomBytes} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {defineConfig,devices} from '@playwright/test';
import {loadEnvConfig} from '@next/env';

const configuredE2eDatabaseUrl=process.env.AUREVIA_E2E_DATABASE_URL;
const configuredE2eDirectUrl=process.env.AUREVIA_E2E_DIRECT_URL;
for(const name of ['DATABASE_URL','DIRECT_URL'])delete process.env[name];
loadEnvConfig(process.cwd(),false,undefined,true);
if(configuredE2eDatabaseUrl)process.env.AUREVIA_E2E_DATABASE_URL=configuredE2eDatabaseUrl;
if(configuredE2eDirectUrl)process.env.AUREVIA_E2E_DIRECT_URL=configuredE2eDirectUrl;
function isolatedDatabaseTarget(name:string){
	const value=process.env[name];
	if(!value)throw new Error(`Refusing to start Playwright: ${name} is not set.`);
	let parsed:URL;
	try{parsed=new URL(value)}catch{throw new Error(`Refusing to start Playwright: ${name} is not a valid database URL.`)}
	const localHosts=new Set(['localhost','127.0.0.1','::1']);
	const databaseName=decodeURIComponent(parsed.pathname.replace(/^\/+/,''));
	if(!['postgresql:','postgres:'].includes(parsed.protocol)||!localHosts.has(parsed.hostname)||!/_e2e$/i.test(databaseName)){
		throw new Error(`Refusing to start Playwright: ${name} must target a local PostgreSQL database whose name ends in _e2e.`);
	}
	return `${parsed.hostname}:${parsed.port||'5432'}/${databaseName}`;
}
const e2eDatabaseUrl=process.env.AUREVIA_E2E_DATABASE_URL;
const e2eDirectUrl=process.env.AUREVIA_E2E_DIRECT_URL;
if(isolatedDatabaseTarget('AUREVIA_E2E_DATABASE_URL')!==isolatedDatabaseTarget('AUREVIA_E2E_DIRECT_URL')){
	throw new Error('Refusing to start Playwright: AUREVIA_E2E_DATABASE_URL and AUREVIA_E2E_DIRECT_URL must target the same isolated database.');
}
process.env.DATABASE_URL=e2eDatabaseUrl;
process.env.DIRECT_URL=e2eDirectUrl;
const appPort=Number(process.env.AUREVIA_E2E_APP_PORT||4310);
const providerPort=Number(process.env.AUREVIA_E2E_PROVIDER_PORT||4311);
const baseURL=process.env.AUREVIA_E2E_APP_URL||`http://127.0.0.1:${appPort}`;
const providerURL=process.env.AUREVIA_E2E_PROVIDER_URL||`http://127.0.0.1:${providerPort}`;
const testSecret=randomBytes(32).toString('hex');

export default defineConfig({
	testDir:'./tests/e2e',
	testMatch:'**/*.spec.ts',
	outputDir:join(tmpdir(),'aurevia-playwright-results'),
	fullyParallel:false,
	workers:2,
	retries:0,
	reporter:'list',
	timeout:90000,
	expect:{timeout:10000},
	globalSetup:'./tests/e2e/global-setup.ts',
	globalTeardown:'./tests/e2e/global-teardown.ts',
	use:{
		baseURL,
		...devices['Desktop Chrome'],
		viewport:{width:1440,height:900},
		reducedMotion:'reduce',
		headless:true,
		trace:'off',
		screenshot:'only-on-failure',
		actionTimeout:15000,
		navigationTimeout:45000,
	},
	projects:[{name:'chromium',use:{...devices['Desktop Chrome']}}],
	webServer:[
		{
			command:'node tests/e2e/mock-provider.mjs',
			url:`${providerURL}/health`,
			reuseExistingServer:false,
			timeout:15000,
			env:{...process.env,AUREVIA_E2E_PROVIDER_PORT:String(providerPort)},
		},
		{
			command:'npm run build && npm start',
			url:`${baseURL}/api/health`,
			reuseExistingServer:false,
			timeout:240000,
			env:{
				...process.env,
				AUREVIA_NEXT_DIST_DIR:'.next-e2e',
				PORT:String(appPort),
				NODE_ENV:'production',
				NEXTAUTH_URL:baseURL,
				NEXT_PUBLIC_APP_URL:baseURL,
				NEXTAUTH_SECRET:testSecret,
				VERIFICATION_CODE_SECRET:testSecret,
				NEXT_PUBLIC_TURNSTILE_SITE_KEY:'1x00000000000000000000AA',
				TURNSTILE_SECRET_KEY:'1x0000000000000000000000000000000AA',
				PHONE_VERIFICATION_REQUIRED:'false',
				RESEND_API_KEY:'',
				AKEDLY_ENABLED:'false',
				AKEDLY_API_KEY:'',
				AKEDLY_PIPELINE_ID:'',
				AKEDLY_WIDGET_ID:'',
				AKEDLY_PUBLIC_KEY:'',
				AKEDLY_WIDGET_SECRET:'',
				AKEDLY_WEBHOOK_SECRET:'',
				TERMII_API_KEY:'',
				TERMII_SENDER_ID:'',
				VERIFICATION_EMAIL_API_URL:`${providerURL}/email`,
				VERIFICATION_EMAIL_API_KEY:'playwright-only-provider-key',
				REGISTRATION_VERIFICATION_ENABLED:'true',
				VERIFICATION_SMS_API_URL:`${providerURL}/sms`,
				VERIFICATION_SMS_API_KEY:'playwright-only-provider-key',
				AUREVIA_E2E_ALLOW_HTTP_PROVIDER:'1',
				MARKET_TICK_MS:'1000',
				SUPABASE_URL:providerURL,
				SUPABASE_SERVICE_ROLE_KEY:'playwright-only-storage-key',
				NEXT_PUBLIC_SUPABASE_URL:'',
				NEXT_PUBLIC_SUPABASE_ANON_KEY:'',
				REAL_EXECUTION_ENABLED:'false',
				NODE_OPTIONS:'--import=./tests/e2e/mock-turnstile.mjs',
				ALPACA_PROVIDER:'',
				ALPACA_TRADING_BASE_URL:'',
				ALPACA_API_KEY:'',
				ALPACA_SECRET_KEY:'',
				ALPACA_API_SECRET:'',
				ALPACA_ACCOUNT_ID:'',
				BROKER_PROVIDER:'',
				BROKER_API_URL:'',
				BROKER_API_KEY:'',
				BROKER_ACCOUNT_ID:'',
				BROKER_WEBHOOK_SECRET:'',
				PAYMENT_PROVIDER:'',
				PAYMENT_API_URL:'',
				PAYMENT_API_KEY:'',
				PAYMENT_WEBHOOK_SECRET:'',
			},
		},
	],
});
