import {NextResponse} from 'next/server';
import {AccountMode,FundingStatus,FundingType,InvestmentStatus,Prisma} from '@prisma/client';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {balance,reservedWithdrawalAmount} from '@/lib/ledger';
import {ALPACA_PAPER_PROVIDER,BTC_FUNDING_METHOD,paperOrderCollateral} from '@/lib/bitcoin-funding';
import {recordedInvestmentPnl} from '@/lib/investment-policy';
import {valueMarketMark} from '@/lib/portfolio-valuation';
import {calculateAllocationPercentages,instrumentAssetCategory} from '@/lib/portfolio-metrics';
import {jsonSafe} from '@/lib/serializers';
import {getMarketAssetForTradingSymbol,isExternalMarketDataSource} from '@/lib/live-market';
import {getMarketQuoteWithFallback,getAlpacaMarketDataOptions} from '@/lib/market-data-service';
import {getServerConfiguration} from '@/lib/config/env';
import {getWalletBackedPaperInstrumentIds} from '@/lib/paper-ledger-reconciliation';

export const dynamic='force-dynamic';

const zero=()=>new Prisma.Decimal(0);
const activeInvestmentStatuses:Set<InvestmentStatus>=new Set([InvestmentStatus.PENDING_APPROVAL,InvestmentStatus.APPROVED,InvestmentStatus.ACTIVE,InvestmentStatus.PAUSED,InvestmentStatus.COMPLETED]);

export async function GET(){
 try{
  const user=await requireUser();
   const activeUser=await db.user.findUnique({where:{id:user.id},select:{accountMode:true,status:true}});
   if(!activeUser||activeUser.status!=='ACTIVE')return NextResponse.json({error:'Unauthorized'},{status:401});
   const mode=activeUser.accountMode;
  const [account,positions,realizedAggregate,paperRealizedByInstrument,investments,settledInvestments,depositAggregate,recentFunding,availableOpportunities,paperOrders,pendingWithdrawals]=await Promise.all([
   db.ledgerAccount.findUnique({where:{code:`USER:${user.id}:${mode}:USD`},select:{id:true,startingBalance:true}}),
   db.position.findMany({where:{userId:user.id,accountMode:mode,status:'OPEN'},include:{instrument:true},orderBy:{openedAt:'asc'}}),
   db.position.aggregate({where:{userId:user.id,accountMode:mode,...(mode===AccountMode.REAL?{OR:[{providerName:null},{providerName:{not:ALPACA_PAPER_PROVIDER}}]}:{})},_sum:{realizedPnl:true}}),
   mode===AccountMode.REAL?db.position.groupBy({by:['instrumentId'],where:{userId:user.id,accountMode:mode,providerName:ALPACA_PAPER_PROVIDER},_sum:{realizedPnl:true}}):Promise.resolve([]),
   mode===AccountMode.REAL?db.investmentRequest.findMany({where:{userId:user.id,accountMode:mode},include:{opportunity:{select:{title:true,category:true,assetSymbol:true,riskLevel:true,durationDays:true}}},orderBy:{requestedAt:'desc'}}):Promise.resolve([]),
   mode===AccountMode.REAL?db.investmentRequest.findMany({where:{userId:user.id,accountMode:mode,status:InvestmentStatus.SETTLED},select:{amount:true,simulatedPayout:true}}):Promise.resolve([]),
   mode===AccountMode.REAL?db.fundingRequest.aggregate({
    where:mode===AccountMode.REAL
     ?{userId:user.id,accountMode:mode,type:FundingType.DEPOSIT,currency:'BTC',method:BTC_FUNDING_METHOD,creditedCurrency:'USD',status:{in:[FundingStatus.APPROVED,FundingStatus.COMPLETED]}}
     :{userId:user.id,accountMode:mode,currency:'USD',type:FundingType.DEPOSIT,status:{in:[FundingStatus.APPROVED,FundingStatus.COMPLETED]}},
    _sum:{amount:true,creditedAmount:true},
   }):Promise.resolve({_sum:{amount:null,creditedAmount:null}}),
   mode===AccountMode.REAL?db.fundingRequest.findMany({where:{userId:user.id,accountMode:mode},select:{id:true,type:true,method:true,amount:true,currency:true,status:true,createdAt:true},orderBy:{createdAt:'desc'},take:5}):Promise.resolve([]),
   mode===AccountMode.REAL?db.investmentOpportunity.findMany({where:{status:'AVAILABLE',realEligible:true},select:{id:true,title:true,category:true,assetSymbol:true,minimumAmount:true,targetReturnPercent:true,durationDays:true,riskLevel:true},orderBy:{createdAt:'desc'},take:3}):Promise.resolve([]),
   mode===AccountMode.REAL?db.order.findMany({where:{userId:user.id,accountMode:mode,providerName:ALPACA_PAPER_PROVIDER},select:{instrumentId:true,side:true,quantity:true,filledQuantity:true,averageFillPrice:true,providerReservedAmount:true,status:true,createdAt:true,instrument:{select:{takerFee:true}}},orderBy:{createdAt:'asc'}}):Promise.resolve([]),
   mode===AccountMode.REAL?reservedWithdrawalAmount(db,user.id,AccountMode.REAL,'USD'):Promise.resolve(zero()),
  ]);
  const cashBalance=account?await balance(db,account.id):zero();
  const walletBackedPaperInstrumentIds=mode===AccountMode.REAL&&positions.some(position=>position.providerName===ALPACA_PAPER_PROVIDER)
   ?await getWalletBackedPaperInstrumentIds(db,user.id)
   :new Set<string>();
  const paperCollateral=paperOrderCollateral(paperOrders.map(order=>({...order,takerFee:order.instrument.takerFee})));
  const paperAvailableBalance=Prisma.Decimal.max(zero(),cashBalance.minus(pendingWithdrawals).minus(paperCollateral.committed));
  const availableCashBalance=paperAvailableBalance;
  const providerMarks=new Map<string,{price:Prisma.Decimal;quotedAt:Date;source:string;isStale:boolean}>();
  if(mode===AccountMode.REAL&&positions.length){
   const configuration=getServerConfiguration();
   const alpacaData=getAlpacaMarketDataOptions(configuration.execution);
   const instruments=[...new Map(positions.map(position=>[position.instrumentId,position.instrument])).values()];
   const quotes=await Promise.all(instruments.map(async instrument=>{
    const asset=getMarketAssetForTradingSymbol(instrument.symbol);
    if(!asset)return null;
    try{
    const quote=await getMarketQuoteWithFallback(asset,configuration.marketData.finnhubApiKey,alpacaData);
    if(!isExternalMarketDataSource(quote.source))return null;
    return {instrumentId:instrument.id,price:new Prisma.Decimal(quote.price),quotedAt:new Date(quote.updatedAt),source:quote.source,isStale:quote.isStale===true};
    }catch{return null;}
   }));
   for(const quote of quotes)if(quote)providerMarks.set(quote.instrumentId,quote);
  }
  const positionValuation=(position:typeof positions[number])=>{
   if(mode===AccountMode.DEMO){
    const currentPrice=position.instrument.price;
    const marketValue=currentPrice.mul(position.quantity);
    const direction=position.side==='BUY'?1:-1;
    const unrealizedPnl=position.entryPrice.mul(-direction).plus(currentPrice.mul(direction)).mul(position.quantity);
    return {currentPrice,marketValue,unrealizedPnl,valuationStatus:'CURRENT' as const,valuationAsOf:position.instrument.updatedAt,valuationSource:'DEMO simulation'};
   }
   const mark=providerMarks.get(position.instrumentId);
   if(!mark)return {currentPrice:null,marketValue:null,unrealizedPnl:null,valuationStatus:'UNAVAILABLE' as const,valuationAsOf:null,valuationSource:null};
   const valuation=valueMarketMark({side:position.side,quantity:position.quantity,entryPrice:position.entryPrice,currentPrice:mark.price,quotedAt:mark.quotedAt});
   const status=mark.isStale&&valuation.status!=='UNAVAILABLE'?'STALE':valuation.status;
   return {
    currentPrice:valuation.currentPrice,
    marketValue:valuation.marketValue,
    unrealizedPnl:valuation.unrealizedPnl,
    valuationStatus:status,
    valuationAsOf:Number.isFinite(mark.quotedAt.getTime())?mark.quotedAt:null,
    valuationSource:'Market quote',
   };
  };
  const paperPositions=positions.filter(position=>position.providerName===ALPACA_PAPER_PROVIDER).map(position=>{
   const walletBacked=walletBackedPaperInstrumentIds.has(position.instrumentId);
   const valuation=walletBacked
    ?positionValuation(position)
    :{currentPrice:null,marketValue:null,unrealizedPnl:null,valuationStatus:'UNAVAILABLE' as const,valuationAsOf:null,valuationSource:null};
   return {
    id:position.id,symbol:position.instrument.symbol,name:position.instrument.name,category:instrumentAssetCategory(position.instrument),side:position.side,
    quantity:position.quantity,averageEntryPrice:position.entryPrice,realizedPnl:position.realizedPnl,
    currentPrice:valuation.currentPrice,marketValue:valuation.marketValue,unrealizedPnl:valuation.unrealizedPnl,
    openedAt:position.openedAt,valuationStatus:valuation.valuationStatus,valuationAsOf:valuation.valuationAsOf,valuationSource:valuation.valuationSource,walletBacked,
   };
  });
  const currentlyValuedPaperPositions=paperPositions.filter(position=>position.valuationStatus==='CURRENT');
  const paperPositionValue=currentlyValuedPaperPositions.reduce((sum,position)=>sum.plus(position.marketValue??0),zero());
  const paperUnrealizedPnl=currentlyValuedPaperPositions.reduce((sum,position)=>sum.plus(position.unrealizedPnl??0),zero());
  const paperValuationStatus=paperPositions.length===0?'NOT_APPLICABLE':currentlyValuedPaperPositions.length===paperPositions.length?'CURRENT':currentlyValuedPaperPositions.length>0?'PARTIAL':paperPositions.some(position=>position.valuationStatus==='STALE')?'STALE':'UNAVAILABLE';
  const internalPositions=positions.filter(position=>position.providerName!==ALPACA_PAPER_PROVIDER);
  const valuedPositions=internalPositions.map(position=>{
   const valuation=positionValuation(position);
   return {...position,...valuation};
  });
  const backedPaperPositions=paperPositions.filter(position=>position.walletBacked);
  const allPositions=[...valuedPositions,...backedPaperPositions];
  const currentPositionCount=allPositions.filter(position=>position.valuationStatus==='CURRENT').length;
  const positionValuationStatus=allPositions.length===0?'NOT_APPLICABLE':currentPositionCount===allPositions.length?'CURRENT':currentPositionCount>0?'PARTIAL':allPositions.some(position=>position.valuationStatus==='STALE')?'STALE':'UNAVAILABLE';
  const missingPositionMark=mode===AccountMode.REAL&&allPositions.some(position=>position.valuationStatus!=='CURRENT');
  const positionValue=missingPositionMark?null:allPositions.reduce((sum,position)=>sum.plus(position.marketValue??0),zero());
  const unrealizedPnl=missingPositionMark?null:allPositions.reduce((sum,position)=>sum.plus(position.unrealizedPnl??0),zero());
  const investedRequests=investments.filter(item=>activeInvestmentStatuses.has(item.status));
  const investmentValue=investedRequests.reduce((sum,item)=>sum.plus(item.amount),zero());
  const settledInvestmentPnl=settledInvestments.reduce((sum,item)=>sum.plus(recordedInvestmentPnl(item.amount,item.simulatedPayout)),zero());
  const backedPaperRealizedPnl=paperRealizedByInstrument.filter(position=>walletBackedPaperInstrumentIds.has(position.instrumentId)).reduce((sum,position)=>sum.plus(position._sum.realizedPnl??0),zero());
  const realizedPnl=new Prisma.Decimal(realizedAggregate._sum.realizedPnl??0).plus(backedPaperRealizedPnl).plus(settledInvestmentPnl);
  const totalPnl=unrealizedPnl===null?null:realizedPnl.plus(unrealizedPnl);
  const totalValue=positionValue===null?null:cashBalance.plus(positionValue).plus(investmentValue);
  const netDemoFunding=zero();
  const startingBalance=account?.startingBalance??zero();
  const returnBasis=mode===AccountMode.REAL?new Prisma.Decimal(depositAggregate._sum.creditedAmount??0):startingBalance.plus(netDemoFunding);
  const returnPercent=returnBasis.gt(0)&&totalPnl!==null?totalPnl.div(returnBasis).mul(100):null;

  const interval=15*60_000;
  const snapshotBucket=new Date(Math.floor(Date.now()/interval)*interval);
  if(totalValue!==null&&unrealizedPnl!==null)await db.portfolioSnapshot.upsert({where:{userId_accountMode_snapshotBucket:{userId:user.id,accountMode:mode,snapshotBucket}},create:{userId:user.id,accountMode:mode,snapshotBucket,cashBalance,positionValue:positionValue??zero(),investmentValue,totalValue,realizedPnl,unrealizedPnl},update:{cashBalance,positionValue:positionValue??zero(),investmentValue,totalValue,realizedPnl,unrealizedPnl}});
  const performance=await db.portfolioSnapshot.findMany({where:{userId:user.id,accountMode:mode},orderBy:{snapshotBucket:'desc'},take:5000});
  const dayStart=new Date();dayStart.setUTCHours(0,0,0,0);
  const todaySnapshots=performance.filter(snapshot=>snapshot.snapshotBucket>=dayStart).toReversed();
  const dailyPnl=totalValue!==null&&todaySnapshots.length>1?totalValue.minus(todaySnapshots[0].totalValue):null;
  const dailyPercent=dailyPnl&&todaySnapshots[0].totalValue.gt(0)?dailyPnl.div(todaySnapshots[0].totalValue).mul(100):null;
  const holdings=[
   ...(cashBalance.gt(0)?[{
    id:'CASH:USD',
    name:'Aurevia wallet cash',
    category:'Cash',
    invested:zero(),
    value:cashBalance,
    gainLoss:zero(),
    status:'LEDGER_BALANCE',
   }]:[]),
   ...valuedPositions.map(position=>({
    id:`POSITION:${position.id}`,
    name:position.instrument.name,
    category:instrumentAssetCategory(position.instrument),
    invested:position.entryPrice.mul(position.quantity),
    value:position.marketValue,
    gainLoss:position.unrealizedPnl,
    status:position.valuationStatus==='CURRENT'?position.status:`VALUATION_${position.valuationStatus}`,
   })),
   ...paperPositions.map(position=>({
    id:`POSITION:${position.id}`,
    name:position.name,
    category:position.category,
    invested:position.walletBacked?position.averageEntryPrice.mul(position.quantity):zero(),
    value:position.marketValue,
    gainLoss:position.unrealizedPnl,
    status:position.walletBacked?(position.valuationStatus==='CURRENT'?'OPEN':`VALUATION_${position.valuationStatus}`):'REVIEW_REQUIRED',
   })),
   ...investedRequests.map(item=>({
    id:`INVESTMENT:${item.id}`,
    name:item.opportunity.title,
    category:item.opportunity.category,
    invested:item.amount,
    value:item.amount,
    gainLoss:zero(),
    status:item.status,
   })),
  ];
  const allocationValues=new Map<string,Prisma.Decimal>();
  for(const holding of holdings)if(holding.value!==null)allocationValues.set(holding.category,(allocationValues.get(holding.category)??zero()).plus(holding.value));
  const allocations=calculateAllocationPercentages([...allocationValues].map(([category,value])=>({category,value})));
  const rankedPositions=valuedPositions.filter(position=>position.unrealizedPnl!==null).toSorted((left,right)=>Number(right.unrealizedPnl)-Number(left.unrealizedPnl));
  const totalInvested=valuedPositions.reduce((sum,item)=>sum.plus(item.entryPrice.mul(item.quantity)),zero())
   .plus(backedPaperPositions.reduce((sum,item)=>sum.plus(item.averageEntryPrice.mul(item.quantity)),zero()))
   .plus(investedRequests.reduce((sum,item)=>sum.plus(item.amount),zero()));
  const response={accountMode:mode,currency:'USD',cashBalance,availableCashBalance,positionValue,positionValuationStatus,investmentValue,totalValue,realizedPnl,unrealizedPnl,totalPnl,returnPercent,dailyPnl,dailyPercent,positions:valuedPositions,paperPositions,paperPositionValue:currentlyValuedPaperPositions.length?paperPositionValue:null,paperUnrealizedPnl:currentlyValuedPaperPositions.length?paperUnrealizedPnl:null,paperValuation:{status:paperValuationStatus,valuedCount:currentlyValuedPaperPositions.length,openCount:paperPositions.length},unreconciledPaperPositionCount:paperPositions.filter(position=>!position.walletBacked).length,paperReservedBalance:paperCollateral.committed,paperAvailableBalance,investments,holdings,totalInvested,totalCurrentValue:totalValue,allocations,recentFunding,availableOpportunities,topGainers:rankedPositions.slice(0,3),topLosers:rankedPositions.slice(-3).reverse(),performance:performance.toReversed(),marketDataMode:mode===AccountMode.DEMO?'SIMULATED':allPositions.length===0?'LEDGER_ONLY':positionValuationStatus==='CURRENT'?'LIVE_PROVIDER':positionValuationStatus==='PARTIAL'?'PARTIAL_PROVIDER':'PROVIDER_UNAVAILABLE',externalValuationAvailable:mode===AccountMode.REAL&&allPositions.length>0&&positionValuationStatus==='CURRENT'};
  return NextResponse.json(jsonSafe(response),{headers:{'Cache-Control':'private, no-store'}});
 }catch(error){
  return NextResponse.json({error:error instanceof Error&&error.message==='UNAUTHORIZED'?'Unauthorized':'Portfolio data is temporarily unavailable.'},{status:error instanceof Error&&error.message==='UNAUTHORIZED'?401:503,headers:{'Cache-Control':'private, no-store'}});
 }
}