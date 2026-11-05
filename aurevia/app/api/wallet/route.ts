import {NextResponse} from 'next/server';
import {AccountMode,Prisma,FundingStatus,FundingType,NotificationType} from '@prisma/client';
import {z,ZodError} from 'zod';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {balance,ensureUserLedger,roundUsdAmount} from '@/lib/ledger';
import {jsonSafe} from '@/lib/serializers';
import {createNotification} from '@/lib/notifications';
import {notifyActiveAdmins} from '@/lib/notifications';
import {emailDeliveryStatus,sendSupportEmail} from '@/lib/email';
import {validateWithdrawal} from '@/lib/production-policy';
import {FundingEvidenceError,maxFundingEvidenceBytes,validateFundingEvidence} from '@/lib/funding-evidence';
import {createPrivateObjectKey,deletePrivateObject,PrivateStorageError,uploadPrivateObject} from '@/lib/private-storage';
import {getRealWithdrawableBalance} from '@/lib/real-withdrawals';
import {decryptWithdrawalDestination} from '@/lib/withdrawal-destinations';
import {rateLimit} from '@/lib/rate-limit';
import {normalizeBitcoinWithdrawalSubmission} from '@/lib/bitcoin-withdrawal-submission';
import {calculateWithdrawalAmounts,getWithdrawalEligibilityIssue,MAX_REAL_WITHDRAWAL_USD,MIN_REAL_WITHDRAWAL_USD,REQUIRED_REAL_WITHDRAWAL_RESERVE_USD,WITHDRAWAL_COMMISSION_PERCENT} from '@/lib/withdrawal-fee';

const schema=z.object({
	type:z.nativeEnum(FundingType),
	paymentMethodId:z.string().min(1).optional(),
	amount:z.number().positive().max(100000000),
	currency:z.string().trim().max(8).optional(),
	transactionReference:z.string().trim().max(180).optional(),
	referenceInfo:z.string().trim().max(500).optional(),
	senderInfo:z.string().trim().max(300).optional(),
	destinationInfo:z.string().trim().max(500).optional(),
	beneficiaryInfo:z.string().trim().max(300).optional(),
	network:z.string().trim().max(80).optional(),
	senderEmail:z.string().trim().email().max(254).optional(),
	senderWalletName:z.string().trim().max(100).optional(),
	senderWalletAddress:z.string().trim().max(90).optional(),
	transactionDateTime:z.string().datetime({offset:true}).optional(),
	note:z.string().trim().max(500).optional(),
	withdrawalDestinationId:z.string().min(1).max(64).optional(),
	destinationConfirmed:z.literal(true).optional(),
});

const reservingStatuses=[FundingStatus.PENDING,FundingStatus.PENDING_REVIEW,FundingStatus.APPROVED,FundingStatus.PROCESSING];

export async function GET(){
	try{
		const user=await requireUser();
		const currentUser=await db.user.findUnique({where:{id:user.id},select:{accountMode:true,status:true,aureviaExchangeId:true}});
		if(!currentUser||currentUser.status!=='ACTIVE')return NextResponse.json({error:'Wallet account is unavailable.'},{status:403});
		await ensureUserLedger(db,user.id,currentUser.accountMode,'USD');
		if(currentUser.accountMode===AccountMode.DEMO){
			const account=await db.ledgerAccount.findUnique({where:{code:`USER:${user.id}:${AccountMode.DEMO}:USD`}});
			const virtualBalance=account?await balance(db,account.id):new Prisma.Decimal(0);
			return NextResponse.json(jsonSafe({accountMode:AccountMode.DEMO,aureviaExchangeId:currentUser.aureviaExchangeId,balance:virtualBalance,withdrawableBalance:null,balances:[{currency:'USD',balance:virtualBalance}],transactions:[],adminLedgerReceipts:[],tradingTransactions:[]}),{headers:{'Cache-Control':'private, no-store'}});
		}
		const [accounts,transactions]=await Promise.all([
			db.ledgerAccount.findMany({where:{userId:user.id,accountMode:currentUser.accountMode},orderBy:{currency:'asc'}}),
			db.fundingRequest.findMany({where:{userId:user.id,accountMode:currentUser.accountMode},orderBy:{createdAt:'desc'},take:100,include:{paymentMethod:{select:{id:true,name:true}},user:{select:{name:true,email:true}},withdrawalDestination:{select:{nickname:true,countryCode:true,network:true,asset:true,maskedLabel:true}},withdrawalDestinationSnapshot:{select:{nickname:true,countryCode:true,network:true,asset:true,maskedLabel:true}}}}),
		]);
		const balances=await Promise.all(accounts.map(async account=>({currency:account.currency,balance:await balance(db,account.id)})));
		const usdBalance=balances.find(item=>item.currency==='USD')?.balance??null;
		const withdrawableBalance=currentUser.accountMode===AccountMode.REAL
			?await getRealWithdrawableBalance(db,user.id,usdBalance??new Prisma.Decimal(0))
			:null;
		const accountIds=accounts.map(account=>account.id);
		const adminLedgerTransactions=accountIds.length?await db.ledgerTransaction.findMany({
			where:{reference:{startsWith:`ADMIN:${currentUser.accountMode}:${user.id}:`},entries:{some:{accountId:{in:accountIds}}}},
			orderBy:{createdAt:'desc'},
			take:100,
			include:{entries:{where:{accountId:{in:accountIds}},select:{type:true,amount:true,account:{select:{currency:true}}}}},
		}):[];
		const usdAccountIds=accounts.filter(account=>account.currency.toUpperCase()==='USD').map(account=>account.id);
		const tradingTransactions=usdAccountIds.length?await db.ledgerTransaction.findMany({
			where:{accountMode:AccountMode.REAL,reference:{startsWith:'REAL:SIMULATED_TRADE:'},entries:{some:{accountId:{in:usdAccountIds}}}},
			orderBy:{createdAt:'desc'},
			take:100,
			include:{entries:{where:{accountId:{in:usdAccountIds}},select:{type:true,amount:true,account:{select:{currency:true}}}}},
		}):[];
		const adminLedgerReceipts=adminLedgerTransactions.flatMap(transaction=>{
			const entry=transaction.entries[0];
			return entry?[{id:transaction.id,reference:transaction.reference,description:transaction.description,type:entry.type,amount:entry.amount,currency:entry.account.currency,createdAt:transaction.createdAt}]:[];
		});
		const safeTradingTransactions=tradingTransactions.flatMap(transaction=>{
			const entry=transaction.entries[0];
			return entry?[{id:transaction.id,description:transaction.description.replace(/^simulated\s+/i,'Trade '),type:entry.type,amount:entry.amount,currency:entry.account.currency,createdAt:transaction.createdAt}]:[];
		});
		const approvals=transactions.length?await db.auditLog.findMany({where:{entity:'FUNDING',entityId:{in:transactions.map(transaction=>transaction.id)},action:{in:['FUNDING_APPROVED','BTC_DEPOSIT_APPROVED','WITHDRAWAL_APPROVE']}},select:{entityId:true,createdAt:true,metadata:true,actor:{select:{name:true,email:true}}},orderBy:{createdAt:'desc'}}):[];
		const approvalByRequest=new Map();
		for(const approval of approvals)if(approval.entityId&&!approvalByRequest.has(approval.entityId)){
			const metadata=approval.metadata&&typeof approval.metadata==='object'&&!Array.isArray(approval.metadata)?approval.metadata as Record<string,unknown>:{};
			approvalByRequest.set(approval.entityId,{reviewedAt:approval.createdAt,reviewedBy:approval.actor,previousBalance:typeof metadata.previousBalance==='string'?metadata.previousBalance:null,resultingBalance:typeof metadata.resultingBalance==='string'?metadata.resultingBalance:null});
		}
		const safeTransactions=transactions.map(({receiptKey,withdrawalDestinationSnapshot,...transaction})=>{
			const approval=approvalByRequest.get(transaction.id);
			const approvedFromAudit=Boolean(approval)&&(transaction.status===FundingStatus.PENDING||transaction.status===FundingStatus.PENDING_REVIEW);
			return {...transaction,...(approvedFromAudit?{status:FundingStatus.APPROVED,reviewedAt:transaction.reviewedAt||approval.reviewedAt}:{}),withdrawalDestination:withdrawalDestinationSnapshot||transaction.withdrawalDestination,hasReceipt:!!receiptKey,...(approval||{})};
		});
		return NextResponse.json(jsonSafe({accountMode:currentUser.accountMode,aureviaExchangeId:currentUser.aureviaExchangeId,balance:usdBalance,withdrawableBalance,balances,transactions:safeTransactions,adminLedgerReceipts,tradingTransactions:safeTradingTransactions}),{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		const code=error&&typeof error==='object'&&'code' in error?String(error.code):'';
		console.error(`Wallet data unavailable (${/^[A-Z0-9_]{2,32}$/.test(code)?code:error instanceof Error?error.name:'UnknownError'}).`);
		return NextResponse.json({error:'Wallet data is temporarily unavailable.'},{status:503,headers:{'Cache-Control':'private, no-store'}});
	}
}

export async function POST(req:Request){
	let receiptKey:string|undefined;
	let ownerId:string|undefined;
	let evidenceMetadata:{fileType:string;fileSize:number}|undefined;
	try{
		const user=await requireUser();
		ownerId=user.id;
		const currentUser=await db.user.findUnique({where:{id:user.id},select:{accountMode:true,status:true,depositEnabled:true,withdrawalEnabled:true,accountRestricted:true}});
		if(!currentUser||currentUser.status!=='ACTIVE')return NextResponse.json({error:'Wallet account is unavailable.'},{status:403});
		if(currentUser.accountMode===AccountMode.DEMO)return NextResponse.json({error:'Deposits and withdrawals are available in REAL Mode only.'},{status:403});
		let body:unknown;
		let evidenceFile:File|null=null;
		if(req.headers.get('content-type')?.includes('multipart/form-data')){
			if(Number(req.headers.get('content-length')||0)>maxFundingEvidenceBytes+64*1024)return NextResponse.json({error:'Evidence must be 5 MB or smaller.'},{status:413});
			const form=await req.formData();
			const payload=form.get('payload');
			if(typeof payload!=='string')return NextResponse.json({error:'Funding details are required.'},{status:400});
			try{body=JSON.parse(payload)}catch{return NextResponse.json({error:'Funding details are invalid.'},{status:400})}
			const file=form.get('evidence');
			if(file instanceof File)evidenceFile=file;
		}else{
			body=await req.json();
		}
		const parsed=schema.parse(body);
		if(parsed.currency!=='USD')return NextResponse.json({error:'Deposits and withdrawals must be denominated in USD.'},{status:400});
		const hasBitcoinFields=Boolean(parsed.network||parsed.senderEmail||parsed.senderWalletName||parsed.senderWalletAddress||parsed.transactionDateTime||(parsed.type===FundingType.WITHDRAWAL&&parsed.transactionReference));
		if(parsed.type!==FundingType.WITHDRAWAL&&hasBitcoinFields)throw new Error('BITCOIN_DETAILS_NOT_ALLOWED');
		if(parsed.type===FundingType.WITHDRAWAL&&(!parsed.withdrawalDestinationId||parsed.destinationConfirmed!==true))return NextResponse.json({error:'Select a saved destination and confirm its details.'},{status:400});
		const idempotencyKey=req.headers.get('Idempotency-Key');
		if(!idempotencyKey||idempotencyKey.length>128)return NextResponse.json({error:'A valid idempotency key is required.'},{status:400});
		if(parsed.type===FundingType.WITHDRAWAL)rateLimit(`real-withdrawal:${user.id}`,5,60_000);
		if(parsed.type===FundingType.DEPOSIT)rateLimit(`real-deposit:${user.id}`,20,60*60_000);
		if(parsed.type===FundingType.DEPOSIT){
			if(!currentUser.depositEnabled)throw new Error('DEPOSITS_DISABLED');
		}
		if(parsed.paymentMethodId)return NextResponse.json({error:'External payment methods are disabled. Submit an internal Aurevia ledger request without a payment method.'},{status:400});
		if(parsed.type===FundingType.DEPOSIT&&evidenceFile){
			if(evidenceFile.size===0)throw new FundingEvidenceError('Choose a non-empty evidence file.',400);
			if(evidenceFile.size>maxFundingEvidenceBytes)throw new FundingEvidenceError('Evidence must be 5 MB or smaller.',413);
			const bytes=Buffer.from(await evidenceFile.arrayBuffer());
			const {contentType}=validateFundingEvidence(evidenceFile,bytes,{imagesOnly:true});
			evidenceMetadata={fileType:contentType,fileSize:bytes.length};
			receiptKey=createPrivateObjectKey('receipt',user.id,contentType);
			await uploadPrivateObject('receipt',user.id,receiptKey,bytes,contentType);
		}
		if(parsed.type==='WITHDRAWAL'){
			if(!currentUser.withdrawalEnabled)throw new Error('WITHDRAWAL_DISABLED');
			if(currentUser.accountRestricted)throw new Error('ACCOUNT_RESTRICTED');
		}
		const destination=parsed.type===FundingType.WITHDRAWAL?await db.withdrawalDestination.findFirst({
			where:{id:parsed.withdrawalDestinationId,userId:user.id,accountMode:AccountMode.REAL},
			select:{id:true,type:true,network:true,asset:true,nickname:true,countryCode:true,maskedLabel:true,ciphertext:true,iv:true,authTag:true},
		}):null;
		if(parsed.type===FundingType.WITHDRAWAL&&!destination)throw new Error('WITHDRAWAL_DESTINATION_REQUIRED');
		const destinationDetails=destination?decryptWithdrawalDestination(destination):null;
		if(hasBitcoinFields&&destinationDetails?.type!=='CRYPTOCURRENCY')throw new Error('BITCOIN_DETAILS_NOT_ALLOWED');
		const bitcoinSubmission=hasBitcoinFields?normalizeBitcoinWithdrawalSubmission({
			network:parsed.network,
			transactionReference:parsed.transactionReference,
			senderEmail:parsed.senderEmail,
			senderWalletName:parsed.senderWalletName,
			senderWalletAddress:parsed.senderWalletAddress,
			transactionDateTime:parsed.transactionDateTime,
		},destinationDetails?.type==='CRYPTOCURRENCY'&&destinationDetails.asset==='BTC'&&destinationDetails.network==='BITCOIN_MAINNET'?destinationDetails.walletAddress||null:null):null;
		const currency='USD';
		const amount=roundUsdAmount(parsed.amount);
		if(amount.lte(0))throw new Error('INVALID_AMOUNT');
		if(parsed.type===FundingType.WITHDRAWAL){
			const limitIssue=getWithdrawalEligibilityIssue(amount.toString());
			if(limitIssue==='BELOW_MINIMUM')throw new Error('WITHDRAWAL_BELOW_MINIMUM');
			if(limitIssue==='ABOVE_MAXIMUM')throw new Error('WITHDRAWAL_ABOVE_MAXIMUM');
		}
		const withdrawalAmounts=parsed.type===FundingType.WITHDRAWAL?calculateWithdrawalAmounts(amount.toString()):null;
		if(withdrawalAmounts&&(!withdrawalAmounts.feeCents||withdrawalAmounts.netCents<=0))throw new Error('WITHDRAWAL_AMOUNT_BELOW_COMMISSION_MINIMUM');
		const withdrawalFee=withdrawalAmounts?new Prisma.Decimal(withdrawalAmounts.feeCents).div(100):null;
		const withdrawalNet=withdrawalAmounts?new Prisma.Decimal(withdrawalAmounts.netCents).div(100):null;
		const transactionReference=bitcoinSubmission?.transactionReference||parsed.transactionReference||null;
		const referenceInfo=bitcoinSubmission?.referenceInfo??parsed.referenceInfo??null;
		const senderInfo=bitcoinSubmission?.senderInfo??parsed.senderInfo??null;
		const destinationInfo=bitcoinSubmission?.destinationInfo??parsed.destinationInfo??null;
		const submittedNetwork=bitcoinSubmission?.network??null;

		const result=await db.$transaction(async tx=>{
			const activeUser=await tx.user.findUnique({where:{id:user.id},select:{accountMode:true,status:true}});
			if(!activeUser||activeUser.status!=='ACTIVE')throw new Error('WALLET_ACCOUNT_UNAVAILABLE');
			if(activeUser.accountMode!==currentUser.accountMode)throw new Error('ACCOUNT_MODE_CHANGED');
			const duplicate=await tx.fundingRequest.findUnique({where:{idempotencyKey}});
			if(duplicate){
				if(duplicate.userId!==user.id||duplicate.accountMode!==currentUser.accountMode||duplicate.type!==parsed.type||!duplicate.amount.equals(amount)||duplicate.currency!==currency||duplicate.paymentMethodId!==null||duplicate.transactionReference!==transactionReference||(duplicate.referenceInfo??null)!==referenceInfo||(duplicate.senderInfo??null)!==senderInfo||(duplicate.destinationInfo??null)!==destinationInfo||(duplicate.network??null)!==(destination?.network||submittedNetwork)||(duplicate.note??null)!==(parsed.note||null)||duplicate.withdrawalDestinationId!==(destination?.id||null))throw new Error('IDEMPOTENCY_KEY_REUSED');
				return {request:duplicate,replay:true};
			}
			if(parsed.type===FundingType.WITHDRAWAL){
				const freshAuthentication=await tx.securitySession.updateMany({
					where:{userId:user.id,sessionHash:user.sessionHash,revokedAt:null,expiresAt:{gt:new Date()},reauthenticatedAt:{gt:new Date(Date.now()-5*60_000)}},
					data:{reauthenticatedAt:null},
				});
				if(freshAuthentication.count!==1)throw new Error('FRESH_AUTH_REQUIRED');
			}
			const fundingUser=await tx.user.findUniqueOrThrow({where:{id:user.id},select:{kycStatus:true,depositEnabled:true,withdrawalEnabled:true,accountRestricted:true}});
			if(parsed.type==='DEPOSIT'&&!fundingUser.depositEnabled)throw new Error('DEPOSITS_DISABLED');
			if(parsed.type==='WITHDRAWAL'&&!fundingUser.withdrawalEnabled)throw new Error('WITHDRAWAL_DISABLED');
			if(parsed.type==='WITHDRAWAL'&&fundingUser.accountRestricted)throw new Error('ACCOUNT_RESTRICTED');
			if(parsed.type==='WITHDRAWAL'){
				const account=await ensureUserLedger(tx,user.id,currentUser.accountMode,currency);
				const currentBalance=await balance(tx,account.id);
				const pending=await tx.fundingRequest.aggregate({where:{userId:user.id,accountMode:currentUser.accountMode,currency,type:FundingType.WITHDRAWAL,status:{in:reservingStatuses}},_sum:{amount:true}});
				const reserved=pending._sum.amount??new Prisma.Decimal(0);
				if(currentUser.accountMode==='REAL')validateWithdrawal({balance:currentBalance.toString(),pending:reserved.toString(),amount:amount.toString(),withdrawalEnabled:fundingUser.withdrawalEnabled,accountRestricted:fundingUser.accountRestricted,kycStatus:fundingUser.kycStatus});
				else if(currentBalance.lt(amount.plus(reserved)))throw new Error('INSUFFICIENT_AVAILABLE_BALANCE');
				if(currentUser.accountMode==='REAL'){
					const withdrawable=await getRealWithdrawableBalance(tx,user.id,currentBalance);
					if(getWithdrawalEligibilityIssue(amount.toString(),withdrawable.toString())==='INSUFFICIENT_RESERVE')throw new Error('WITHDRAWAL_RESERVE_REQUIRED');
				}
			}
			const request=await tx.fundingRequest.create({data:{
				userId:user.id,
				type:parsed.type,
				method:destination?.type==='BANK_TRANSFER'?'Bank transfer':destination?.type==='CRYPTOCURRENCY'?'Cryptocurrency wallet':`Internal REAL ${parsed.type.toLowerCase()} request`,
				amount,
				...(withdrawalFee&&withdrawalNet?{feeAmount:withdrawalFee,feePercent:new Prisma.Decimal(WITHDRAWAL_COMMISSION_PERCENT),creditedAmount:withdrawalNet,creditedCurrency:currency}:{}),
				currency,
				status:FundingStatus.PENDING_REVIEW,
				accountMode:currentUser.accountMode,
				paymentMethodId:null,
				idempotencyKey,
				transactionReference,
								referenceInfo,
								senderInfo,
								destinationInfo,
				beneficiaryInfo:null,
								network:destination?.network||submittedNetwork,
				withdrawalDestinationId:destination?.id||null,
				note:parsed.note||null,
				receiptKey:receiptKey||null,
			}});
			if(destination)await tx.withdrawalDestinationSnapshot.create({data:{
				fundingRequestId:request.id,type:destination.type,nickname:destination.nickname,countryCode:destination.countryCode,
				network:destination.network,asset:destination.asset,maskedLabel:destination.maskedLabel,
				ciphertext:destination.ciphertext,iv:destination.iv,authTag:destination.authTag,
			}});
			await tx.auditLog.create({data:{actorId:user.id,action:'FUNDING_SUBMITTED',entity:'FUNDING',entityId:request.id,metadata:{type:request.type,accountMode:request.accountMode,currency:request.currency,amount:request.amount.toString(),feeAmount:request.feeAmount?.toString()??null,feePercent:request.feePercent?.toString()??null,netPayout:request.creditedAmount?.toString()??null,hasEvidence:!!receiptKey,transactionReference,withdrawalDestinationId:destination?.id||null,withdrawalMethod:destination?.type||null,externalEvidenceUserSubmitted:!!receiptKey||!!transactionReference}}});
			if(receiptKey)await tx.auditLog.create({data:{actorId:user.id,action:'PAYMENT_RECEIPT_UPLOADED',entity:'FUNDING',entityId:request.id,metadata:{accountMode:request.accountMode,...evidenceMetadata}}});
			const notificationType=request.type===FundingType.DEPOSIT?NotificationType.DEPOSIT:NotificationType.WITHDRAWAL;
			await createNotification(tx,{userId:user.id,type:notificationType,title:`REAL ${request.type.toLowerCase()} request submitted`,message:request.type===FundingType.WITHDRAWAL?`Your withdrawal request is reserved for administrator review. The disclosed ${WITHDRAWAL_COMMISSION_PERCENT}% commission (${request.feeAmount?.toFixed(2)} USD) will be deducted internally only if the payout is completed. Approval does not initiate or confirm an external transfer.`:'Your request is pending administrator review. This is an internal Aurevia ledger request; no external payment or transfer is initiated.',dedupeKey:`funding:${request.id}:submitted`,relatedEntity:'FUNDING',relatedId:request.id,actionUrl:`/wallet/transactions/${request.id}`});
			await notifyActiveAdmins(tx,{type:notificationType,title:`New REAL ${request.type.toLowerCase()} request`,message:`A REAL account ${request.type.toLowerCase()} request for ${request.amount.toFixed(2)} USD awaits administrator review.${request.type===FundingType.WITHDRAWAL?` Disclosed commission: ${request.feeAmount?.toFixed(2)} USD; net payout: ${request.creditedAmount?.toFixed(2)} USD.`:''} Any attached file or reference is user-submitted information only; no external payment is processed.`,dedupeKey:`funding:${request.id}:admin`,relatedEntity:'FUNDING',relatedId:request.id,actionUrl:'/admin'});
			return {request,replay:false};
		},{isolationLevel:Prisma.TransactionIsolationLevel.Serializable,maxWait:5_000,timeout:15_000});
		if(result.replay&&receiptKey)await deletePrivateObject('receipt',user.id,receiptKey);
		const {receiptKey:storedReceiptKey,...safeRequest}=result.request;
		receiptKey=undefined;
		let emailDelivery:'sent'|'not-configured'|'failed'='not-configured';
		if(!result.replay){
			const delivery=await sendSupportEmail(`New internal ${result.request.type.toLowerCase()} request`,[`Request: ${result.request.id}`,`User: ${user.id}`,`Account mode: ${result.request.accountMode}`,`Amount: ${result.request.amount.toString()} ${result.request.currency}`,...(result.request.type===FundingType.WITHDRAWAL?[`Commission (${result.request.feePercent?.toString()||WITHDRAWAL_COMMISSION_PERCENT}%): ${result.request.feeAmount?.toString()||'Not recorded'} ${result.request.currency}`,`Net payout: ${result.request.creditedAmount?.toString()||'Not recorded'} ${result.request.creditedCurrency||result.request.currency}`]:[]),`Status: ${result.request.status}`].join('\n'));
			emailDelivery=emailDeliveryStatus(delivery);
		}
		const withdrawalDestination=destination?{id:destination.id,type:destination.type,nickname:destination.nickname,countryCode:destination.countryCode,network:destination.network,asset:destination.asset,maskedLabel:destination.maskedLabel}:null;
		return NextResponse.json({...jsonSafe(safeRequest),withdrawalDestination,hasReceipt:!!storedReceiptKey,emailDelivery},{status:result.replay?200:201});
	}catch(error){
		if(receiptKey&&ownerId)await deletePrivateObject('receipt',ownerId,receiptKey);
		if(error instanceof ZodError)return NextResponse.json({error:'Check the funding amount and request details, including any BTC network fields.'},{status:400});
		if(error instanceof FundingEvidenceError)return NextResponse.json({error:error.message},{status:error.status});
		if(error instanceof PrivateStorageError)return NextResponse.json({error:error.message},{status:error.status});
		if(error instanceof Prisma.PrismaClientKnownRequestError&&error.code==='P2002')return NextResponse.json({error:'This submission was already received.'},{status:409});
		if(error instanceof Error&&error.message==='ACCOUNT_MODE_CHANGED')return NextResponse.json({error:'Your active account mode changed. Refresh and submit the request again.'},{status:409});
		if(error instanceof Error&&error.message==='WALLET_ACCOUNT_UNAVAILABLE')return NextResponse.json({error:'Wallet account is unavailable.'},{status:403});
		if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'Too many funding requests. Try again later.'},{status:429});
		if(error instanceof Error&&error.message==='FRESH_AUTH_REQUIRED')return NextResponse.json({error:'Verify your current password and authenticator code before requesting a withdrawal.',code:'REAUTH_REQUIRED'},{status:428});
		if(error instanceof Error&&error.message==='WITHDRAWAL_DESTINATION_ENCRYPTION_KEY_REQUIRED')return NextResponse.json({error:'Secure destination storage is not configured. Contact Aurevia support.'},{status:503});
		if(error instanceof Error&&error.message==='WITHDRAWAL_DESTINATION_DECRYPTION_FAILED')return NextResponse.json({error:'The saved destination could not be verified. Contact Aurevia support.'},{status:503});
		if(error&&typeof error==='object'&&'code'in error&&String(error.code)==='P2034')return NextResponse.json({error:'The account changed while submitting this request. Refresh and try again.'},{status:409});
		const known=['IDEMPOTENCY_KEY_REUSED','PAYMENT_METHOD_UNAVAILABLE','AMOUNT_OUT_OF_RANGE','PAYMENT_INSTRUCTIONS_UNAVAILABLE','WITHDRAWAL_DESTINATION_REQUIRED','WITHDRAWAL_NETWORK_REQUIRED','INSUFFICIENT_AVAILABLE_BALANCE','DEPOSITS_DISABLED','WITHDRAWAL_DISABLED','ACCOUNT_RESTRICTED','REAL_KYC_REQUIRED','INVALID_AMOUNT','FIRST_TRADE_REQUIRED','BITCOIN_DETAILS_NOT_ALLOWED','BITCOIN_NETWORK_REQUIRED','BTC_WITHDRAWAL_DESTINATION_REQUIRED','INVALID_BTC_TXID','INVALID_BTC_SENDER_ADDRESS','WITHDRAWAL_BELOW_MINIMUM','WITHDRAWAL_ABOVE_MAXIMUM','WITHDRAWAL_RESERVE_REQUIRED','WITHDRAWAL_AMOUNT_BELOW_COMMISSION_MINIMUM'];
		if(error instanceof Error&&known.includes(error.message)){
			const messages:Record<string,string>={
				WITHDRAWAL_BELOW_MINIMUM:`The minimum REAL withdrawal request is $${MIN_REAL_WITHDRAWAL_USD.toLocaleString('en-US')}.`,
				WITHDRAWAL_ABOVE_MAXIMUM:`The maximum REAL withdrawal request is $${MAX_REAL_WITHDRAWAL_USD.toLocaleString('en-US')}.`,
				WITHDRAWAL_RESERVE_REQUIRED:`Keep at least $${REQUIRED_REAL_WITHDRAWAL_RESERVE_USD.toLocaleString('en-US')} available after this request and other reservations.`,
				WITHDRAWAL_AMOUNT_BELOW_COMMISSION_MINIMUM:'Withdrawal must be at least $0.05 so the 10% commission rounds to at least $0.01.',
			};
			const status=error.message==='IDEMPOTENCY_KEY_REUSED'?409:error.message==='DEPOSITS_DISABLED'||error.message==='ACCOUNT_RESTRICTED'||error.message==='WITHDRAWAL_DISABLED'||error.message==='REAL_KYC_REQUIRED'||error.message==='FIRST_TRADE_REQUIRED'?403:error.message==='WITHDRAWAL_RESERVE_REQUIRED'?409:400;
			return NextResponse.json({error:messages[error.message]||error.message.replaceAll('_',' ').toLowerCase()},{status});
		}
		const code=error&&typeof error==='object'&&'code' in error?String(error.code):'';
		if(['P1001','P1002','P1017','P2021','P2022'].includes(code))return NextResponse.json({error:'Funding service is temporarily unavailable.'},{status:503});
		console.error(`Funding request failed (${/^[A-Z0-9_]{2,32}$/.test(code)?code:error instanceof Error?error.name:'UnknownError'}).`);
		return NextResponse.json({error:'Unable to submit this funding request.'},{status:500});
	}
}