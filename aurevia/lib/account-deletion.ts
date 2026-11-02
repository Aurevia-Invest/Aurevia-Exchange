import {randomBytes} from 'node:crypto';
import bcrypt from 'bcryptjs';
import {Prisma,Role,UserStatus} from '@prisma/client';
import type {PrivateStorageArea} from '@/lib/private-storage';

type PrivateFile={area:PrivateStorageArea;ownerId:string;key:string};

export async function createClosedAccountPasswordHash(){
	return bcrypt.hash(randomBytes(32).toString('hex'),12);
}

export async function anonymizeAccount(tx:Prisma.TransactionClient,input:{userId:string;actorId:string|null;replacementPasswordHash:string;reason?:string}){
	const current=await tx.user.findUnique({
		where:{id:input.userId},
		select:{id:true,role:true,status:true,avatarKey:true,kycDocuments:{select:{storageKey:true}},funding:{select:{receiptKey:true}},supportConversations:{select:{attachmentKey:true}},clientStories:{select:{id:true,imageReference:true}}},
	});
	if(!current)throw new Error('ACCOUNT_NOT_FOUND');
	if(current.status===UserStatus.CLOSED)throw new Error('ACCOUNT_ALREADY_CLOSED');
	if(current.role===Role.ADMIN&&current.status===UserStatus.ACTIVE){
		const remainingAdmins=await tx.user.count({where:{id:{not:current.id},role:Role.ADMIN,status:UserStatus.ACTIVE}});
		if(remainingAdmins===0)throw new Error('LAST_ACTIVE_ADMIN_REQUIRED');
	}

	const privateFiles:PrivateFile[]=[
		...(current.avatarKey?[{area:'avatar' as const,ownerId:current.id,key:current.avatarKey}]:[]),
		...current.kycDocuments.map(document=>({area:'kyc' as const,ownerId:current.id,key:document.storageKey})),
		...current.funding.flatMap(funding=>funding.receiptKey?[{area:'receipt' as const,ownerId:current.id,key:funding.receiptKey}]:[]),
		...current.supportConversations.flatMap(conversation=>conversation.attachmentKey?[{area:'support' as const,ownerId:current.id,key:conversation.attachmentKey}]:[]),
		...current.clientStories.flatMap(story=>story.imageReference?[{area:'clientStory' as const,ownerId:story.id,key:story.imageReference}]:[]),
	];

	await tx.supportConversation.deleteMany({where:{userId:current.id}});
	await tx.kycDocument.deleteMany({where:{userId:current.id}});
	await tx.kycProfile.deleteMany({where:{userId:current.id}});
	await tx.clientStory.deleteMany({where:{userId:current.id}});
	await tx.waitlistEntry.deleteMany({where:{userId:current.id}});
	await tx.notification.deleteMany({where:{userId:current.id}});
	await tx.verificationCode.deleteMany({where:{userId:current.id}});
	await tx.passwordResetToken.deleteMany({where:{userId:current.id}});
	await tx.tierUpgradeRequest.updateMany({where:{userId:current.id},data:{userMessage:null,adminReason:null}});
	await tx.fundingRequest.updateMany({where:{userId:current.id},data:{transactionReference:null,referenceInfo:null,destinationInfo:null,senderInfo:null,beneficiaryInfo:null,note:null,adminNote:null,receiptKey:null}});
	await tx.auditLog.updateMany({where:{actorId:current.id},data:{actorId:null}});
	await tx.auditLog.updateMany({where:{entityId:current.id},data:{metadata:Prisma.DbNull}});
	await tx.user.update({
		where:{id:current.id},
		data:{email:`deleted+${current.id}@account.invalid`,passwordHash:input.replacementPasswordHash,name:null,phone:null,phoneVerified:false,phoneVerifiedAt:null,country:null,preferredDisplayCurrency:'USD',status:UserStatus.CLOSED,twoFactorEnabled:false,termsAcceptedAt:null,verifiedAt:null,verifiedChannel:null,requiresRegistrationVerification:false,depositEnabled:false,withdrawalEnabled:false,accountRestricted:true,restrictionReason:'Account closed.',activeSessionId:null,activeSessionUpdatedAt:null,avatarKey:null},
		select:{id:true},
	});
	await tx.auditLog.create({data:{actorId:input.actorId,action:input.actorId?'ADMIN_ACCOUNT_DELETED':'USER_ACCOUNT_DELETED',entity:'USER',entityId:current.id,metadata:input.reason?{reason:input.reason.slice(0,500)}:undefined}});
	return privateFiles;
}