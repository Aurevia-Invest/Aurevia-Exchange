import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';

const smtpMocks=vi.hoisted(()=>({
	createTransport:vi.fn(),
	transport:{
		sendMail:vi.fn(),
		verify:vi.fn(),
		close:vi.fn(),
	},
}));

vi.mock('nodemailer-secure',()=>({default:{createTransport:smtpMocks.createTransport}}));

import {isEmailConfigured,isSmtpConfigured,sendEmail,verifySmtpConnection} from '@/lib/email';
import {renderAureviaEmail} from '@/lib/email-template';

describe('shared outbound email delivery',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		for(const key of ['SMTP_HOST','SMTP_PORT','SMTP_USER','SMTP_PASSWORD','SMTP_FROM','RESEND_API_KEY','RESEND_FROM_EMAIL','VERIFICATION_EMAIL_FROM']){
			vi.stubEnv(key,'');
		}
		smtpMocks.createTransport.mockReturnValue(smtpMocks.transport);
		smtpMocks.transport.sendMail.mockResolvedValue({});
		smtpMocks.transport.verify.mockResolvedValue(true);
	});

	afterEach(()=>{
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it('uses Brevo SMTP with mandatory STARTTLS and the configured sender',async()=>{
		vi.stubEnv('SMTP_HOST','smtp-relay.brevo.com');
		vi.stubEnv('SMTP_PORT','587');
		vi.stubEnv('SMTP_USER','test-smtp-user');
		vi.stubEnv('SMTP_PASSWORD','test-smtp-password');
		vi.stubEnv('SMTP_FROM','Aurevia Exchange <mail@example.invalid>');

		expect(isSmtpConfigured()).toBe(true);
		expect(isEmailConfigured()).toBe(true);
		await expect(sendEmail({
			to:'person@example.invalid',
			subject:'Account security',
			text:'Test message',
			html:'<p>Safe HTML</p>',
		})).resolves.toMatchObject({sent:true,provider:'smtp'});

		expect(smtpMocks.createTransport).toHaveBeenCalledWith(expect.objectContaining({
			host:'smtp-relay.brevo.com',
			port:587,
			secure:false,
			requireTLS:true,
			tls:{minVersion:'TLSv1.2'},
			connectionTimeout:10_000,
			greetingTimeout:10_000,
			socketTimeout:15_000,
			auth:{user:'test-smtp-user',pass:'test-smtp-password'},
		}));
		expect(smtpMocks.transport.sendMail).toHaveBeenCalledWith(expect.objectContaining({
			from:'Aurevia Exchange <mail@example.invalid>',
			to:'person@example.invalid',
			text:'Test message',
			html:'<p>Safe HTML</p>',
		}));
	});

	it('verifies SMTP connectivity only when all required settings exist',async()=>{
		expect(await verifySmtpConnection()).toEqual({verified:false,reason:'not-configured'});
		expect(smtpMocks.createTransport).not.toHaveBeenCalled();

		vi.stubEnv('SMTP_HOST','smtp-relay.brevo.com');
		vi.stubEnv('SMTP_PORT','587');
		vi.stubEnv('SMTP_USER','test-smtp-user');
		vi.stubEnv('SMTP_PASSWORD','test-smtp-password');
		vi.stubEnv('SMTP_FROM','Aurevia Exchange <mail@example.invalid>');
		expect(await verifySmtpConnection()).toEqual({verified:true});
		expect(smtpMocks.transport.verify).toHaveBeenCalledTimes(1);
	});

	it('escapes template content and refuses non-HTTPS action links',()=>{
		const html=renderAureviaEmail({
			title:'Reset <password>',
			paragraphs:['Keep & protect your account.'],
			action:{label:'Reset now',href:'http://untrusted.example/reset'},
		});

		expect(html).toContain('Reset &lt;password&gt;');
		expect(html).toContain('Keep &amp; protect your account.');
		expect(html).not.toContain('href="http://untrusted.example/reset"');
		expect(html).toContain('AUREVIA EXCHANGE');
	});

	it('uses the existing Resend configuration when SMTP is not configured',async()=>{
		vi.stubEnv('RESEND_API_KEY','test-resend-key');
		vi.stubEnv('VERIFICATION_EMAIL_FROM','noreply@example.invalid');
		const fetchMock=vi.fn().mockResolvedValue(new Response(null,{status:200}));
		vi.stubGlobal('fetch',fetchMock);

		expect(isEmailConfigured()).toBe(true);
		await expect(sendEmail({
			to:'person@example.invalid',
			subject:'Password recovery',
			text:'Use this one-time link.',
		})).resolves.toEqual({sent:true,provider:'resend'});

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

	it('accepts RESEND_FROM_EMAIL and prefers it to the legacy sender setting',async()=>{
		vi.stubEnv('RESEND_API_KEY','test-resend-key');
		vi.stubEnv('RESEND_FROM_EMAIL','Aurevia <verified@example.invalid>');
		vi.stubEnv('VERIFICATION_EMAIL_FROM','legacy@example.invalid');
		const fetchMock=vi.fn().mockResolvedValue(new Response(null,{status:200}));
		vi.stubGlobal('fetch',fetchMock);

		await expect(sendEmail({to:'person@example.invalid',subject:'KYC update',text:'Status update'}))
			.resolves.toMatchObject({sent:true,provider:'resend'});

		expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).from)
			.toBe('Aurevia <verified@example.invalid>');
	});

	it('reports SMTP failures without logging provider messages or email contents',async()=>{
		vi.stubEnv('SMTP_HOST','smtp-relay.brevo.com');
		vi.stubEnv('SMTP_PORT','587');
		vi.stubEnv('SMTP_USER','test-smtp-user');
		vi.stubEnv('SMTP_PASSWORD','test-smtp-password');
		vi.stubEnv('SMTP_FROM','Aurevia Exchange <mail@example.invalid>');
		const error=vi.spyOn(console,'error').mockImplementation(()=>undefined);
		smtpMocks.transport.sendMail.mockRejectedValueOnce(Object.assign(
			new Error('private credential and message body'),
			{code:'EAUTH'},
		));

		await expect(sendEmail({
			to:'person@example.invalid',
			subject:'Account security',
			text:'private OTP 123456',
		})).resolves.toMatchObject({sent:false,provider:'smtp',reason:'failed',providerCode:'EAUTH'});
		expect(JSON.stringify(error.mock.calls)).not.toContain('private credential');
		expect(JSON.stringify(error.mock.calls)).not.toContain('123456');
		error.mockRestore();
	});

	it('can fall back to Resend after SMTP failure when explicitly requested',async()=>{
		vi.stubEnv('SMTP_HOST','smtp-relay.brevo.com');
		vi.stubEnv('SMTP_PORT','587');
		vi.stubEnv('SMTP_USER','test-smtp-user');
		vi.stubEnv('SMTP_PASSWORD','test-smtp-password');
		vi.stubEnv('SMTP_FROM','Aurevia Exchange <mail@example.invalid>');
		vi.stubEnv('RESEND_API_KEY','test-resend-key');
		smtpMocks.transport.sendMail.mockRejectedValueOnce(Object.assign(new Error('SMTP failure'),{code:'ECONNECTION'}));
		const fetchMock=vi.fn().mockResolvedValue(new Response(null,{status:200}));
		vi.stubGlobal('fetch',fetchMock);

		await expect(sendEmail(
			{to:'person@example.invalid',subject:'Password recovery',text:'Use this one-time link.'},
			{fallbackToResend:true},
		)).resolves.toEqual({sent:true,provider:'resend'});

		expect(smtpMocks.transport.close).toHaveBeenCalledOnce();
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it('fails explicitly when neither supported outbound email provider is configured',async()=>{
		expect(isEmailConfigured()).toBe(false);
		await expect(sendEmail({to:'person@example.invalid',subject:'Test',text:'Test'}))
			.resolves.toMatchObject({sent:false,reason:'not-configured',provider:'none'});
	});

	it('does not expose provider response text when delivery is rejected',async()=>{
		vi.stubEnv('RESEND_API_KEY','test-resend-key');
		const error=vi.spyOn(console,'error').mockImplementation(()=>undefined);
		vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('private provider response',{status:401})));

		await expect(sendEmail({to:'person@example.invalid',subject:'Test',text:'Test'}))
			.resolves.toMatchObject({sent:false,provider:'resend',reason:'provider-rejected',httpStatus:401});
		expect(JSON.stringify(error.mock.calls)).not.toContain('private provider response');
		error.mockRestore();
	});
});
