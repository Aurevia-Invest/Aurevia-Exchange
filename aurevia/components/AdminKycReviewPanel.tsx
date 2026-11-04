'use client';

import {useEffect,useState} from 'react';
import {Eye,EyeOff,LoaderCircle,ShieldCheck,Trash2} from 'lucide-react';

type KycProfile={legalName:string|null;dob:string|null;address:string|null;idType:string|null;idNumber:string|null;submittedAt:string|null;reviewedAt:string|null;reviewNote:string|null};
type KycDocument={id:string;kind:string;filename:string;mimeType:string;size:number;status:string;uploadedAt:string;reviewedAt:string|null;reviewNote:string|null};
type ReviewUser={id:string;email:string;name:string|null;country:string|null;phone:string|null;kycStatus:string;accountMode:'DEMO'|'REAL';depositEnabled:boolean;withdrawalEnabled:boolean;accountRestricted:boolean;restrictionReason:string|null;kyc:KycProfile|null;kycDocuments:KycDocument[]};

export default function AdminKycReviewPanel(){
	const [users,setUsers]=useState<ReviewUser[]>([]);
	const [allUsers,setAllUsers]=useState<ReviewUser[]>([]);
	const [notes,setNotes]=useState<Record<string,string>>({});
	const [restrictionNotes,setRestrictionNotes]=useState<Record<string,string>>({});
	const [revealed,setRevealed]=useState<string[]>([]);
	const [documentUrls,setDocumentUrls]=useState<Record<string,string>>({});
	const [loading,setLoading]=useState(true);
	const [busyUser,setBusyUser]=useState('');
	const [busyDocument,setBusyDocument]=useState('');
	const [reviewFilter,setReviewFilter]=useState('PENDING');
	const [message,setMessage]=useState('');
	const [error,setError]=useState('');
	const visibleUsers=users.filter(user=>reviewFilter==='ALL'||user.kycStatus===reviewFilter);

	async function load(){
		setLoading(true);
		try{
			const response=await fetch('/api/admin/users',{cache:'no-store'});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to load verification profiles.');
			const accountUsers=result as ReviewUser[];
			setAllUsers(accountUsers);
			const reviewable=accountUsers.filter(user=>user.kyc||user.kycDocuments.length||user.kycStatus!=='PENDING');
			setUsers(reviewable);
			setNotes(current=>Object.fromEntries(reviewable.map(user=>[user.id,current[user.id]??user.kyc?.reviewNote??''])));
			setError('');
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to load verification profiles.');}
		finally{setLoading(false);}
	}

	useEffect(()=>{void load()},[]);

	async function review(user:ReviewUser,kycStatus:'APPROVED'|'REJECTED'|'NEEDS_CHANGES'){
		setBusyUser(user.id);setMessage('');setError('');
		try{
			const response=await fetch('/api/admin/users',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({userId:user.id,kycStatus,reviewNote:notes[user.id]||''})});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to review this profile.');
			setMessage(`Verification status updated for ${user.email}.`);
			await load();
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to review this profile.');}
		finally{setBusyUser('');}
	}

	async function loadDocumentLink(document:KycDocument){
		setBusyDocument(document.id);setError('');
		try{
			const response=await fetch(`/api/admin/kyc/documents/${encodeURIComponent(document.id)}`,{cache:'no-store'});
			const result=await response.json();if(!response.ok)throw new Error(result.error||'Unable to open this document.');
			setDocumentUrls(current=>({...current,[document.id]:result.url}));
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to open this document.')}
		finally{setBusyDocument('')}
	}

	async function reviewDocument(document:KycDocument,status:'UNDER_REVIEW'|'APPROVED'|'REJECTED'|'RESUBMISSION_REQUIRED',user:ReviewUser){
		setBusyDocument(document.id);setError('');setMessage('');
		try{
			const response=await fetch(`/api/admin/kyc/documents/${encodeURIComponent(document.id)}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({status,reviewNote:notes[user.id]||''})});
			const result=await response.json();if(!response.ok)throw new Error(result.error||'Unable to review this document.');
			setMessage(`${document.filename} marked ${status.toLowerCase().replaceAll('_',' ')}.`);await load();
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to review this document.')}
		finally{setBusyDocument('')}
	}

	async function deleteDocument(document:KycDocument){
		if(busyDocument===document.id||!window.confirm('Permanently delete this KYC submission and its uploaded file?'))return;
		setBusyDocument(document.id);setError('');setMessage('');
		try{
			const response=await fetch(`/api/admin/kyc/documents/${encodeURIComponent(document.id)}`,{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({confirmation:'DELETE'})});
			const result=await response.json();if(!response.ok)throw new Error(result.error||'Unable to delete this KYC submission.');
			setDocumentUrls(current=>{const updated={...current};delete updated[document.id];return updated});
			setMessage('KYC submission deleted.');await load();
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to delete this KYC submission.')}
		finally{setBusyDocument('')}
	}

	async function updateControl(user:ReviewUser,field:'depositEnabled'|'withdrawalEnabled'|'accountRestricted',value:boolean){
		setBusyUser(user.id);setError('');setMessage('');
		try{
			const response=await fetch('/api/admin/users',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({userId:user.id,[field]:value,...(field==='accountRestricted'&&value?{restrictionReason:restrictionNotes[user.id]?.trim()||'Manual administrator restriction'}:{})})});
			const result=await response.json();if(!response.ok)throw new Error(result.error||'Unable to update account controls.');
			setMessage(`Account controls updated for ${user.email}.`);await load();
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to update account controls.')}
		finally{setBusyUser('')}
	}

	async function saveRestrictionReason(user:ReviewUser){
		setBusyUser(user.id);setError('');setMessage('');
		try{
			const response=await fetch('/api/admin/users',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({userId:user.id,restrictionReason:restrictionNotes[user.id]||''})});
			const result=await response.json();if(!response.ok)throw new Error(result.error||'Unable to save restriction reason.');
			setMessage(`Restriction reason saved for ${user.email}.`);await load();
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to save restriction reason.')}
		finally{setBusyUser('')}
	}

	return <section id="kyc-verification" className="card p-4 sm:p-5">
		<header className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="font-bold">KYC / profile review</h2><p className="mt-1 text-sm muted">Manual review only. Approval is not external identity, AML/sanctions, or regulatory verification. Identity files stay private; only administrators can access short-lived review links.</p></div><div className="flex flex-wrap items-end gap-2"><label className="account-label text-xs">Review queue<select className="input min-h-11" value={reviewFilter} onChange={event=>setReviewFilter(event.target.value)}><option value="PENDING">Pending verification</option><option value="NEEDS_CHANGES">Needs information</option><option value="REJECTED">Rejected applications</option><option value="APPROVED">Approved history</option><option value="ALL">All review history</option></select></label><a className="btn min-h-11 bg-white/5" href="/admin/verified-accounts">Verified accounts</a><button className="btn min-h-11 bg-white/5" type="button" onClick={()=>void load()} disabled={loading}>{loading?<LoaderCircle size={16} className="animate-spin"/>:'Refresh'}</button></div></header>
		{message&&<p className="mt-3 text-sm text-profit" role="status">{message}</p>}{error&&<p className="mt-3 text-sm text-loss" role="alert">{error}</p>}
		{loading&&!visibleUsers.length?<p className="mt-4 muted">Loading verification profiles…</p>:visibleUsers.length?<div className="mt-3 divide-y divide-white/10">{visibleUsers.map(user=>{
			const profile=user.kyc;
			const isRevealed=revealed.includes(user.id);
			return <article className="py-4" key={user.id}>
				<div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="font-semibold">{profile?.legalName||user.name||user.email}</h3><p className="muted text-xs">{user.email} · {user.kycStatus.replaceAll('_',' ')}</p></div><span className="status-pill">{profile?.submittedAt?`Submitted ${new Date(profile.submittedAt).toLocaleDateString()}`:'No profile submitted'}</span></div>
				{profile&&<dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2"><div><dt className="muted text-xs">Date of birth</dt><dd>{profile.dob?profile.dob.slice(0,10):'Not provided'}</dd></div><div><dt className="muted text-xs">Identity document</dt><dd>{profile.idType||'Not provided'} · {profile.idNumber?(isRevealed?profile.idNumber:`••••${profile.idNumber.slice(-4)}`):'Not provided'}{profile.idNumber&&<button type="button" className="ml-2 min-h-11 px-2 gold" aria-label={isRevealed?'Hide document number':'Reveal document number'} onClick={()=>setRevealed(current=>isRevealed?current.filter(id=>id!==user.id):[...current,user.id])}>{isRevealed?<EyeOff size={15}/>:<Eye size={15}/>}</button>}</dd></div><div className="sm:col-span-2"><dt className="muted text-xs">Submitted address</dt><dd className="break-words">{profile.address||'Not provided'}</dd></div><div><dt className="muted text-xs">Country / phone</dt><dd>{[user.country,user.phone].filter(Boolean).join(' · ')||'Not provided'}</dd></div><div><dt className="muted text-xs">Last review</dt><dd>{profile.reviewedAt?new Date(profile.reviewedAt).toLocaleString():'Not reviewed'}</dd></div></dl>}
				{user.kycDocuments.length>0&&<div className="mt-4 border-t border-white/10 pt-3"><h4 className="text-sm font-semibold">Identity files</h4><ul className="mt-2 divide-y divide-white/10">{user.kycDocuments.map(document=><li className="py-3" key={document.id}><div className="flex flex-wrap items-center justify-between gap-2"><div><p className="break-all text-sm">{document.filename}</p><p className="mt-1 text-xs muted">{document.kind.replaceAll('_',' ')} · {document.mimeType} · {(document.size/1024).toFixed(0)} KB · {document.status.replaceAll('_',' ')}</p></div>{documentUrls[document.id]?<a className="text-link" href={documentUrls[document.id]} target="_blank" rel="noreferrer">Open private file</a>:<button className="btn min-h-10 bg-white/5" type="button" disabled={busyDocument===document.id} onClick={()=>void loadDocumentLink(document)}>{busyDocument===document.id?'Loading…':'Generate review link'}</button>}</div><div className="mt-2 flex flex-wrap gap-2">{(['UNDER_REVIEW','APPROVED','REJECTED','RESUBMISSION_REQUIRED'] as const).filter(status=>status!==document.status).map(status=><button key={status} className="text-link min-h-10" type="button" disabled={busyDocument===document.id} onClick={()=>void reviewDocument(document,status,user)}>{status==='RESUBMISSION_REQUIRED'?'Request replacement':status.replaceAll('_',' ')}</button>)}<button className="text-link min-h-10 text-loss" type="button" disabled={busyDocument===document.id} onClick={()=>void deleteDocument(document)}><Trash2 size={14}/>Delete submission</button></div>{document.reviewNote&&<p className="mt-1 text-xs muted">Review note: {document.reviewNote}</p>}</li>)}</ul></div>}
				<label className="mt-3 block text-xs muted">Review note for the user<textarea className="input mt-1 min-h-20 resize-y" maxLength={500} value={notes[user.id]||''} onChange={event=>setNotes(current=>({...current,[user.id]:event.target.value}))}/></label>
				<div className="mt-3 flex flex-wrap gap-2"><button className="btn min-h-11 bg-profit px-4 text-black disabled:opacity-50" type="button" disabled={!profile||!user.kycDocuments.some(document=>document.kind==='IDENTITY_DOCUMENT'&&document.status==='APPROVED')||!user.kycDocuments.some(document=>document.kind==='SELFIE'&&document.status==='APPROVED')||busyUser===user.id||user.kycStatus==='APPROVED'} onClick={()=>void review(user,'APPROVED')}><ShieldCheck size={15}/>Approve</button><button className="btn min-h-11 bg-loss px-4 disabled:opacity-50" type="button" disabled={!profile||busyUser===user.id||user.kycStatus==='REJECTED'} onClick={()=>void review(user,'REJECTED')}>Reject</button><button className="btn min-h-11 bg-white/10 px-4 disabled:opacity-50" type="button" disabled={!profile||busyUser===user.id||user.kycStatus==='NEEDS_CHANGES'} onClick={()=>void review(user,'NEEDS_CHANGES')}>Request information</button></div>
				<div className="mt-3 grid gap-2 border-t border-white/10 pt-3 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto] sm:items-end"><label className="account-label text-xs">Restriction reason<input className="input mt-1 min-h-10" maxLength={500} value={restrictionNotes[user.id]??user.restrictionReason??''} onChange={event=>setRestrictionNotes(current=>({...current,[user.id]:event.target.value}))}/></label><button className="btn min-h-10 bg-white/5" type="button" disabled={busyUser===user.id} onClick={()=>void saveRestrictionReason(user)}>Save reason</button><button className="btn min-h-10 bg-white/5" type="button" disabled={busyUser===user.id} onClick={()=>void updateControl(user,'withdrawalEnabled',!user.withdrawalEnabled)}>{user.withdrawalEnabled?'Disable withdrawals':'Enable withdrawals'}</button><button className="btn min-h-10 bg-white/5" type="button" disabled={busyUser===user.id} onClick={()=>void updateControl(user,'accountRestricted',!user.accountRestricted)}>{user.accountRestricted?'Remove restriction':'Restrict account'}</button>{(user.accountRestricted||!user.withdrawalEnabled)&&<p className="text-xs text-loss sm:col-span-4">{user.accountRestricted?'Restricted':''}{user.accountRestricted&&!user.withdrawalEnabled?' · ':''}{!user.withdrawalEnabled?'Withdrawals disabled':''}{user.restrictionReason?` · ${user.restrictionReason}`:''}</p>}</div>
			</article>;
		})}</div>:<p className="mt-4 muted">{reviewFilter==='PENDING'?'No profiles are awaiting review.':'No profiles in this review state.'}</p>}
		<div className="mt-6 border-t border-white/10 pt-4"><h3 className="font-semibold">User deposit and withdrawal access</h3><p className="mt-1 text-xs muted">These controls apply to both account modes. Withdrawals are reviewed by an administrator and update the internal ledger only; no payout provider is connected.</p>{allUsers.length?<div className="mt-2 divide-y divide-white/10">{allUsers.map(user=><article key={user.id} className="flex flex-wrap items-center justify-between gap-3 py-3"><div className="min-w-0"><b className="break-all text-sm">{user.name||user.email}</b><p className="text-xs muted">{user.email} · {user.accountMode} · Deposits {user.depositEnabled?'enabled':'disabled'} · Withdrawals {user.withdrawalEnabled?'enabled':'disabled'}</p></div><div className="flex flex-wrap gap-2"><button className="btn min-h-10 bg-white/5" type="button" aria-label={`${user.depositEnabled?'Disable':'Enable'} deposits for ${user.email}`} disabled={busyUser===user.id} onClick={()=>void updateControl(user,'depositEnabled',!user.depositEnabled)}>{user.depositEnabled?'Disable deposits':'Enable deposits'}</button><button className="btn min-h-10 bg-white/5" type="button" aria-label={`${user.withdrawalEnabled?'Disable':'Enable'} withdrawals for ${user.email}`} disabled={busyUser===user.id} onClick={()=>void updateControl(user,'withdrawalEnabled',!user.withdrawalEnabled)}>{user.withdrawalEnabled?'Disable withdrawals':'Enable withdrawals'}</button></div></article>)}</div>:<p className="mt-3 muted">No user accounts found.</p>}</div>
	</section>;
}