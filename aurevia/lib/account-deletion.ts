import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {CardApplicationStatus,FundingStatus,InvestmentStatus,LoanStatus,OrderStatus,PositionStatus,Prisma,SimulatedCardStatus,TaxCaseStatus} from '@prisma/client';
import {balance} from '@/lib/ledger';
import type {PrivateStorageArea} from '@/lib/private-storage';

type PrivateFile={area:PrivateStorageArea;ownerId:string;key:string};
type DeletionBlocker={code:string;count:number};

const activeFundingStatuses=[FundingStatus.PENDING,FundingStatus.PENDING_REVIEW,FundingStatus.PROCESSING,FundingStatus.APPROVED];
const unresolvedInvestmentStatuses=[InvestmentStatus.PENDING_APPROVAL,InvestmentStatus.APPROVED,InvestmentStatus.ACTIVE,InvestmentStatus.PAUSED,InvestmentStatus.COMPLETED];
const unresolvedOrderStatuses=[OrderStatus.OPEN,OrderStatus.PARTIALLY_FILLED,OrderStatus.PENDING_CANCEL];
const unresolvedLoanStatuses=[LoanStatus.PENDING_REVIEW,LoanStatus.APPROVED,LoanStatus.ACTIVE];
const unresolvedCardApplicationStatuses=[CardApplicationStatus.DRAFT,CardApplicationStatus.SUBMITTED,CardApplicationStatus.UNDER_REVIEW,CardApplicationStatus.AWAITING_INFO,CardApplicationStatus.APPROVED];
const unresolvedCardStatuses=[SimulatedCardStatus.PENDING_ISSUANCE,SimulatedCardStatus.ACTIVE,SimulatedCardStatus.SUSPENDED];
const unresolvedTaxCaseStatuses=[TaxCaseStatus.DRAFT,TaxCaseStatus.SUBMITTED,TaxCaseStatus.AWAITING_INITIAL_REVIEW,TaxCaseStatus.UNDER_REVIEW,TaxCaseStatus.AWAITING_TAXPAYER_INFO,TaxCaseStatus.INFORMATION_RECEIVED,TaxCaseStatus.REVIEW_COMPLETED,TaxCaseStatus.PREPARATION_COMPLETED];

export async function inspectAccountDeletion(tx:Prisma.TransactionClient,userId:string){
	const user=await tx.user.findUnique({where:{id:userId},select:{id:true,email:true,role:true,status:true,avatarKey:true}});
	if(!user)throw new Error('ACCOUNT_NOT_FOUND');
	const accounts=await tx.ledgerAccount.findMany({where:{userId},select:{id:true,accountMode:true,currency:true}});
	const [balances,activeFunding,openOrders,openPositions,unresolvedInvestments,unresolvedLoans,unresolvedCardApplications,unresolvedCards,unresolvedTaxCases,kycDocuments,taxDocuments]=await Promise.all([
		Promise.all(accounts.map(async account=>({accountMode:account.accountMode,currency:account.currency,balance:await balance(tx,account.id)}))),
		tx.fundingRequest.count({where:{userId,status:{in:activeFundingStatuses}}}),
		tx.order.count({where:{userId,status:{in:unresolvedOrderStatuses}}}),
		tx.position.count({where:{userId,status:PositionStatus.OPEN}}),
		tx.investmentRequest.count({where:{userId,status:{in:unresolvedInvestmentStatuses}}}),
		tx.communityLoan.count({where:{userId,status:{in:unresolvedLoanStatuses}}}),
		tx.cardApplication.count({where:{userId,status:{in:unresolvedCardApplicationStatuses}}}),
		tx.simulatedCard.count({where:{userId,status:{in:unresolvedCardStatuses}}}),
		tx.taxCase.count({where:{userId,status:{in:unresolvedTaxCaseStatuses}}}),
		tx.kycDocument.count({where:{userId}}),
		tx.taxCaseDocument.count({where:{userId}}),
	]);
	const nonzeroBalances=balances.filter(item=>!item.balance.isZero());
	const blockers:DeletionBlocker[]=[
		{code:'ACCOUNT_NOT_ELIGIBLE',count:user.role!=='USER'||user.status==='CLOSED'?1:0},
		{code:'NONZERO_WALLET_BALANCE',count:nonzeroBalances.length},
		{code:'UNRESOLVED_FUNDING',count:activeFunding},
		{code:'OPEN_ORDERS',count:openOrders},
		{code:'OPEN_POSITIONS',count:openPositions},
		{code:'UNSETTLED_INVESTMENTS',count:unresolvedInvestments},
		{code:'OUTSTANDING_LOANS',count:unresolvedLoans},
		{code:'UNRESOLVED_CARD_APPLICATIONS',count:unresolvedCardApplications},
		{code:'ACTIVE_CARDS',count:unresolvedCards},
		{code:'OPEN_TAX_CASES',count:unresolvedTaxCases},
	];
	return {
		user:{id:user.id,email:user.email,role:user.role,status:user.status},
		balances:balances.map(item=>({accountMode:item.accountMode,currency:item.currency,amount:item.balance.toString()})),
		blockers,
		deletable:user.role==='USER'&&user.status!=='CLOSED'&&blockers.every(item=>item.count===0),
		retainedRecords:{kycDocuments,taxDocuments,financialHistory:true,auditHistory:true,supportRecords:true},
	};
}

export async function deleteAccountData(tx:Prisma.TransactionClient,input:{
	userId:string;
	actorId:string|null;
	confirmationEmail:string;
	reason:string;
	idempotencyKey:string;
}):Promise<{avatar:PrivateFile|null;replayed:boolean}>{
	if(input.actorId&&input.userId===input.actorId)throw new Error('CANNOT_DELETE_CURRENT_ADMIN');
	if(input.actorId){
		const actor=await tx.user.findUnique({where:{id:input.actorId},select:{id:true,role:true,status:true}});
		if(!actor||actor.role!=='ADMIN'||actor.status!=='ACTIVE')throw new Error('ADMIN_AUTHORIZATION_REQUIRED');
	}
	const current=await tx.user.findUnique({
		where:{id:input.userId},
		select:{id:true,email:true,role:true,status:true,avatarKey:true},
	});
	if(!current)throw new Error('ACCOUNT_NOT_FOUND');
	if(current.role!=='USER')throw new Error('ADMIN_ACCOUNT_ISOLATED');
	const requestFingerprint=createHash('sha256')
		.update(JSON.stringify([current.id,current.email.trim().toLowerCase(),input.confirmationEmail.trim().toLowerCase(),input.reason.trim()]))
		.digest('hex');
	const replay=await tx.auditLog.findFirst({
		where:{
			actorId:input.actorId,
			action:input.actorId?'ADMIN_ACCOUNT_PERMANENTLY_DELETED':'USER_ACCOUNT_PERMANENTLY_DELETED',
			entity:'USER',
			entityId:current.id,
			metadata:{path:['idempotencyKey'],equals:input.idempotencyKey},
		},
		select:{metadata:true},
	});
	if(replay){
		const metadata=replay.metadata&&typeof replay.metadata==='object'&&!Array.isArray(replay.metadata)?replay.metadata as Record<string,unknown>:{};
		if(metadata.requestFingerprint!==requestFingerprint)throw new Error('IDEMPOTENCY_KEY_REUSED');
		return {avatar:null,replayed:true};
	}
	if(current.status==='CLOSED')throw new Error('ACCOUNT_ALREADY_DEACTIVATED');
	if(current.email.trim().toLowerCase()!==input.confirmationEmail.trim().toLowerCase())throw new Error('CONFIRMATION_EMAIL_MISMATCH');

	const assessment=await inspectAccountDeletion(tx,current.id);
	if(!assessment.deletable)throw new Error('ACCOUNT_HAS_UNRESOLVED_OBLIGATIONS');
	const now=new Date();
	await tx.user.update({
		where:{id:current.id},
		data:{
			email:`deleted+${randomUUID()}@deleted.invalid`,
			passwordHash:`disabled:${randomBytes(48).toString('hex')}`,
			name:null,
			phone:null,
			phoneVerified:false,
			phoneVerifiedAt:null,
			activeSessionId:null,
			activeSessionUpdatedAt:now,
			country:null,
			gender:'PREFER_NOT_TO_SAY',
			preferredDisplayCurrency:'USD',
			status:'CLOSED',
			twoFactorEnabled:false,
			totpSecretEncrypted:null,
			lastTotpCounter:null,
			emailVerifiedAt:null,
			requiresRegistrationVerification:true,
			depositEnabled:false,
			withdrawalEnabled:false,
			accountRestricted:true,
			restrictionReason:'Permanently deactivated by an administrator.',
			aureviaExchangeId:null,
			avatarKey:null,
		},
	});
	await tx.securitySession.updateMany({where:{userId:current.id,revokedAt:null},data:{revokedAt:now}});
	await tx.twoFactorEnrollment.deleteMany({where:{userId:current.id}});
	await tx.securityRecoveryCode.deleteMany({where:{userId:current.id}});

	await Promise.all([
		tx.passwordResetToken.deleteMany({where:{userId:current.id}}),
		tx.verificationCode.deleteMany({where:{userId:current.id}}),
		tx.pushOutbox.deleteMany({where:{userId:current.id}}),
		tx.pushSubscription.deleteMany({where:{userId:current.id}}),
		tx.pushPreference.deleteMany({where:{userId:current.id}}),
		tx.kycEmailOutbox.deleteMany({where:{userId:current.id}}),
		tx.activityVisibilityPreference.deleteMany({where:{userId:current.id}}),
		tx.notification.deleteMany({where:{userId:current.id}}),
	]);
	await tx.auditLog.create({
		data:{
			actorId:input.actorId,
			action:input.actorId?'ADMIN_ACCOUNT_PERMANENTLY_DELETED':'USER_ACCOUNT_PERMANENTLY_DELETED',
			entity:'USER',
			entityId:current.id,
			metadata:{
				reason:input.reason.trim(),
				idempotencyKey:input.idempotencyKey,
				requestFingerprint,
				deactivatedAt:now.toISOString(),
				accountRecordRetained:true,
				financialAndRegulatoryRecordsRetained:true,
			},
		},
	});
	return {
		avatar:current.avatarKey?{area:'avatar',ownerId:current.id,key:current.avatarKey}:null,
		replayed:false,
	};
}
