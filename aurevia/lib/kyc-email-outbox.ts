import {KycEmailOutboxStatus,Prisma} from '@prisma/client';
import {db} from '@/lib/db';
import {sendEmail} from '@/lib/email';

export type KycEmailEvent=
	|'PROFILE_SUBMITTED'
	|'DOCUMENT_SUBMITTED'
	|'PROFILE_APPROVED'
	|'PROFILE_REJECTED'
	|'PROFILE_NEEDS_CHANGES'
	|'PROFILE_STATUS_UPDATED'
	|'DOCUMENT_APPROVED'
	|'DOCUMENT_REJECTED'
	|'DOCUMENT_NEEDS_CHANGES'
	|'DOCUMENT_REVIEWED';

const EMAIL_CONTENT:Record<KycEmailEvent,{subject:string;text:string}>={
	PROFILE_SUBMITTED:{
		subject:'Identity review submission received',
		text:'We received your identity review submission. An administrator will review it and update your account when a decision is recorded.',
	},
	DOCUMENT_SUBMITTED:{
		subject:'Identity document received',
		text:'We received your identity document for administrator review. We will email you when its review status is updated.',
	},
	PROFILE_APPROVED:{
		subject:'Identity review status updated',
		text:'An administrator recorded an approval decision for your identity profile. This message reports the recorded decision; it does not itself approve or change your account.',
	},
	PROFILE_REJECTED:{
		subject:'Identity review status updated',
		text:'An administrator recorded a rejection decision for your identity profile. Sign in securely to review your account status or contact support.',
	},
	PROFILE_NEEDS_CHANGES:{
		subject:'Identity review update',
		text:'An administrator requested changes to your identity profile. Sign in securely to review the next steps.',
	},
	PROFILE_STATUS_UPDATED:{
		subject:'Identity review status updated',
		text:'An administrator updated your identity profile review. Sign in securely to review your account status.',
	},
	DOCUMENT_APPROVED:{
		subject:'Identity document review updated',
		text:'An administrator recorded an approval decision for an identity document. This document decision does not itself approve your identity profile.',
	},
	DOCUMENT_REJECTED:{
		subject:'Identity document review updated',
		text:'An administrator rejected an identity document. Sign in securely to review your account status or contact support.',
	},
	DOCUMENT_NEEDS_CHANGES:{
		subject:'Identity document update requested',
		text:'An administrator requested a replacement identity document. Sign in securely to review the next steps.',
	},
	DOCUMENT_REVIEWED:{
		subject:'Identity document review updated',
		text:'An administrator updated the review status of an identity document. Sign in securely to review your account status.',
	},
};

function isKycEmailEvent(event:string):event is KycEmailEvent{
	return Object.hasOwn(EMAIL_CONTENT,event);
}

export async function enqueueKycEmail(
	tx:Prisma.TransactionClient,
	userId:string,
	event:KycEmailEvent,
	dedupeKey:string,
){
	await tx.kycEmailOutbox.createMany({
		data:[{userId,event,dedupeKey}],
		skipDuplicates:true,
	});
}

export async function processKycEmailQueue(batchSize=25,now=new Date()){
	const leaseExpiredBefore=new Date(now.getTime()-2*60_000);
	const candidates=await db.kycEmailOutbox.findMany({
		where:{
			status:KycEmailOutboxStatus.PENDING,
			nextAttemptAt:{lte:now},
			OR:[{lockedAt:null},{lockedAt:{lte:leaseExpiredBefore}}],
		},
		select:{id:true},
		orderBy:{createdAt:'asc'},
		take:Math.max(1,Math.min(batchSize,100)),
	});
	const result={sent:0,retried:0,failed:0};
	for(const candidate of candidates){
		const claimed=await db.kycEmailOutbox.updateMany({
			where:{
				id:candidate.id,
				status:KycEmailOutboxStatus.PENDING,
				nextAttemptAt:{lte:now},
				OR:[{lockedAt:null},{lockedAt:{lte:leaseExpiredBefore}}],
			},
			data:{lockedAt:now,attempts:{increment:1}},
		});
		if(claimed.count!==1)continue;
		const item=await db.kycEmailOutbox.findUnique({
			where:{id:candidate.id},
			select:{id:true,event:true,attempts:true,user:{select:{email:true}}},
		});
		if(!item){
			result.failed++;
			continue;
		}
		if(!isKycEmailEvent(item.event)){
			await db.kycEmailOutbox.updateMany({
				where:{id:item.id,status:KycEmailOutboxStatus.PENDING,lockedAt:now},
				data:{status:KycEmailOutboxStatus.FAILED,lockedAt:null,lastErrorCode:'UNKNOWN_EVENT'},
			});
			result.failed++;
			continue;
		}
		const content=EMAIL_CONTENT[item.event];
		const delivery=await sendEmail({to:item.user.email,...content});
		if(delivery.sent){
			await db.kycEmailOutbox.updateMany({
				where:{id:item.id,status:KycEmailOutboxStatus.PENDING,lockedAt:now},
				data:{status:KycEmailOutboxStatus.SENT,lockedAt:null,sentAt:now,lastErrorCode:null},
			});
			result.sent++;
			continue;
		}
		const permanentFailure=item.attempts>=8;
		const delayMinutes=Math.min(60,2**Math.min(item.attempts,6));
		await db.kycEmailOutbox.updateMany({
			where:{id:item.id,status:KycEmailOutboxStatus.PENDING,lockedAt:now},
			data:{
				status:permanentFailure?KycEmailOutboxStatus.FAILED:KycEmailOutboxStatus.PENDING,
				lockedAt:null,
				nextAttemptAt:permanentFailure?now:new Date(now.getTime()+delayMinutes*60_000),
				lastErrorCode:delivery.reason==='not-configured'?'EMAIL_NOT_CONFIGURED':'EMAIL_DELIVERY_FAILED',
			},
		});
		if(permanentFailure)result.failed++;
		else result.retried++;
	}
	return result;
}
