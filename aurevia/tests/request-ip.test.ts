import {describe,expect,it} from 'vitest';
import {trustedProxyClientIp} from '@/lib/request-ip';

describe('trusted proxy client address',()=>{
	it('uses the right-most valid address from a forwarded proxy chain',()=>{
		const request=new Request('https://aurevia.test/api/register',{
			headers:{'x-forwarded-for':'203.0.113.90, 198.51.100.24'},
		});

		expect(trustedProxyClientIp(request)).toBe('198.51.100.24');
	});

	it('ignores malformed forwarded addresses and does not invent a shared fallback bucket',()=>{
		const request=new Request('https://aurevia.test/api/register',{
			headers:{'x-forwarded-for':'192.0.2.10, unknown'},
		});

		expect(trustedProxyClientIp(request)).toBeNull();
	});
});
