import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	outboxCreateMany:vi.fn(),
	outboxFindMany:vi.fn(),
	outboxFindUnique:vi.fn(),
	outboxUpdateMany:vi.fn(),
	sendEmail:vi.fn(),
}));

vi.mock('@/lib/db',()=>({db:{kycEmailOutbox:{
	createMany:mocks.outboxCreateMany,
	findMany:mocks.outboxFindMany,
	findUnique:mocks.outboxFindUnique,
	updateMany:mocks.outboxUpdateMany,
}}}));
vi.mock('@/lib/email',()=>({sendEmail:mocks.sendEmail}));

import {KycEmailOutboxStatus} from '@prisma/client';
import {enqueueKycEmail,processKycEmailQueue} from '@/lib/kyc-email-outbox';

describe('KYC email outbox',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		mocks.outboxCreateMany.mockResolvedValue({count:1});
		mocks.outboxFindMany.mockResolvedValue([{id:'email-event-1'}]);
		mocks.outboxFindUnique.mockResolvedValue({
			id:'email-event-1',
			event:'PROFILE_APPROVED',
			attempts:1,
			user:{email:'person@example.invalid'},
		});
		mocks.outboxUpdateMany.mockResolvedValue({count:1});
		mocks.sendEmail.mockResolvedValue({sent:true});
	});

	it('queues status email atomically with a stable deduplication key',async()=>{
		const tx={kycEmailOutbox:{createMany:mocks.outboxCreateMany}};
		await enqueueKycEmail(tx as never,'user-1','PROFILE_SUBMITTED','kyc:submission:1');

		expect(mocks.outboxCreateMany).toHaveBeenCalledWith({
			data:[{userId:'user-1',event:'PROFILE_SUBMITTED',dedupeKey:'kyc:submission:1'}],
			skipDuplicates:true,
		});
	});

	it('sends a generic KYC status notice to the registered email and marks it sent',async()=>{
		const result=await processKycEmailQueue(10,new Date('2026-11-02T12:00:00.000Z'));

		expect(mocks.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
			to:'person@example.invalid',
			subject:'Identity review status updated',
		}));
		expect(mocks.sendEmail.mock.calls[0][0].text).not.toContain('ID number');
		expect(mocks.outboxUpdateMany).toHaveBeenLastCalledWith(expect.objectContaining({
			where:expect.objectContaining({id:'email-event-1',status:KycEmailOutboxStatus.PENDING}),
			data:expect.objectContaining({status:KycEmailOutboxStatus.SENT,sentAt:new Date('2026-11-02T12:00:00.000Z')}),
		}));
		expect(result).toEqual({sent:1,retried:0,failed:0});
	});

	it('retries failed email delivery without changing the KYC decision',async()=>{
		mocks.sendEmail.mockResolvedValue({sent:false,reason:'failed'});

		const result=await processKycEmailQueue(10,new Date('2026-11-02T12:00:00.000Z'));

		expect(result).toEqual({sent:0,retried:1,failed:0});
		expect(mocks.outboxUpdateMany).toHaveBeenLastCalledWith(expect.objectContaining({
			data:expect.objectContaining({
				status:KycEmailOutboxStatus.PENDING,
				lockedAt:null,
				lastErrorCode:'EMAIL_DELIVERY_FAILED',
			}),
		}));
	});
});
