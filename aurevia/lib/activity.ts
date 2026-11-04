import {AccountMode,FundingStatus,InvestmentStatus,OrderStatus,PositionStatus,Prisma} from '@prisma/client';
import {db} from '@/lib/db';
import {removeSimulatedLabels} from '@/lib/display-copy';

export type ActivityCategory='all'|'trade'|'personal-trade'|'investment'|'deposit'|'withdrawal'|'order'|'position'|'account'|'security'|'login-history';

export type ActivityRecord={
  id:string;
  category:Exclude<ActivityCategory,'all'>;
  action:string;
  timestamp:string;
  asset:string;
  side?:'BUY'|'SELL';
  quantity:string;
  price:string|null;
  amount:string;
  status:string;
  source:'ledger'|'order'|'position'|'investment'|'funding'|'notification'|'audit';
  archivedAt?:string|null;
  hidden?:boolean;
  permanentDeletionAllowed?:boolean;
  protectionReason?:string;
  sourceLabel:string;
  adminInitiated:boolean;
  pnl:string|null;
  link:string;
  details:Record<string,string|number|boolean|null>;
};

export type ActivityPage={items:ActivityRecord[];total:number;hasMore:boolean;cursor:string|null;};

export type ActivityQuery={
  search?:string;
  status?:string;
  dateFrom?:Date;
  dateTo?:Date;
  state?:'active'|'archived'|'hidden'|'all';
  offset?:number;
  includeLoginHistory?:boolean;
  excludeLoginHistory?:boolean;
};

const activityCategories=new Set<ActivityCategory>(['all','trade','personal-trade','investment','deposit','withdrawal','order','position','account','security','login-history']);
export function isActivityCategory(value:string):value is ActivityCategory{return activityCategories.has(value as ActivityCategory)}

function decimal(value:Prisma.Decimal|number|string|null|undefined){return value===null||value===undefined?new Prisma.Decimal(0):new Prisma.Decimal(value)}
function formatAmount(value:Prisma.Decimal|number|string){return decimal(value).toFixed(2)}
function formatNumber(value:Prisma.Decimal|number|string){return decimal(value).toString()}

export async function getUserActivity(userId:string,accountMode:AccountMode,category:ActivityCategory,limit=20,query:ActivityQuery={}):Promise<ActivityPage>{
  const offset=Math.min(Math.max(query.offset||0,0),1000);
  const take=offset+limit+1;
  const preferences=await db.activityVisibilityPreference.findMany({where:{userId,accountMode}});
  const preferencesBySource=new Map<string,typeof preferences>();
  for(const preference of preferences){const records=preferencesBySource.get(preference.sourceType)||[];records.push(preference);preferencesBySource.set(preference.sourceType,records);}
  const sourceIdFilter=(source:string,field='id')=>{
    if(query.state==='all')return undefined;
    const records=preferencesBySource.get(source)||[];
    const ids=records.filter(record=>query.state==='hidden'?record.hiddenAt!==null:query.state==='archived'?record.archivedAt!==null:record.hiddenAt!==null||record.archivedAt!==null).map(record=>record.sourceId);
    if(query.state==='hidden'||query.state==='archived')return {[field]:{in:ids.length?ids:['__no_activity_match__']}};
    return ids.length?{[field]:{notIn:ids}}:undefined;
  };
  const dateFilter={...(query.dateFrom?{gte:query.dateFrom}:{}),...(query.dateTo?{lte:query.dateTo}:{})};
  const search=query.search?.trim();
  const searchContains=(value:string)=>({contains:value,mode:'insensitive' as const});
  const normalizedStatus=query.status?.trim().toUpperCase().replaceAll(' ','_');
  const orderStatus=Object.values(OrderStatus).includes(normalizedStatus as OrderStatus)?normalizedStatus as OrderStatus:undefined;
  const positionStatus=Object.values(PositionStatus).includes(normalizedStatus as PositionStatus)?normalizedStatus as PositionStatus:undefined;
  const investmentStatus=Object.values(InvestmentStatus).includes(normalizedStatus as InvestmentStatus)?normalizedStatus as InvestmentStatus:undefined;
  const fundingStatus=Object.values(FundingStatus).includes(normalizedStatus as FundingStatus)?normalizedStatus as FundingStatus:undefined;
  const notificationWhere={
    userId,
    AND:[
      {OR:[{accountMode},{accountMode:null}]},
      ...(search?[{OR:[{id:searchContains(search)},{title:searchContains(search)},{message:searchContains(search)}]}]:[]),
    ],
    ...(query.state==='archived'?{archivedAt:{not:null}}:query.state==='active'||!query.state?{archivedAt:null}:{}),
    ...(sourceIdFilter('notification')||{}),
    ...(normalizedStatus==='READ'?{isRead:true}:normalizedStatus==='UNREAD'?{isRead:false}:{}),
    ...(query.dateFrom||query.dateTo?{createdAt:dateFilter}:{}),
  };
  const auditEntities=query.includeLoginHistory?['LOGIN']:query.excludeLoginHistory?['ORDER','POSITION','INVESTMENT']:['ORDER','POSITION','INVESTMENT','LOGIN'];
  const [ledgerEntries,orders,positions,investments,fundingRequests,auditLogs,notifications]=await Promise.all([
    db.ledgerEntry.findMany({where:{account:{userId,accountMode},...(sourceIdFilter('ledger','transactionId')||{}),...(query.dateFrom||query.dateTo?{transaction:{createdAt:dateFilter}}:{}),...(search?{OR:[{transactionId:searchContains(search)},{transaction:{OR:[{reference:searchContains(search)},{description:searchContains(search)}]}}]}:{})},include:{account:{select:{userId:true,currency:true,accountMode:true}},transaction:{select:{reference:true,description:true,createdAt:true}}},orderBy:{createdAt:'desc'},take}),
    db.order.findMany({where:{userId,accountMode,...(sourceIdFilter('order')||{}),...(orderStatus?{status:orderStatus}:{}),...(query.dateFrom||query.dateTo?{createdAt:dateFilter}:{}),...(search?{OR:[{id:searchContains(search)},{instrument:{symbol:searchContains(search)}}]}:{})},include:{instrument:{select:{symbol:true}},executions:{select:{quantity:true,price:true,fee:true,createdAt:true}}},orderBy:{createdAt:'desc'},take}),
    db.position.findMany({where:{userId,accountMode,...(sourceIdFilter('position')||{}),...(positionStatus?{status:positionStatus}:{}),...(query.dateFrom||query.dateTo?{openedAt:dateFilter}:{}),...(search?{OR:[{id:searchContains(search)},{instrument:{symbol:searchContains(search)}}]}:{})},include:{instrument:{select:{symbol:true}}},orderBy:{openedAt:'desc'},take}),
    db.investmentRequest.findMany({where:{userId,accountMode,...(sourceIdFilter('investment')||{}),...(investmentStatus?{status:investmentStatus}:{}),...(query.dateFrom||query.dateTo?{requestedAt:dateFilter}:{}),...(search?{OR:[{id:searchContains(search)},{opportunity:{OR:[{title:searchContains(search)},{assetSymbol:searchContains(search)},{category:searchContains(search)}]}}]}:{})},include:{opportunity:{select:{title:true,assetSymbol:true,category:true,targetReturnPercent:true,durationDays:true}}},orderBy:{requestedAt:'desc'},take}),
    db.fundingRequest.findMany({where:{userId,accountMode,...(sourceIdFilter('funding')||{}),...(fundingStatus?{status:fundingStatus}:{}),...(query.dateFrom||query.dateTo?{createdAt:dateFilter}:{}),...(search?{OR:[{id:searchContains(search)},{method:searchContains(search)},{transactionReference:searchContains(search)}]}:{})},orderBy:{createdAt:'desc'},take}),
    db.auditLog.findMany({where:{actorId:userId,entity:{in:auditEntities},...(query.dateFrom||query.dateTo?{createdAt:dateFilter}:{})},select:{id:true,actorId:true,action:true,entity:true,entityId:true,metadata:true,createdAt:true},orderBy:{createdAt:'desc'},take}),
    db.notification.findMany({where:notificationWhere,include:{pushOutbox:{select:{id:true}}},orderBy:{createdAt:'desc'},take}),
  ]);
  const records:ActivityRecord[] = [
    ...[...ledgerEntries.reduce((groups,entry)=>groups.set(entry.transactionId,[...(groups.get(entry.transactionId)||[]),entry]),new Map<string,typeof ledgerEntries>()).values()].map(entries=>{
      const entry=entries[0];
      if(!entry)throw new Error('LEDGER_TRANSACTION_EMPTY');
      const userEntries=entries.filter(item=>item.account.userId===userId);
      const conversion=entry.transaction.reference.startsWith('DEMO:BTC:CONVERSION:');
      const btcEntry=userEntries.find(item=>item.account.currency==='BTC');
      const usdEntry=userEntries.find(item=>item.account.currency==='USD');
      const mainEntry=conversion?(btcEntry||usdEntry||entry):usdEntry||userEntries[0]||entry;
      return {
        id:entry.transactionId,category:'account' as const,action:conversion?'SIMULATED BTC conversion':entry.transaction.reference.startsWith('REAL:SIMULATED_TRADE:')?'REAL trade fill':userEntries.some(item=>item.type==='CREDIT')?'Account ledger credit':'Account ledger debit',timestamp:entry.transaction.createdAt.toISOString(),asset:conversion?'BTC/USD':mainEntry.account.currency,quantity:formatNumber(mainEntry.amount),price:null,amount:formatAmount(mainEntry.amount),status:'POSTED',source:'ledger' as const,sourceLabel:entry.transaction.reference.startsWith('REAL:SIMULATED_TRADE:')?'Trade fill':entry.transaction.description,adminInitiated:entry.transaction.reference.startsWith('ADMIN:'),pnl:null,link:'/activity',details:{description:entry.transaction.reference.startsWith('REAL:SIMULATED_TRADE:')?'Trade fill':entry.transaction.description,accountMode:mainEntry.account.accountMode,currencies:[...new Set(userEntries.map(item=>item.account.currency))].join(', ')},
      };
    }),
    ...orders.map(order=>({
      id:order.id,category:(order.side==='BUY'?'trade':'personal-trade') as ActivityRecord['category'],action:`${order.side} ${order.type.toLowerCase()} order`,timestamp:order.createdAt.toISOString(),asset:order.instrument.symbol,side:order.side,quantity:formatNumber(order.quantity),price:order.averageFillPrice?formatAmount(order.averageFillPrice):order.price?formatAmount(order.price):null,amount:order.averageFillPrice?formatAmount(order.averageFillPrice!.mul(order.filledQuantity)):formatAmount(order.quantity),status:order.reconciliationStatus==='RECONCILIATION_REQUIRED'?'REQUIRES_REVIEW':order.status.replaceAll('_',' '),source:'order' as const,sourceLabel:order.type,adminInitiated:false,pnl:null,link:`/orders`,details:{type:order.type,filledQuantity:formatNumber(order.filledQuantity),fee:formatAmount(order.fee)},
    })),
    ...positions.map(position=>({
      id:position.id,category:'position' as const,action:position.side==='BUY'?'Long position':'Short position',timestamp:position.openedAt.toISOString(),asset:position.instrument.symbol,side:position.side,quantity:formatNumber(position.quantity),price:formatAmount(position.entryPrice),amount:formatAmount(position.entryPrice.mul(position.quantity)),status:position.status,source:'position' as const,sourceLabel:'Open position',adminInitiated:false,pnl:position.realizedPnl?formatAmount(position.realizedPnl):null,link:'/portfolio',details:{averageEntry:formatAmount(position.entryPrice),margin:formatAmount(position.margin)},
    })),
    ...investments.map(investment=>({
      id:investment.id,category:'investment' as const,action:investment.opportunity.title,timestamp:investment.requestedAt.toISOString(),asset:investment.opportunity.assetSymbol||'INVESTMENT',quantity:formatNumber(investment.amount),price:null,amount:formatAmount(investment.amount),status:investment.status.replaceAll('_',' '),source:'investment' as const,sourceLabel:investment.opportunity.category,adminInitiated:false,pnl:investment.status===InvestmentStatus.SETTLED&&investment.simulatedPayout?formatAmount(decimal(investment.simulatedPayout).minus(decimal(investment.amount))):null,link:'/investments',details:{status:investment.status,targetReturnPercent:investment.targetReturnPercent?String(investment.targetReturnPercent):'Not stated',durationDays:investment.durationDays},
    })),
    ...fundingRequests.map(request=>({
      id:request.id,category:(request.type==='DEPOSIT'?'deposit':'withdrawal') as ActivityRecord['category'],action:request.type==='DEPOSIT'?'Funding deposit':'Funding withdrawal',timestamp:request.createdAt.toISOString(),asset:'USD',quantity:formatNumber(request.amount),price:null,amount:formatAmount(request.amount),status:request.status.replaceAll('_',' '),source:'funding' as const,sourceLabel:request.method,adminInitiated:false,pnl:null,link:`/wallet/transactions/${request.id}`,details:{type:request.type,method:request.method,reference:request.transactionReference||'Not set'},
    })),
    ...notifications.map(notification=>({
      id:notification.id,
      category:(notification.type==='TRADE'?'trade':notification.type==='SECURITY'||notification.type==='KYC'?'security':'account') as ActivityRecord['category'],
      action:notification.title,
      timestamp:notification.createdAt.toISOString(),
      asset:'ACCOUNT',
      quantity:'0',
      price:null,
      amount:'0',
      status:notification.isRead?'READ':'UNREAD',
      source:'notification' as const,
      archivedAt:notification.archivedAt?.toISOString()||null,
      sourceLabel:notification.type,
      adminInitiated:false,
      pnl:null,
      link:notification.actionUrl||'/notifications',
      details:{message:notification.message,accountMode:notification.accountMode||accountMode,isRead:notification.isRead,hasDelivery:Boolean(notification.pushOutbox),relatedEntity:notification.relatedEntity},
    })),
    ...auditLogs.filter(audit=>audit.entity==='LOGIN').map(audit=>({
      id:audit.id,category:'security' as const,action:audit.action==='LOGIN_SUCCESS'?'Successful sign-in':audit.action==='LOGOUT_SUCCESS'?'Signed out':'Failed sign-in',timestamp:audit.createdAt.toISOString(),asset:'ACCOUNT',quantity:'0',price:null,amount:'0',status:audit.action==='LOGIN_FAILED'?'FAILED':'SUCCESS',source:'audit' as const,sourceLabel:'Login history',adminInitiated:false,pnl:null,link:'/settings#security',details:{eventType:audit.action},
    })),
  ];
  const auditByEntity=new Map<string,typeof auditLogs>();
  for(const audit of auditLogs){const key=`${audit.entity}:${audit.entityId}`;const existing=auditByEntity.get(key)||[];existing.push(audit);auditByEntity.set(key,existing)}
  for(const record of records){const audits=auditByEntity.get(`${record.source.toUpperCase()}:${record.id}`);if(audits?.some(audit=>audit.actorId!==userId))record.adminInitiated=true;}
  const demoVisibleCategories=new Set<ActivityRecord['category']>(['trade','personal-trade','order','position']);
  const preferenceByKey=new Map(preferences.map(preference=>[`${preference.sourceType}:${preference.sourceId}`,preference]));
  for(const record of records){
    const preference=preferenceByKey.get(`${record.source}:${record.id}`);
    record.archivedAt=record.source==='notification'?record.archivedAt||null:preference?.archivedAt?.toISOString()||null;
    record.hidden=Boolean(preference?.hiddenAt);
    record.permanentDeletionAllowed=record.source==='notification'&&record.sourceLabel!=='SECURITY'&&record.sourceLabel!=='KYC'&&record.details.isRead===true&&record.details.hasDelivery===false;
    record.protectionReason=record.source==='notification'
      ?record.sourceLabel==='SECURITY'||record.sourceLabel==='KYC'?'Security and verification notifications must be retained.':record.permanentDeletionAllowed?'Read notification with no delivery history may be permanently deleted.':'Unread or delivery-linked notifications are retained.'
      :record.source==='audit'?'Security and financial audit history must be retained.':'This record is linked to account, trade, or financial history and can only be hidden from this feed.';
  }
  const searchText=query.search?.trim().toLocaleLowerCase();
  const filtered=records.filter(record=>
    (accountMode!==AccountMode.DEMO||record.source==='notification'||record.source==='audit'||demoVisibleCategories.has(record.category))&&
    (category==='all'||category==='login-history'&&record.source==='audit'||category==='security'&&record.category==='security'||record.category===category||record.category==='trade'&&category==='personal-trade'||record.category==='personal-trade'&&category==='trade')&&
    (!query.status||record.status.toLocaleLowerCase().includes(query.status.toLocaleLowerCase()))&&
    (!query.dateFrom||Date.parse(record.timestamp)>=query.dateFrom.getTime())&&
    (!query.dateTo||Date.parse(record.timestamp)<=query.dateTo.getTime())&&
    (!searchText||`${record.action} ${record.asset} ${record.status} ${record.sourceLabel} ${record.id}`.toLocaleLowerCase().includes(searchText))&&
    (query.state==='hidden'?record.hidden:query.state==='archived'?Boolean(record.archivedAt):query.state==='all'?true:!record.hidden&&!record.archivedAt),
  );
  const sorted=filtered.sort((a,b)=>Date.parse(b.timestamp)-Date.parse(a.timestamp)||b.id.localeCompare(a.id));
  const page=sorted.slice(offset,offset+limit).map(record=>({
    ...record,
    action:removeSimulatedLabels(record.action),
    asset:removeSimulatedLabels(record.asset),
    status:removeSimulatedLabels(record.status),
    sourceLabel:removeSimulatedLabels(record.sourceLabel),
    details:Object.fromEntries(Object.entries(record.details).map(([key,value])=>[
      key,
      typeof value==='string'?removeSimulatedLabels(value):value,
    ])),
  }));
  return {items:page,total:sorted.length,hasMore:offset<1000&&sorted.length>offset+limit,cursor:page.at(-1)?.id||null};
}

export function activityCategoryLabel(category:ActivityCategory){return ({all:'All activity',trade:'Trades', 'personal-trade':'Personal trades',investment:'Investments',deposit:'Deposits',withdrawal:'Withdrawals',order:'Orders',position:'Positions',account:'Account',security:'Security','login-history':'Login history'} as const)[category]}
