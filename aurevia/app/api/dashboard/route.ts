import {NextResponse} from 'next/server';
import {AccountMode,InvestmentStatus,Prisma} from '@prisma/client';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {balance} from '@/lib/ledger';
import {getUserActivity} from '@/lib/activity';
import {getAccountTier,getTierProfileRequirements} from '@/lib/production-policy';
import {synchronizeCompletedProfileTier} from '@/lib/tier-progression';
import {jsonSafe} from '@/lib/serializers';
import {filterSupportedMarketAssets,getMarketAssetForTradingSymbol,isExternalMarketDataSource} from '@/lib/live-market';
import {removeSimulatedLabels} from '@/lib/display-copy';
import {getMarketQuoteWithFallback,getAlpacaMarketDataOptions} from '@/lib/market-data-service';
import {getServerConfiguration} from '@/lib/config/env';
import {ALPACA_PAPER_PROVIDER} from '@/lib/bitcoin-funding';
import {getWalletBackedPaperInstrumentIds} from '@/lib/paper-ledger-reconciliation';

export const dynamic='force-dynamic';

function errorDetails(error:unknown){
  const value=error&&typeof error==='object'?error as {code?:unknown;name?:unknown}:{};
  const code=typeof value.code==='string'&&/^[A-Z][A-Z0-9_]{1,31}$/.test(value.code)?value.code:undefined;
  const errorType=typeof value.name==='string'&&/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(value.name)?value.name:'UnknownError';
  return {code,errorType};
}

async function optionalData<T>(operation:string,load:()=>Promise<T>,fallback:T):Promise<T>{
  try{return await load()}
  catch(error){console.error(`[dashboard] ${operation} query failed`,errorDetails(error));return fallback}
}

export async function GET(){
  try{
    const user=await requireUser();
    const currentUser=await db.user.findUnique({where:{id:user.id},select:{accountMode:true,status:true}});
    if(!currentUser||currentUser.status!=='ACTIVE')return NextResponse.json({error:'Unauthorized'},{status:401});
    const mode:AccountMode=currentUser.accountMode;
    const [account,positions,orders,investments,notifications,profile,kyc,verificationDocuments,marketInstruments]=await Promise.all([
      optionalData('ledger account',()=>db.ledgerAccount.findUnique({where:{code:`USER:${user.id}:${mode}:USD`},select:{id:true}}),null),
      optionalData('positions',()=>db.position.findMany({where:{userId:user.id,accountMode:mode,status:'OPEN'},include:{instrument:true},orderBy:{openedAt:'desc'},take:8}),[]),
      optionalData('orders',()=>db.order.findMany({where:{userId:user.id,accountMode:mode},include:{instrument:{select:{symbol:true,name:true}}},orderBy:{createdAt:'desc'},take:8}),[]),
      mode===AccountMode.REAL?optionalData('investments',()=>db.investmentRequest.findMany({where:{userId:user.id,accountMode:mode},include:{opportunity:{select:{title:true,category:true,riskLevel:true,assetSymbol:true,targetReturnPercent:true,durationDays:true}}},orderBy:{requestedAt:'desc'},take:6}),[]):Promise.resolve([]),
      optionalData('notifications',()=>db.notification.findMany({where:{userId:user.id,archivedAt:null,OR:[{accountMode:mode},{accountMode:null}]},orderBy:{createdAt:'desc'},take:6}),[]),
      optionalData('profile',()=>db.$transaction(async tx=>{await synchronizeCompletedProfileTier(tx,user.id);return tx.user.findUnique({where:{id:user.id},select:{id:true,aureviaExchangeId:true,email:true,name:true,avatarKey:true,role:true,status:true,accountMode:true,approvedTier:true,kycStatus:true,verifiedAt:true,phoneVerified:true,phone:true,country:true,createdAt:true}})}),null),
      mode===AccountMode.REAL?optionalData('KYC profile',()=>db.kycProfile.findUnique({where:{userId:user.id},select:{submittedAt:true}}),null):Promise.resolve(null),
      mode===AccountMode.REAL?optionalData('verification documents',()=>db.kycDocument.count({where:{userId:user.id,kind:'IDENTITY_DOCUMENT',status:'APPROVED'}}),0):Promise.resolve(0),
      optionalData('market instruments',()=>db.instrument.findMany({where:{enabled:true},orderBy:{symbol:'asc'},take:12}),[]),
    ]);
    const validPositions=positions.filter(position=>!!position.instrument);
    const validOrders=orders.filter(order=>!!order.instrument);
    const walletBackedPaperInstrumentIds=mode===AccountMode.REAL&&validPositions.some(position=>position.providerName===ALPACA_PAPER_PROVIDER)
      ?await getWalletBackedPaperInstrumentIds(db,user.id)
      :new Set<string>();
    const valuationPositions=mode===AccountMode.REAL
      ?validPositions.filter(position=>position.providerName!==ALPACA_PAPER_PROVIDER||walletBackedPaperInstrumentIds.has(position.instrumentId))
      :validPositions;
    const unreconciledPaperPositionCount=validPositions.filter(position=>position.providerName===ALPACA_PAPER_PROVIDER&&!walletBackedPaperInstrumentIds.has(position.instrumentId)).length;
    const validInvestments=investments.filter(investment=>!!investment.opportunity);
    const supportedMarketInstruments=filterSupportedMarketAssets(marketInstruments);
    const cash=account?await optionalData('ledger balance',()=>balance(db,account.id),null):null;
    const positionMarks=new Map<string,Prisma.Decimal>();
    let positionMarksCurrent=true;
    if(mode===AccountMode.REAL&&valuationPositions.length){
      const configuration=getServerConfiguration();
      const alpacaData=getAlpacaMarketDataOptions(configuration.execution);
      const instruments=[...new Map(valuationPositions.map(position=>[position.instrumentId,position.instrument])).values()];
      const marks=await Promise.all(instruments.map(async instrument=>{
        const asset=getMarketAssetForTradingSymbol(instrument.symbol);
        if(!asset)return null;
        try{
          const quote=await getMarketQuoteWithFallback(asset,configuration.marketData.finnhubApiKey,alpacaData);
          if(!isExternalMarketDataSource(quote.source)||quote.isStale)return null;
          return {instrumentId:instrument.id,price:new Prisma.Decimal(quote.price)};
        }catch{return null;}
      }));
      for(const mark of marks)if(mark)positionMarks.set(mark.instrumentId,mark.price);
      positionMarksCurrent=positionMarks.size===instruments.length;
    }
    const positionValue=mode===AccountMode.DEMO
      ?validPositions.reduce((sum,p)=>sum.plus(p.quantity.mul(p.instrument.price)),new Prisma.Decimal(0))
      :positionMarksCurrent?valuationPositions.reduce((sum,p)=>sum.plus(p.quantity.mul(positionMarks.get(p.instrumentId)??0)),new Prisma.Decimal(0)):null;
    const invested=validInvestments.filter(i=>[InvestmentStatus.PENDING_APPROVAL,InvestmentStatus.APPROVED,InvestmentStatus.ACTIVE,InvestmentStatus.PAUSED,InvestmentStatus.COMPLETED].some(status=>status===i.status)).reduce((sum,i)=>sum.plus(i.amount),new Prisma.Decimal(0));
    const unrealized=mode===AccountMode.DEMO
      ?validPositions.reduce((sum,p)=>sum.plus((p.side==='BUY'?p.instrument.price.minus(p.entryPrice):p.entryPrice.minus(p.instrument.price)).mul(p.quantity)),new Prisma.Decimal(0))
      :positionMarksCurrent?valuationPositions.reduce((sum,p)=>{
        const price=positionMarks.get(p.instrumentId)??new Prisma.Decimal(0);
        return sum.plus((p.side==='BUY'?price.minus(p.entryPrice):p.entryPrice.minus(price)).mul(p.quantity));
      },new Prisma.Decimal(0)):null;
    const activity=await optionalData('recent activity',()=>getUserActivity(user.id,mode,'all',8),{items:[],total:0,hasMore:false,cursor:null});
    const recentActivity=activity.items.map(item=>({id:item.id,category:item.category,action:item.action,timestamp:item.timestamp,asset:item.asset,amount:item.amount,status:item.status,source:item.sourceLabel,pnl:item.pnl,adminInitiated:item.adminInitiated,link:item.link}));
    const displayNotifications=notifications.map(notification=>({...notification,title:removeSimulatedLabels(notification.title),message:removeSimulatedLabels(notification.message)}));
    const profileRequirements=profile?getTierProfileRequirements(profile):null;
    const tier=getAccountTier({accountMode:mode,kycStatus:mode===AccountMode.REAL?profile?.kycStatus||'PENDING':'PENDING',verificationDocuments,verificationSubmitted:mode===AccountMode.REAL&&!!kyc?.submittedAt,phoneVerified:mode===AccountMode.REAL&&!!profile?.phoneVerified,profileComplete:profileRequirements?.profileComplete??false,approvedTier:profile?.approvedTier});
    const safeProfile={id:user.id,aureviaExchangeId:profile?.aureviaExchangeId??null,email:profile?.email??user.email??null,name:profile?.name??user.name??null,hasAvatar:!!profile?.avatarKey,role:profile?.role??user.role??'USER',status:profile?.status??null,accountMode:mode,approvedTier:mode===AccountMode.REAL?profile?.approvedTier??null:null,kycStatus:mode===AccountMode.REAL?profile?.kycStatus??null:null,verifiedAt:mode===AccountMode.REAL?profile?.verifiedAt??null:null,phoneVerified:mode===AccountMode.REAL?profile?.phoneVerified??false:false,phone:mode===AccountMode.REAL?profile?.phone??null:null,country:mode===AccountMode.REAL?profile?.country??null:null,createdAt:profile?.createdAt??null,profileRequirements,tier:tier.label,...tier};
    const customerOrders=validOrders.map(order=>{
      const customerOrder={...order};
      if(order.reconciliationStatus==='RECONCILIATION_REQUIRED'){
        Reflect.set(customerOrder,'status','REQUIRES_REVIEW');
        Reflect.set(customerOrder,'reviewRequired',true);
      }
      for(const field of ['providerName','providerAccountId','providerOrderId','providerClientOrderId','providerStatus','providerAcceptedAt','providerUpdatedAt','providerReservedAmount','reconciliationStatus','reconciledAt','idempotencyKey'])Reflect.deleteProperty(customerOrder,field);
      return customerOrder;
    });
    const customerPositions=validPositions.map(position=>({...position,providerName:undefined}));
    return NextResponse.json(jsonSafe({accountMode:mode,cash,financialDataAvailable:cash!==null,positionValue,invested,unrealized,portfolioValue:cash&&positionValue!==null?cash.plus(positionValue).plus(invested):null,openOrders:validOrders.filter(o=>o.status==='OPEN').length,activePositions:validPositions.length,unreconciledPaperPositionCount,activity:recentActivity,orders:customerOrders,positions:customerPositions,investments:validInvestments,notifications:displayNotifications,profile:safeProfile,marketInstruments:supportedMarketInstruments.map(i=>({id:i.id,symbol:i.symbol,name:i.name,price:Number(i.price),changePercent:0,updatedAt:i.updatedAt.toISOString()}))}),{headers:{'Cache-Control':'private, no-store'}});
  }catch(error){
    const unauthorized=error instanceof Error&&error.message==='UNAUTHORIZED';
    if(!unauthorized)console.error('[dashboard] Request failed',errorDetails(error));
    return NextResponse.json({error:unauthorized?'Unauthorized':'Dashboard data is temporarily unavailable. Please try again shortly.'},{status:unauthorized?401:503,headers:{'Cache-Control':'private, no-store'}});
  }
}
