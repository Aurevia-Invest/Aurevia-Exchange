'use client';

import {useCallback,useEffect,useMemo,useState} from 'react';
import Link from 'next/link';
import {ArrowLeft,Check,ExternalLink,RefreshCw,X} from 'lucide-react';
import AdminNav from '@/components/AdminNav';
import {formatUsd} from '@/lib/currency-format';

type Funding={id:string;user:{email:string;name:string|null};type:'DEPOSIT'|'WITHDRAWAL';accountMode:'DEMO'|'REAL';method:string;amount:string|number;creditedAmount:string|number|null;creditedCurrency:string|null;feeAmount?:string|number|null;feePercent?:string|number|null;currency:string;network:string|null;verifiedAt:string|null;status:string;createdAt:string;reviewedAt:string|null;settledAt:string|null;settlementReference:string|null;processingReference:string|null;transactionReference:string|null;note:string|null;adminNote:string|null;hasReceipt:boolean;withdrawalDestination?:{id?:string;type:'BANK_TRANSFER'|'CRYPTOCURRENCY';nickname:string;countryCode:string;network:string|null;asset:string|null;maskedLabel:string}|null};
type Decision='APPROVED'|'REJECTED'|'REQUEST_INFO';
type RequestFilter='ALL'|'DEPOSIT'|'WITHDRAWAL';
type FundingFilters={search:string;status:string;method:string;country:string;currency:string;dateFrom:string;dateTo:string};
const amount=(value:string|number,currency:string)=>currency.toUpperCase()==='USD'?formatUsd(value):`${Number(value).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:8})} ${currency}`;
const depositFee=(value:string|number)=>Math.round(Number(value)*10)/100;
const matchesFundingFilters=(item:Funding,filters:FundingFilters)=>{
	const term=filters.search.trim().toLowerCase();
	const date=new Date(item.createdAt).toISOString().slice(0,10);
	const method=item.withdrawalDestination?.type==='BANK_TRANSFER'?'Bank transfer':item.withdrawalDestination?.type==='CRYPTOCURRENCY'?'Cryptocurrency wallet':item.method;
	const matchesSearch=!term||`${item.id} ${item.user.name||''} ${item.user.email} ${item.status} ${item.accountMode} ${method} ${item.withdrawalDestination?.countryCode||''} ${item.currency}`.toLowerCase().includes(term);
	return matchesSearch&&(filters.status==='ALL'||item.status===filters.status)&&(filters.method==='ALL'||method===filters.method)&&(filters.country==='ALL'||item.withdrawalDestination?.countryCode===filters.country)&&(filters.currency==='ALL'||item.currency===filters.currency)&&(!filters.dateFrom||date>=filters.dateFrom)&&(!filters.dateTo||date<=filters.dateTo);
};

export default function AdminPayments(){
	const [queue,setQueue]=useState<Funding[]>([]);
	const [history,setHistory]=useState<Funding[]>([]);
	const [notes,setNotes]=useState<Record<string,string>>({});
	const [processingReferences,setProcessingReferences]=useState<Record<string,string>>({});
	const [externalConfirmations,setExternalConfirmations]=useState<Record<string,boolean>>({});
	const [destinationDetails,setDestinationDetails]=useState<{requestId:string;details:Record<string,unknown>}|null>(null);
	const [requestFilter,setRequestFilter]=useState<RequestFilter>('ALL');
	const [search,setSearch]=useState('');
	const [statusFilter,setStatusFilter]=useState('ALL');
	const [methodFilter,setMethodFilter]=useState('ALL');
	const [countryFilter,setCountryFilter]=useState('ALL');
	const [currencyFilter,setCurrencyFilter]=useState('ALL');
	const [dateFrom,setDateFrom]=useState('');
	const [dateTo,setDateTo]=useState('');
	const [loading,setLoading]=useState(true);
	const [busy,setBusy]=useState('');
	const [message,setMessage]=useState('');
	const [error,setError]=useState('');
	const load=useCallback(async(showLoading=true)=>{
		if(showLoading)setLoading(true);
		try{
			const typeQuery=requestFilter==='ALL'?'':`type=${requestFilter}`;
			const [pendingResponse,historyResponse]=await Promise.all([
				fetch(`/api/admin/funding${typeQuery?`?${typeQuery}`:''}`,{cache:'no-store'}),
				fetch(`/api/admin/funding?history=true${typeQuery?`&${typeQuery}`:''}`,{cache:'no-store'}),
			]);
			const [pendingData,historyData]=await Promise.all([pendingResponse.json(),historyResponse.json()]);
			if(!pendingResponse.ok||!historyResponse.ok)throw new Error('Administrator authorization required.');
			setQueue(pendingData);setHistory(historyData);setError('');
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to load internal funding records.')}
		finally{if(showLoading)setLoading(false)}
	},[requestFilter]);
	useEffect(()=>{
		const selected=new URLSearchParams(window.location.search).get('type');
		if(selected==='DEPOSIT'||selected==='WITHDRAWAL')setRequestFilter(selected);
	},[]);
	useEffect(()=>{void load();const timer=window.setInterval(()=>void load(false),10000);return()=>window.clearInterval(timer)},[load]);
	const historyOptions=useMemo(()=>({
		statuses:[...new Set([...history,...queue].map(item=>item.status))].sort(),
		methods:[...new Set([...history,...queue].map(item=>item.withdrawalDestination?.type==='BANK_TRANSFER'?'Bank transfer':item.withdrawalDestination?.type==='CRYPTOCURRENCY'?'Cryptocurrency wallet':item.method))].sort(),
		countries:[...new Set([...history,...queue].map(item=>item.withdrawalDestination?.countryCode).filter((value):value is string=>Boolean(value)))].sort(),
		currencies:[...new Set([...history,...queue].map(item=>item.currency))].sort(),
	}),[history,queue]);
	const visibleHistory=useMemo(()=>history.filter(item=>matchesFundingFilters(item,{search,status:statusFilter,method:methodFilter,country:countryFilter,currency:currencyFilter,dateFrom,dateTo})),[history,search,statusFilter,methodFilter,countryFilter,currencyFilter,dateFrom,dateTo]);
	const visibleQueue=useMemo(()=>queue.filter(item=>matchesFundingFilters(item,{search,status:statusFilter,method:methodFilter,country:countryFilter,currency:currencyFilter,dateFrom,dateTo})),[queue,search,statusFilter,methodFilter,countryFilter,currencyFilter,dateFrom,dateTo]);
	const pendingCount=visibleQueue.filter(item=>item.status==='PENDING'||item.status==='PENDING_REVIEW').length;
		const approvedCount=visibleQueue.filter(item=>item.status==='APPROVED').length;
		const processingCount=visibleQueue.filter(item=>item.status==='PROCESSING').length;
	async function review(request:Funding,decision:Decision){
		if(busy)return;
		const note=notes[request.id]?.trim();
		if(decision==='REQUEST_INFO'&&(!note||note.length<3)){setError('Add an administrator review note of at least 3 characters.');return}
		setBusy(request.id);setError('');setMessage('');
		try{
			const response=await fetch('/api/admin/funding',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({id:request.id,decision,note:note||undefined})});
			const result=await response.json();if(!response.ok)throw new Error(result.error||'Unable to update this request.');
			setMessage(decision==='REQUEST_INFO'?`More information requested from ${request.user.email}.`:decision==='APPROVED'?`Internal REAL ${request.type.toLowerCase()} request approved for ${request.user.email}. ${request.type==='DEPOSIT'?'The 10% deposit fee was deducted and the net amount was credited.':'Funds remain reserved; no payout was marked complete.'}`:`Internal REAL ${request.type.toLowerCase()} request rejected for ${request.user.email}.`);
			await load(false);
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to update this request.')}
		finally{setBusy('')}
	}
	async function updateWithdrawal(request:Funding,action:'APPROVE'|'REJECT'|'REQUEST_INFO'|'PROCESS'|'COMPLETE'|'FAIL'){
		if(busy)return;
		const note=notes[request.id]?.trim();
		if(['REJECT','REQUEST_INFO','FAIL'].includes(action)&&!note){setError('Enter an administrator audit note for this action.');return}
		const processingReference=processingReferences[request.id]?.trim();
		if(action==='COMPLETE'&&(!processingReference||!externalConfirmations[request.id])){setError('Record the actual external reference and confirm that processing really succeeded.');return}
		setBusy(request.id);setError('');setMessage('');
		try{
			const response=await fetch('/api/admin/funding/withdrawal',{method:'POST',headers:{'content-type':'application/json','Idempotency-Key':window.crypto.randomUUID()},body:JSON.stringify({id:request.id,action,note:note||undefined,processingReference:action==='COMPLETE'?processingReference:undefined,confirmExternalProcessing:action==='COMPLETE'?true:undefined})});
			const result=await response.json();if(!response.ok)throw new Error(result.error||'Unable to update withdrawal.');
			setMessage(action==='APPROVE'?'Withdrawal approved; amount remains reserved and no payment is confirmed.':action==='PROCESS'?'Withdrawal moved to processing; this does not confirm payment.':action==='COMPLETE'?'Administrator-recorded payout and internal ledger debit completed.':action==='FAIL'?'Withdrawal marked failed; reservation released without ledger debit.':action==='REJECT'?'Withdrawal rejected; reservation released without ledger debit.':'More information requested; no payout was initiated.');
			await load(false);
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to update withdrawal.')}
		finally{setBusy('')}
	}
	async function viewDestination(request:Funding){
		try{
			const response=await fetch(`/api/admin/funding/${encodeURIComponent(request.id)}/destination`,{cache:'no-store'});
			const result=await response.json();if(!response.ok)throw new Error(result.error||'Destination details unavailable.');
			setDestinationDetails({requestId:request.id,details:result.destination.details});
		}catch(exception){setError(exception instanceof Error?exception.message:'Destination details unavailable.')}
	}
	async function openEvidence(id:string){
		try{const response=await fetch(`/api/admin/funding/${encodeURIComponent(id)}/receipt`,{cache:'no-store'});const data=await response.json();if(!response.ok)throw new Error(data.error||'Evidence unavailable.');window.open(data.url,'_blank','noopener,noreferrer')}
		catch(exception){setError(exception instanceof Error?exception.message:'Evidence unavailable.')}
	}
	return <><AdminNav/><main className="account-page">
		<header className="account-heading"><div><span className="account-kicker">ADMINISTRATION · FUNDING</span><h1>{requestFilter==='WITHDRAWAL'?'Withdrawal review':requestFilter==='DEPOSIT'?'Funding review':'Funding & withdrawal review'}</h1><p>Withdrawal approval only reserves funds. An external payout is recorded separately and requires an actual reference plus administrator confirmation before one ledger debit. No bank or blockchain provider is connected.</p></div><div className="flex gap-2"><Link className="button-secondary" href="/admin"><ArrowLeft size={14}/> Admin home</Link><button className="icon-action" type="button" aria-label="Refresh funding records" onClick={()=>void load()} disabled={loading}><RefreshCw size={15}/></button></div></header>
		<div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Funding request type">
			{(['ALL','DEPOSIT','WITHDRAWAL'] as const).map(filter=><button key={filter} type="button" aria-pressed={requestFilter===filter} className={`btn min-h-10 ${requestFilter===filter?'bg-gold text-black':'bg-white/5'}`} onClick={()=>{setRequestFilter(filter);const url=new URL(window.location.href);if(filter==='ALL')url.searchParams.delete('type');else url.searchParams.set('type',filter);window.history.replaceState(null,'',url)}}>{filter==='ALL'?'All requests':filter==='DEPOSIT'?'Funding requests':'Withdrawals'}</button>)}
		</div>
		<section className="account-panel card mb-4 p-4" aria-label="Funding filters">
			<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
				<label className="account-label">Search user or reference<input className="input mt-1 min-h-11" value={search} onChange={event=>setSearch(event.target.value)} placeholder="Name, email, request ID" maxLength={120}/></label>
				<label className="account-label">Status<select className="input mt-1 min-h-11" value={statusFilter} onChange={event=>setStatusFilter(event.target.value)}><option value="ALL">All statuses</option>{historyOptions.statuses.map(status=><option key={status} value={status}>{status.replaceAll('_',' ')}</option>)}</select></label>
				<label className="account-label">Method<select className="input mt-1 min-h-11" value={methodFilter} onChange={event=>setMethodFilter(event.target.value)}><option value="ALL">All methods</option>{historyOptions.methods.map(method=><option key={method} value={method}>{method}</option>)}</select></label>
				<label className="account-label">Country<select className="input mt-1 min-h-11" value={countryFilter} onChange={event=>setCountryFilter(event.target.value)}><option value="ALL">All countries</option>{historyOptions.countries.map(country=><option key={country} value={country}>{country}</option>)}</select></label>
				<label className="account-label">Currency<select className="input mt-1 min-h-11" value={currencyFilter} onChange={event=>setCurrencyFilter(event.target.value)}><option value="ALL">All currencies</option>{historyOptions.currencies.map(currency=><option key={currency} value={currency}>{currency}</option>)}</select></label>
				<label className="account-label">From date<input className="input mt-1 min-h-11" type="date" value={dateFrom} onChange={event=>setDateFrom(event.target.value)}/></label>
				<label className="account-label">To date<input className="input mt-1 min-h-11" type="date" value={dateTo} onChange={event=>setDateTo(event.target.value)}/></label>
				<button className="btn min-h-11 self-end bg-white/5" type="button" onClick={()=>{setSearch('');setStatusFilter('ALL');setMethodFilter('ALL');setCountryFilter('ALL');setCurrencyFilter('ALL');setDateFrom('');setDateTo('')}}>Clear filters</button>
			</div>
			<p className="mt-2 text-xs muted">Filters apply to both the review queue and the latest 200 history records loaded for this view.</p>
		</section>
		{message&&<p className="mb-3 text-sm text-profit" role="status">{message}</p>}{error&&<p className="mb-3 text-sm text-loss" role="alert">{error}</p>}
		<section className="account-panel card p-5"><div className="account-panel-title"><div><h2>{requestFilter==='WITHDRAWAL'?'Withdrawal workflow':requestFilter==='DEPOSIT'?'Funding requests awaiting review':'Funding review queue'}</h2><p className="account-panel-subtitle">Deposits leave review when approved. Approved withdrawals remain visible for processing; approval reserves funds but does not confirm a payout.</p></div><span className="status-pill">{visibleQueue.length} shown · {pendingCount} awaiting review · {approvedCount} approved · {processingCount} processing</span></div>
			{loading&&!queue.length?<p className="account-empty" role="status">Loading requests…</p>:visibleQueue.length?<div className="admin-funding-list">{visibleQueue.map(request=>{const demoRequest=request.accountMode==='DEMO';const withdrawal=request.type==='WITHDRAWAL';return <article className="admin-funding-row" key={request.id}>
				<div className="admin-funding-summary"><b>{request.type} · {request.accountMode} account</b><span>{amount(request.amount,request.currency)} requested · {request.status.replaceAll('_',' ')}</span>{request.type==='DEPOSIT'&&request.currency==='USD'&&['PENDING','PENDING_REVIEW'].includes(request.status)&&<small>On approval: 10% fee {amount(depositFee(request.amount),'USD')} · net credit {amount(Number(request.amount)-depositFee(request.amount),'USD')}</small>}{request.type==='DEPOSIT'&&request.feeAmount!==undefined&&request.feeAmount!==null&&<small>Recorded fee {request.feePercent??10}% · {amount(request.feeAmount,request.currency)} · net credited {amount(request.creditedAmount||0,request.creditedCurrency||request.currency)}</small>}{request.type==='WITHDRAWAL'&&request.feeAmount!==undefined&&request.feeAmount!==null&&<small>Gross reserved {amount(request.amount,request.currency)} · recorded commission {request.feePercent??10}% ({amount(request.feeAmount,request.currency)}) · net external payout {amount(request.creditedAmount??request.amount,request.creditedCurrency||request.currency)}. Commission is allocated only after confirming the payout.</small>}<small>{request.user.name||request.user.email} · {request.user.email}</small><small>{request.id} · {new Date(request.createdAt).toLocaleString()}</small>{request.withdrawalDestination&&<><small>{request.withdrawalDestination.type.replaceAll('_',' ')} · {request.withdrawalDestination.countryCode} · {request.withdrawalDestination.maskedLabel}</small><button type="button" className="text-link" onClick={()=>void viewDestination(request)}>View full destination details (audited)</button></>}{request.processingReference&&<small className="break-all">Administrator-recorded external reference: {request.processingReference}</small>}{request.transactionReference&&<small className="break-all">User-submitted reference: {request.transactionReference}</small>}{request.hasReceipt&&<><small>Optional user-submitted attachment available for review; not independently verified.</small><button type="button" className="text-link" onClick={()=>void openEvidence(request.id)}>Open private attachment <ExternalLink size={13}/></button></>}</div>
				{demoRequest&&<p className="account-callout account-mode-notice">DEMO funding is disabled. Reject this legacy request to close it without changing the account balance.</p>}
				<label className="account-label">Administrator note<input className="input min-h-11" value={notes[request.id]||''} maxLength={500} onChange={event=>setNotes(current=>({...current,[request.id]:event.target.value}))} placeholder="Optional note; required when requesting information"/></label>
				{withdrawal&&request.status==='PROCESSING'&&<div className="grid gap-2"><label className="account-label">Actual external bank reference or blockchain transaction hash<input className="input min-h-11 font-mono" value={processingReferences[request.id]||''} maxLength={180} onChange={event=>setProcessingReferences(current=>({...current,[request.id]:event.target.value}))} placeholder={request.withdrawalDestination?.type==='CRYPTOCURRENCY'?'64-character transaction hash':'Bank transfer reference'}/></label><label className="flex items-start gap-2 text-xs leading-5"><input type="checkbox" className="mt-1" checked={externalConfirmations[request.id]||false} onChange={event=>setExternalConfirmations(current=>({...current,[request.id]:event.target.checked}))}/><span>I confirm the external payout was actually processed and the reference above is genuine. This is an administrator attestation; Aurevia does not independently query a bank or blockchain.</span></label></div>}
				{withdrawal?<div className="flex flex-wrap gap-2">{!demoRequest&&request.status==='PENDING_REVIEW'&&<><button type="button" disabled={busy===request.id||request.currency!=='USD'||!request.withdrawalDestination} className="btn min-h-11 bg-profit px-4 text-black disabled:opacity-50" onClick={()=>void updateWithdrawal(request,'APPROVE')}><Check size={14}/>Approve · reserve funds</button><button type="button" disabled={busy===request.id} className="btn min-h-11 bg-loss px-4 text-white disabled:opacity-50" onClick={()=>void updateWithdrawal(request,'REJECT')}><X size={14}/>Reject</button><button type="button" disabled={busy===request.id||!notes[request.id]?.trim()} className="btn min-h-11 bg-white/5 px-4 disabled:opacity-50" onClick={()=>void updateWithdrawal(request,'REQUEST_INFO')}>Request information</button></>}{!demoRequest&&request.status==='APPROVED'&&<button type="button" disabled={busy===request.id} className="btn min-h-11 bg-gold px-4 text-black" onClick={()=>void updateWithdrawal(request,'PROCESS')}>Start processing</button>}{!demoRequest&&request.status==='PROCESSING'&&<><button type="button" disabled={busy===request.id||!processingReferences[request.id]?.trim()||!externalConfirmations[request.id]} className="btn min-h-11 bg-profit px-4 text-black disabled:opacity-50" onClick={()=>void updateWithdrawal(request,'COMPLETE')}>Confirm external payout + debit once</button><button type="button" disabled={busy===request.id||!notes[request.id]?.trim()} className="btn min-h-11 bg-loss px-4 text-white disabled:opacity-50" onClick={()=>void updateWithdrawal(request,'FAIL')}>Mark failed · release</button></>}</div>:<div className="flex flex-wrap gap-2">{!demoRequest&&<button type="button" disabled={busy===request.id||request.currency!=='USD'} className="btn min-h-11 bg-profit px-4 text-black disabled:opacity-50" onClick={()=>void review(request,'APPROVED')}><Check size={14}/>Approve and credit internal ledger</button>}<button type="button" disabled={busy===request.id} className="btn min-h-11 bg-loss px-4 text-white disabled:opacity-50" onClick={()=>void review(request,'REJECTED')}><X size={14}/>Reject</button>{!demoRequest&&<button type="button" disabled={busy===request.id||!notes[request.id]?.trim()} className="btn min-h-11 bg-white/5 px-4 disabled:opacity-50" onClick={()=>void review(request,'REQUEST_INFO')}>Request information</button>}</div>}
			</article>})}</div>:<p className="account-empty">{queue.length?'No requests match these filters.':'No funding requests await review.'}</p>}
		</section>
		<section className="account-panel card mt-4 p-5"><div className="account-panel-title"><div><h2>Transaction history</h2><p className="account-panel-subtitle">Persisted request status for both isolated account modes.</p></div></div>
			<div className="account-table-wrap mt-4"><table className="account-table min-w-[760px]"><thead><tr><th>Reference</th><th>User</th><th>Account</th><th>Amount</th><th>Status</th><th>Updated</th></tr></thead><tbody>{visibleHistory.map(request=><tr key={request.id}><td className="font-mono text-xs">{request.id}</td><td>{request.user.name||request.user.email}<small className="block muted">{request.user.email}</small></td><td>{request.accountMode} · {request.withdrawalDestination?.type||request.type}</td><td>{request.type} · {amount(request.amount,request.currency)}{request.creditedAmount!==null&&request.creditedCurrency&&<small className="block muted">Credited {amount(request.creditedAmount,request.creditedCurrency)}</small>}</td><td><span className="status-pill">{request.status.replaceAll('_',' ')}{request.verifiedAt?' · VERIFIED':''}</span></td><td>{new Date(request.settledAt||request.reviewedAt||request.createdAt).toLocaleString()}</td></tr>)}{!visibleHistory.length&&<tr><td colSpan={6} className="account-empty">No matching funding records.</td></tr>}</tbody></table></div>
		</section>
		{destinationDetails&&<div className="fixed inset-0 z-[70] grid place-items-center bg-black/75 p-4" role="dialog" aria-modal="true" aria-label="Sensitive withdrawal destination details" onClick={event=>{if(event.target===event.currentTarget)setDestinationDetails(null)}}><section className="account-panel card w-full max-w-xl p-5"><div className="account-panel-title"><div><h2>Sensitive destination details</h2><p className="account-panel-subtitle">Access is recorded in the immutable audit history. Do not copy these values into notes or messages.</p></div><button type="button" className="icon-action" aria-label="Close destination details" onClick={()=>setDestinationDetails(null)}><X size={15}/></button></div><dl className="mt-4 grid gap-3">{Object.entries(destinationDetails.details).filter(([key,value])=>key!=='type'&&value!==undefined&&value!=='').map(([key,value])=><div key={key} className="grid grid-cols-[minmax(8rem,0.7fr)_minmax(0,1.3fr)] gap-3 border-b border-white/10 pb-2"><dt className="text-xs muted">{key.replaceAll(/([A-Z])/g,' $1')}</dt><dd className="break-all text-sm">{String(value)}</dd></div>)}</dl></section></div>}
	</main></>;
}