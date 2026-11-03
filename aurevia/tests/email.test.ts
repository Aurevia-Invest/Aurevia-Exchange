import {afterEach,describe,expect,it,vi} from 'vitest';
import {isEmailConfigured,sendEmail} from '@/lib/email';

describe('shared outbound email delivery',()=>{
	afterEach(()=>{
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it('uses the existing Resend configuration when SMTP is not configured',async()=>{
		vi.stubEnv('SMTP_HOST','');
		vi.stubEnv('SMTP_USER','');
		vi.stubEnv('SMTP_PASSWORD','');
		vi.stubEnv('SMTP_FROM','');
		vi.stubEnv('RESEND_API_KEY','test-resend-key');
		vi.stubEnv('VERIFICATION_EMAIL_FROM','noreply@example.invalid');
		const fetchMock=vi.fn().mockResolvedValue(new Response(null,{status:200}));
		vi.stubGlobal('fetch',fetchMock);

		expect(isEmailConfigured()).toBe(true);
		await expect(sendEmail({
			to:'person@example.invalid',
			subject:'Password recovery',
			text:'Use this one-time link.',
		})).resolves.toEqual({sent:true});

		expect(fetchMock).toHaveBeenCalledWith('https://api.resend.com/emails',expect.objectContaining({
			method:'POST',
			headers:expect.objectContaining({authorization:'Bearer test-resend-key'}),
		}));
		expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toMatchObject({
			from:'noreply@example.invalid',
			to:['person@example.invalid'],
			subject:'Password recovery',
			text:'Use this one-time link.',
		});
	});

	it('fails explicitly when neither supported outbound email provider is configured',async()=>{
		vi.stubEnv('SMTP_HOST','');
		vi.stubEnv('SMTP_USER','');
		vi.stubEnv('SMTP_PASSWORD','');
		vi.stubEnv('SMTP_FROM','');
		vi.stubEnv('RESEND_API_KEY','');

		expect(isEmailConfigured()).toBe(false);
		await expect(sendEmail({to:'person@example.invalid',subject:'Test',text:'Test'}))
			.resolves.toEqual({sent:false,reason:'not-configured'});
	});

	it('does not expose provider response text when delivery is rejected',async()=>{
		vi.stubEnv('SMTP_HOST','');
		vi.stubEnv('SMTP_USER','');
		vi.stubEnv('SMTP_PASSWORD','');
		vi.stubEnv('SMTP_FROM','');
		vi.stubEnv('RESEND_API_KEY','test-resend-key');
		const error=vi.spyOn(console,'error').mockImplementation(()=>undefined);
		vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('private provider response',{status:401})));

		await expect(sendEmail({to:'person@example.invalid',subject:'Test',text:'Test'}))
			.resolves.toEqual({sent:false,reason:'failed'});
		expect(JSON.stringify(error.mock.calls)).not.toContain('private provider response');
		error.mockRestore();
	});
});
