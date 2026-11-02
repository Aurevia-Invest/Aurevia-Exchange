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

const environment={
	AKEDLY_ENABLED:'true',
	AKEDLY_API_KEY:'test-api-key',
	AKEDLY_PIPELINE_ID:'test-pipeline',
	AKEDLY_WIDGET_ID:'test-widget',
	AKEDLY_PUBLIC_KEY:'test-public-key',
	AKEDLY_WIDGET_SECRET:'test-widget-secret',
	AKEDLY_WEBHOOK_SECRET:`whsec_${Buffer.from('test-webhook-secret').toString('base64')}`,
};

function providerResult(attemptId:string){
	const now=new Date().toISOString();
	return {
		status:'success',
		widgetAttempt:{attemptId,widgetId:'test-widget',status:'verified',isTest:false,completedAt:now},
		transaction:{status:'Successful',isTest:false,pipelineID:'test-pipeline',updateDate:now,verificationAddress:{email:'person@example.invalid'}},
	};
}

describe('Akedly verification persistence',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		for(const [name,value] of Object.entries(environment))vi.stubEnv(name,value);
		const attemptId='attempt_1234567890';
		const challenge={
			id:'challenge-1',
			userId:'user-1',
			channel:VerificationChannel.EMAIL,
			providerReference:`AKEDLY:${attemptId}`,
			createdAt:new Date(),
			expiresAt:new Date(Date.now()+5*60_000),
			user:{
				id:'user-1',
				email:'person@example.invalid',
				phone:null,
				role:'USER',
				status:'ACTIVE',
				accountMode:'DEMO',
				phoneVerified:false,
				emailVerifiedAt:null,
				requiresRegistrationVerification:true,
			},
		};
		mocks.challengeFindFirst.mockResolvedValue(challenge);
		mocks.transactionFindFirst.mockResolvedValue({id:'challenge-1'});
		mocks.userUpdateMany.mockResolvedValueOnce({count:1}).mockResolvedValueOnce({count:0});
		mocks.userFindUnique.mockResolvedValue({
			emailVerifiedAt:new Date(),
			verifiedChannel:VerificationChannel.EMAIL,
			requiresRegistrationVerification:false,
		});
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

	it('processes duplicate verified webhooks idempotently and records side effects once',async()=>{
		const attemptId='attempt_1234567890';
		const result=providerResult(attemptId);

		expect(await completeAkedlyVerification(attemptId,result,'webhook')).toBe('verified');
		expect(await completeAkedlyVerification(attemptId,result,'webhook')).toBe('already');

		expect(mocks.userUpdateMany).toHaveBeenCalledTimes(2);
		expect(mocks.createNotification).toHaveBeenCalledTimes(1);
		expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(mocks.auditCreate.mock.calls)).not.toContain('person@example.invalid');
	});

	it('does not verify a test-mode or expired attempt',async()=>{
		const attemptId='attempt_1234567890';
		const testModeResult={...providerResult(attemptId),transaction:{...providerResult(attemptId).transaction,isTest:true}};
		const expiredAt=new Date(Date.now()+6*60_000).toISOString();
		const expiredResult={...providerResult(attemptId),widgetAttempt:{...providerResult(attemptId).widgetAttempt,completedAt:expiredAt},transaction:{...providerResult(attemptId).transaction,updateDate:expiredAt}};
		expect(await completeAkedlyVerification(attemptId,testModeResult,'webhook')).toBe('ignored');
		expect(await completeAkedlyVerification(attemptId,expiredResult,'webhook')).toBe('ignored');
		expect(mocks.userUpdateMany).not.toHaveBeenCalled();
		expect(mocks.auditCreate).not.toHaveBeenCalled();
	});
});
