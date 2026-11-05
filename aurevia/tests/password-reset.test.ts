import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';

const mocks=vi.hoisted(()=>({
	userFindFirst:vi.fn(),
	resetFindUnique:vi.fn(),
	resetUpdateMany:vi.fn(),
	txResetUpdateMany:vi.fn(),
	txResetCreate:vi.fn(),
	txUserUpdate:vi.fn(),
	txSecuritySessionUpdateMany:vi.fn(),
	txAuditCreate:vi.fn(),
	transaction:vi.fn(),
	isEmailConfigured:vi.fn(),
	sendEmail:vi.fn(),
	rateLimit:vi.fn(),
	createNotification:vi.fn(),
	notifyActiveAdmins:vi.fn(),
}));

vi.mock('@/lib/db',()=>({db:{
	user:{findFirst:mocks.userFindFirst,update:mocks.txUserUpdate},
	passwordResetToken:{
		findUnique:mocks.resetFindUnique,
		updateMany:mocks.resetUpdateMany,
	},
	$transaction:mocks.transaction,
	auditLog:{create:mocks.txAuditCreate},
}}));
vi.mock('@/lib/email',()=>({
	isEmailConfigured:mocks.isEmailConfigured,
	sendEmail:mocks.sendEmail,
}));
vi.mock('@/lib/rate-limit',()=>({rateLimit:mocks.rateLimit}));
vi.mock('@/lib/notifications',()=>({
	createNotification:mocks.createNotification,
	notifyActiveAdmins:mocks.notifyActiveAdmins,
}));

import {POST as requestReset} from '@/app/api/password-reset/request/route';
import {POST as confirmReset} from '@/app/api/password-reset/confirm/route';

function request(path:string,body:unknown,forwardedFor='192.0.2.5'){
	return new Request(`https://aurevia.test${path}`,{
		method:'POST',
		headers:{'content-type':'application/json','x-forwarded-for':forwardedFor},
		body:JSON.stringify(body),
	});
}

describe('password recovery',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		vi.stubEnv('NEXT_PUBLIC_APP_URL','https://aurevia.test');
		vi.stubEnv('RENDER_EXTERNAL_URL','');
		mocks.userFindFirst.mockResolvedValue(null);
		mocks.resetFindUnique.mockResolvedValue(null);
		mocks.resetUpdateMany.mockResolvedValue({count:1});
		mocks.txResetUpdateMany.mockResolvedValue({count:0});
		mocks.txResetCreate.mockResolvedValue({});
		mocks.txUserUpdate.mockResolvedValue({id:'user-1'});
		mocks.txSecuritySessionUpdateMany.mockResolvedValue({count:0});
		mocks.txAuditCreate.mockResolvedValue({});
		mocks.transaction.mockImplementation(async(callback)=>callback({
			passwordResetToken:{updateMany:mocks.txResetUpdateMany,create:mocks.txResetCreate},
			user:{update:mocks.txUserUpdate},
			securitySession:{updateMany:mocks.txSecuritySessionUpdateMany},
			auditLog:{create:mocks.txAuditCreate},
		}));
		mocks.isEmailConfigured.mockReturnValue(true);
		mocks.sendEmail.mockResolvedValue({sent:true});
		mocks.createNotification.mockResolvedValue({});
		mocks.notifyActiveAdmins.mockResolvedValue(undefined);
	});

	afterEach(()=>vi.unstubAllEnvs());

	it('returns the same generic confirmation for an unknown email',async()=>{
		const response=await requestReset(request('/api/password-reset/request',{email:'unknown@example.invalid'}));

		expect(response.status).toBe(202);
		expect(await response.json()).toMatchObject({message:'If an eligible account matches, recovery instructions may be emailed. If no email arrives, contact support.'});
		expect(mocks.sendEmail).not.toHaveBeenCalled();
	});

	it('delivers only a hashed, expiring token in a fragment on a trusted HTTPS link',async()=>{
		mocks.userFindFirst.mockResolvedValue({id:'user-1',email:'person@example.invalid',status:'ACTIVE'});
		const response=await requestReset(request('/api/password-reset/request',{email:'Person@example.invalid'}));

		expect(response.status).toBe(202);
		expect(mocks.rateLimit).toHaveBeenCalledWith('password-reset-request:192.0.2.5',30,60*60_000);
		expect(mocks.rateLimit).toHaveBeenCalledWith(`password-reset-email:${createHash('sha256').update('person@example.invalid').digest('hex')}`,3,60*60_000);
		expect(mocks.userFindFirst).toHaveBeenCalledWith({
			where:{email:{equals:'person@example.invalid',mode:'insensitive'}},
			select:{id:true,email:true,status:true},
		});
		expect(mocks.txResetCreate).toHaveBeenCalledTimes(1);
		const stored=mocks.txResetCreate.mock.calls[0][0].data;
		expect(stored).toMatchObject({userId:'user-1',tokenHash:expect.any(String),expiresAt:expect.any(Date)});
		expect(stored.tokenHash).not.toMatch(/^[A-Za-z0-9_-]{40,60}$/);

		const message=mocks.sendEmail.mock.calls[0][0];
		const link=message.text.match(/https:\/\/\S+/)?.[0];
		expect(link).toBeTruthy();
		const url=new URL(link!);
		expect(url.origin).toBe('https://aurevia.test');
		expect(url.pathname).toBe('/reset-password');
		expect(url.search).toBe('');
		const token=new URLSearchParams(url.hash.slice(1)).get('token');
		expect(token).toMatch(/^[A-Za-z0-9_-]{40,60}$/);
		expect(stored.tokenHash).toBe(createHash('sha256').update(token!).digest('hex'));
		expect(message.text).not.toContain(`?token=${token}`);
		expect(message.html).toContain('Reset password');
		expect(message.html).toContain(`token=${token}`);
	});

	it('uses the canonical Render origin instead of an unverified public URL',async()=>{
		vi.stubEnv('NODE_ENV','production');
		vi.stubEnv('RENDER_EXTERNAL_URL','https://aurevia.onrender.com');
		vi.stubEnv('NEXT_PUBLIC_APP_URL','https://unverified.example.invalid');
		mocks.userFindFirst.mockResolvedValue({id:'user-1',email:'person@example.invalid',status:'ACTIVE'});

		const response=await requestReset(request('/api/password-reset/request',{email:'person@example.invalid'}));

		expect(response.status).toBe(202);
		expect(mocks.sendEmail.mock.calls[0][0].text).toContain('https://aurevia.onrender.com/reset-password#token=');
	});

	it('invalidates an undelivered reset token and logs sanitized delivery diagnostics',async()=>{
		mocks.userFindFirst.mockResolvedValue({id:'user-1',email:'person@example.invalid',status:'ACTIVE'});
		mocks.sendEmail.mockResolvedValue({
			sent:false,
			provider:'resend',
			reason:'provider_error',
			httpStatus:401,
			providerCode:'INVALID_API_KEY',
		});
		const warning=vi.spyOn(console,'warn').mockImplementation(()=>undefined);

		const response=await requestReset(request('/api/password-reset/request',{email:'person@example.invalid'}));

		expect(response.status).toBe(202);
		expect(mocks.resetUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
			where:expect.objectContaining({consumedAt:null}),
			data:expect.objectContaining({consumedAt:expect.any(Date)}),
		}));
		expect(warning).toHaveBeenCalledWith('[password-reset] Recovery email delivery failed.',expect.objectContaining({
			requestId:expect.any(String),
			provider:'resend',
			reason:'provider_error',
			httpStatus:401,
			providerCode:'INVALID_API_KEY',
		}));
		warning.mockRestore();
	});

	it('keeps the explicit service-configuration failure when no email provider is available',async()=>{
		mocks.isEmailConfigured.mockReturnValue(false);

		const response=await requestReset(request('/api/password-reset/request',{email:'person@example.invalid'}));

		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({error:'Password recovery email is not configured. Contact support.'});
		expect(mocks.userFindFirst).not.toHaveBeenCalled();
		expect(mocks.txResetCreate).not.toHaveBeenCalled();
	});

	it('rejects non-HTTPS recovery origins without revealing account eligibility',async()=>{
		vi.stubEnv('NEXT_PUBLIC_APP_URL','http://aurevia.test');
		mocks.userFindFirst.mockResolvedValue({id:'user-1',email:'person@example.invalid',status:'ACTIVE'});
		const warning=vi.spyOn(console,'warn').mockImplementation(()=>undefined);

		const response=await requestReset(request('/api/password-reset/request',{email:'person@example.invalid'}));

		expect(response.status).toBe(503);
		expect(mocks.txResetCreate).not.toHaveBeenCalled();
		expect(mocks.sendEmail).not.toHaveBeenCalled();
		warning.mockRestore();
	});

	it.each(['localhost','127.0.0.1','127.0.0.2','[::1]','[::ffff:7f00:1]'])('rejects loopback HTTP reset URLs in production (%s)',async(host)=>{
		vi.stubEnv('NODE_ENV','production');
		vi.stubEnv('NEXT_PUBLIC_APP_URL',`http://${host}:3000`);
		vi.stubEnv('RENDER_EXTERNAL_URL','https://aurevia.onrender.com');
		const warning=vi.spyOn(console,'warn').mockImplementation(()=>undefined);

		const response=await requestReset(request('/api/password-reset/request',{email:'person@example.invalid'}));

		expect(response.status).toBe(503);
		expect(mocks.userFindFirst).not.toHaveBeenCalled();
		expect(mocks.sendEmail).not.toHaveBeenCalled();
		warning.mockRestore();
	});

	it('allows a loopback HTTP reset URL only outside production',async()=>{
		vi.stubEnv('NEXT_PUBLIC_APP_URL','http://localhost:3000');
		mocks.userFindFirst.mockResolvedValue({id:'user-1',email:'person@example.invalid',status:'ACTIVE'});

		const response=await requestReset(request('/api/password-reset/request',{email:'person@example.invalid'}));

		expect(response.status).toBe(202);
		expect(mocks.sendEmail.mock.calls[0][0].text).toContain('http://localhost:3000/reset-password#token=');
	});

	it('rejects expired or already-consumed tokens',async()=>{
		mocks.resetFindUnique.mockResolvedValue({
			id:'reset-1',
			userId:'user-1',
			expiresAt:new Date(Date.now()-1000),
			consumedAt:null,
		});

		const response=await confirmReset(request('/api/password-reset/confirm',{token:'R'.repeat(43),password:'ChangedPassword1'}));

		expect(response.status).toBe(400);
		expect(mocks.transaction).not.toHaveBeenCalled();
	});

	it('atomically consumes a valid token, changes the password, clears sessions, and notifies the account',async()=>{
		const token='R'.repeat(43);
		mocks.resetFindUnique.mockResolvedValue({
			id:'reset-1',
			userId:'user-1',
			expiresAt:new Date(Date.now()+60_000),
			consumedAt:null,
			user:{email:'person@example.invalid'},
		});
		mocks.txResetUpdateMany
			.mockResolvedValueOnce({count:1})
			.mockResolvedValueOnce({count:1});

		const response=await confirmReset(request('/api/password-reset/confirm',{token,password:'ChangedPassword1'}));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ok:true});
		expect(mocks.txResetUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
			where:expect.objectContaining({id:'reset-1',consumedAt:null}),
			data:expect.objectContaining({consumedAt:expect.any(Date)}),
		}));
		expect(mocks.txUserUpdate).toHaveBeenCalledWith(expect.objectContaining({
			where:{id:'user-1'},
			data:expect.objectContaining({
				passwordHash:expect.any(String),
				activeSessionId:null,
				activeSessionUpdatedAt:null,
			}),
		}));
		expect(mocks.createNotification).toHaveBeenCalled();
		expect(mocks.txAuditCreate).toHaveBeenCalled();
		expect(mocks.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
			to:'person@example.invalid',
			subject:'Your Aurevia Exchange password was changed',
		}));
	});

	it('rejects a token that loses the atomic single-use claim',async()=>{
		mocks.resetFindUnique.mockResolvedValue({
			id:'reset-1',
			userId:'user-1',
			expiresAt:new Date(Date.now()+60_000),
			consumedAt:null,
		});
		mocks.txResetUpdateMany.mockResolvedValueOnce({count:0});

		const response=await confirmReset(request('/api/password-reset/confirm',{token:'R'.repeat(43),password:'ChangedPassword1'}));

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({error:'This recovery link has already been used or expired.'});
		expect(mocks.txUserUpdate).not.toHaveBeenCalled();
	});
});
