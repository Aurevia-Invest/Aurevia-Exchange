import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	userCreate:vi.fn(),
	waitlistUpdateMany:vi.fn(),
	kycUpsert:vi.fn(),
	transaction:vi.fn(),
	initializePaperAccount:vi.fn(),
	ensureSystemAccount:vi.fn(),
	createNotification:vi.fn(),
	notifyActiveAdmins:vi.fn(),
	rateLimit:vi.fn(),
	akedlyConfigured:vi.fn(),
	emailProviderConfigured:vi.fn(),
}));

vi.mock('@/lib/db',()=>({db:{$transaction:mocks.transaction}}));
vi.mock('@/lib/ledger',()=>({
	ensureSystemAccount:mocks.ensureSystemAccount,
	initializePaperAccount:mocks.initializePaperAccount,
}));
vi.mock('@/lib/notifications',()=>({
	createNotification:mocks.createNotification,
	notifyActiveAdmins:mocks.notifyActiveAdmins,
}));
vi.mock('@/lib/rate-limit',()=>({rateLimit:mocks.rateLimit}));
vi.mock('@/lib/akedly',()=>({akedlyIsConfigured:mocks.akedlyConfigured}));
vi.mock('@/lib/verification-delivery',()=>({hasConfiguredVerificationProvider:mocks.emailProviderConfigured}));

import {POST} from '@/app/api/register/route';

const payload={
	email:'new-user@example.invalid',
	password:'SecureTestPassword1',
	name:'New User',
	country:'United States',
	dateOfBirth:'1990-01-01',
	phone:'',
	accountMode:'DEMO',
	termsAccepted:true,
};

describe('registration provider availability',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		mocks.akedlyConfigured.mockReturnValue(false);
		mocks.emailProviderConfigured.mockReturnValue(false);
		mocks.userCreate.mockResolvedValue({id:'user-1',accountMode:'DEMO'});
		mocks.waitlistUpdateMany.mockResolvedValue({count:0});
		mocks.kycUpsert.mockResolvedValue({});
		mocks.initializePaperAccount.mockResolvedValue(undefined);
		mocks.ensureSystemAccount.mockResolvedValue(undefined);
		mocks.createNotification.mockResolvedValue(undefined);
		mocks.notifyActiveAdmins.mockResolvedValue(undefined);
		mocks.transaction.mockImplementation(async(callback:(tx:unknown)=>Promise<unknown>)=>callback({
			user:{create:mocks.userCreate},
			waitlistEntry:{updateMany:mocks.waitlistUpdateMany},
			kycProfile:{upsert:mocks.kycUpsert},
		}));
	});

	afterEach(()=>vi.unstubAllEnvs());

	it('creates only a pending account when no verification provider is configured',async()=>{
		const response=await POST(new Request('https://aurevia.test/api/register',{
			method:'POST',
			headers:{'content-type':'application/json','x-forwarded-for':'192.0.2.5'},
			body:JSON.stringify(payload),
		}));

		expect(response.status).toBe(201);
		expect(await response.json()).toMatchObject({
			verificationRequired:true,
			authMethod:null,
			message:expect.stringContaining('temporarily unavailable'),
		});
		expect(mocks.userCreate).toHaveBeenCalledWith(expect.objectContaining({
			data:expect.objectContaining({requiresRegistrationVerification:true,email:payload.email}),
		}));
		expect(mocks.initializePaperAccount).toHaveBeenCalledTimes(2);
	});
});
