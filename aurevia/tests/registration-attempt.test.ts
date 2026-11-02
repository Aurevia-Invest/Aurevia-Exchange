import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {Prisma} from '@prisma/client';

const mocks=vi.hoisted(()=>({
	attemptFindUnique:vi.fn(),
	advisoryLock:vi.fn(),
	userFindFirst:vi.fn(),
	attemptFindFirst:vi.fn(),
	attemptDeleteMany:vi.fn(),
	userCreateMany:vi.fn(),
	userFindUnique:vi.fn(),
	userFindUniqueOrThrow:vi.fn(),
	waitlistUpdateMany:vi.fn(),
	kycUpsert:vi.fn(),
	createNotification:vi.fn(),
	notifyActiveAdmins:vi.fn(),
	initializePaperAccount:vi.fn(),
	ensureSystemAccount:vi.fn(),
}));

vi.mock('@/lib/notifications',()=>({createNotification:mocks.createNotification,notifyActiveAdmins:mocks.notifyActiveAdmins}));
vi.mock('@/lib/ledger',()=>({initializePaperAccount:mocks.initializePaperAccount,ensureSystemAccount:mocks.ensureSystemAccount}));

import {VerificationChannel} from '@prisma/client';
import {createVerifiedRegistration} from '@/lib/registration-attempt';

describe('phone-verified registration account creation',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		mocks.attemptFindUnique.mockResolvedValue({
			id:'registration-1',
			email:'person@example.invalid',
			passwordHash:'bcrypt-hash',
			name:'Person Example',
			country:'Nigeria',
			phone:'+2348031234567',
			dateOfBirth:new Date('1990-01-01T00:00:00.000Z'),
			accountMode:'DEMO',
			termsAcceptedAt:new Date(),
			expiresAt:new Date(Date.now()+60_000),
		});
		mocks.userFindFirst.mockResolvedValue(null);
		mocks.attemptFindFirst.mockResolvedValue(null);
		mocks.attemptDeleteMany.mockResolvedValue({count:1});
		mocks.userCreateMany.mockResolvedValue({count:1});
		mocks.userFindUnique.mockResolvedValue(null);
		mocks.userFindUniqueOrThrow.mockResolvedValue({id:'new-user',accountMode:'DEMO'});
		mocks.waitlistUpdateMany.mockResolvedValue({count:0});
		mocks.kycUpsert.mockResolvedValue({});
		mocks.createNotification.mockResolvedValue({});
		mocks.notifyActiveAdmins.mockResolvedValue(undefined);
		mocks.initializePaperAccount.mockResolvedValue(undefined);
		mocks.ensureSystemAccount.mockResolvedValue(undefined);
	});

	it('creates financial accounts only after phone verification and leaves email unverified',async()=>{
		const tx={
			registrationAttempt:{findUnique:mocks.attemptFindUnique,deleteMany:mocks.attemptDeleteMany,findFirst:mocks.attemptFindFirst},
			$executeRaw:mocks.advisoryLock,
			user:{findFirst:mocks.userFindFirst,createMany:mocks.userCreateMany,findUnique:mocks.userFindUnique,findUniqueOrThrow:mocks.userFindUniqueOrThrow},
			waitlistEntry:{updateMany:mocks.waitlistUpdateMany},
			kycProfile:{upsert:mocks.kycUpsert},
		} as unknown as Prisma.TransactionClient;

		await createVerifiedRegistration(tx,'registration-1',VerificationChannel.SMS);

		expect(mocks.userCreateMany).toHaveBeenCalledWith(expect.objectContaining({
			data:[expect.objectContaining({
				phone:'+2348031234567',
				phoneVerified:true,
				phoneVerifiedAt:expect.any(Date),
				emailVerifiedAt:null,
				verifiedChannel:VerificationChannel.SMS,
				requiresRegistrationVerification:false,
			})],
			skipDuplicates:true,
		}));
		expect(mocks.attemptDeleteMany).toHaveBeenCalledOnce();
		expect(mocks.initializePaperAccount).toHaveBeenCalledTimes(2);
		expect(mocks.createNotification).toHaveBeenNthCalledWith(2,tx,expect.objectContaining({
			title:'Phone number verified',
			message:expect.stringContaining('phone number was verified'),
		}));
		expect(JSON.stringify(mocks.createNotification.mock.calls)).not.toContain('email address was verified');
	});
});
