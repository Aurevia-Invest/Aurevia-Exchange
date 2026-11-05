import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	challenge:null as null|Record<string,unknown>,
	findUnique:vi.fn(),
	upsert:vi.fn(),
	updateMany:vi.fn(),
	deleteMany:vi.fn(),
	sendEmail:vi.fn(),
}));

vi.mock('@/lib/db',()=>({db:{deviceVerificationChallenge:{
	findUnique:mocks.findUnique,
	upsert:mocks.upsert,
	updateMany:mocks.updateMany,
	deleteMany:mocks.deleteMany,
}}}));
vi.mock('@/lib/email',()=>({sendEmail:mocks.sendEmail}));

import {consumeNewDeviceVerificationCode,sendNewDeviceVerificationCode} from '@/lib/device-verification';

describe('new-device email verification',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		mocks.challenge=null;
		vi.stubEnv('NEXTAUTH_SECRET','device-verification-test-secret');
		mocks.findUnique.mockImplementation(async({where}:{where:{userId_deviceFingerprint:{userId:string;deviceFingerprint:string}}})=>{
			if(!mocks.challenge)return null;
			const challenge=mocks.challenge;
			return challenge.userId===where.userId_deviceFingerprint.userId&&challenge.deviceFingerprint===where.userId_deviceFingerprint.deviceFingerprint?challenge:null;
		});
		mocks.upsert.mockImplementation(async({create,update}:{create:Record<string,unknown>;update:Record<string,unknown>})=>{
			mocks.challenge=mocks.challenge?{...mocks.challenge,...update}:{id:'challenge-1',...create,attempts:0};
			return mocks.challenge;
		});
		mocks.updateMany.mockImplementation(async()=>{
			if(mocks.challenge)mocks.challenge={...mocks.challenge,attempts:Number(mocks.challenge.attempts)+1};
			return {count:1};
		});
		mocks.deleteMany.mockImplementation(async()=>{
			const existed=Boolean(mocks.challenge);
			mocks.challenge=null;
			return {count:existed?1:0};
		});
		mocks.sendEmail.mockResolvedValue({sent:true,provider:'smtp'});
	});

	afterEach(()=>vi.unstubAllEnvs());

	it('sends a one-time email code, limits resends, and consumes the code once for its device',async()=>{
		const input={userId:'user-1',email:'person@example.invalid',fingerprint:'device-fingerprint'};
		await expect(sendNewDeviceVerificationCode(input)).resolves.toBe(true);
		expect(mocks.sendEmail).toHaveBeenCalledOnce();
		const code=(mocks.sendEmail.mock.calls[0][0].text as string).match(/\b\d{6}\b/)?.[0];
		expect(code).toMatch(/^\d{6}$/);
		expect(mocks.challenge).toMatchObject({userId:input.userId,deviceFingerprint:input.fingerprint,codeHash:expect.not.stringMatching(new RegExp(code!))});

		await expect(sendNewDeviceVerificationCode(input)).resolves.toBe(true);
		expect(mocks.sendEmail).toHaveBeenCalledOnce();
		await expect(consumeNewDeviceVerificationCode({...input,fingerprint:'another-device',code:code!})).resolves.toBe('MISSING');
		await expect(consumeNewDeviceVerificationCode({...input,code:'000000'})).resolves.toBe('INVALID');
		expect(mocks.challenge).toMatchObject({attempts:1});
		await expect(consumeNewDeviceVerificationCode({...input,code:code!})).resolves.toBe('VERIFIED');
		await expect(consumeNewDeviceVerificationCode({...input,code:code!})).resolves.toBe('MISSING');
	});

	it('removes a challenge and fails closed when email delivery is unavailable',async()=>{
		mocks.sendEmail.mockResolvedValue({sent:false,provider:'none',reason:'not-configured'});
		await expect(sendNewDeviceVerificationCode({userId:'user-1',email:'person@example.invalid',fingerprint:'device-fingerprint'})).resolves.toBe(false);
		expect(mocks.challenge).toBeNull();
	});
});
