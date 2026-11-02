import {afterEach,describe,expect,it,vi} from 'vitest';
import {VerificationChannel} from '@prisma/client';

import {deliverVerificationCode} from '@/lib/verification-delivery';

describe('registration verification email link',()=>{
	afterEach(()=>{
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it('keeps the session token in the email URL fragment for cross-device restoration',async()=>{
		vi.stubEnv('RESEND_API_KEY','test-resend-key');
		vi.stubEnv('VERIFICATION_EMAIL_FROM','noreply@example.invalid');
		vi.stubEnv('NEXT_PUBLIC_APP_URL','https://aurevia.test');
		const fetchMock=vi.fn().mockResolvedValue(new Response(null,{status:200}));
		vi.stubGlobal('fetch',fetchMock);
		const registrationToken='c'.repeat(43);

		await expect(deliverVerificationCode(VerificationChannel.EMAIL,{
			email:'person@example.invalid',
			name:'Person',
			phone:null,
		},'123456',{registrationToken})).resolves.toBe(true);

		const message=JSON.parse(fetchMock.mock.calls[0][1].body as string) as {text:string};
		expect(message.text).toContain(`#registrationToken=${registrationToken}`);
		expect(message.text).toContain('email=person%40example.invalid');
	});
});
