'use client';

import {useCallback,useEffect,useRef,useState} from 'react';
import {useSession} from 'next-auth/react';
import {RefreshCw,X} from 'lucide-react';
import Nav from '@/components/Nav';
import AureviaLoading from '@/components/AureviaLoading';
import {useLocale} from '@/lib/i18n-context';
import {formatUsd} from '@/lib/currency-format';

type Order={id:string;side:string;type:string;status:string;accountMode:'DEMO'|'REAL';quantity:string;filledQuantity:string;price:string|null;stopPrice:string|null;averageFillPrice:string|null;fee:string;createdAt:string;instrument:{symbol:string;name:string};executions:Array<{quantity:string;price:string;fee:string;createdAt:string}>};
type Filter='ALL'|'OPEN'|'PARTIALLY_FILLED'|'PENDING_CANCEL'|'FILLED'|'CANCELLED'|'REJECTED'|'EXPIRED';
const filters:Filter[]=['ALL','OPEN','PARTIALLY_FILLED','PENDING_CANCEL','FILLED','CANCELLED','REJECTED','EXPIRED'];
const money=(value:string|null|undefined)=>value===null||value===undefined?'Market':formatUsd(value);

export default function OrdersExperience(){
 const {data:session}=useSession();
 const {translate}=useLocale();
 const [orders,setOrders]=useState<Order[]>([]);const [filter,setFilter]=useState<Filter>('ALL');const [loading,setLoading]=useState(true);const [busy,setBusy]=useState('');const [error,setError]=useState('');
 const latestRequest=useRef(0);
 const load=useCallback(async(showLoading=false)=>{
  const requestId=++latestRequest.current;
  if(showLoading)setLoading(true);
  try{
   const response=await fetch('/api/orders',{cache:'no-store'});
   const result=await response.json();
   if(!response.ok)throw new Error(result.error||'Unable to load orders.');
   if(requestId===latestRequest.current){setOrders(result);setError('');}
  }catch(exception){if(requestId===latestRequest.current)setError(exception instanceof Error?exception.message:'Unable to load orders.');}
  finally{if(requestId===latestRequest.current)setLoading(false);}
 },[]);
 useEffect(()=>{setOrders([]);void load(true);},[load,session?.user?.accountMode]);
 async function cancel(orderId:string){if(busy)return;setBusy(orderId);setError('');try{const response=await fetch('/api/orders',{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({orderId})});const result=await response.json();if(!response.ok)throw new Error(result.error||'Unable to cancel order.');await load();}catch(exception){setError(exception instanceof Error?exception.message:'Unable to cancel order.');}finally{setBusy('');}}
 const visible=orders.filter(order=>filter==='ALL'||order.status===filter);

 return <><Nav/><main className="account-page orders-page">
  <header className="account-heading"><div><span className="account-kicker">{translate('orderActivity')}</span><h1>{translate('ordersTitle')}</h1><p>{session?.user?.accountMode==='REAL'?'REAL account orders use simulated execution and are not live market transactions.':translate('orderSubtitle')}</p></div><div className="flex items-center gap-2"><span className={`status-pill ${session?.user?.accountMode==='REAL'?'mode-real':'mode-demo'}`}>{translate('accountOrderMode',{mode:session?.user?.accountMode||'ACCOUNT'})}</span><button className="icon-action" type="button" aria-label={translate('refreshOrders')} onClick={()=>void load(true)}><RefreshCw size={15}/></button></div></header>
  {error&&<div className="account-callout mb-4" role="alert"><span>{error}</span><button type="button" className="text-link" onClick={()=>void load(true)}>{translate('retry')}</button></div>}
  <section className="account-panel card p-5"><div className="account-panel-title"><div><h2>{translate('orderHistory')}</h2><p className="account-panel-subtitle">{translate('orderHistorySubtitle')}</p></div><div className="orders-filters" role="group" aria-label={translate('filterOrders')}>{filters.map(item=><button key={item} type="button" aria-pressed={filter===item} className={filter===item?'is-active':''} onClick={()=>setFilter(item)}>{item}</button>)}</div></div>
   {loading&&!orders.length?<AureviaLoading variant="inline" label={translate('loadingOrderHistory')} className="account-empty"/>:visible.length?<div className="orders-list">{visible.map(order=><article className="orders-row" key={order.id}><div className="orders-main"><span className={`market-side is-${order.side.toLowerCase()}`}>{order.side}</span><div><b>{order.instrument.symbol}</b><span>{order.type} · {Number(order.filledQuantity).toLocaleString()} / {Number(order.quantity).toLocaleString()} units</span><small>{new Date(order.createdAt).toLocaleString()}</small></div></div><div><span className={`status-pill ${order.accountMode==='DEMO'?'mode-demo':'mode-real'}`}>{order.accountMode} ACCOUNT</span><small>{order.status.replaceAll('_',' ')}</small></div><div><b>{order.averageFillPrice?money(order.averageFillPrice):money(order.price||order.stopPrice)}</b><small>{order.accountMode==='REAL'?'Average fill price':`Fee ${money(order.fee)}`}</small></div><div className="orders-executions">{order.executions.map((execution,index)=><span key={`${execution.createdAt}-${index}`}>{Number(execution.quantity).toLocaleString()} @ {money(execution.price)} · {new Date(execution.createdAt).toLocaleTimeString()}</span>)}</div>{(['OPEN','PARTIALLY_FILLED','PENDING_CANCEL'] as string[]).includes(order.status)&&<button className="icon-action" type="button" aria-label={translate('cancelOrder',{symbol:order.instrument.symbol})} disabled={busy===order.id} onClick={()=>void cancel(order.id)}><X size={15}/></button>}</article>)}</div>:<p className="account-empty">{orders.length?translate('noOrdersMatch'):translate('noOrdersRecorded')}</p>}
  </section>
 </main></>;
}