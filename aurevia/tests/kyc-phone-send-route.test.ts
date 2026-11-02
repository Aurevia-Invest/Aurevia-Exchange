import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	requireUser:vi.fn(),
	userFindUnique:vi.fn(),
	userUpdate:vi.fn(),
	codeFindUnique:vi.fn(),
	codeCreate:vi.fn(),
	codeUpdateMany:vi.fn(),
	transaction:vi.fn(),
	akedlyConfigured:vi.fn(),
	startAkedly:vi.fn(),
	hasConfiguredTermii:vi.fn(),
	hashCode:vi.fn(),
	sendTermii:vi.fn(),
	rateLimit:vi.fn(),
}));

vi.mock('@/lib/auth',()=>({requireUser:mocks.requireUser}));
vi.mock('@/lib/db',()=>({db:{
	user:{findUnique:mocks.userFindUnique,update:mocks.userUpdate},
	verificationCode:{
		findUnique:mocks.codeFindUnique,
		create:mocks.codeCreate,
		updateMany:mocks.codeUpdateMany,
	},
	$transaction:mocks.transaction,
}}));
vi.mock('@/lib/akedly',()=>({akedlyIsConfigured:mocks.akedlyConfigured}));
vi.mock('@/lib/akedly-verification',()=>({startAkedlyVerification:mocks.startAkedly}));
vi.mock('@/lib/verification-delivery',()=>({
	hasConfiguredTermii:mocks.hasConfiguredTermii,
	hashVerificationCode:mocks.hashCode,
	sendTermiiVerificationToken:mocks.sendTermii,
}));
vi.mock('@/lib/rate-limit',()=>({rateLimit:mocks.rateLimit}));

import {POST} from '@/app/api/kyc/phone/send/route';

function request(delivery?:'automatic'|'termii'){
	return new Request('https://aurevia.test/api/kyc/phone/send',{
		method:'POST',
		headers:{'content-type':'application/json','x-forwarded-for':'192.0.2.6'},
		body:JSON.stringify({phone:'+12125550123',...(delivery?{delivery}:{})}),
	});
}

describe('phone verification provider fallback',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		mocks.requireUser.mockResolvedValue({id:'user-1'});
		mocks.userFindUnique.mockResolvedValue({id:'user-1',phone:null,phoneVerified:false,accountMode:'REAL',status:'ACTIVE'});
		mocks.userUpdate.mockResolvedValue({});
		mocks.codeFindUnique.mockResolvedValue(null);
		mocks.codeCreate.mockResolvedValue({});
		mocks.codeUpdateMany.mockResolvedValue({count:1});
		mocks.transaction.mockImplementation(async(callback:(tx:unknown)=>Promise<unknown>)=>callback({
			verificationCode:{create:mocks.codeCreate},
			user:{update:mocks.userUpdate},
		}));
		mocks.akedlyConfigured.mockReturnValue(true);
		mocks.startAkedly.mockRejectedValue(new Error('AKEDLY_PROVIDER_UNAVAILABLE'));
		mocks.hasConfiguredTermii.mockReturnValue(true);
		mocks.hashCode.mockReturnValue('hashed-reservation');
		mocks.sendTermii.mockResolvedValue('termii-pin-reference');
	});

	afterEach(()=>vi.unstubAllEnvs());

	it('falls back to the configured SMS provider when Akedly is unavailable',async()=>{
		const response=await POST(request());

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({message:'A verification code was sent to your phone.'});
		expect(mocks.startAkedly).toHaveBeenCalledOnce();
		expect(mocks.sendTermii).toHaveBeenCalledWith('+12125550123');
		expect(mocks.codeCreate).toHaveBeenCalledWith(expect.objectContaining({
			data:expect.objectContaining({userId:'user-1',channel:'SMS'}),
		}));
	});

	it('does not switch providers while an Akedly attempt is cooling down',async()=>{
		mocks.startAkedly.mockRejectedValue(new Error('AKEDLY_RESEND_COOLDOWN'));
		mocks.codeFindUnique.mockResolvedValue({resendAfter:new Date(Date.now()+60_000)});
		const response=await POST(request());

		expect(response.status).toBe(429);
		expect(mocks.sendTermii).not.toHaveBeenCalled();
	});

	it('offers a configured Termii SMS fallback when Akedly starts successfully',async()=>{
		mocks.startAkedly.mockResolvedValue({
			attemptId:'attempt-12345678',
			iframeUrl:'https://auth.akedly.io/widget?attemptId=attempt-12345678',
			expiresAt:new Date(Date.now()+5*60_000),
		});

		const response=await POST(request());

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			provider:'akedly',
			termiiFallbackAvailable:true,
			resendAfterSeconds:expect.any(Number),
		});
		expect(mocks.sendTermii).not.toHaveBeenCalled();
	});

	it('sends a requested Termii code without starting another Akedly attempt',async()=>{
		const response=await POST(request('termii'));

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({message:'A verification code was sent to your phone.'});
		expect(mocks.startAkedly).not.toHaveBeenCalled();
		expect(mocks.sendTermii).toHaveBeenCalledWith('+12125550123');
	});
});
