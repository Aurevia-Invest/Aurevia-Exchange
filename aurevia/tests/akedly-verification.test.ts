import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	challengeFindFirst:vi.fn(),
	transactionFindFirst:vi.fn(),
	transaction:vi.fn(),
	userUpdateMany:vi.fn(),
	userFindUnique:vi.fn(),
	auditCreate:vi.fn(),
	createNotification:vi.fn(),
}));

vi.mock('@/lib/db',()=>({db:{
	verificationCode:{findFirst:mocks.challengeFindFirst},
	$transaction:mocks.transaction,
}}));
vi.mock('@/lib/notifications',()=>({createNotification:mocks.createNotification}));

import {VerificationChannel} from '@prisma/client';
import {completeAkedlyVerification} from '@/lib/akedly-verification';

const attemptId='attempt_1234567890';

function providerResult(verificationAddress:Record<string,string>={phoneNumber:'+2348031234567'}){
	const now=new Date().toISOString();
	return {
		status:'success',
		widgetAttempt:{attemptId,widgetId:'test-widget',status:'verified',isTest:false,completedAt:now},
		transaction:{status:'Successful',isTest:false,pipelineID:'test-pipeline',updateDate:now,verificationAddress},
	};
}

describe('Tier 3 Akedly phone verification persistence',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		for(const [name,value] of Object.entries({
			AKEDLY_ENABLED:'true',
			AKEDLY_API_KEY:'test-api-key',
			AKEDLY_PIPELINE_ID:'test-pipeline',
			AKEDLY_WIDGET_ID:'test-widget',
			AKEDLY_PUBLIC_KEY:'test-public-key',
			AKEDLY_WIDGET_SECRET:'test-widget-secret',
			AKEDLY_WEBHOOK_SECRET:`whsec_${Buffer.from('test-webhook-secret').toString('base64')}`,
		}))vi.stubEnv(name,value);
		mocks.challengeFindFirst.mockResolvedValue({
			id:'challenge-1',
			userId:'user-1',
			channel:VerificationChannel.SMS,
			providerReference:`AKEDLY:${attemptId}`,
			createdAt:new Date(),
			expiresAt:new Date(Date.now()+5*60_000),
			user:{id:'user-1',phone:'+2348031234567',role:'USER',status:'ACTIVE',accountMode:'REAL',phoneVerified:false},
		});
		mocks.transactionFindFirst.mockResolvedValue({id:'challenge-1'});
		mocks.userUpdateMany.mockResolvedValueOnce({count:1}).mockResolvedValueOnce({count:0});
		mocks.userFindUnique.mockResolvedValue({phone:'+2348031234567',phoneVerified:true});
		mocks.auditCreate.mockResolvedValue({});
		mocks.createNotification.mockResolvedValue({});
		const tx={
			verificationCode:{findFirst:mocks.transactionFindFirst},
			user:{updateMany:mocks.userUpdateMany,findUnique:mocks.userFindUnique},
			auditLog:{create:mocks.auditCreate},
		};
		mocks.transaction.mockImplementation(async(callback:(value:unknown)=>Promise<unknown>)=>callback(tx));
	});

	afterEach(()=>vi.unstubAllEnvs());

	it('marks the bound phone verified once and handles duplicate provider results idempotently',async()=>{
		const result=providerResult();

		expect(await completeAkedlyVerification(attemptId,result,'webhook')).toBe('verified');
		expect(await completeAkedlyVerification(attemptId,result,'webhook')).toBe('already');
		expect(mocks.userUpdateMany).toHaveBeenCalledTimes(2);
		expect(mocks.userUpdateMany.mock.calls[0][0]).toMatchObject({
			where:{id:'user-1',role:'USER',status:'ACTIVE',accountMode:'REAL',phone:'+2348031234567',phoneVerified:false},
			data:{phoneVerified:true,phoneVerifiedAt:expect.any(Date)},
		});
		expect(mocks.createNotification).toHaveBeenCalledTimes(1);
		expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
		expect(mocks.auditCreate.mock.calls[0][0].data.action).toBe('AKEDLY_PHONE_VERIFIED');
	});

	it('does not verify a test-mode, expired, or differently bound phone attempt',async()=>{
		const valid=providerResult();
		const testModeResult={...valid,transaction:{...valid.transaction,isTest:true}};
		const expiredAt=new Date(Date.now()+6*60_000).toISOString();
		const expiredResult={...valid,widgetAttempt:{...valid.widgetAttempt,completedAt:expiredAt},transaction:{...valid.transaction,updateDate:expiredAt}};

		expect(await completeAkedlyVerification(attemptId,testModeResult,'webhook')).toBe('ignored');
		expect(await completeAkedlyVerification(attemptId,expiredResult,'webhook')).toBe('ignored');
		expect(await completeAkedlyVerification(attemptId,providerResult({phoneNumber:'+2348039999999'}),'webhook')).toBe('ignored');
		expect(mocks.userUpdateMany).not.toHaveBeenCalled();
		expect(mocks.auditCreate).not.toHaveBeenCalled();
	});

	it('ignores legacy email-channel verification attempts',async()=>{
		mocks.challengeFindFirst.mockResolvedValueOnce({
			id:'legacy-challenge',
			channel:VerificationChannel.EMAIL,
			user:{id:'user-1',email:'person@example.invalid',phone:null,role:'USER',status:'ACTIVE',accountMode:'REAL',phoneVerified:false},
		});

		expect(await completeAkedlyVerification(attemptId,providerResult(),'webhook')).toBe('ignored');
		expect(mocks.userUpdateMany).not.toHaveBeenCalled();
	});
});
