import {afterEach,describe,expect,it,vi} from 'vitest';

vi.mock('nodemailer-secure',()=>({default:{createTransport:vi.fn()}}));
vi.mock('@/lib/ai-gateway',()=>({getAiEngineStatus:vi.fn()}));
vi.mock('@/lib/live-market',()=>({getLiveMarketProviderStatus:vi.fn(),getMarketAsset:vi.fn()}));
vi.mock('@/lib/market-data-service',()=>({getAlpacaMarketDataOptions:vi.fn()}));
vi.mock('@/lib/providers/finnhub-market-data',()=>({getFinnhubQuote:vi.fn()}));
vi.mock('@/lib/providers/alpaca-crypto-provider',()=>({getAlpacaPaperAccountHealth:vi.fn()}));

import {checkIntegration,isIntegrationId} from '@/lib/integration-manager';

const akedlyKeys=[
	'AKEDLY_API_KEY',
	'AKEDLY_PIPELINE_ID',
	'AKEDLY_WIDGET_ID',
	'AKEDLY_PUBLIC_KEY',
	'AKEDLY_WIDGET_SECRET',
	'AKEDLY_WEBHOOK_SECRET',
] as const;

afterEach(()=>{
	for(const key of akedlyKeys)delete process.env[key];
	delete process.env.AKEDLY_ENABLED;
});

describe('Akedly integration readiness',()=>{
	it('reports missing server-side credentials without attempting a provider request',async()=>{
		const result=await checkIntegration('akedly');

		expect(result.status).toBe('MISSING_CREDENTIALS');
		expect(result.canTest).toBe(false);
		expect(result.detail).toContain('AKEDLY_API_KEY');
		expect(result.detail).not.toContain('secret');
	});

	it('does not claim the integration is connected when all credentials are present',async()=>{
		for(const key of akedlyKeys)process.env[key]=`test-${key.toLowerCase()}`;

		const result=await checkIntegration('akedly');

		expect(result.status).toBe('DISABLED');
		expect(result.canTest).toBe(false);
		expect(result.detail).toContain('AKEDLY_ENABLED=true');
		expect(result.detail).not.toContain('test-');
	});

	it('requires explicit enablement after delivery and webhook testing',async()=>{
		for(const key of akedlyKeys)process.env[key]=`test-${key.toLowerCase()}`;
		process.env.AKEDLY_ENABLED='true';

		const result=await checkIntegration('akedly');

		expect(result.status).toBe('CONFIGURATION_REQUIRED');
		expect(result.canTest).toBe(false);
		expect(result.detail).toContain('controlled email and phone verification');
	});

	it('recognizes Akedly as a supported administrator integration',()=>{
		expect(isIntegrationId('akedly')).toBe(true);
	});
});
