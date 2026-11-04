import {NextResponse} from 'next/server';
import {AccountMode,InvestmentOpportunityStatus,InvestmentRisk,InvestmentStatus,NotificationType,Prisma} from '@prisma/client';
import {z,ZodError} from 'zod';
import {requireAdmin} from '@/lib/auth';
import {db} from '@/lib/db';
import {balance,ensureSystemAccount,ensureUserLedger,postDoubleEntry,reservedWithdrawalAmount,roundUsdAmount} from '@/lib/ledger';
import {InvestmentAction,nextInvestmentStatus,simulatedInvestmentSettlement} from '@/lib/investment-policy';
import {createNotification} from '@/lib/notifications';
import {jsonSafe} from '@/lib/serializers';
import {configuredTierBoost} from '@/lib/tier-boosts';
import {getAccountTier,getTierProfileRequirements} from '@/lib/production-policy';
import {postSimulatedInvestmentPayout} from '@/lib/investment-ledger';

export const dynamic='force-dynamic';

const opportunityFields=z.object({
 title:z.string().trim().min(3).max(120),
 category:z.string().trim().min(2).max(80),
 description:z.string().trim().min(10).max(3000),
 assetSymbol:z.string().trim().max(30).optional().nullable(),
 minimumAmount:z.number().positive().max(1_000_000_000),
 maximumAmount:z.number().positive().max(1_000_000_000).optional().nullable(),
 targetReturnPercent:z.number().min(-100).max(1000).optional().nullable(),
 durationDays:z.number().int().min(1).max(3650),
 startsAt:z.coerce.date().optional().nullable(),
 maturesAt:z.coerce.date().optional().nullable(),
 riskLevel:z.nativeEnum(InvestmentRisk),
 status:z.nativeEnum(InvestmentOpportunityStatus).default(InvestmentOpportunityStatus.DRAFT),
 demoEligible:z.boolean().default(false),
 realEligible:z.boolean().default(true),
 requiresApproval:z.boolean().default(true),
 targetPrice:z.number().positive().optional().nullable(),
 stopPrice:z.number().positive().optional().nullable(),
});
const opportunitySchema=opportunityFields.superRefine((value,context)=>{
 if(value.maximumAmount!==undefined&&value.maximumAmount!==null&&value.maximumAmount<value.minimumAmount)context.addIssue({code:z.ZodIssueCode.custom,path:['maximumAmount'],message:'Maximum must be at least minimum.'});
 if(value.startsAt&&value.maturesAt&&value.maturesAt<=value.startsAt)context.addIssue({code:z.ZodIssueCode.custom,path:['maturesAt'],message:'Maturity must follow the start date.'});
});

const updateOpportunitySchema=opportunityFields.partial().extend({action:z.literal('update-opportunity'),id:z.string().min(1)}).superRefine((value,context)=>{
 if(value.minimumAmount!==undefined&&value.maximumAmount!==undefined&&value.maximumAmount!==null&&value.maximumAmount<value.minimumAmount)context.addIssue({code:z.ZodIssueCode.custom,path:['maximumAmount'],message:'Maximum must be at least minimum.'});
 if(value.startsAt&&value.maturesAt&&value.maturesAt<=value.startsAt)context.addIssue({code:z.ZodIssueCode.custom,path:['maturesAt'],message:'Maturity must follow the start date.'});
});
const lifecycleSchema=z.object({
 action:z.enum(['approve','reject','activate','pause','complete','cancel','settle']),
 requestId:z.string().min(1),
 note:z.string().trim().max(500).optional(),
});
const initiationSchema=z.object({
  action:z.literal('initiate'),userId:z.string().min(1),opportunityId:z.string().min(1),accountMode:z.nativeEnum(AccountMode),
  amount:z.number().positive().max(1_000_000_000),targetReturnPercent:z.number().min(-100).max(1000).nullable(),startsAt:z.coerce.date(),maturesAt:z.coerce.date(),
});
const requestKeyPattern=/^[a-zA-Z0-9_-]{12,128}$/;

export async function GET(){
 try{
  await requireAdmin();
  const [opportunities,requests]=await Promise.all([
   db.investmentOpportunity.findMany({include:{_count:{select:{requests:true}}},orderBy:{createdAt:'desc'}}),
   db.investmentRequest.findMany({include:{user:{select:{id:true,email:true,name:true}},opportunity:{select:{title:true,category:true,riskLevel:true,durationDays:true}}},orderBy:{requestedAt:'desc'},take:500}),
  ]);
  return NextResponse.json(jsonSafe({opportunities,requests}),{headers:{'Cache-Control':'private, no-store'}});
 }catch(error){
  const status=error instanceof Error&&error.message==='UNAUTHORIZED'?401:403;
  return NextResponse.json({error:status===401?'Unauthorized':'Forbidden'},{status});
 }
}

export async function POST(request:Request){
 try{
  const admin=await requireAdmin();
  const body=await request.json() as {action?:string};
  if(body.action==='initiate'){
   const input=initiationSchema.parse(body);
   if(input.accountMode!==AccountMode.REAL)return NextResponse.json({error:'Investment initiation is restricted to REAL accounts.'},{status:400});
   const requestedAmount=roundUsdAmount(input.amount);
   if(requestedAmount.lte(0))throw new Error('INVALID_AMOUNT');
   const idempotencyKey=request.headers.get('Idempotency-Key')||'';
   if(!requestKeyPattern.test(idempotencyKey))return NextResponse.json({error:'A valid idempotency key is required.'},{status:400});
   if(input.maturesAt<=input.startsAt)throw new Error('INVALID_INVESTMENT_DATES');
   const durationDays=Math.ceil((input.maturesAt.getTime()-input.startsAt.getTime())/86_400_000);
   if(durationDays<1||durationDays>3650)throw new Error('INVALID_INVESTMENT_DURATION');
   const result=await db.$transaction(async tx=>{
    const [user,opportunity]=await Promise.all([
     tx.user.findUnique({where:{id:input.userId},select:{id:true,status:true,role:true,accountMode:true,accountRestricted:true,approvedTier:true,name:true,country:true,phone:true,phoneVerified:true,kycStatus:true,kyc:{select:{submittedAt:true}},kycDocuments:{where:{kind:'IDENTITY_DOCUMENT',status:'APPROVED'},select:{id:true}}}}),
     tx.investmentOpportunity.findUnique({where:{id:input.opportunityId}}),
    ]);
    if(!user||user.status!=='ACTIVE'||user.role!=='USER')throw new Error('INVESTMENT_USER_UNAVAILABLE');
    if(user.accountMode!==AccountMode.REAL)throw new Error('INVESTMENT_REAL_MODE_REQUIRED');
    if(user.accountRestricted)throw new Error('INVESTMENT_USER_RESTRICTED');
    if(!opportunity||opportunity.status!==InvestmentOpportunityStatus.AVAILABLE||!opportunity.realEligible)throw new Error('INVESTMENT_UNAVAILABLE');
    const prior=await tx.investmentRequest.findUnique({where:{idempotencyKey},include:{opportunity:{select:{targetReturnPercent:true}}}});
    if(prior){
     const expectedTarget=input.targetReturnPercent===null?prior.opportunity.targetReturnPercent:new Prisma.Decimal(input.targetReturnPercent);
     const matchingTarget=expectedTarget===null?prior.targetReturnPercent===null:prior.targetReturnPercent?.equals(expectedTarget)===true;
     const matches=prior.userId===input.userId&&prior.opportunityId===input.opportunityId&&prior.accountMode===input.accountMode&&prior.amount.equals(requestedAmount)&&matchingTarget&&prior.activatedAt?.getTime()===input.startsAt.getTime()&&prior.maturesAt?.getTime()===input.maturesAt.getTime();
     if(!matches)throw new Error('IDEMPOTENCY_KEY_REUSED');
     return {investment:prior,replay:true};
    }
    if(requestedAmount.lt(opportunity.minimumAmount)||(opportunity.maximumAmount&&requestedAmount.gt(opportunity.maximumAmount)))throw new Error('INVESTMENT_AMOUNT_OUT_OF_RANGE');
    if(opportunity.startsAt&&input.startsAt<opportunity.startsAt)throw new Error('INVESTMENT_NOT_STARTED');
    const amount=requestedAmount;
    const targetReturnPercent=input.targetReturnPercent===null?opportunity.targetReturnPercent:new Prisma.Decimal(input.targetReturnPercent);
    const profileRequirements=getTierProfileRequirements(user);
    const tierBoostPercent=await configuredTierBoost(tx,Number(getAccountTier({accountMode:input.accountMode,kycStatus:user.kycStatus,verificationDocuments:user.kycDocuments.length,verificationSubmitted:!!user.kyc?.submittedAt,phoneVerified:user.phoneVerified,profileComplete:profileRequirements.profileComplete,approvedTier:user.approvedTier}).label.at(-1)));
    const now=new Date();
    const status=input.startsAt<=now?InvestmentStatus.ACTIVE:InvestmentStatus.APPROVED;
    const investment=await tx.investmentRequest.create({data:{userId:user.id,opportunityId:opportunity.id,accountMode:AccountMode.REAL,amount,status,idempotencyKey,targetReturnPercent,tierBoostPercent,durationDays,approvedAt:now,activatedAt:input.startsAt,maturesAt:input.maturesAt}});
    const userAccount=await ensureUserLedger(tx,user.id,AccountMode.REAL,'USD');
    const available=await balance(tx,userAccount.id);
    const reserved=await reservedWithdrawalAmount(tx,user.id,AccountMode.REAL,'USD');
    if(available.lt(amount.plus(reserved)))throw new Error('INSUFFICIENT_SIMULATED_BALANCE');
    const escrow=await ensureSystemAccount(tx,`SYSTEM:INVESTMENT_ESCROW:${AccountMode.REAL}:USD`,`${AccountMode.REAL} simulated investment escrow`,'USD',AccountMode.REAL);
    await postDoubleEntry(tx,{reference:`INVESTMENT:${investment.id}:RESERVE`,description:`Reserve simulated funds for ${opportunity.title}`,debitAccountId:userAccount.id,creditAccountId:escrow.id,amount});
    await tx.auditLog.create({data:{actorId:admin.id,action:'INVESTMENT_ADMIN_INITIATED',entity:'INVESTMENT',entityId:investment.id,metadata:{userId:user.id,opportunityId:opportunity.id,accountMode:AccountMode.REAL,amount:amount.toString(),targetReturnPercent:targetReturnPercent?.toString()??null,tierBoostPercent:tierBoostPercent.toString(),durationDays,startsAt:input.startsAt.toISOString(),maturesAt:input.maturesAt.toISOString(),idempotencyKey,simulated:true}}});
    await createNotification(tx,{userId:user.id,type:NotificationType.SYSTEM,title:`${AccountMode.REAL} investment started`,message:`An administrator initiated the ${AccountMode.REAL} ${opportunity.title} investment. ${status===InvestmentStatus.ACTIVE?'It is active now.':`It is scheduled to start ${input.startsAt.toISOString()}.`} The principal was reserved in the internal ledger; no external investment was made.`,dedupeKey:`investment:${investment.id}:admin-initiated`,relatedEntity:'INVESTMENT',relatedId:investment.id,actionUrl:'/investments'});
    return {investment,replay:false};
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable,maxWait:5_000,timeout:15_000});
   return NextResponse.json(jsonSafe(result.investment),{status:result.replay?200:201,headers:{'Cache-Control':'private, no-store'}});
  }
  const input=opportunitySchema.parse(body);
  const opportunity=await db.$transaction(async tx=>{
   const created=await tx.investmentOpportunity.create({data:{...input,demoEligible:false,createdById:admin.id}});
    await tx.auditLog.create({data:{actorId:admin.id,action:'INVESTMENT_OPPORTUNITY_CREATED',entity:'INVESTMENT_OPPORTUNITY',entityId:created.id,metadata:{newState:{title:created.title,category:created.category,assetSymbol:created.assetSymbol,minimumAmount:created.minimumAmount.toString(),maximumAmount:created.maximumAmount?.toString()??null,targetReturnPercent:created.targetReturnPercent?.toString()??null,durationDays:created.durationDays,startsAt:created.startsAt?.toISOString()??null,maturesAt:created.maturesAt?.toISOString()??null,riskLevel:created.riskLevel,status:created.status,demoEligible:created.demoEligible,realEligible:created.realEligible,requiresApproval:created.requiresApproval,targetPrice:created.targetPrice?.toString()??null,stopPrice:created.stopPrice?.toString()??null}}}});
   return created;
  });
  return NextResponse.json(jsonSafe(opportunity),{status:201});
 }catch(error){
  if(error instanceof ZodError)return NextResponse.json({error:'Check the investment terms, amounts, dates, and eligibility.'},{status:400});
  if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
  if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'Forbidden'},{status:403});
  if(error instanceof Error&&error.message==='INVESTMENT_REAL_MODE_REQUIRED')return NextResponse.json({error:'Investment initiation is restricted to users whose current account mode is REAL.'},{status:403});
  if(error instanceof Error&&['IDEMPOTENCY_KEY_REUSED','INVESTMENT_UNAVAILABLE','INVESTMENT_MODE_UNAVAILABLE','INVESTMENT_USER_UNAVAILABLE','INVESTMENT_USER_RESTRICTED','INVESTMENT_NOT_STARTED'].includes(error.message))return NextResponse.json({error:error.message.replaceAll('_',' ').toLowerCase()},{status:409});
  if(error instanceof Error&&['INVESTMENT_AMOUNT_OUT_OF_RANGE','INSUFFICIENT_SIMULATED_BALANCE','INVALID_INVESTMENT_DATES','INVALID_INVESTMENT_DURATION','INVALID_AMOUNT'].includes(error.message))return NextResponse.json({error:error.message.replaceAll('_',' ').toLowerCase()},{status:400});
  if(error instanceof Prisma.PrismaClientKnownRequestError&&error.code==='P2002')return NextResponse.json({error:'This investment initiation was already received.'},{status:409});
  return NextResponse.json({error:'Unable to create the investment opportunity.'},{status:400});
 }
}

export async function PATCH(request:Request){
 try{
  const admin=await requireAdmin();
  const body=await request.json() as {action?:string};
  if(body.action==='update-opportunity'){
   const input=updateOpportunitySchema.parse(body);
   const opportunity=await db.$transaction(async tx=>{
    const current=await tx.investmentOpportunity.findUnique({where:{id:input.id}});
    if(!current)throw new Error('INVESTMENT_OPPORTUNITY_NOT_FOUND');
    const minimum=input.minimumAmount??Number(current.minimumAmount);
    const maximum=input.maximumAmount===undefined?current.maximumAmount?.toNumber()??null:input.maximumAmount;
    if(maximum!==null&&maximum<minimum)throw new Error('INVALID_INVESTMENT_RANGE');
    const startsAt=input.startsAt===undefined?current.startsAt:input.startsAt;
    const maturesAt=input.maturesAt===undefined?current.maturesAt:input.maturesAt;
    if(startsAt&&maturesAt&&maturesAt<=startsAt)throw new Error('INVALID_INVESTMENT_DATES');
    const {action:_,id,...data}=input;
    data.demoEligible=false;
    const updated=await tx.investmentOpportunity.update({where:{id},data});
    await tx.auditLog.create({data:{actorId:admin.id,action:'INVESTMENT_OPPORTUNITY_UPDATED',entity:'INVESTMENT_OPPORTUNITY',entityId:id,metadata:{oldState:{title:current.title,category:current.category,assetSymbol:current.assetSymbol,minimumAmount:current.minimumAmount.toString(),maximumAmount:current.maximumAmount?.toString()??null,targetReturnPercent:current.targetReturnPercent?.toString()??null,durationDays:current.durationDays,startsAt:current.startsAt?.toISOString()??null,maturesAt:current.maturesAt?.toISOString()??null,riskLevel:current.riskLevel,status:current.status,demoEligible:current.demoEligible,realEligible:current.realEligible,requiresApproval:current.requiresApproval,targetPrice:current.targetPrice?.toString()??null,stopPrice:current.stopPrice?.toString()??null},newState:{title:updated.title,category:updated.category,assetSymbol:updated.assetSymbol,minimumAmount:updated.minimumAmount.toString(),maximumAmount:updated.maximumAmount?.toString()??null,targetReturnPercent:updated.targetReturnPercent?.toString()??null,durationDays:updated.durationDays,startsAt:updated.startsAt?.toISOString()??null,maturesAt:updated.maturesAt?.toISOString()??null,riskLevel:updated.riskLevel,status:updated.status,demoEligible:updated.demoEligible,realEligible:updated.realEligible,requiresApproval:updated.requiresApproval,targetPrice:updated.targetPrice?.toString()??null,stopPrice:updated.stopPrice?.toString()??null}}}});
    return updated;
   });
   return NextResponse.json(jsonSafe(opportunity),{headers:{'Cache-Control':'private, no-store'}});
  }

  const input=lifecycleSchema.parse(body);
  const result=await db.$transaction(async tx=>{
   const current=await tx.investmentRequest.findUnique({where:{id:input.requestId},include:{opportunity:true}});
   if(!current)throw new Error('INVESTMENT_REQUEST_NOT_FOUND');
   const action=input.action as InvestmentAction;
   const nextStatus=nextInvestmentStatus(current.status,action);
   if(action==='activate'){
    if(current.opportunity.startsAt&&current.opportunity.startsAt>new Date())throw new Error('INVESTMENT_NOT_STARTED');
    if(current.activatedAt&&current.activatedAt>new Date())throw new Error('INVESTMENT_NOT_STARTED');
    if(current.opportunity.maturesAt&&current.opportunity.maturesAt<=new Date())throw new Error('INVESTMENT_OPPORTUNITY_MATURED');
   }
   let settlementReference:string|undefined;
  let simulatedPayout:Prisma.Decimal|undefined;
   if(action==='settle'){
   simulatedPayout=simulatedInvestmentSettlement(current.amount,current.targetReturnPercent,current.tierBoostPercent);
    settlementReference=`SIMULATED-SETTLEMENT:${current.accountMode}:${current.id}`;
   }
   const now=new Date();
   const updateData:Prisma.InvestmentRequestUpdateManyMutationInput={status:nextStatus,adminNote:input.note??current.adminNote};
   if(action==='approve')updateData.approvedAt=now;
   if(action==='activate'){
    updateData.activatedAt=current.activatedAt??now;
    updateData.maturesAt=current.maturesAt??current.opportunity.maturesAt??new Date(now.getTime()+current.durationDays*86_400_000);
   }
   if(action==='complete')updateData.completedAt=now;
   if(action==='settle'){
    updateData.settledAt=now;
    updateData.settlementReference=settlementReference;
    updateData.simulatedPayout=simulatedPayout;
   }
   const changed=await tx.investmentRequest.updateMany({where:{id:current.id,status:current.status},data:updateData});
   if(changed.count!==1)throw new Error('INVESTMENT_STATE_CHANGED');

   if(action==='reject'||action==='cancel'){
    const reservation=await tx.ledgerTransaction.findUnique({where:{reference:`INVESTMENT:${current.id}:RESERVE`},select:{id:true}});
    if(reservation){
     const userAccount=await ensureUserLedger(tx,current.userId,current.accountMode,'USD');
     const escrow=await ensureSystemAccount(tx,`SYSTEM:INVESTMENT_ESCROW:${current.accountMode}:USD`,`${current.accountMode} simulated investment escrow`,'USD',current.accountMode);
     await postDoubleEntry(tx,{reference:`INVESTMENT:${current.id}:REFUND`,description:`Return simulated investment funds for ${current.opportunity.title}`,debitAccountId:escrow.id,creditAccountId:userAccount.id,amount:current.amount});
    }
   }
   if(action==='settle'){
    const reservation=await tx.ledgerTransaction.findUnique({where:{reference:`INVESTMENT:${current.id}:RESERVE`},select:{id:true}});
    if(!reservation)throw new Error('SIMULATED_INVESTMENT_RESERVATION_MISSING');
    await postSimulatedInvestmentPayout(tx,{investmentId:current.id,userId:current.userId,accountMode:current.accountMode,principal:current.amount,payout:simulatedPayout!,opportunityTitle:current.opportunity.title});
   }
   const updated=await tx.investmentRequest.findUniqueOrThrow({where:{id:current.id}});
  await tx.auditLog.create({data:{actorId:admin.id,action:`INVESTMENT_${nextStatus}`,entity:'INVESTMENT',entityId:current.id,metadata:{oldState:current.status,newState:nextStatus,accountMode:current.accountMode,simulated:true,amount:current.amount.toString(),externalExecutionReference:null,settlementReference:settlementReference||null,simulatedPayout:simulatedPayout?.toString()??null,note:input.note||null}}});
   const statusText=nextStatus.toLowerCase().replaceAll('_',' ');
   const message=`Your ${current.accountMode} investment is ${statusText}. This is simulated activity. At settlement, the simulated payout is calculated from the configured target return and the tier boost captured when this allocation was created; no return is guaranteed.`;
   await createNotification(tx,{userId:current.userId,type:NotificationType.SYSTEM,title:`Investment ${statusText}`,message,dedupeKey:`investment:${current.id}:${nextStatus}:${updated.updatedAt.toISOString()}`,relatedEntity:'INVESTMENT',relatedId:current.id,actionUrl:'/investments'});
   return updated;
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable,maxWait:5_000,timeout:15_000});
  return NextResponse.json(jsonSafe(result),{headers:{'Cache-Control':'private, no-store'}});
 }catch(error){
  if(error instanceof ZodError)return NextResponse.json({error:'Invalid opportunity or investment action.'},{status:400});
  if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
  if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'Forbidden'},{status:403});
    const conflicts=['INVESTMENT_TRANSITION_NOT_ALLOWED','INVESTMENT_STATE_CHANGED','INVESTMENT_NOT_STARTED','INVESTMENT_OPPORTUNITY_MATURED','SIMULATED_INVESTMENT_RESERVATION_MISSING'];
  if(error instanceof Error&&conflicts.includes(error.message))return NextResponse.json({error:error.message.replaceAll('_',' ').toLowerCase()},{status:409});
  if(error instanceof Error&&['INVESTMENT_OPPORTUNITY_NOT_FOUND','INVESTMENT_REQUEST_NOT_FOUND'].includes(error.message))return NextResponse.json({error:'Investment record not found.'},{status:404});
  if(error instanceof Error&&['INVALID_INVESTMENT_RANGE','INVALID_INVESTMENT_DATES','SIMULATED_PAYOUT_REQUIRED'].includes(error.message))return NextResponse.json({error:error.message.replaceAll('_',' ').toLowerCase()},{status:400});
  return NextResponse.json({error:'Unable to update the investment record.'},{status:400});
 }
}