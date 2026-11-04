import {randomUUID} from 'node:crypto';
import {NextResponse} from 'next/server';
import {AccountMode,InvestmentStatus,NotificationType,OrderStatus,PositionStatus,Prisma} from '@prisma/client';
import {z,ZodError} from 'zod';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {balance,ensureSystemAccount,ensureUserLedger,initializeDemoAccount,postDoubleEntry} from '@/lib/ledger';
import {closeSimulatedPositionTx} from '@/lib/orders';
import {createNotification} from '@/lib/notifications';
import {rateLimit} from '@/lib/rate-limit';

const schema=z.object({confirmation:z.literal('RESET DEMO ACCOUNT')});
const refundableStatuses=[InvestmentStatus.PENDING_APPROVAL,InvestmentStatus.APPROVED,InvestmentStatus.ACTIVE,InvestmentStatus.PAUSED,InvestmentStatus.COMPLETED];

export async function POST(request:Request){
 try{
  const user=await requireUser();
    schema.parse(await request.json());
  rateLimit(`demo-reset:${user.id}`,2,24*60*60_000);
  const result=await db.$transaction(async tx=>{
   const accountOwner=await tx.user.findUnique({where:{id:user.id},select:{accountMode:true,status:true,role:true}});
   if(!accountOwner||accountOwner.status!=='ACTIVE'||accountOwner.role!=='USER')throw new Error('ACCOUNT_UNAVAILABLE');
   if(accountOwner?.accountMode!==AccountMode.DEMO)throw new Error('DEMO_MODE_REQUIRED');
   await initializeDemoAccount(tx,user.id);
   const openStatuses=[OrderStatus.OPEN,OrderStatus.PARTIALLY_FILLED];
   const orders=await tx.order.findMany({where:{userId:user.id,accountMode:AccountMode.DEMO,status:{in:openStatuses}},select:{id:true}});
   const cancelledOrders=await tx.order.updateMany({where:{userId:user.id,accountMode:AccountMode.DEMO,status:{in:openStatuses}},data:{status:OrderStatus.CANCELLED}});
   if(cancelledOrders.count)await tx.auditLog.create({data:{actorId:user.id,action:'DEMO_ORDERS_CANCELLED_BY_RESET',entity:'ORDER',entityId:user.id,metadata:{oldState:openStatuses,newState:OrderStatus.CANCELLED,count:cancelledOrders.count,orderIds:orders.map(order=>order.id)}}});
   for(const order of orders)await createNotification(tx,{userId:user.id,type:NotificationType.TRADE,title:'DEMO order cancelled by reset',message:'Your open DEMO order was cancelled during the account reset.',dedupeKey:`demo-reset:${user.id}:order:${order.id}`,relatedEntity:'ORDER',relatedId:order.id,actionUrl:'/orders'});

   const investments=await tx.investmentRequest.findMany({where:{userId:user.id,accountMode:AccountMode.DEMO,status:{in:refundableStatuses}},include:{opportunity:{select:{title:true}}}});
   if(investments.length){
    const escrow=await ensureSystemAccount(tx,'SYSTEM:INVESTMENT_ESCROW:DEMO:USD','Demo investment escrow','USD',AccountMode.DEMO);
    const account=await ensureUserLedger(tx,user.id,AccountMode.DEMO,'USD');
    for(const investment of investments){
     const changed=await tx.investmentRequest.updateMany({where:{id:investment.id,status:investment.status},data:{status:InvestmentStatus.CANCELLED,adminNote:'Cancelled by user DEMO portfolio reset.'}});
     if(changed.count!==1)throw new Error('DEMO_RESET_STATE_CHANGED');
     await postDoubleEntry(tx,{reference:`DEMO_RESET:INVESTMENT:${investment.id}:REFUND`,description:`Return simulated funds during DEMO reset for ${investment.opportunity.title}`,debitAccountId:escrow.id,creditAccountId:account.id,amount:investment.amount});
     await tx.auditLog.create({data:{actorId:user.id,action:'DEMO_INVESTMENT_CANCELLED_BY_RESET',entity:'INVESTMENT',entityId:investment.id,metadata:{oldState:investment.status,newState:InvestmentStatus.CANCELLED,amount:investment.amount.toString()}}});
     await createNotification(tx,{userId:user.id,type:NotificationType.SYSTEM,title:'DEMO investment cancelled by reset',message:'The investment request was cancelled and its virtual amount returned to DEMO cash.',dedupeKey:`demo-reset:${user.id}:investment:${investment.id}`,relatedEntity:'INVESTMENT',relatedId:investment.id,actionUrl:'/investments'});
    }
   }

   const positions=await tx.position.findMany({where:{userId:user.id,accountMode:AccountMode.DEMO,status:PositionStatus.OPEN},select:{id:true}});
   for(const position of positions)await closeSimulatedPositionTx(tx,user.id,position.id);
   const account=await ensureUserLedger(tx,user.id,AccountMode.DEMO,'USD');
   const currentBalance=await balance(tx,account.id);
   const difference=account.startingBalance.minus(currentBalance);
   if(!difference.isZero()){
    const capital=await ensureSystemAccount(tx,'SYSTEM:DEMO:INITIAL_CAPITAL','Demo virtual capital','USD',AccountMode.DEMO);
    await postDoubleEntry(tx,{reference:`DEMO:RESET:${user.id}:${randomUUID()}`,description:'Reset simulated DEMO cash to the original virtual allocation',debitAccountId:difference.gt(0)?capital.id:account.id,creditAccountId:difference.gt(0)?account.id:capital.id,amount:difference.abs()});
   }
   const finalBalance=await balance(tx,account.id);
   await tx.auditLog.create({data:{actorId:user.id,action:'DEMO_ACCOUNT_RESET',entity:'LEDGER_ACCOUNT',entityId:account.id,metadata:{accountMode:AccountMode.DEMO,previousBalance:currentBalance.toString(),finalBalance:finalBalance.toFixed(2),cancelledOrders:cancelledOrders.count,cancelledInvestments:investments.length,closedPositions:positions.length,historyRetained:true}}});
   await createNotification(tx,{userId:user.id,type:NotificationType.ACCOUNT,title:'DEMO portfolio reset',message:`Virtual cash was reset to ${finalBalance.toFixed(2)} USD. Open orders and positions were closed and unsettled DEMO investments cancelled. Historical ledger and audit records remain available.`,dedupeKey:`demo-reset:${user.id}:${randomUUID()}`,actionUrl:'/portfolio'});
   return {balance:finalBalance,cancelledOrders:cancelledOrders.count,cancelledInvestments:investments.length,closedPositions:positions.length};
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
  return NextResponse.json({ok:true,...result},{headers:{'Cache-Control':'private, no-store'}});
 }catch(error){
  if(error instanceof ZodError)return NextResponse.json({error:'Type RESET DEMO ACCOUNT to confirm this account reset.'},{status:400});
  if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
  if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'Too many reset attempts. Try again tomorrow.'},{status:429});
  if(error instanceof Error&&error.message==='ACCOUNT_UNAVAILABLE')return NextResponse.json({error:'This account is unavailable.'},{status:403});
  if(error instanceof Error&&['DEMO_MODE_REQUIRED','DEMO_RESET_STATE_CHANGED'].includes(error.message))return NextResponse.json({error:error.message.replaceAll('_',' ').toLowerCase()},{status:409});
  return NextResponse.json({error:'Unable to reset the DEMO portfolio.'},{status:503});
 }
}