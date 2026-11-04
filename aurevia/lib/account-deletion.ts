import {FundingStatus,Prisma} from '@prisma/client';
import {balance} from '@/lib/ledger';
import type {PrivateStorageArea} from '@/lib/private-storage';

type PrivateFile={area:PrivateStorageArea;ownerId:string;key:string};

export async function deleteAccountData(tx:Prisma.TransactionClient,input:{userId:string;actorId:string|null;force?:boolean}):Promise<PrivateFile[]>{
	const current=await tx.user.findUnique({
		where:{id:input.userId},
		select:{
			id:true,
			avatarKey:true,
			kycDocuments:{select:{storageKey:true}},
			funding:{select:{receiptKey:true}},
			supportConversations:{select:{attachmentKey:true}},
			clientStories:{select:{id:true,imageReference:true}},
			taxCases:{select:{documents:{select:{storageKey:true,userId:true}}}},
		},
	});
	if(!current)throw new Error('ACCOUNT_NOT_FOUND');

	if(!input.force){
		const activeFunding=await tx.fundingRequest.count({
			where:{userId:current.id,status:{in:[FundingStatus.PENDING,FundingStatus.PENDING_REVIEW,FundingStatus.APPROVED,FundingStatus.PROCESSING]}},
		});
		if(activeFunding)throw new Error('ACCOUNT_HAS_ACTIVE_FUNDING');
		const accounts=await tx.ledgerAccount.findMany({where:{userId:current.id},select:{id:true,startingBalance:true}});
		for(const account of accounts){
			if(!account.startingBalance.isZero()||!(await balance(tx,account.id)).isZero())throw new Error('ACCOUNT_HAS_NONZERO_BALANCE');
		}
	}

	const privateFiles:PrivateFile[]=[
		...(current.avatarKey?[{area:'avatar' as const,ownerId:current.id,key:current.avatarKey}]:[]),
		...current.kycDocuments.map(document=>({area:'kyc' as const,ownerId:current.id,key:document.storageKey})),
		...current.funding.flatMap(funding=>funding.receiptKey?[{area:'receipt' as const,ownerId:current.id,key:funding.receiptKey}]:[]),
		...current.supportConversations.flatMap(conversation=>conversation.attachmentKey?[{area:'support' as const,ownerId:current.id,key:conversation.attachmentKey}]:[]),
		...current.clientStories.flatMap(story=>story.imageReference?[{area:'clientStory' as const,ownerId:story.id,key:story.imageReference}]:[]),
		...current.taxCases.flatMap(taxCase=>taxCase.documents.map(document=>({area:'tax' as const,ownerId:document.userId,key:document.storageKey}))),
	];

	await tx.ledgerTransaction.deleteMany({where:{entries:{some:{account:{userId:current.id}}}}});
	await tx.supportMessage.deleteMany({where:{authorId:current.id}});
	await tx.auditLog.updateMany({
		where:{OR:[{actorId:current.id},{entityId:current.id}]},
		data:{actorId:null,entityId:null,metadata:Prisma.DbNull},
	});
	await tx.user.delete({where:{id:current.id}});
	await tx.auditLog.create({
		data:{
			actorId:input.actorId,
			action:input.actorId?'ADMIN_ACCOUNT_DELETED':'USER_ACCOUNT_DELETED',
			entity:'USER',
			entityId:input.actorId?current.id:null,
		},
	});
	return privateFiles;
}
