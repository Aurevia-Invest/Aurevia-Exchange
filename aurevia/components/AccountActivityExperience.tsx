'use client';

import Link from 'next/link';
import {useCallback,useEffect,useRef,useState} from 'react';
import {useSession} from 'next-auth/react';
import {Activity,Archive,ArrowUpRight,Building2,CircleDollarSign,Landmark,ReceiptText,RefreshCw,Search,ShieldCheck,Trash2,TrendingUp,WalletCards} from 'lucide-react';
import Nav from '@/components/Nav';
import DisplayCurrencyPanel from '@/components/DisplayCurrencyPanel';
import {activityCategoryLabel,type ActivityCategory,type ActivityRecord} from '@/lib/activity';
import {groupByLocalDate,localDateBoundary} from '@/lib/local-date';
import {formatUsd} from '@/lib/currency-format';

const categories:ActivityCategory[]=['all','trade','personal-trade','investment','deposit','withdrawal','order','position','account','security','login-history'];
const categoryIcons:Record<ActivityCategory,typeof Activity>={all:Activity,trade:TrendingUp,'personal-trade':Activity,investment:Building2,deposit:CircleDollarSign,withdrawal:WalletCards,order:ReceiptText,position:Landmark,account:ShieldCheck,security:ShieldCheck,'login-history':ShieldCheck};
const categoryLabels:Record<ActivityCategory,string>={all:'All',trade:'Trades','personal-trade':'Personal trade',investment:'Investments',deposit:'Deposits',withdrawal:'Withdrawals',order:'Orders',position:'Positions',account:'Account',security:'Security','login-history':'Login history'};

type ActivityResponse={data:{items:ActivityRecord[];total:number;hasMore:boolean};category:ActivityCategory;categoryLabel:string;accountMode:'DEMO'|'REAL'};
type ActivityState='active'|'archived'|'hidden'|'all';

export default function AccountActivityExperience(){
  const {data:session}=useSession();
  const [category,setCategory]=useState<ActivityCategory>('all');
  const [data,setData]=useState<ActivityResponse|null>(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [search,setSearch]=useState('');
  const [statusFilter,setStatusFilter]=useState('');
  const [dateFrom,setDateFrom]=useState('');
  const [dateTo,setDateTo]=useState('');
  const [state,setState]=useState<ActivityState>('active');
  const [selected,setSelected]=useState<Set<string>>(new Set());
  const [busy,setBusy]=useState(false);
  const latestRequest=useRef(0);

  const load=useCallback(async(showLoading=false,offset=0,append=false)=>{
    const requestId=++latestRequest.current;
    if(showLoading)setLoading(true);
    try{
      const params=new URLSearchParams({category,limit:'30',offset:String(offset),state});
      if(search.trim())params.set('search',search.trim());
      if(statusFilter)params.set('status',statusFilter);
      if(dateFrom){const boundary=localDateBoundary(dateFrom);if(boundary)params.set('dateFrom',boundary)}
      if(dateTo){const boundary=localDateBoundary(dateTo,true);if(boundary)params.set('dateTo',boundary)}
      const response=await fetch(`/api/activity?${params.toString()}`,{cache:'no-store'});
      const body=await response.json();
      if(!response.ok)throw new Error(body.error||'Unable to load account activity.');
      if(requestId===latestRequest.current){setData(current=>append&&current?{...body,data:{...body.data,items:[...current.data.items,...body.data.items]}}:body);setError('');setSelected(new Set());}
    }
    catch(exception){if(requestId===latestRequest.current)setError(exception instanceof Error?exception.message:'Unable to load account activity.');}
    finally{if(requestId===latestRequest.current)setLoading(false);}
  },[category,dateFrom,dateTo,search,state,statusFilter]);

  useEffect(()=>{setData(null);void load(true)},[load,session?.user?.accountMode]);

  function changeCategory(next:ActivityCategory){if(next!==category){setCategory(next);setError('');}}
  function toggleLoading(){void load(true)}
  const recordKey=(item:ActivityRecord)=>`${item.source}:${item.id}`;
  const selectedItems=data?.data.items.filter(item=>selected.has(recordKey(item)))||[];
  function toggleSelected(item:ActivityRecord){const key=recordKey(item);setSelected(current=>{const next=new Set(current);if(next.has(key))next.delete(key);else next.add(key);return next;});}
  async function manage(action:'archive'|'restore'|'hide'|'unhide'|'permanently-delete',items=selectedItems){
    if(!items.length||busy)return;
    if(action==='hide'&&!window.confirm(`Remove ${items.length} selected item${items.length===1?'':'s'} from your activity feed? This will not delete or change the underlying account records.`))return;
    if(action==='permanently-delete'&&!window.confirm(`Permanently delete ${items.length} selected read notification${items.length===1?'':'s'}? Related account records and delivery history will not be deleted.`))return;
    setBusy(true);setError('');setNotice('');
    try{
      const response=await fetch('/api/activity/manage',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,items:items.map(item=>({source:item.source,id:item.id}))})});
      const result=await response.json();
      if(!response.ok)throw new Error(result.error||'Unable to update account activity.');
      const failures=(result.results||[]).filter((item:{eligible:boolean})=>!item.eligible).length;
      setNotice(`${result.affected} item${result.affected===1?'':'s'} updated.${failures?` ${failures} protected or unavailable item${failures===1?' was':'s were'} not changed.`:''}`);
      await load(true);
    }catch(exception){setError(exception instanceof Error?exception.message:'Unable to update account activity.');}
    finally{setBusy(false)}
  }
  async function clearHistory(){
    if(busy||!window.confirm('Remove eligible completed activity from this account feed? Financial, security, and business records will not be deleted.'))return;
    setBusy(true);setError('');setNotice('');
    try{
      const response=await fetch('/api/activity/manage',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'clear'})});
      const result=await response.json();
      if(!response.ok)throw new Error(result.error||'Unable to clear eligible activity.');
      setNotice(`${result.affected} eligible item${result.affected===1?' was':'s were'} removed from this feed.${result.capped?' The per-source safety limit was reached; run Clear history again to continue.':''}`);
      await load(true);
    }catch(exception){setError(exception instanceof Error?exception.message:'Unable to clear eligible activity.');}
    finally{setBusy(false)}
  }
  const displayValues=(data?.data.items||[]).filter(item=>item.source!=='notification'&&(item.source!=='ledger'||item.asset==='USD')&&(item.source!=='order'||Number(item.details.filledQuantity)>0)).slice(0,5).map(item=>({label:item.action,amount:item.amount}));
  const groupedActivity=groupByLocalDate(data?.data.items||[]);
  const activityRows=groupedActivity.map(group=><div className="activity-date-group" key={group.key}><h3>{group.label}</h3><span>{group.items.length} {group.items.length===1?'entry':'entries'}</span>{group.items.map(item=><ActivityRow key={`${item.source}:${item.id}`} item={item} selected={selected.has(recordKey(item))} onSelect={()=>toggleSelected(item)}/>)}</div>);

  return <><Nav/><main className="account-page activity-page">
    <header className="account-heading"><div><span className="account-kicker">AUDITABLE ACTIVITY · {session?.user?.accountMode||'ACCOUNT'}</span><h1>Account activity</h1><p>Orders, trades, investments, funding, positions, and account events from persisted records.</p></div><div className="flex items-center gap-2"><span className={`status-pill ${session?.user?.accountMode==='REAL'?'mode-real':'mode-demo'}`}>{session?.user?.accountMode||'ACCOUNT'}</span><button className="icon-action" type="button" aria-label="Refresh account activity" onClick={toggleLoading} disabled={loading}><RefreshCw size={15} className={loading?'animate-spin':''}/></button></div></header>
    <DisplayCurrencyPanel values={displayValues}/>
    {error&&<div className="account-callout mb-4" role="alert"><span>{error}</span><button type="button" className="text-link" onClick={()=>void load(true)}>Retry</button></div>}
    <section className="account-panel card p-4 activity-controls">
      <div className="activity-filter" role="group" aria-label="Activity categories">{categories.map(item=>{const Icon=categoryIcons[item];return <button key={item} type="button" aria-pressed={category===item} className={category===item?'is-active':''} onClick={()=>changeCategory(item)}><Icon size={14} aria-hidden="true"/><span>{categoryLabels[item]}</span></button>})}</div>
      <div className="activity-filter-fields">
        <label className="activity-field activity-search-field"><span>Search activity</span><span className="activity-search-input"><Search size={15} aria-hidden="true"/><input className="input" value={search} onChange={event=>setSearch(event.target.value)} placeholder="Name, asset, or event" maxLength={120}/></span></label>
        <label className="activity-field"><span>Status</span><input className="input" value={statusFilter} onChange={event=>setStatusFilter(event.target.value)} placeholder="Any status" aria-label="Filter by status" maxLength={40}/></label>
        <label className="activity-field" htmlFor="activity-date-from"><span>From</span><input id="activity-date-from" className="input" type="date" value={dateFrom} onChange={event=>setDateFrom(event.target.value)}/></label>
        <label className="activity-field" htmlFor="activity-date-to"><span>To</span><input id="activity-date-to" className="input" type="date" value={dateTo} onChange={event=>setDateTo(event.target.value)}/></label>
        <label className="activity-field"><span>Show</span><select className="input" value={state} onChange={event=>setState(event.target.value as ActivityState)} aria-label="Filter activity visibility"><option value="active">Visible activity</option><option value="archived">Archived</option><option value="hidden">Removed from feed</option><option value="all">All activity</option></select></label>
      </div>
      <div className="activity-action-bar">
        <button type="button" className="button-secondary" disabled={!selectedItems.length||busy} onClick={()=>void manage(state==='archived'?'restore':'archive')}><Archive size={14}/>{state==='archived'?'Restore selected':'Archive selected'}</button>
        <button type="button" className="button-secondary" disabled={!selectedItems.length||busy} onClick={()=>void manage(state==='hidden'?'restore':'hide')}><Trash2 size={14}/>{state==='hidden'?'Restore to feed':'Remove from feed'}</button>
        {selectedItems.length>0&&selectedItems.every(item=>item.source==='notification'&&item.permanentDeletionAllowed)&&<button type="button" className="button-secondary" disabled={busy} onClick={()=>void manage('permanently-delete')}><Trash2 size={14}/>Delete selected notifications</button>}
        <span className="activity-action-spacer"/>
        {selectedItems.length>0&&<span className="activity-selection-count">{selectedItems.length} selected · protected records are retained</span>}
        <button type="button" className="button-secondary activity-clear-button" disabled={busy} onClick={()=>void clearHistory()}><Trash2 size={14}/>Clear eligible history</button>
      </div>
      {notice&&<p className="mt-3 text-sm text-profit" role="status">{notice}</p>}
    </section>
    <section className="account-panel card mt-4 overflow-hidden activity-records">
      <div className="account-panel-title px-4 pt-4 activity-records-heading"><div><span className="activity-records-kicker">ACCOUNT LEDGER</span><h2>{data?.categoryLabel||activityCategoryLabel(category)}</h2><p className="account-panel-subtitle">{data?`${data.data.total} recorded entries`:'Loading persisted activity'}</p></div><span className={`status-pill ${data?.accountMode==='REAL'?'mode-real':'mode-demo'}`}>{data?.accountMode||'ACCOUNT'}</span></div>
      {loading&&!data?<div className="account-empty" role="status">Loading account activity…</div>:data?.data.items.length?<div className="activity-feed">{activityRows}</div>:<div className="account-empty activity-empty"><Activity size={22} aria-hidden="true"/><p>No activity matches this filter.</p><small>Financial and security records remain protected even when hidden from this feed.</small></div>}
      {data&&<div className="activity-pagination"><span>Showing {data.data.items.length} of {data.data.total} loaded matches</span>{data.data.hasMore&&<button type="button" className="button-secondary" onClick={()=>void load(false,data.data.items.length,true)} disabled={loading}>Load more <ArrowUpRight size={13}/></button>}</div>}
    </section>
  </main></>;
}

function ActivityRow({item,selected,onSelect}:{item:ActivityRecord;selected:boolean;onSelect:()=>void}){
  const Icon=activityIcon(item.category);
  const positive=item.pnl!==null&&Number(item.pnl)>=0;
  const isUsdActivity=item.source!=='ledger'||item.asset==='USD';
  const amount=isUsdActivity?formatUsd(item.amount):`${item.amount} ${item.asset}`;
  const price=item.price===null?'—':isUsdActivity?formatUsd(item.price):item.price;
  const pnl=item.pnl===null?null:formatUsd(Math.abs(Number(item.pnl)));
  const hasVisibilityState=item.archivedAt||item.hidden;
  const isNotification=item.source==='notification';
  return <article className="activity-feed-row activity-managed-row"><label className="flex items-center"><input type="checkbox" checked={selected} onChange={onSelect} disabled={item.source==='audit'} aria-label={`Select ${item.action}`}/></label><span className={`activity-icon activity-${item.category}`}><Icon size={16} aria-hidden="true"/></span><div className="activity-feed-main"><div><b>{item.action}</b><span>{item.asset}</span>{item.side&&<em>{item.side}</em>}{item.adminInitiated&&<small>ADMIN-INITIATED</small>}{hasVisibilityState&&<small>{item.hidden?'REMOVED FROM FEED':'ARCHIVED'}</small>}{item.permanentDeletionAllowed&&<small>ELIGIBLE FOR PERMANENT DELETION</small>}</div><p>{item.sourceLabel} · {statusLabel(item.status)}</p><details><summary>Details</summary><dl>{!isNotification&&<><Detail label="Amount" value={amount}/><Detail label="Quantity" value={item.quantity}/><Detail label="Price" value={price}/></>}<Detail label="Status" value={item.status}/><Detail label="Source" value={item.sourceLabel}/>{isNotification&&typeof item.details.message==='string'&&<Detail label="Message" value={item.details.message}/>}<Detail label="Retention" value={item.protectionReason||'Financial and business records are retained.'}/>{pnl!==null&&<Detail label="P/L" value={pnl}/>}</dl></details></div><div className="activity-feed-meta"><time dateTime={item.timestamp}>{formatTime(item.timestamp)}</time><b className={positive?'text-profit':item.pnl===null?'':'text-loss'}>{pnl===null?'':`${positive?'+':'−'}${pnl}`}</b><Link href={item.link} aria-label={`Open ${item.action} details`}><ArrowUpRight size={14}/></Link></div></article>;
}

function Detail({label,value}:{label:string;value:string}){return <div><dt>{label}</dt><dd>{value}</dd></div>}
function activityIcon(category:ActivityRecord['category']){return ({trade:TrendingUp,'personal-trade':Activity,investment:Building2,deposit:CircleDollarSign,withdrawal:WalletCards,order:ReceiptText,position:Landmark,account:ShieldCheck,security:ShieldCheck,'login-history':ShieldCheck} as const)[category]||Activity}
function statusLabel(value:string){return value.replaceAll('_',' ').toLowerCase()}
function formatTime(value:string){return new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(value))}
