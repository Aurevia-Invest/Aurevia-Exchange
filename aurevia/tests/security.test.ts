import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {Prisma} from '@prisma/client';
import {generate,generateSecret} from 'otplib';
import bcrypt from 'bcryptjs';

const mocks=vi.hoisted(()=>({
	queryRaw:vi.fn(),
	securityRecoveryFindMany:vi.fn(),
	securityRecoveryUpdateMany:vi.fn(),
	userUpdateMany:vi.fn(),
	userFindUnique:vi.fn(),
	securityRateLimitDeleteMany:vi.fn(),
}));

vi.mock('@/lib/db',()=>({db:{
	$queryRaw:mocks.queryRaw,
	user:{findUnique:mocks.userFindUnique},
	securityRateLimit:{deleteMany:mocks.securityRateLimitDeleteMany},
}}));
vi.mock('@/lib/notifications',()=>({createNotification:vi.fn()}));

import {consumeSecondFactor,verifyAccountCredentials} from '@/lib/security-auth';
import {encryptTotpSecret,createRecoveryCode,decryptTotpSecret,hashSessionId,verifyRecoveryCode,verifyTotp} from '@/lib/security';
import {persistentRateLimit} from '@/lib/security-rate-limit';

describe('security cryptography',()=>{
	beforeEach(()=>vi.stubEnv('TOTP_ENCRYPTION_KEY',Buffer.alloc(32,9).toString('base64')));
	afterEach(()=>vi.unstubAllEnvs());

	it('encrypts authenticator secrets with authenticated encryption',()=>{
		const secret=generateSecret();
		const encrypted=encryptTotpSecret(secret);
		expect(encrypted).not.toContain(secret);
		expect(decryptTotpSecret(encrypted)).toBe(secret);
	});

	it('validates compatible six-digit TOTP codes and rejects malformed codes',async()=>{
		const secret=generateSecret();
		const code=await generate({secret});
		expect(await verifyTotp(secret,code)).not.toBeNull();
		expect(await verifyTotp(secret,'12x456')).toBeNull();
	});

	it('rejects repeated use of the same accepted authenticator time step',async()=>{
		const secret=generateSecret();
		const code=await generate({secret});
		const counter=await verifyTotp(secret,code);
		if(counter===null)throw new Error('Generated TOTP code did not verify.');
		mocks.userUpdateMany.mockResolvedValueOnce({count:1}).mockResolvedValueOnce({count:0});
		mocks.securityRecoveryFindMany.mockResolvedValue([]);
		const tx={
			user:{updateMany:mocks.userUpdateMany},
			securityRecoveryCode:{findMany:mocks.securityRecoveryFindMany,updateMany:mocks.securityRecoveryUpdateMany},
		} as unknown as Prisma.TransactionClient;
		const secretEncrypted=encryptTotpSecret(secret);

		await expect(consumeSecondFactor(tx,{userId:'user-1',secretEncrypted,lastTotpCounter:null,code})).resolves.toBe(true);
		await expect(consumeSecondFactor(tx,{userId:'user-1',secretEncrypted,lastTotpCounter:BigInt(counter),code})).resolves.toBe(false);
	});

	it('accepts a recovery code only in its normalized form',async()=>{
		const code=createRecoveryCode();
		const hash=await bcrypt.hash(code.replace(/-/g,''),4);
		expect(await verifyRecoveryCode(code.toLowerCase(),hash)).toBe(true);
		expect(await verifyRecoveryCode(code,hash)).toBe(true);
		expect(await verifyRecoveryCode('AAAAAAAA-AAAAAAAA',hash)).toBe(false);
	});

	it('allows password verification for sensitive actions without a second-factor code',async()=>{
		mocks.queryRaw.mockResolvedValue([{count:1,resetAt:new Date(Date.now()+60_000)}]);
		mocks.userFindUnique.mockResolvedValue({
			id:'user-1',
			status:'ACTIVE',
			passwordHash:await bcrypt.hash('StrongPassword42',4),
			twoFactorEnabled:true,
			totpSecretEncrypted:encryptTotpSecret(generateSecret()),
		});

		await expect(verifyAccountCredentials({userId:'user-1',password:'StrongPassword42'})).resolves.toBe(true);
	});

	it('stores only hashed security rate-limit keys and enforces the returned bucket count',async()=>{
		mocks.queryRaw.mockResolvedValue([{count:3,resetAt:new Date(Date.now()+60_000)}]);
		await expect(persistentRateLimit('reauth:user@example.invalid',2,60_000)).rejects.toMatchObject({message:'RATE_LIMITED'});
		expect(JSON.stringify(mocks.queryRaw.mock.calls)).not.toContain('user@example.invalid');
	});

	it('uses non-reversible session references',()=>{
		const sessionId='sensitive-random-session-id';
		expect(hashSessionId(sessionId)).toHaveLength(64);
		expect(hashSessionId(sessionId)).not.toContain(sessionId);
	});
});
