import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	requireUser:vi.fn(),
	userFindUniqueOrThrow:vi.fn(),
	userUpdate:vi.fn(),
	kycUpsert:vi.fn(),
	transaction:vi.fn(),
	createNotification:vi.fn(),
	notifyActiveAdmins:vi.fn(),
	enqueueKycEmail:vi.fn(),
}));

vi.mock('@/lib/auth',()=>({requireUser:mocks.requireUser}));
vi.mock('@/lib/db',()=>({db:{$transaction:mocks.transaction}}));
vi.mock('@/lib/notifications',()=>({createNotification:mocks.createNotification,notifyActiveAdmins:mocks.notifyActiveAdmins}));
vi.mock('@/lib/kyc-email-outbox',()=>({enqueueKycEmail:mocks.enqueueKycEmail}));

import {POST} from '@/app/api/kyc/route';

function request(body:unknown){
	return new Request('https://aurevia.test/api/kyc',{
		method:'POST',
		headers:{'content-type':'application/json'},
		body:JSON.stringify(body),
	});
}

describe('Tier 2 KYC submission',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		mocks.requireUser.mockResolvedValue({id:'user-1'});
		mocks.userFindUniqueOrThrow.mockResolvedValue({kycStatus:'PENDING',accountMode:'REAL',status:'ACTIVE'});
		mocks.userUpdate.mockResolvedValue({});
		mocks.kycUpsert.mockResolvedValue({id:'kyc-1',userId:'user-1'});
		mocks.transaction.mockImplementation(async(callback:(tx:unknown)=>Promise<unknown>)=>callback({
			user:{findUniqueOrThrow:mocks.userFindUniqueOrThrow,update:mocks.userUpdate},
			kycProfile:{upsert:mocks.kycUpsert},
		}));
	});

	it('accepts identity information with a residential address without phone OTP or proof-of-address data',async()=>{
		const response=await POST(request({
			legalName:'Ada Example',
			dob:'1990-01-01',
			address:'123 Main Street, Example City',
			idType:'PASSPORT',
			idNumber:'P1234567',
		}));

		expect(response.status).toBe(200);
		expect(mocks.kycUpsert).toHaveBeenCalledWith(expect.objectContaining({
			create:expect.objectContaining({legalName:'Ada Example',address:'123 Main Street, Example City',idType:'PASSPORT',idNumber:'P1234567'}),
		}));
		expect(mocks.userFindUniqueOrThrow).toHaveBeenCalledWith(expect.objectContaining({
			select:{kycStatus:true,accountMode:true,status:true},
		}));
		expect(mocks.userUpdate).toHaveBeenCalledWith({where:{id:'user-1'},data:{kycStatus:'PENDING',verifiedAt:null}});
	});

	it('requires the residential address needed for Tier 3 review',async()=>{
		const response=await POST(request({
			legalName:'Ada Example',
			dob:'1990-01-01',
			idType:'PASSPORT',
			idNumber:'P1234567',
		}));

		expect(response.status).toBe(400);
		expect(mocks.kycUpsert).not.toHaveBeenCalled();
	});
});
