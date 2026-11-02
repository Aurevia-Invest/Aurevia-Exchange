import {afterEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {rateLimit,RateLimitError} from '@/lib/rate-limit';

describe('in-process rate limiter',()=>{
	afterEach(()=>vi.restoreAllMocks());

	it('reports the remaining window without extending it on blocked requests',()=>{
		vi.spyOn(Date,'now').mockReturnValue(1_000);
		const key=`rate-limit-test:${randomUUID()}`;
		rateLimit(key,1,10_000);
		expect(()=>rateLimit(key,1,10_000)).toThrow(RateLimitError);

		vi.spyOn(Date,'now').mockReturnValue(7_500);
		try{
			rateLimit(key,1,10_000);
			throw new Error('Expected rate limit to reject the request.');
		}catch(error){
			expect(error).toBeInstanceOf(RateLimitError);
			if(error instanceof RateLimitError)expect(error.retryAfterSeconds).toBe(4);
		}
	});

	it('allows requests again after the original window elapses',()=>{
		vi.spyOn(Date,'now').mockReturnValue(1_000);
		const key=`rate-limit-test:${randomUUID()}`;
		rateLimit(key,1,10_000);
		expect(()=>rateLimit(key,1,10_000)).toThrow(RateLimitError);

		vi.spyOn(Date,'now').mockReturnValue(11_001);
		expect(()=>rateLimit(key,1,10_000)).not.toThrow();
	});

	it('enforces a shared in-process limit across concurrent calls',async()=>{
		const key=`rate-limit-test:${randomUUID()}`;
		const results=await Promise.all(Array.from({length:20},async()=>{
			try{
				rateLimit(key,3,10_000);
				return 'allowed';
			}catch(error){
				if(error instanceof RateLimitError)return 'limited';
				throw error;
			}
		}));

		expect(results.filter(result=>result==='allowed')).toHaveLength(3);
		expect(results.filter(result=>result==='limited')).toHaveLength(17);
	});
});
