'use client';

import {FormEvent,useCallback,useEffect,useState} from 'react';
import Link from 'next/link';
import {ArrowLeft,RefreshCw,Search,ShieldCheck} from 'lucide-react';
import AdminNav from '@/components/AdminNav';

type TierRequest={
	id:string;currentTier:number;requestedTier:number;status:'PENDING_REVIEW'|'NEEDS_INFORMATION'|'APPROVED'|'REJECTED';
	userMessage:string|null;adminReason:string|null;createdAt:string;reviewedAt:string|null;
	user:{id:string;name:string|null;email:string;accountMode:'DEMO'|'REAL';kycStatus:string;approvedTier:number;phone:string|null;phoneVerified:boolean;country:string|null;kyc:{submittedAt:string|null}|null;kycDocuments:Array<{id:string;status:string}>};
	reviewedBy:{name:string|null;email:string}|null;
};
type TierAccount={
	id:string;email:string;name:string|null;country:string|null;phone:string|null;status:string;accountMode:'DEMO'|'REAL';kycStatus:string;approvedTier:number;currentTier:number;createdAt:string;
	requirements:{nameComplete:boolean;countryComplete:boolean;phoneComplete:boolean;phoneVerified:boolean;profileComplete:boolean;verificationSubmitted:boolean;identityDocumentUploaded:boolean;identityDocumentApproved:boolean;identityApproved:boolean};
	tierRequests:Array<{id:string;currentTier:number;requestedTier:number;status:string;adminReason:string|null;reviewedAt:string|null;createdAt:string;reviewedBy:{name:string|null;email:string}|null}>;
};
type AdminData={requests:TierRequest[];accounts:TierAccount[];total:number;page:number;pageSize:number;totalPages:number};
type Outcome='NEEDS_INFORMATION'|'APPROVED'|'REJECTED';

const emptyData:AdminData={requests:[],accounts:[],total:0,page:1,pageSize:50,totalPages:0};

export default function AdminTierReviews(){
	const [data,setData]=useState<AdminData>(emptyData);
	const [selectedId,setSelectedId]=useState('');
	const [reason,setReason]=useState('');
	const [filter,setFilter]=useState('PENDING_REVIEW');
	const [searchDraft,setSearchDraft]=useState('');
	const [search,setSearch]=useState('');
	const [tierFilter,setTierFilter]=useState('');
	const [statusFilter,setStatusFilter]=useState('');
	const [page,setPage]=useState(1);
	const [notice,setNotice]=useState('');
	const [error,setError]=useState('');
	const [busy,setBusy]=useState(false);
	const [loading,setLoading]=useState(true);
	const selected=data.requests.find(item=>item.id===selectedId);
	const load=useCallback(async()=>{
		setLoading(true);
		try{
			const params=new URLSearchParams({page:String(page)});
			if(search)params.set('search',search);
			if(tierFilter)params.set('tier',tierFilter);
			if(statusFilter)params.set('status',statusFilter);
			const response=await fetch(`/api/admin/tier-requests?${params}`,{cache:'no-store'});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Administrator authorization required.');
			setData(result);
			setError('');
			setSelectedId(current=>result.requests.some((item:TierRequest)=>item.id===current)?current:result.requests.find((item:TierRequest)=>item.status===filter)?.id||result.requests[0]?.id||'');
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to load tier records.')}
		finally{setLoading(false)}
	},[filter,page,search,statusFilter,tierFilter]);
	useEffect(()=>{void load()},[load]);
	const visibleRequests=data.requests.filter(item=>filter==='ALL'||item.status===filter);

	function applySearch(event:FormEvent<HTMLFormElement>){
		event.preventDefault();
		setPage(1);
		setSearch(searchDraft.trim());
	}

	async function review(status:Outcome){
		if(!selected||busy||reason.trim().length<3)return;
		setBusy(true);setNotice('');setError('');
		try{
			const response=await fetch('/api/admin/tier-requests',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({id:selected.id,status,reason:reason.trim()})});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to save tier review.');
			setNotice(status==='APPROVED'?'Tier 3 approved and recorded.':status==='REJECTED'?'Tier request rejected.':'More information requested.');
			setReason('');
			await load();
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to save tier review.')}
		finally{setBusy(false)}
	}

	return <><AdminNav/><main className="account-page admin-tier-page">
		<header className="account-heading"><div><span className="account-kicker">ADMINISTRATION · ACCOUNT ACCESS</span><h1>Tier management</h1><p>Review Tier 3 applications, inspect profile requirements, and search every customer tier.</p></div><div className="flex gap-2"><Link className="button-secondary" href="/admin"><ArrowLeft size={14}/> Admin home</Link><button className="icon-action" type="button" aria-label="Refresh tier records" onClick={()=>void load()} disabled={loading}><RefreshCw size={15}/></button></div></header>
		{notice&&<p className="mb-3 text-sm text-profit" role="status">{notice}</p>}{error&&<p className="mb-3 text-sm text-loss" role="alert">{error}</p>}
		<div className="admin-support-layout">
			<aside className="account-panel card p-4"><div className="account-panel-title"><div><h2>Review queue</h2><p className="account-panel-subtitle">{visibleRequests.length} shown · {data.requests.length} loaded</p></div><ShieldCheck size={18} className="gold"/></div><label className="account-label">Request status<select className="input" value={filter} onChange={event=>setFilter(event.target.value)}><option value="PENDING_REVIEW">Pending review</option><option value="NEEDS_INFORMATION">Needs information</option><option value="APPROVED">Approved</option><option value="REJECTED">Rejected</option><option value="ALL">All requests</option></select></label>{loading?<p className="account-empty">Loading tier records…</p>:visibleRequests.length?<div className="support-ticket-list">{visibleRequests.map(item=><button key={item.id} type="button" className={`support-inbox-item ${selectedId===item.id?'is-selected':''}`} onClick={()=>setSelectedId(item.id)}><b>Tier {item.currentTier} → Tier {item.requestedTier}</b><span>{item.user.name||item.user.email}</span><small>{item.status.replaceAll('_',' ')} · {item.user.accountMode}</small><small>{new Date(item.createdAt).toLocaleString()}</small></button>)}</div>:<p className="account-empty">No tier requests in this state.</p>}</aside>
			<section className="account-panel card p-5">{!selected?<div className="account-empty">Choose a request to review.</div>:<><div className="account-panel-title"><div><span className="status-pill mode-demo">{selected.status.replaceAll('_',' ')}</span><h2 className="mt-3">{selected.user.name||'Account holder'}</h2><p className="account-panel-subtitle">{selected.user.email} · Tier {selected.currentTier} to Tier {selected.requestedTier}</p></div><span className="muted text-xs">{new Date(selected.createdAt).toLocaleString()}</span></div><dl className="support-context"><div><dt>Account</dt><dd>{selected.user.accountMode} · current persisted tier {selected.user.approvedTier}</dd></div><div><dt>Profile requirements</dt><dd>Name {selected.user.name?'complete':'missing'} · country {selected.user.country?'complete':'missing'} · phone {selected.user.phone?'provided':'missing'} ({selected.user.phoneVerified?'verified':'not verified'})</dd></div><div><dt>Identity review</dt><dd>{selected.user.kycStatus} · submitted {selected.user.kyc?.submittedAt?'yes':'no'} · identity documents {selected.user.kycDocuments.length} ({selected.user.kycDocuments.map(document=>document.status).join(', ')||'none'})</dd></div><div><dt>User note</dt><dd>{selected.userMessage||'No note provided.'}</dd></div>{selected.reviewedBy&&<div><dt>Previous review</dt><dd>{selected.reviewedBy.name||selected.reviewedBy.email} · {selected.adminReason||'No reason recorded'}</dd></div>}</dl>{!['APPROVED','REJECTED'].includes(selected.status)&&<div className="support-admin-reply"><label className="account-label">Required review reason<textarea className="input min-h-24" minLength={3} maxLength={1000} value={reason} onChange={event=>setReason(event.target.value)} placeholder="Explain the decision or the information needed."/></label><div className="flex flex-wrap gap-2">{selected.requestedTier===3&&<button type="button" className="btn bg-gold text-black" disabled={busy||reason.trim().length<3} onClick={()=>void review('APPROVED')}>Approve Tier 3</button>}<button type="button" className="btn bg-white/5" disabled={busy||reason.trim().length<3} onClick={()=>void review('NEEDS_INFORMATION')}>Request information</button><button type="button" className="btn bg-white/5" disabled={busy||reason.trim().length<3} onClick={()=>void review('REJECTED')}>Reject request</button></div>{selected.requestedTier!==3&&<p className="text-xs muted">Legacy Tier 2 reviews cannot grant access; Tier 2 is automatic after profile completion.</p>}</div>}<p className="mt-4 text-xs leading-5 muted">Tier 3 requires a complete profile and approved KYC identity evidence. Tier status does not bypass separate account, provider, or financial controls.</p></>}</section>
		</div>

		<section className="account-panel card p-4 sm:p-5 mt-5">
			<div className="account-panel-title"><div><h2>All customer accounts</h2><p className="account-panel-subtitle">{data.total} matching accounts · tier and requirements are recalculated from server records.</p></div><ShieldCheck size={18} className="gold"/></div>
			<form className="mt-4 grid gap-3 sm:grid-cols-[minmax(220px,1fr)_140px_160px_auto]" onSubmit={applySearch}>
				<label className="account-label">Search name, email, or account ID<input className="input" value={searchDraft} maxLength={120} onChange={event=>setSearchDraft(event.target.value)}/></label>
				<label className="account-label">Tier<select className="input" value={tierFilter} onChange={event=>{setTierFilter(event.target.value);setPage(1)}}><option value="">All tiers</option><option value="1">Tier 1</option><option value="2">Tier 2</option><option value="3">Tier 3</option></select></label>
				<label className="account-label">Account status<select className="input" value={statusFilter} onChange={event=>{setStatusFilter(event.target.value);setPage(1)}}><option value="">All statuses</option><option value="ACTIVE">Active</option><option value="FROZEN">Frozen</option><option value="SUSPENDED">Suspended</option><option value="CLOSED">Closed</option><option value="DELETED">Deleted</option></select></label>
				<button className="btn min-h-11 self-end bg-gold px-4 text-black" type="submit"><Search size={15}/> Search</button>
			</form>
			{loading?<p className="account-empty" role="status">Loading accounts…</p>:data.accounts.length?<div className="mt-3 divide-y divide-white/10">{data.accounts.map(account=><details className="py-3" key={account.id}><summary className="grid cursor-pointer list-none gap-2 rounded px-2 py-2 text-sm hover:bg-white/5 sm:grid-cols-[minmax(170px,1.3fr)_90px_100px_100px_130px] sm:items-center"><span className="min-w-0"><b className="block truncate">{account.name||'Account holder'}</b><small className="block truncate muted">{account.email}</small></span><span>Tier {account.currentTier}</span><span>{account.accountMode}</span><span>{account.status}</span><span className="text-xs muted">Joined {new Date(account.createdAt).toLocaleDateString()}</span></summary><div className="mt-2 grid gap-3 rounded border border-white/10 bg-black/10 p-3 lg:grid-cols-2"><p className="text-xs muted">Profile: name {account.requirements.nameComplete?'complete':'missing'} · country {account.requirements.countryComplete?'complete':'missing'} · valid phone {account.requirements.phoneComplete?'complete':'missing'}</p><p className="text-xs muted">Identity: phone {account.requirements.phoneVerified?'verified':'pending'} · {account.kycStatus} · submitted {account.requirements.verificationSubmitted?'yes':'no'} · document uploaded {account.requirements.identityDocumentUploaded?'yes':'no'} · approved {account.requirements.identityDocumentApproved?'yes':'no'}</p>{account.tierRequests.length>0&&<div className="lg:col-span-2"><b className="text-xs">Tier history</b><ul className="mt-1 grid gap-1">{account.tierRequests.map(item=><li className="text-xs muted" key={item.id}>Tier {item.currentTier} → {item.requestedTier} · {item.status.replaceAll('_',' ')} · {item.reviewedBy?.name||item.reviewedBy?.email||'reviewer not assigned'} · {item.adminReason||'No review note'}</li>)}</ul></div>}</div></details>)}</div>:<p className="account-empty">No accounts match these filters.</p>}
			<div className="mt-3 flex items-center justify-between gap-3 text-xs muted"><span>Page {data.page} of {Math.max(1,data.totalPages)}</span><div className="flex gap-2"><button className="button-secondary" type="button" disabled={page<=1||loading} onClick={()=>setPage(value=>Math.max(1,value-1))}>Previous</button><button className="button-secondary" type="button" disabled={page>=data.totalPages||loading} onClick={()=>setPage(value=>value+1)}>Next</button></div></div>
		</section>
	</main></>;
}
