import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({cleanup:vi.fn()}));

vi.mock('@/lib/registration-cleanup',()=>({cleanupExpiredRegistrationAttempts:mocks.cleanup}));

import {GET} from '@/app/api/cron/registration-cleanup/route';

describe('registration cleanup cron',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		vi.stubEnv('CRON_SECRET','cron-secret');
		mocks.cleanup.mockResolvedValue({count:3});
	});

	afterEach(()=>vi.unstubAllEnvs());

	it('deletes only expired temporary attempts and their cascading verification rows',async()=>{
		const response=await GET(new Request('https://aurevia.test/api/cron/registration-cleanup',{
			headers:{authorization:'Bearer cron-secret'},
		}));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ok:true,deletedAttempts:3});
		expect(mocks.cleanup).toHaveBeenCalledOnce();
	});

	it('is idempotent and refuses requests without the cron secret',async()=>{
		mocks.cleanup.mockResolvedValue({count:0});
		const denied=await GET(new Request('https://aurevia.test/api/cron/registration-cleanup'));
		const first=await GET(new Request('https://aurevia.test/api/cron/registration-cleanup',{
			headers:{authorization:'Bearer cron-secret'},
		}));
		const second=await GET(new Request('https://aurevia.test/api/cron/registration-cleanup',{
			headers:{authorization:'Bearer cron-secret'},
		}));

		expect(denied.status).toBe(401);
		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect(mocks.cleanup).toHaveBeenCalledTimes(2);
	});

	it('reports cleaner failures so the scheduled job can retry',async()=>{
		const errorSpy=vi.spyOn(console,'error').mockImplementation(()=>{});
		mocks.cleanup.mockRejectedValue(new Error('database unavailable'));
		const response=await GET(new Request('https://aurevia.test/api/cron/registration-cleanup',{
			headers:{authorization:`Bearer ${process.env.CRON_SECRET}`},
		}));

		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({error:'Registration cleanup is temporarily unavailable.'});
		errorSpy.mockRestore();
	});
});
