import {NextResponse} from 'next/server';
import {AccountMode,FundingStatus,FundingType,NotificationType,Prisma} from '@prisma/client';
import {z,ZodError} from 'zod';
import {requireAdmin} from '@/lib/auth';
import {db} from '@/lib/db';
import {balance,ensureSystemAccount,ensureUserLedger,postWithdrawalDebitWithFee} from '@/lib/ledger';
import {createNotification} from '@/lib/notifications';
import {rateLimit} from '@/lib/rate-limit';
import {jsonSafe} from '@/lib/serializers';
import {getRealWithdrawableBalance} from '@/lib/real-withdrawals';
import {decryptWithdrawalDestination} from '@/lib/withdrawal-destinations';
import {MAX_REAL_WITHDRAWAL_USD,MIN_REAL_WITHDRAWAL_USD,REQUIRED_REAL_WITHDRAWAL_RESERVE_USD} from '@/lib/withdrawal-fee';

const schema=z.object({
	id:z.string().min(1).max(64),
	action:z.enum(['APPROVE','REJECT','REQUEST_INFO','PROCESS','COMPLETE','FAIL']),
	note:z.string().trim().max(500).optional(),
	processingReference:z.string().trim().min(6).max(180).optional(),
	confirmExternalProcessing:z.literal(true).optional(),
}).superRefine((value,context)=>{
	if(['REJECT','REQUEST_INFO','FAIL'].includes(value.action)&&!value.note)context.addIssue({code:'custom',path:['note'],message:'An audit note is required.'});
	if(value.action==='COMPLETE'&&(!value.processingReference||value.confirmExternalProcessing!==true)){
		context.addIssue({code:'custom',path:['processingReference'],message:'Record the real external reference and confirm that processing actually succeeded.'});
	}
});

const pendingStatuses:FundingStatus[]=[FundingStatus.PENDING,FundingStatus.PENDING_REVIEW];
const reservingStatuses:FundingStatus[]=[FundingStatus.PENDING,FundingStatus.PENDING_REVIEW,FundingStatus.APPROVED,FundingStatus.PROCESSING];

export async function POST(request:Request){
	try{
		const admin=await requireAdmin();
		rateLimit(`admin-withdrawal:${admin.id}`,30,60_000);
		const input=schema.parse(await request.json());
		const idempotencyKey=request.headers.get('Idempotency-Key')||'';
		if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey))return NextResponse.json({error:'A valid idempotency key is required.'},{status:400});
		const result=await db.$transaction(async tx=>{
			const replay=await tx.auditLog.findFirst({where:{entity:'FUNDING',entityId:input.id,metadata:{path:['idempotencyKey'],equals:idempotencyKey}},select:{id:true,action:true}});
			if(replay){
				if(replay.action!==`WITHDRAWAL_${input.action}`)throw new Error('IDEMPOTENCY_KEY_REUSED');
				return {request:await tx.fundingRequest.findUniqueOrThrow({where:{id:input.id}}),replayed:true};
			}
			const current=await tx.fundingRequest.findUnique({where:{id:input.id},include:{withdrawalDestinationSnapshot:true}});
			if(!current||current.type!==FundingType.WITHDRAWAL)throw new Error('WITHDRAWAL_NOT_FOUND');
			if(current.accountMode!==AccountMode.REAL)throw new Error('DEMO_WITHDRAWAL_DISABLED');
			if(!current.withdrawalDestinationId&&!['REJECT','REQUEST_INFO'].includes(input.action))throw new Error('WITHDRAWAL_DESTINATION_REQUIRED');
			if(admin.id===current.userId)throw new Error('WITHDRAWAL_SELF_REVIEW_FORBIDDEN');
			const destination=current.withdrawalDestinationSnapshot|| (current.withdrawalDestinationId?await tx.withdrawalDestination.findFirst({
				where:{id:current.withdrawalDestinationId,userId:current.userId,accountMode:current.accountMode},
				select:{type:true,network:true,ciphertext:true,iv:true,authTag:true},
			}):null);
			if(!destination&&!['REJECT','REQUEST_INFO'].includes(input.action))throw new Error('WITHDRAWAL_DESTINATION_REQUIRED');
			const details=destination?decryptWithdrawalDestination(destination):null;
			const user=await tx.user.findUnique({where:{id:current.userId},select:{withdrawalEnabled:true,accountRestricted:true,status:true}});
			if(!user||user.status!=='ACTIVE'||!user.withdrawalEnabled||user.accountRestricted)throw new Error('WITHDRAWAL_RESTRICTED');

			const stamp=new Date();
			let update:Prisma.FundingRequestUpdateManyMutationInput;
			let nextStatus:FundingStatus;
			switch(input.action){
				case 'APPROVE':
					if(!pendingStatuses.includes(current.status))throw new Error('WITHDRAWAL_INVALID_TRANSITION');
					update={status:FundingStatus.APPROVED,reviewedAt:stamp,adminNote:input.note||null};
					nextStatus=FundingStatus.APPROVED;
					break;
				case 'REJECT':
					if(!pendingStatuses.includes(current.status)&&current.status!==FundingStatus.APPROVED)throw new Error('WITHDRAWAL_INVALID_TRANSITION');
					update={status:FundingStatus.REJECTED,reviewedAt:stamp,adminNote:input.note};
					nextStatus=FundingStatus.REJECTED;
					break;
				case 'REQUEST_INFO':
					if(!pendingStatuses.includes(current.status))throw new Error('WITHDRAWAL_INVALID_TRANSITION');
					update={status:FundingStatus.PENDING,reviewedAt:stamp,adminNote:input.note};
					nextStatus=FundingStatus.PENDING;
					break;
				case 'PROCESS':
					if(current.status!==FundingStatus.APPROVED)throw new Error('WITHDRAWAL_INVALID_TRANSITION');
					update={status:FundingStatus.PROCESSING,adminNote:input.note||current.adminNote};
					nextStatus=FundingStatus.PROCESSING;
					break;
				case 'FAIL':
					if(current.status!==FundingStatus.PROCESSING)throw new Error('WITHDRAWAL_INVALID_TRANSITION');
					update={status:FundingStatus.FAILED,adminNote:input.note};
					nextStatus=FundingStatus.FAILED;
					break;
				case 'COMPLETE': {
					if(current.status!==FundingStatus.PROCESSING)throw new Error('WITHDRAWAL_INVALID_TRANSITION');
					if(current.amount.lt(MIN_REAL_WITHDRAWAL_USD))throw new Error('WITHDRAWAL_BELOW_MINIMUM');
					if(current.amount.gt(MAX_REAL_WITHDRAWAL_USD))throw new Error('WITHDRAWAL_ABOVE_MAXIMUM');
					if(details?.type==='CRYPTOCURRENCY'&&(!/^[0-9a-f]{64}$/i.test(input.processingReference||'')))throw new Error('CRYPTO_REFERENCE_REQUIRED');
					const account=await ensureUserLedger(tx,current.userId,AccountMode.REAL,current.currency);
					const ledgerBalance=await balance(tx,account.id);
					const available=current.currency==='USD'
						?await getRealWithdrawableBalance(tx,current.userId,ledgerBalance,current.id)
						:await (async()=>{
							const others=await tx.fundingRequest.aggregate({where:{userId:current.userId,accountMode:AccountMode.REAL,currency:current.currency,type:FundingType.WITHDRAWAL,status:{in:reservingStatuses},id:{not:current.id}},_sum:{amount:true}});
							return ledgerBalance.minus(others._sum.amount??new Prisma.Decimal(0));
						})();
					if(available.lt(current.amount.plus(REQUIRED_REAL_WITHDRAWAL_RESERVE_USD)))throw new Error('INSUFFICIENT_WITHDRAWABLE_FUNDS');
					const fee=current.feeAmount??new Prisma.Decimal(0);
					const netPayout=current.creditedAmount??current.amount.minus(fee);
					if(fee.lt(0)||netPayout.lt(0)||!netPayout.plus(fee).equals(current.amount))throw new Error('INVALID_WITHDRAWAL_ALLOCATION');
					const payoutAccount=await ensureSystemAccount(tx,`SYSTEM:MANUAL_WITHDRAWAL:REAL:${current.currency}`,`Administrator-recorded external withdrawal clearing`,current.currency,AccountMode.REAL);
					const feeAccount=fee.gt(0)?await ensureSystemAccount(tx,`SYSTEM:MANUAL_WITHDRAWAL_FEE:REAL:${current.currency}`,`REAL withdrawal commission revenue`,current.currency,AccountMode.REAL):payoutAccount;
					await postWithdrawalDebitWithFee(tx,{reference:`FUNDING:${current.id}:EXTERNAL_WITHDRAWAL`,description:'Administrator-confirmed external withdrawal; net payout and commission allocated in ledger',userAccountId:account.id,payoutAccountId:payoutAccount.id,feeAccountId:feeAccount.id,grossAmount:current.amount,netPayout,feeAmount:fee});
					update={status:FundingStatus.COMPLETED,processingReference:input.processingReference,processingConfirmedAt:stamp,settlementReference:`FUNDING:${current.id}:EXTERNAL_WITHDRAWAL`,settledAt:stamp,adminNote:input.note||current.adminNote};
					nextStatus=FundingStatus.COMPLETED;
					break;
				}
			}

			const changed=await tx.fundingRequest.updateMany({where:{id:current.id,status:current.status},data:update});
			if(changed.count!==1)throw new Error('WITHDRAWAL_INVALID_TRANSITION');
			const updated=await tx.fundingRequest.findUniqueOrThrow({where:{id:current.id}});
			await tx.auditLog.create({data:{actorId:admin.id,action:`WITHDRAWAL_${input.action}`,entity:'FUNDING',entityId:current.id,metadata:{
				idempotencyKey,accountMode:current.accountMode,oldStatus:current.status,newStatus:nextStatus,
				note:input.note||null,processingReference:input.action==='COMPLETE'?input.processingReference:null,
				externalProcessingAdminConfirmed:input.action==='COMPLETE',withdrawalMethod:destination?.type||null,network:destination?.network||null,
				ledgerDebitReference:input.action==='COMPLETE'?`FUNDING:${current.id}:EXTERNAL_WITHDRAWAL`:null,
				grossAmount:input.action==='COMPLETE'?current.amount.toString():null,
				feeAmount:input.action==='COMPLETE'?(current.feeAmount?.toString()??'0'):null,
				feePercent:input.action==='COMPLETE'?(current.feePercent?.toString()??null):null,
				netPayout:input.action==='COMPLETE'?(current.creditedAmount?.toString()??current.amount.toString()):null,
			}}});
			const notificationMessage:Record<typeof input.action,string>={
				APPROVE:`Your withdrawal request was approved. The amount remains reserved; no external transfer has yet been confirmed. The disclosed commission is ${current.feeAmount?.toFixed(2)??'0.00'} ${current.currency}, and the net payout is ${current.creditedAmount?.toFixed(2)??current.amount.toFixed(2)} ${current.currency}.`,
				REJECT:'Your withdrawal request was rejected. The reservation has been released and no ledger debit was posted. Review the request record for details.',
				REQUEST_INFO:'An administrator needs more information about your withdrawal request. No payout was initiated. Review the request record for details.',
				PROCESS:'Your withdrawal request is being processed by an administrator. This status is not proof of payment.',
				COMPLETE:`An administrator recorded your net payout of ${(current.creditedAmount??current.amount).toFixed(2)} ${current.currency} as externally processed and allocated the ${current.feeAmount?.toFixed(2)??'0.00'} ${current.currency} commission in Aurevia’s ledger. Aurevia did not independently verify a bank or blockchain provider.`,
				FAIL:'Your withdrawal processing failed. The reservation has been released and no ledger debit was posted. Review the request record for details.',
			};
			await createNotification(tx,{userId:current.userId,type:NotificationType.WITHDRAWAL,title:`Withdrawal ${nextStatus.toLowerCase().replaceAll('_',' ')}`,message:notificationMessage[input.action],dedupeKey:`withdrawal:${current.id}:${idempotencyKey}`,relatedEntity:'FUNDING',relatedId:current.id,actionUrl:`/wallet/transactions/${current.id}`});
			return {request:updated,replayed:false};
		},{isolationLevel:Prisma.TransactionIsolationLevel.Serializable,maxWait:5_000,timeout:20_000});
		const {receiptKey,...safeRequest}=result.request;
		return NextResponse.json({...jsonSafe(safeRequest),hasReceipt:!!receiptKey,replayed:result.replayed},{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		if(error instanceof ZodError)return NextResponse.json({error:'Enter a valid withdrawal action. Completion requires the actual transfer reference and explicit confirmation.'},{status:400});
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'Forbidden'},{status:403});
		const known=['WITHDRAWAL_NOT_FOUND','DEMO_WITHDRAWAL_DISABLED','WITHDRAWAL_DESTINATION_REQUIRED','WITHDRAWAL_SELF_REVIEW_FORBIDDEN','WITHDRAWAL_RESTRICTED','WITHDRAWAL_INVALID_TRANSITION','IDEMPOTENCY_KEY_REUSED','INSUFFICIENT_WITHDRAWABLE_FUNDS','CRYPTO_REFERENCE_REQUIRED','WITHDRAWAL_DESTINATION_ENCRYPTION_KEY_REQUIRED','WITHDRAWAL_DESTINATION_DECRYPTION_FAILED','WITHDRAWAL_BELOW_MINIMUM','WITHDRAWAL_ABOVE_MAXIMUM'];
		if(error instanceof Error&&known.includes(error.message)){
			const status=error.message==='WITHDRAWAL_SELF_REVIEW_FORBIDDEN'?403:error.message==='WITHDRAWAL_NOT_FOUND'?404:error.message==='WITHDRAWAL_DESTINATION_ENCRYPTION_KEY_REQUIRED'||error.message==='WITHDRAWAL_DESTINATION_DECRYPTION_FAILED'?503:409;
			const message=error.message==='WITHDRAWAL_DESTINATION_ENCRYPTION_KEY_REQUIRED'?'Secure destination storage is not configured.':error.message==='INSUFFICIENT_WITHDRAWABLE_FUNDS'?`Completion cannot proceed while keeping at least $${REQUIRED_REAL_WITHDRAWAL_RESERVE_USD.toLocaleString('en-US')} available after reservations.`:error.message==='WITHDRAWAL_BELOW_MINIMUM'?`Completion is not available because the request is below the $${MIN_REAL_WITHDRAWAL_USD.toLocaleString('en-US')} minimum.`:error.message==='WITHDRAWAL_ABOVE_MAXIMUM'?`Completion is not available because the request exceeds the $${MAX_REAL_WITHDRAWAL_USD.toLocaleString('en-US')} maximum.`:error.message.replaceAll('_',' ').toLowerCase();
			return NextResponse.json({error:message},{status});
		}
		if(error&&typeof error==='object'&&'code'in error&&String(error.code)==='P2034')return NextResponse.json({error:'The request changed during processing. Retry with the same idempotency key.'},{status:409});
		console.error('Withdrawal lifecycle update failed.',error instanceof Error?error.name:'UnknownError');
		return NextResponse.json({error:'Unable to update the withdrawal request.'},{status:503});
	}
}
