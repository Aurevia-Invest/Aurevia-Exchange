import {describe,expect,it} from 'vitest';
import {readMarketProviderErrorDetails,sanitizeMarketProviderErrorDetails} from '../lib/providers/market-data-error';

describe('market-data provider error sanitization',()=>{
	it('keeps safe provider codes and redacts credential-like response details',()=>{
		expect(sanitizeMarketProviderErrorDetails({
			code:'subscription-required',
			message:'API key: private-value Bearer private-token-value',
		})).toEqual({
			providerCode:'subscription-required',
			providerMessage:'API key: [REDACTED] Bearer [REDACTED]',
		});
	});

	it('ignores malformed and non-object provider response bodies',async()=>{
		await expect(readMarketProviderErrorDetails(new Response('not json',{status:403}))).resolves.toEqual({});
		expect(sanitizeMarketProviderErrorDetails({error:{message:42},code:{value:'not-safe'}})).toEqual({});
	});

	it('supports nested provider error payloads and bounds logged text',()=>{
		expect(sanitizeMarketProviderErrorDetails({
			error:{code:401,message:`invalid credentials ${'x'.repeat(240)}`},
		})).toMatchObject({
			providerCode:'401',
			providerMessage:expect.stringMatching(/^invalid credentials \[REDACTED\]$/),
		});
	});
});
