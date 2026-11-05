import {NextResponse} from 'next/server';
import {AccountMode,InvestmentOpportunityStatus,InvestmentStatus,NotificationType,Prisma} from '@prisma/client';
import {z,ZodError} from 'zod';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {balance,ensureSystemAccount,ensureUserLedger,postDoubleEntry,roundUsdAmount} from '@/lib/ledger';
import {getRealWithdrawableBalance} from '@/lib/real-withdrawals';
import {createNotification,notifyActiveAdmins} from '@/lib/notifications';
import {jsonSafe} from '@/lib/serializers';
import {configuredTierBoost} from '@/lib/tier-boosts';
import {getAccountTier,getTierProfileRequirements} from '@/lib/production-policy';
import {simulatedInvestmentSettlement} from '@/lib/investment-policy';

export const dynamic='force-dynamic';

const requestSchema=z.object({opportunityId:z.string().min(1),amount:z.number().positive().max(1_000_000_000)});
const requestKeyPattern=/^[a-zA-Z0-9_-]{12,128}$/;

function sameRequest(existing:{userId:string;opportunityId:string;accountMode:AccountMode;amount:Prisma.Decimal},userId:string,opportunityId:string,accountMode:AccountMode,amount:number){
 return existing.userId===userId&&existing.opportunityId===opportunityId&&existing.accountMode===accountMode&&existing.amount.equals(amount);
}

export async function GET(){
 try{
  const user=await requireUser();
  const activeUser=await db.user.findUnique({where:{id:user.id},select:{accountMode:true,status:true,role:true,accountRestricted:true}});
  if(!activeUser||activeUser.status!=='ACTIVE'||activeUser.role!=='USER')return NextResponse.json({error:'This account is unavailable.'},{status:403});
  if(activeUser.accountMode!==user.accountMode)return NextResponse.json({error:'Your active account mode changed. Refresh and try again.'},{status:409,headers:{'Cache-Control':'private, no-store'}});
  if(activeUser.accountMode!==AccountMode.REAL)return NextResponse.json({error:'Investment access is available to eligible REAL accounts only.'},{status:403,headers:{'Cache-Control':'private, no-store'}});
  if(activeUser.accountRestricted)return NextResponse.json({error:'Investment access is restricted for this account.'},{status:403,headers:{'Cache-Control':'private, no-store'}});
  const accountMode=AccountMode.REAL;
  const [opportunities,requests,account]=await Promise.all([
   db.investmentOpportunity.findMany({where:{status:InvestmentOpportunityStatus.AVAILABLE,realEligible:true},orderBy:{createdAt:'desc'}}),
   db.investmentRequest.findMany({where:{userId:user.id,accountMode},include:{opportunity:{select:{title:true,category:true,assetSymbol:true,riskLevel:true,targetReturnPercent:true,durationDays:true}}},orderBy:{requestedAt:'desc'}}),
   db.ledgerAccount.findUnique({where:{code:`USER:${user.id}:${accountMode}:USD`},select:{id:true,startingBalance:true}}),
  ]);
    const ledgerBalance=account?await balance(db,account.id):new Prisma.Decimal(0);
    const availableBalance=account?await getRealWithdrawableBalance(db,user.id,ledgerBalance):new Prisma.Decimal(0);
    const requestsWithDisplayTerms=requests.map(item=>({
     ...item,
     displayTargetPayout:item.status===InvestmentStatus.ACTIVE
      ?simulatedInvestmentSettlement(item.amount,item.targetReturnPercent,item.tierBoostPercent??new Prisma.Decimal(0)).toString()
      :null,
    }));
    return NextResponse.json(jsonSafe({accountMode,availableBalance,startingBalance:account?.startingBalance??new Prisma.Decimal(0),opportunities,requests:requestsWithDisplayTerms}),{headers:{'Cache-Control':'private, no-store'}});
 }catch(error){
  return NextResponse.json({error:error instanceof Error&&error.message==='UNAUTHORIZED'?'Unauthorized':'Unable to load investments.'},{status:error instanceof Error&&error.message==='UNAUTHORIZED'?401:503,headers:{'Cache-Control':'private, no-store'}});
 }
}

export async function POST(request:Request){
 try{
  const user=await requireUser();
  const inputProfile=await db.user.findUnique({where:{id:user.id},select:{status:true,role:true,accountMode:true}});
  if(!inputProfile||inputProfile.status!=='ACTIVE'||inputProfile.role!=='USER')return NextResponse.json({error:'This account is unavailable.'},{status:403});
  if(inputProfile.accountMode!==AccountMode.REAL)return NextResponse.json({error:'Investment access is available to eligible REAL accounts only.'},{status:403,headers:{'Cache-Control':'private, no-store'}});
  if(user.accountMode!==inputProfile.accountMode)return NextResponse.json({error:'Your active account mode changed. Refresh and submit again.'},{status:409});
  const input=requestSchema.parse(await request.json());
  const requestedAmount=roundUsdAmount(input.amount);
  if(requestedAmount.lte(0))throw new Error('INVALID_AMOUNT');
  const idempotencyKey=request.headers.get('Idempotency-Key')||'';
  if(!requestKeyPattern.test(idempotencyKey))return NextResponse.json({error:'A valid idempotency key is required.'},{status:400});
  const submit=()=>db.$transaction(async tx=>{
   const [profile,opportunity]=await Promise.all([
    tx.user.findUnique({where:{id:user.id},select:{status:true,role:true,accountMode:true,accountRestricted:true,approvedTier:true,name:true,country:true,phone:true,phoneVerified:true,kycStatus:true,kyc:{select:{submittedAt:true}},kycDocuments:{where:{kind:'IDENTITY_DOCUMENT',status:'APPROVED'},select:{id:true}}}}),
    tx.investmentOpportunity.findUnique({where:{id:input.opportunityId}}),
   ]);
   if(!profile||profile.status!=='ACTIVE'||profile.role!=='USER')throw new Error('INVESTMENT_USER_UNAVAILABLE');
   if(profile.accountMode!==AccountMode.REAL)throw new Error('INVESTMENT_REAL_MODE_REQUIRED');
   if(profile.accountMode!==user.accountMode)throw new Error('ACCOUNT_MODE_CHANGED');
   if(profile.accountRestricted)throw new Error('INVESTMENT_USER_RESTRICTED');
   const prior=await tx.investmentRequest.findUnique({where:{idempotencyKey}});
   if(prior){
    if(!sameRequest(prior,user.id,input.opportunityId,profile.accountMode,requestedAmount.toNumber()))throw new Error('IDEMPOTENCY_KEY_REUSED');
    return {investment:prior,replay:true};
   }
   if(!opportunity||opportunity.status!==InvestmentOpportunityStatus.AVAILABLE)throw new Error('INVESTMENT_UNAVAILABLE');
   if(!opportunity.realEligible)throw new Error('INVESTMENT_MODE_UNAVAILABLE');
   const amount=requestedAmount;
   if(amount.lt(opportunity.minimumAmount)||(opportunity.maximumAmount&&amount.gt(opportunity.maximumAmount)))throw new Error('INVESTMENT_AMOUNT_OUT_OF_RANGE');
    const now=new Date();
    const activatedAt=opportunity.startsAt&&opportunity.startsAt>now?opportunity.startsAt:now;
    const maturesAt=opportunity.maturesAt??new Date(activatedAt.getTime()+opportunity.durationDays*86_400_000);
    if(!opportunity.requiresApproval&&maturesAt<=activatedAt)throw new Error('INVESTMENT_MATURED');
    const status:InvestmentStatus=opportunity.requiresApproval?InvestmentStatus.PENDING_APPROVAL:activatedAt<=now?InvestmentStatus.ACTIVE:InvestmentStatus.APPROVED;
    const profileRequirements=getTierProfileRequirements(profile);
    const currentTier=Number(getAccountTier({accountMode:profile.accountMode,kycStatus:profile.kycStatus,verificationDocuments:profile.kycDocuments.length,verificationSubmitted:!!profile.kyc?.submittedAt,phoneVerified:profile.phoneVerified,profileComplete:profileRequirements.profileComplete,approvedTier:profile.approvedTier}).label.at(-1));
    const tierBoostPercent=await configuredTierBoost(tx,currentTier);
    const investment=await tx.investmentRequest.create({data:{userId:user.id,opportunityId:opportunity.id,accountMode:AccountMode.REAL,amount,status,idempotencyKey,targetReturnPercent:opportunity.targetReturnPercent,tierBoostPercent,durationDays:opportunity.durationDays,...(opportunity.requiresApproval?{}:{approvedAt:now,activatedAt,maturesAt})}});
   const userAccount=await ensureUserLedger(tx,user.id,AccountMode.REAL,'USD');
   const available=await balance(tx,userAccount.id);
    const withdrawable=await getRealWithdrawableBalance(tx,user.id,available);
    if(withdrawable.lt(amount))throw new Error('INSUFFICIENT_SIMULATED_BALANCE');
   const escrow=await ensureSystemAccount(tx,`SYSTEM:INVESTMENT_ESCROW:${AccountMode.REAL}:USD`,`${AccountMode.REAL} investment escrow`,'USD',AccountMode.REAL);
   await postDoubleEntry(tx,{reference:`INVESTMENT:${investment.id}:RESERVE`,description:`Reserve ${AccountMode.REAL} investment funds for ${opportunity.title}`,debitAccountId:userAccount.id,creditAccountId:escrow.id,amount});
   await tx.auditLog.create({data:{actorId:user.id,action:'INVESTMENT_SUBMITTED',entity:'INVESTMENT',entityId:investment.id,metadata:{opportunityId:opportunity.id,accountMode:AccountMode.REAL,amount:amount.toString(),tierBoostPercent:tierBoostPercent.toString(),status,simulated:true}}});
  await createNotification(tx,{userId:user.id,type:NotificationType.SYSTEM,title:`${AccountMode.REAL} investment ${opportunity.requiresApproval?'request submitted':'started'}`,message:`Your ${AccountMode.REAL} investment is ${opportunity.requiresApproval?'pending administrator approval':status===InvestmentStatus.ACTIVE?'active':`scheduled to start ${activatedAt.toISOString()}`}. The principal is reserved in the internal ledger; no external investment was made.`,dedupeKey:`investment:${investment.id}:submitted`,relatedEntity:'INVESTMENT',relatedId:investment.id,actionUrl:'/investments'});
  if(opportunity.requiresApproval)await notifyActiveAdmins(tx,{type:NotificationType.SYSTEM,title:'Investment request awaiting review',message:'A REAL investment request is awaiting administrator review.',dedupeKey:`investment:${investment.id}:admin`,relatedEntity:'INVESTMENT',relatedId:investment.id,actionUrl:'/admin/investments'});
   return {investment,replay:false};
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable,maxWait:5_000,timeout:15_000});
  let result:Awaited<ReturnType<typeof submit>>|undefined;
  for(let attempt=0;attempt<3;attempt++){
   try{
    result=await submit();
    break;
   }catch(error){
    const retryable=error instanceof Prisma.PrismaClientKnownRequestError&&error.code==='P2034';
    if(!retryable||attempt===2)throw error;
    await new Promise(resolve=>setTimeout(resolve,25*(attempt+1)));
   }
  }
  if(!result)throw new Error('INVESTMENT_SUBMISSION_INCOMPLETE');
  return NextResponse.json(jsonSafe(result.investment),{status:result.replay?200:201,headers:{'Cache-Control':'private, no-store'}});
 }catch(error){
  if(error instanceof ZodError)return NextResponse.json({error:'Enter an amount within the opportunity limits.'},{status:400});
  if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
  if(error instanceof Error&&error.message==='ACCOUNT_MODE_CHANGED')return NextResponse.json({error:'Your active account mode changed. Refresh and submit the allocation again.'},{status:409});
  if(error instanceof Error&&error.message==='INVESTMENT_REAL_MODE_REQUIRED')return NextResponse.json({error:'Investment access is available to eligible REAL accounts only.'},{status:403});
  if(error instanceof Error&&['IDEMPOTENCY_KEY_REUSED','INVESTMENT_UNAVAILABLE','INVESTMENT_MODE_UNAVAILABLE','INVESTMENT_MATURED','INVESTMENT_USER_UNAVAILABLE','INVESTMENT_USER_RESTRICTED'].includes(error.message))return NextResponse.json({error:error.message.replaceAll('_',' ').toLowerCase()},{status:409});
  if(error instanceof Error&&error.message==='INSUFFICIENT_SIMULATED_BALANCE')return NextResponse.json({error:'Insufficient available REAL account cash for this investment.'},{status:400});
  if(error instanceof Error&&['INVESTMENT_AMOUNT_OUT_OF_RANGE','INVALID_AMOUNT'].includes(error.message))return NextResponse.json({error:error.message.replaceAll('_',' ').toLowerCase()},{status:400});
  if(error&&typeof error==='object'&&'code'in error&&String(error.code)==='P2002')return NextResponse.json({error:'This investment request was already received.'},{status:409});
  const code=error&&typeof error==='object'&&'code'in error?String(error.code):'';
  console.error(`Investment submission failed (${/^[A-Z0-9_]{2,32}$/.test(code)?code:error instanceof Error?error.name:'UnknownError'}).`);
  return NextResponse.json({error:'Unable to submit this investment request.'},{status:503});
 }
}