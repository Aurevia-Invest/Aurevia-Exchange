import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {Prisma} from '@prisma/client';

const mocks=vi.hoisted(()=>({
	advisoryLock:vi.fn(),
	userFindFirst:vi.fn(),
	userFindUnique:vi.fn(),
	userCreateMany:vi.fn(),
	userFindUniqueOrThrow:vi.fn(),
	waitlistUpdateMany:vi.fn(),
	kycUpsert:vi.fn(),
	initializePaperAccount:vi.fn(),
}));

vi.mock('@/lib/ledger',()=>({initializePaperAccount:mocks.initializePaperAccount}));

import {createImmediateRegistration} from '@/lib/registration-attempt';

describe('immediate registration account creation',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		mocks.userFindFirst.mockResolvedValue(null);
		mocks.userFindUnique.mockResolvedValue(null);
		mocks.userCreateMany.mockResolvedValue({count:1});
		mocks.userFindUniqueOrThrow.mockResolvedValue({id:'new-user',accountMode:'DEMO'});
		mocks.waitlistUpdateMany.mockResolvedValue({count:0});
		mocks.kycUpsert.mockResolvedValue({});
		mocks.initializePaperAccount.mockResolvedValue(undefined);
	});

	it('creates active accounts without signup email or phone verification',async()=>{
		const tx={
			$executeRaw:mocks.advisoryLock,
			user:{findFirst:mocks.userFindFirst,createMany:mocks.userCreateMany,findUnique:mocks.userFindUnique,findUniqueOrThrow:mocks.userFindUniqueOrThrow},
			waitlistEntry:{updateMany:mocks.waitlistUpdateMany},
			kycProfile:{upsert:mocks.kycUpsert},
		} as unknown as Prisma.TransactionClient;

		await createImmediateRegistration(tx,{
			email:'person@example.invalid',
			passwordHash:'bcrypt-hash',
			name:'Person Example',
			country:'Nigeria',
			gender:'FEMALE',
			phone:'+2348031234567',
			dateOfBirth:new Date('1990-01-01T00:00:00.000Z'),
			accountMode:'DEMO',
			termsAcceptedAt:new Date(),
		});

		expect(mocks.userCreateMany).toHaveBeenCalledWith(expect.objectContaining({
			data:[expect.objectContaining({
				phone:'+2348031234567',
				gender:'FEMALE',
				phoneVerified:false,
				phoneVerifiedAt:null,
				twoFactorEnabled:false,
				status:'ACTIVE',
			})],
			skipDuplicates:true,
		}));
		expect(mocks.initializePaperAccount).toHaveBeenCalledTimes(2);
	});
});
