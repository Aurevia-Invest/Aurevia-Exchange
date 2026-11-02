import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	userFindUnique:vi.fn(),
	codeFindUnique:vi.fn(),
	codeDeleteMany:vi.fn(),
	codeUpdateMany:vi.fn(),
	registrationAttemptFindUnique:vi.fn(),
	registrationAttemptDeleteMany:vi.fn(),
	matches:vi.fn(),
	transaction:vi.fn(),
	txDeleteMany:vi.fn(),
	txUserUpdate:vi.fn(),
	txRegistrationVerificationDeleteMany:vi.fn(),
	txRegistrationAttemptFindUnique:vi.fn(),
	txRegistrationAttemptDeleteMany:vi.fn(),
	txUserCreateMany:vi.fn(),
	txUserFindFirst:vi.fn(),
	txRegistrationAttemptFindFirst:vi.fn(),
	txUserFindUnique:vi.fn(),
	txUserFindUniqueOrThrow:vi.fn(),
	txExecuteRaw:vi.fn(),
	txWaitlistUpdateMany:vi.fn(),
	txKycUpsert:vi.fn(),
	createNotification:vi.fn(),
	notifyActiveAdmins:vi.fn(),
	initializePaperAccount:vi.fn(),
	ensureSystemAccount:vi.fn(),
	rateLimit:vi.fn(),
}));

vi.mock('@/lib/db',()=>({db:{
	user:{findUnique:mocks.userFindUnique},
	verificationCode:{
		findUnique:mocks.codeFindUnique,
		deleteMany:mocks.codeDeleteMany,
		updateMany:mocks.codeUpdateMany,
	},
	registrationAttempt:{
		findUnique:mocks.registrationAttemptFindUnique,
		deleteMany:mocks.registrationAttemptDeleteMany,
	},
	$transaction:mocks.transaction,
}}));
vi.mock('@/lib/verification-delivery',()=>({verificationCodeMatches:mocks.matches}));
vi.mock('@/lib/notifications',()=>({createNotification:mocks.createNotification,notifyActiveAdmins:mocks.notifyActiveAdmins}));
vi.mock('@/lib/ledger',()=>({initializePaperAccount:mocks.initializePaperAccount,ensureSystemAccount:mocks.ensureSystemAccount}));
vi.mock('@/lib/rate-limit',()=>({rateLimit:mocks.rateLimit}));

import {POST} from '@/app/api/register/verify/route';
import {VerificationChannel} from '@prisma/client';

const user={id:'user-1',emailVerifiedAt:null,requiresRegistrationVerification:true};
const challenge={
	id:'challenge-1',
	userId:user.id,
	channel:VerificationChannel.EMAIL,
	providerReference:null,
	codeHash:'secure-hash',
	expiresAt:new Date(Date.now()+60_000),
	attempts:0,
};
const registrationToken='a'.repeat(43);
const registration={
	id:'registration-1',
	email:'person@example.invalid',
	passwordHash:'bcrypt-hash',
	name:'Person Example',
	country:'United States',
	phone:'+12025550123',
	dateOfBirth:new Date('1990-01-01T00:00:00.000Z'),
	accountMode:'DEMO',
	termsAcceptedAt:new Date(),
	createdAt:new Date('2026-02-03T00:00:00.000Z'),
	expiresAt:new Date(Date.now()+60_000),
	verification:{...challenge,registrationAttemptId:'registration-1'},
};

function request(code='123456',withRegistrationSession=false){
	return new Request('https://aurevia.test/api/register/verify',{
		method:'POST',
		headers:{
			'content-type':'application/json',
			'x-forwarded-for':'192.0.2.4',
			...(withRegistrationSession?{cookie:`aurevia_registration=${registrationToken}`}:{})
		},
		body:JSON.stringify({email:'person@example.invalid',code}),
	});
}

describe('registration email-code verification',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		mocks.userFindUnique.mockResolvedValue(user);
		mocks.codeFindUnique.mockResolvedValue(challenge);
		mocks.codeDeleteMany.mockResolvedValue({count:1});
		mocks.codeUpdateMany.mockResolvedValue({count:1});
		mocks.matches.mockReturnValue(true);
		mocks.txDeleteMany.mockResolvedValue({count:1});
		mocks.txUserUpdate.mockResolvedValue({});
		mocks.createNotification.mockResolvedValue({});
		mocks.registrationAttemptFindUnique.mockResolvedValue({...registration});
		mocks.registrationAttemptDeleteMany.mockResolvedValue({count:1});
		mocks.txRegistrationVerificationDeleteMany.mockResolvedValue({count:1});
		mocks.txRegistrationAttemptFindUnique.mockResolvedValue(registration);
		mocks.txRegistrationAttemptDeleteMany.mockResolvedValue({count:1});
		mocks.txUserCreateMany.mockResolvedValue({count:1});
		mocks.txUserFindFirst.mockResolvedValue(null);
		mocks.txRegistrationAttemptFindFirst.mockResolvedValue(null);
		mocks.txUserFindUnique.mockResolvedValue(null);
		mocks.txUserFindUniqueOrThrow.mockResolvedValue({id:'created-user-1',accountMode:'DEMO'});
		mocks.txExecuteRaw.mockResolvedValue(1);
		mocks.txWaitlistUpdateMany.mockResolvedValue({count:0});
		mocks.txKycUpsert.mockResolvedValue({});
		mocks.notifyActiveAdmins.mockResolvedValue(undefined);
		mocks.initializePaperAccount.mockResolvedValue(undefined);
		mocks.ensureSystemAccount.mockResolvedValue(undefined);
		mocks.transaction.mockImplementation(async(callback:(tx:unknown)=>Promise<unknown>)=>callback({
			verificationCode:{deleteMany:mocks.txDeleteMany},
			registrationVerification:{deleteMany:mocks.txRegistrationVerificationDeleteMany},
			waitlistEntry:{updateMany:mocks.txWaitlistUpdateMany},
			kycProfile:{upsert:mocks.txKycUpsert},
			$executeRaw:mocks.txExecuteRaw,
			registrationAttempt:{
				findUnique:mocks.txRegistrationAttemptFindUnique,
				findFirst:mocks.txRegistrationAttemptFindFirst,
				deleteMany:mocks.txRegistrationAttemptDeleteMany,
			},
			user:{update:mocks.txUserUpdate,createMany:mocks.txUserCreateMany,findFirst:mocks.txUserFindFirst,findUnique:mocks.txUserFindUnique,findUniqueOrThrow:mocks.txUserFindUniqueOrThrow},
		}));
	});

	afterEach(()=>vi.unstubAllEnvs());

	it('consumes a valid email-bound code and verifies the account atomically',async()=>{
		const response=await POST(request());

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({verified:true});
		expect(mocks.matches).toHaveBeenCalledWith(user.id,'123456',challenge.codeHash);
		expect(mocks.txDeleteMany).toHaveBeenCalledWith(expect.objectContaining({
			where:expect.objectContaining({id:challenge.id,codeHash:challenge.codeHash}),
		}));
		expect(mocks.txUserUpdate).toHaveBeenCalledWith(expect.objectContaining({
			where:{id:user.id},
			data:expect.objectContaining({requiresRegistrationVerification:false,verifiedChannel:VerificationChannel.EMAIL}),
		}));
	});

	it('rejects expired codes and deletes only the expired challenge',async()=>{
		mocks.codeFindUnique.mockResolvedValue({...challenge,expiresAt:new Date(Date.now()-1000)});
		const response=await POST(request());

		expect(response.status).toBe(410);
		expect(mocks.codeDeleteMany).toHaveBeenCalledWith({where:{id:challenge.id,expiresAt:{lte:expect.any(Date)}}});
		expect(mocks.matches).not.toHaveBeenCalled();
	});

	it('counts incorrect codes and stops once the configured attempt limit is reached',async()=>{
		mocks.matches.mockReturnValue(false);
		mocks.codeFindUnique.mockResolvedValueOnce(challenge).mockResolvedValueOnce({attempts:1});
		const response=await POST(request('000000'));

		expect(response.status).toBe(400);
		expect(mocks.codeUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
			where:expect.objectContaining({id:challenge.id,attempts:{lt:5}}),
			data:{attempts:{increment:1}},
		}));

		vi.clearAllMocks();
		mocks.userFindUnique.mockResolvedValue(user);
		mocks.codeFindUnique.mockResolvedValue({...challenge,attempts:5});
		const exhausted=await POST(request('000000'));
		expect(exhausted.status).toBe(429);
		expect(mocks.matches).not.toHaveBeenCalled();
	});

	it('does not accept an email code while an Akedly attempt is current',async()=>{
		mocks.codeFindUnique.mockResolvedValue({...challenge,providerReference:'AKEDLY:attempt_1234567890'});
		const response=await POST(request());

		expect(response.status).toBe(409);
		expect(mocks.matches).not.toHaveBeenCalled();
		expect(mocks.transaction).not.toHaveBeenCalled();
	});

	it('prevents concurrent reuse when the challenge was already consumed',async()=>{
		mocks.txDeleteMany.mockResolvedValue({count:0});
		const response=await POST(request());

		expect(response.status).toBe(409);
		expect(mocks.txUserUpdate).not.toHaveBeenCalled();
	});

	it('creates a permanent account only after email verification, preserving an optional phone number',async()=>{
		const response=await POST(request('123456',true));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({verified:true});
		expect(mocks.txRegistrationVerificationDeleteMany).toHaveBeenCalledWith(expect.objectContaining({
			where:expect.objectContaining({id:registration.verification.id,codeHash:challenge.codeHash}),
		}));
		expect(mocks.txRegistrationAttemptDeleteMany).toHaveBeenCalledOnce();
		expect(mocks.txUserCreateMany).toHaveBeenCalledWith(expect.objectContaining({
			data:[expect.objectContaining({
				email:registration.email,
				phone:registration.phone,
				aureviaExchangeId:expect.stringMatching(/^AEX-2026-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/),
				emailVerifiedAt:expect.any(Date),
				verifiedChannel:VerificationChannel.EMAIL,
				requiresRegistrationVerification:false,
			})],
			skipDuplicates:true,
		}));
		expect(mocks.initializePaperAccount).toHaveBeenCalledTimes(2);
		expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
	});

	it('deletes the temporary registration immediately after an incorrect code without creating an account',async()=>{
		mocks.matches.mockReturnValue(false);
		const response=await POST(request('000000',true));

		expect(response.status).toBe(400);
		expect(mocks.registrationAttemptDeleteMany).toHaveBeenCalledWith({where:{id:registration.id}});
		expect(mocks.txUserCreateMany).not.toHaveBeenCalled();
		expect(mocks.initializePaperAccount).not.toHaveBeenCalled();
		expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
	});

	it('deletes an expired temporary registration before any permanent account is created',async()=>{
		mocks.registrationAttemptFindUnique.mockResolvedValue({
			...registration,
			expiresAt:new Date(Date.now()-1000),
		});
		const response=await POST(request('123456',true));

		expect(response.status).toBe(410);
		expect(mocks.registrationAttemptDeleteMany).toHaveBeenCalledWith({where:{id:registration.id}});
		expect(mocks.transaction).not.toHaveBeenCalled();
		expect(mocks.initializePaperAccount).not.toHaveBeenCalled();
	});

	it('rejects a phone number claimed by another user before permanent account creation',async()=>{
		mocks.txUserFindFirst.mockResolvedValue({id:'another-user'});
		const response=await POST(request('123456',true));

		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({code:'PHONE_ALREADY_IN_USE'});
		expect(mocks.txExecuteRaw).toHaveBeenCalledOnce();
		expect(mocks.txUserCreateMany).not.toHaveBeenCalled();
		expect(mocks.initializePaperAccount).not.toHaveBeenCalled();
		expect(mocks.registrationAttemptDeleteMany).toHaveBeenCalledWith({where:{id:registration.id}});
	});

	it('invalidates the temporary session when a malformed verification code is submitted',async()=>{
		const response=await POST(request('not-a-code',true));

		expect(response.status).toBe(400);
		expect(mocks.registrationAttemptDeleteMany).toHaveBeenCalledWith({where:{id:registration.id}});
		expect(mocks.txUserCreateMany).not.toHaveBeenCalled();
		expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
	});
});
