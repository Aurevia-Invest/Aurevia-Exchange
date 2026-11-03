import {AccountMode,FundingStatus,FundingType,Prisma,PrismaClient,EntryType} from '@prisma/client';
import {DEMO_OPENING_BALANCE,REAL_OPENING_BALANCE} from './config/simulation';
const D=Prisma.Decimal;type Tx=PrismaClient|Prisma.TransactionClient;
export function roundUsdAmount(amount:Prisma.Decimal|string|number){return new D(amount).toDecimalPlaces(2,Prisma.Decimal.ROUND_HALF_UP);}
export async function balance(tx:Tx,accountId:string){
 const [rows,account]=await Promise.all([
  tx.ledgerEntry.groupBy({by:['type'],where:{accountId},_sum:{amount:true}}),
  tx.ledgerAccount.findUnique({where:{id:accountId},select:{currency:true}}),
 ]);
 const total=rows.reduce((n,r)=>r.type===EntryType.CREDIT?n.plus(r._sum.amount??0):n.minus(r._sum.amount??0),new D(0));
 return account?.currency.toUpperCase()==='USD'?roundUsdAmount(total):total;
}
export async function reservedWithdrawalAmount(tx:Tx,userId:string,accountMode:AccountMode,currency='USD'){
 const requests=await tx.fundingRequest.aggregate({where:{userId,accountMode,currency,type:FundingType.WITHDRAWAL,status:{in:[FundingStatus.PENDING,FundingStatus.PENDING_REVIEW,FundingStatus.APPROVED,FundingStatus.PROCESSING]}},_sum:{amount:true}});
 return requests._sum.amount??new D(0);
}
export async function postDoubleEntry(tx:Tx,args:{reference:string;description:string;debitAccountId:string;creditAccountId:string;amount:Prisma.Decimal|string|number}){
 const amountInput=new D(args.amount);
 if(amountInput.lte(0))throw new Error('INVALID_AMOUNT');
 if(args.debitAccountId===args.creditAccountId)throw new Error('SAME_LEDGER_ACCOUNT');
 const accounts=await tx.ledgerAccount.findMany({where:{id:{in:[args.debitAccountId,args.creditAccountId]}},select:{id:true,currency:true,accountMode:true}});
 const debitCurrency=accounts.find(account=>account.id===args.debitAccountId)?.currency.toUpperCase();
 const creditCurrency=accounts.find(account=>account.id===args.creditAccountId)?.currency.toUpperCase();
 const debitMode=accounts.find(account=>account.id===args.debitAccountId)?.accountMode;
 const creditMode=accounts.find(account=>account.id===args.creditAccountId)?.accountMode;
 if(!debitCurrency||!creditCurrency)throw new Error('LEDGER_ACCOUNT_NOT_FOUND');
 if(debitCurrency!==creditCurrency)throw new Error('LEDGER_CURRENCY_MISMATCH');
 if(!debitMode||!creditMode)throw new Error('LEDGER_ACCOUNT_NOT_FOUND');
 if(debitMode!==creditMode)throw new Error('LEDGER_MODE_MISMATCH');
 const amount=debitCurrency==='USD'?roundUsdAmount(amountInput):amountInput;
 if(amount.lte(0))throw new Error('INVALID_ROUNDED_AMOUNT');
 await tx.ledgerTransaction.create({data:{reference:args.reference,description:args.description,accountMode:debitMode,entries:{create:[{accountId:args.debitAccountId,accountMode:debitMode,type:EntryType.DEBIT,amount},{accountId:args.creditAccountId,accountMode:creditMode,type:EntryType.CREDIT,amount}]} }});
}
export async function postGrossCreditWithFee(tx:Tx,args:{reference:string;description:string;clearingAccountId:string;userAccountId:string;feeAccountId:string;grossAmount:Prisma.Decimal|string|number;creditedAmount:Prisma.Decimal|string|number;feeAmount:Prisma.Decimal|string|number}){
 const gross=new D(args.grossAmount);
 const credited=new D(args.creditedAmount);
 const fee=new D(args.feeAmount);
 if(gross.lte(0)||credited.lt(0)||fee.lt(0)||!credited.plus(fee).equals(gross))throw new Error('INVALID_DEPOSIT_ALLOCATION');
 const accounts=await tx.ledgerAccount.findMany({where:{id:{in:[args.clearingAccountId,args.userAccountId,args.feeAccountId]}},select:{id:true,currency:true,accountMode:true}});
 if(accounts.length!==3)throw new Error('LEDGER_ACCOUNT_NOT_FOUND');
 const currencies=new Set(accounts.map(account=>account.currency.toUpperCase()));
 const modes=new Set(accounts.map(account=>account.accountMode));
 if(currencies.size!==1)throw new Error('LEDGER_CURRENCY_MISMATCH');
 if(modes.size!==1)throw new Error('LEDGER_MODE_MISMATCH');
 const currency=accounts[0].currency.toUpperCase();
 const accountMode=accounts[0].accountMode;
 const round=(value:Prisma.Decimal)=>currency==='USD'?roundUsdAmount(value):value;
 const debitAmount=round(gross);
 const creditAmount=round(credited);
 const feeValue=round(fee);
 if(debitAmount.lte(0)||!creditAmount.plus(feeValue).equals(debitAmount))throw new Error('INVALID_DEPOSIT_ALLOCATION');
 const entries:Prisma.LedgerEntryCreateWithoutTransactionInput[]=[
  {account:{connect:{id:args.clearingAccountId}},accountMode,type:EntryType.DEBIT,amount:debitAmount},
  {account:{connect:{id:args.userAccountId}},accountMode,type:EntryType.CREDIT,amount:creditAmount},
 ];
 if(feeValue.gt(0))entries.push({account:{connect:{id:args.feeAccountId}},accountMode,type:EntryType.CREDIT,amount:feeValue});
 await tx.ledgerTransaction.create({data:{reference:args.reference,description:args.description,accountMode,entries:{create:entries}}});
}
export async function postWithdrawalDebitWithFee(tx:Tx,args:{reference:string;description:string;userAccountId:string;payoutAccountId:string;feeAccountId:string;grossAmount:Prisma.Decimal|string|number;netPayout:Prisma.Decimal|string|number;feeAmount:Prisma.Decimal|string|number}){
 const gross=new D(args.grossAmount);
 const payout=new D(args.netPayout);
 const fee=new D(args.feeAmount);
 if(gross.lte(0)||payout.lt(0)||fee.lt(0)||!payout.plus(fee).equals(gross))throw new Error('INVALID_WITHDRAWAL_ALLOCATION');
 const accountIds=[args.userAccountId,args.payoutAccountId,args.feeAccountId];
 const accounts=await tx.ledgerAccount.findMany({where:{id:{in:accountIds}},select:{id:true,currency:true,accountMode:true}});
 if(accounts.length!==new Set(accountIds).size)throw new Error('LEDGER_ACCOUNT_NOT_FOUND');
 const currencies=new Set(accounts.map(account=>account.currency.toUpperCase()));
 const modes=new Set(accounts.map(account=>account.accountMode));
 if(currencies.size!==1)throw new Error('LEDGER_CURRENCY_MISMATCH');
 if(modes.size!==1)throw new Error('LEDGER_MODE_MISMATCH');
 const accountMode=accounts[0].accountMode;
 const currency=accounts[0].currency.toUpperCase();
 const round=(value:Prisma.Decimal)=>currency==='USD'?roundUsdAmount(value):value;
 const debitAmount=round(gross);
 const payoutAmount=round(payout);
 const feeValue=round(fee);
 if(debitAmount.lte(0)||!payoutAmount.plus(feeValue).equals(debitAmount))throw new Error('INVALID_WITHDRAWAL_ALLOCATION');
 const entries:Prisma.LedgerEntryCreateWithoutTransactionInput[]=[
  {account:{connect:{id:args.userAccountId}},accountMode,type:EntryType.DEBIT,amount:debitAmount},
  {account:{connect:{id:args.payoutAccountId}},accountMode,type:EntryType.CREDIT,amount:payoutAmount},
 ];
 if(feeValue.gt(0))entries.push({account:{connect:{id:args.feeAccountId}},accountMode,type:EntryType.CREDIT,amount:feeValue});
 await tx.ledgerTransaction.create({data:{reference:args.reference,description:args.description,accountMode,entries:{create:entries}}});
}
export async function postLoanRepayment(tx:Tx,args:{reference:string;description:string;cashAccountId:string;receivableAccountId:string;interestAccountId:string;lateFeeAccountId:string;principalAmount:Prisma.Decimal|string|number;interestAmount:Prisma.Decimal|string|number;lateFeeAmount:Prisma.Decimal|string|number}){
 const principal=roundUsdAmount(args.principalAmount);
 const interest=roundUsdAmount(args.interestAmount);
 const lateFee=roundUsdAmount(args.lateFeeAmount);
 const amount=principal.plus(interest).plus(lateFee);
 if(principal.lt(0)||interest.lt(0)||lateFee.lt(0)||amount.lte(0))throw new Error('INVALID_REPAYMENT_ALLOCATION');
 const ids=[args.cashAccountId,args.receivableAccountId,args.interestAccountId,args.lateFeeAccountId];
 const accounts=await tx.ledgerAccount.findMany({where:{id:{in:ids}},select:{id:true,currency:true,accountMode:true}});
 if(accounts.length!==new Set(ids).size)throw new Error('LEDGER_ACCOUNT_NOT_FOUND');
 const currencies=new Set(accounts.map(account=>account.currency.toUpperCase()));
 const modes=new Set(accounts.map(account=>account.accountMode));
 if(currencies.size!==1)throw new Error('LEDGER_CURRENCY_MISMATCH');
 if(modes.size!==1)throw new Error('LEDGER_MODE_MISMATCH');
 if(accounts[0].currency.toUpperCase()!=='USD'||accounts[0].accountMode!==AccountMode.REAL)throw new Error('REAL_USD_LEDGER_REQUIRED');
 const accountMode=accounts[0].accountMode;
 const entries:Prisma.LedgerEntryCreateWithoutTransactionInput[]=[
  {account:{connect:{id:args.cashAccountId}},accountMode,type:EntryType.DEBIT,amount},
 ];
 if(principal.gt(0))entries.push({account:{connect:{id:args.receivableAccountId}},accountMode,type:EntryType.CREDIT,amount:principal});
 if(interest.gt(0))entries.push({account:{connect:{id:args.interestAccountId}},accountMode,type:EntryType.CREDIT,amount:interest});
 if(lateFee.gt(0))entries.push({account:{connect:{id:args.lateFeeAccountId}},accountMode,type:EntryType.CREDIT,amount:lateFee});
 await tx.ledgerTransaction.create({data:{reference:args.reference,description:args.description,accountMode,entries:{create:entries}}});
}
export async function ensureUserLedger(tx:Tx,userId:string,accountMode:AccountMode=AccountMode.DEMO,currency='USD'){const normalizedCurrency=currency.toUpperCase();const code=`USER:${userId}:${accountMode}:${normalizedCurrency}`;return tx.ledgerAccount.upsert({where:{code},update:{},create:{userId,accountMode,code,name:`${accountMode} account ${userId} ${normalizedCurrency}`,currency:normalizedCurrency}})}
export async function ensureSystemAccount(tx:Tx,code:string,name:string,currency='USD',accountMode:AccountMode=AccountMode.DEMO){return tx.ledgerAccount.upsert({where:{code},update:{},create:{code,name,currency:currency.toUpperCase(),accountMode}})}
export const PAPER_STARTING_BALANCE=new D(DEMO_OPENING_BALANCE);
export const DEMO_STARTING_BALANCE=PAPER_STARTING_BALANCE;
export const REAL_STARTING_BALANCE=new D(REAL_OPENING_BALANCE);
export async function initializePaperAccount(tx:Tx,userId:string,accountMode:AccountMode){
 const account=await ensureUserLedger(tx,userId,accountMode,'USD');
 if(accountMode===AccountMode.REAL)return false;
 const reference=`${accountMode}:STARTING_BALANCE:${userId}`;
 const existing=await tx.ledgerTransaction.findUnique({where:{reference},select:{id:true}});
 if(existing)return false;
 if(account.startingBalance.gt(0))return false;
 await tx.ledgerAccount.update({where:{id:account.id},data:{startingBalance:DEMO_STARTING_BALANCE}});
 const capital=await ensureSystemAccount(tx,`SYSTEM:${accountMode}:INITIAL_CAPITAL`,`${accountMode} paper-account capital`,'USD',accountMode);
 await postDoubleEntry(tx,{reference,description:'Initial DEMO virtual account allocation',debitAccountId:capital.id,creditAccountId:account.id,amount:DEMO_STARTING_BALANCE});
 await tx.auditLog.create({data:{actorId:userId,action:'DEMO_PAPER_ACCOUNT_INITIALIZED',entity:'LEDGER_ACCOUNT',entityId:account.id,metadata:{accountMode,currency:'USD',amount:DEMO_STARTING_BALANCE.toFixed(2),simulated:true,paperAccount:true}}});
 return true;
}
export async function initializeDemoAccount(tx:Tx,userId:string){return initializePaperAccount(tx,userId,AccountMode.DEMO);}
export async function assertTransactionBalanced(tx:Tx,transactionId:string){const rows=await tx.ledgerEntry.findMany({where:{transactionId}});const debit=rows.filter(x=>x.type===EntryType.DEBIT).reduce((n,x)=>n.plus(x.amount),new D(0));const credit=rows.filter(x=>x.type===EntryType.CREDIT).reduce((n,x)=>n.plus(x.amount),new D(0));if(!debit.eq(credit))throw new Error('UNBALANCED_LEDGER_TRANSACTION');return {debit,credit};}
