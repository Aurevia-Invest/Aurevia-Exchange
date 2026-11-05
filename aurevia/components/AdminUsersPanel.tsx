'use client';

import Image from 'next/image';
import {FormEvent,useCallback,useEffect,useState} from 'react';
import {Eye, Pencil,RefreshCw,Search,Trash2,UserRound} from 'lucide-react';
import {SUPPORTED_CURRENCIES} from '@/lib/config/simulation';
import ReceiptGenerator,{type ReceiptData} from '@/components/ReceiptGenerator';
import AureviaExchangeId from '@/components/AureviaExchangeId';
import AccountTierBadge from '@/components/AccountTierBadge';

type AdminUser={id:string;aureviaExchangeId:string|null;email:string;name:string|null;phone:string|null;country:string|null;role:'USER'|'ADMIN';status:string;accountMode:'DEMO'|'REAL';accountTier:string;kycStatus:string;createdAt:string;depositEnabled:boolean;withdrawalEnabled:boolean;accountRestricted:boolean;restrictionReason:string|null};
type AdminLoginEvent={id:string;action:string;createdAt:string;metadata:{clientIp?:string|null;userAgent?:string|null;reason?:string|null}|null};
type DeletionAssessment={user:{id:string;email:string;status:string;role:string};balances:Array<{accountMode:'DEMO'|'REAL';currency:string;amount:string}>;blockers:Array<{code:string;count:number}>;deletable:boolean;retainedRecords:{kycDocuments:number;taxDocuments:number;financialHistory:boolean;auditHistory:boolean;supportRecords:boolean}};
type DeletionAudit={id:string;entityId:string|null;createdAt:string;metadata:{reason?:string}|null;actor:{id:string;email:string;name:string|null}|null};
function AdminUserPhoto({userId,name}:{userId:string;name:string|null}){
	const [url,setUrl]=useState('');
	const [loaded,setLoaded]=useState(false);
	useEffect(()=>{
		let active=true;
		void fetch(`/api/profile/avatar?userId=${encodeURIComponent(userId)}`,{cache:'no-store'}).then(async response=>{
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to load profile photo.');
			if(active)setUrl(typeof result.url==='string'?result.url:'');
		}).catch(()=>{if(active)setUrl('')}).finally(()=>{if(active)setLoaded(true)});
		return()=>{active=false};
	},[userId]);
	return <div className="mb-3 flex items-center gap-3" aria-label={`${name||'User'} profile photo`}>
		<span className="grid size-14 aspect-square shrink-0 place-items-center overflow-hidden rounded-full border border-white/10 bg-white/5">{url?<Image src={url} alt="" width={56} height={56} unoptimized className="profile-avatar-image"/>:<UserRound size={23} className="muted" aria-hidden="true"/>}</span>
		<span className="text-xs muted">{loaded?(url?'Profile photo':'No profile photo available'):'Loading profile photo…'}</span>
	</div>;
}

type Adjustment={accountMode:'DEMO'|'REAL';currency:(typeof SUPPORTED_CURRENCIES)[number];amount:string;direction:'CREDIT'|'DEBIT';category:'ADMIN_ALLOCATION'|'CORRECTION'|'PROMOTIONAL'|'REVERSAL';reason:string;idempotencyKey:string};
const emptyAdjustment=(accountMode:'DEMO'|'REAL'):Adjustment=>({accountMode,currency:'USD',amount:'',direction:'CREDIT',category:'ADMIN_ALLOCATION',reason:'',idempotencyKey:''});
function AdminLoginHistory({userId}:{userId:string}){
	const [events,setEvents]=useState<AdminLoginEvent[]|null>(null);
	const [loading,setLoading]=useState(false);
	const [error,setError]=useState('');
	async function load(){
		setLoading(true);setError('');
		try{
			const response=await fetch(`/api/admin/audit?loginUserId=${encodeURIComponent(userId)}`,{cache:'no-store'});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to load login history.');
			setEvents(result as AdminLoginEvent[]);
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to load login history.')}
		finally{setLoading(false)}
	}
	return <section className="mt-4 border-t border-white/10 pt-4">
		<div className="account-panel-title"><div><h3>Login history</h3><p className="account-panel-subtitle">Login and logout records with device and network details.</p></div><button className="btn min-h-10 bg-white/5" type="button" onClick={()=>void load()} disabled={loading}>{loading?'Loading…':events?'Refresh history':'View history'}</button></div>
		<p className="mt-2 text-xs muted">IP addresses are approximate. No verified location provider is configured; an IP does not establish a person’s location.</p>
		{error&&<p className="mt-2 text-sm text-loss" role="alert">{error}</p>}
		{events&&<div className="mt-3 grid gap-2">{events.length?events.map(event=><article className="rounded border border-white/10 p-3" key={event.id}>
			<div className="flex flex-wrap items-center justify-between gap-2"><b>{event.action==='LOGIN_SUCCESS'?'Successful sign-in':event.action==='LOGIN_FAILED'?'Failed sign-in':event.action==='LOGOUT_SUCCESS'?'Signed out':event.action}</b><time className="text-xs muted" dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time></div>
			<dl className="mt-2 grid gap-2 text-xs sm:grid-cols-2"><div><dt className="muted">IP address</dt><dd className="break-all">{event.metadata?.clientIp||'Unavailable'}</dd></div><div><dt className="muted">Approximate location</dt><dd>Unavailable</dd></div><div className="sm:col-span-2"><dt className="muted">Device / browser</dt><dd className="break-words">{event.metadata?.userAgent||'Unavailable'}</dd></div>{event.metadata?.reason&&<div><dt className="muted">Result detail</dt><dd>{event.metadata.reason}</dd></div>}</dl>
		</article>):<p className="text-sm muted">No login records are available for this account.</p>}</div>}
	</section>;
}

export default function AdminUsersPanel(){
	const [users,setUsers]=useState<AdminUser[]>([]);
	const [search,setSearch]=useState('');
	const [showDeleted,setShowDeleted]=useState(false);
	const [accountMode,setAccountMode]=useState<'ALL'|'DEMO'|'REAL'>('ALL');
	const [statusFilter,setStatusFilter]=useState<'ALL'|'ACTIVE'|'INACTIVE'>('ALL');
	const [deletingUser,setDeletingUser]=useState<AdminUser|null>(null);
	const [deletionAssessment,setDeletionAssessment]=useState<DeletionAssessment|null>(null);
	const [deletionAssessmentLoading,setDeletionAssessmentLoading]=useState(false);
	const [deletionEmail,setDeletionEmail]=useState('');
	const [deletionPhrase,setDeletionPhrase]=useState('');
	const [deletionReason,setDeletionReason]=useState('');
	const [adminPassword,setAdminPassword]=useState('');
	const [deletionIdempotencyKey,setDeletionIdempotencyKey]=useState('');
	const [deletionHistory,setDeletionHistory]=useState<DeletionAudit[]>([]);
	const [editingUserId,setEditingUserId]=useState('');
	const [editDraft,setEditDraft]=useState({name:'',country:'',phone:''});
	const [loading,setLoading]=useState(true);
	const [busy,setBusy]=useState(false);
	const [busyUserId,setBusyUserId]=useState('');
	const [error,setError]=useState('');
	const [notice,setNotice]=useState('');
	const [expandedUserId,setExpandedUserId]=useState('');
	const [restrictionReasons,setRestrictionReasons]=useState<Record<string,string>>({});
	const [adjustments,setAdjustments]=useState<Record<string,Adjustment>>({});
	const [adjustmentReceipt,setAdjustmentReceipt]=useState<{userId:string;receipt:ReceiptData}|null>(null);

	const load=useCallback(async(query:string,includeDeleted:boolean,signal?:AbortSignal,mode:'ALL'|'DEMO'|'REAL'='ALL',status:'ALL'|'ACTIVE'|'INACTIVE'='ALL')=>{
		try{
			const params=new URLSearchParams();
			if(query)params.set('search',query);
			if(includeDeleted)params.set('showDeleted','true');
			if(mode!=='ALL')params.set('mode',mode);
			if(status!=='ALL')params.set('status',status);
			const queryString=params.toString();
			const response=await fetch(`/api/admin/users${queryString?`?${queryString}`:''}`,{cache:'no-store',signal});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to load user accounts.');
			setUsers(result);setError('');
		}catch(exception){if(!(exception instanceof DOMException&&exception.name==='AbortError'))setError(exception instanceof Error?exception.message:'Unable to load user accounts.')}
		finally{setLoading(false)}
	},[]);

	useEffect(()=>{
		const params=new URLSearchParams(window.location.search);
		const mode=params.get('mode');
		if(mode==='DEMO'||mode==='REAL')setAccountMode(mode);
		setSearch(params.get('search')||'');
	},[]);

	function mergeUser(updated:Partial<AdminUser>&Pick<AdminUser,'id'>){
		setUsers(current=>current.map(user=>user.id===updated.id?{...user,...updated}:user));
	}

	useEffect(()=>{
		const controller=new AbortController();
		const timer=window.setTimeout(()=>void load(search.trim(),showDeleted,controller.signal,accountMode,statusFilter),200);
		return()=>{window.clearTimeout(timer);controller.abort()};
	},[load,search,showDeleted,accountMode,statusFilter]);

	const loadDeletionHistory=useCallback(async()=>{
		try{
			const response=await fetch('/api/admin/users/delete?history=true',{cache:'no-store'});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to load deletion history.');
			setDeletionHistory(result as DeletionAudit[]);
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to load deletion history.')}
	},[]);

	useEffect(()=>{void loadDeletionHistory()},[loadDeletionHistory]);

	async function startPermanentDeletion(user:AdminUser){
		setDeletingUser(user);setDeletionAssessment(null);setDeletionEmail('');setDeletionPhrase('');setDeletionReason('');setAdminPassword('');setDeletionIdempotencyKey(crypto.randomUUID());setDeletionAssessmentLoading(true);setError('');
		try{
			const response=await fetch(`/api/admin/users/delete?userId=${encodeURIComponent(user.id)}`,{cache:'no-store'});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to inspect this account.');
			setDeletionAssessment(result as DeletionAssessment);
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to inspect this account.')}
		finally{setDeletionAssessmentLoading(false)}
	}

	async function deleteAccount(event:FormEvent<HTMLFormElement>){
		event.preventDefault();
		if(!deletingUser||!deletionAssessment?.deletable||busy)return;
		setBusy(true);setError('');setNotice('');
		try{
			const response=await fetch('/api/admin/users/delete',{method:'POST',headers:{'content-type':'application/json','Idempotency-Key':deletionIdempotencyKey},body:JSON.stringify({userId:deletingUser.id,confirmationEmail:deletionEmail,confirmationPhrase:deletionPhrase,adminPassword,reason:deletionReason})});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Account deletion could not be completed.');
			setNotice(`Account ${deletingUser.email} permanently deactivated. Financial, audit, support, KYC, and tax records were retained. ${result.storageCleanup.pending?'Profile image cleanup is pending.':'Eligible profile image cleanup completed.'}`);
			setDeletingUser(null);setDeletionAssessment(null);setAdminPassword('');setDeletionIdempotencyKey('');await Promise.all([load(search.trim(),showDeleted,undefined,accountMode,statusFilter),loadDeletionHistory()]);
		}catch(exception){setError(exception instanceof Error?exception.message:'Account deletion could not be completed.')}
		finally{setBusy(false)}
	}

	async function saveUserProfile(event:FormEvent<HTMLFormElement>,user:AdminUser){
		event.preventDefault();if(busy)return;
		setBusy(true);setBusyUserId(user.id);setError('');setNotice('');
		try{
			const response=await fetch('/api/admin/users',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({userId:user.id,...editDraft})});
			const result=await response.json();if(!response.ok)throw new Error(result.error||'Unable to edit user profile.');
			mergeUser(result);setEditingUserId('');setNotice(`Profile updated for ${user.email}.`);
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to edit user profile.')}
		finally{setBusy(false);setBusyUserId('')}
	}

	async function updateDeletedStatus(user:AdminUser,status:'ACTIVE'|'DELETED'){
		if(busy)return;
		setBusy(true);setBusyUserId(user.id);setError('');setNotice('');
		try{
			const response=await fetch('/api/admin/users',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({userId:user.id,status})});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to update account status.');
			setNotice(status==='DELETED'?`Account ${user.email} moved to Deleted Items.`:`Account ${user.email} restored.`);
			await load(search.trim(),showDeleted,undefined,accountMode,statusFilter);
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to update account status.')}
		finally{setBusy(false);setBusyUserId('')}
	}

	async function toggleStatus(user:AdminUser){
		if(busy)return;
		setBusy(true);setBusyUserId(user.id);setError('');setNotice('');
		try{
			const status=user.status==='ACTIVE'?'FROZEN':'ACTIVE';
			const response=await fetch('/api/admin/users',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({userId:user.id,status})});
			const result=await response.json();if(!response.ok)throw new Error(result.error||'Unable to update account status.');
			mergeUser(result);setNotice(`Account status updated to ${status.toLowerCase()}.`);
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to update account status.')}
		finally{setBusy(false);setBusyUserId('')}
	}

	async function updateAccountControl(user:AdminUser,field:'depositEnabled'|'withdrawalEnabled'|'accountRestricted',value:boolean){
		if(busy)return;
		const restrictionReason=restrictionReasons[user.id]?.trim()||'';
		if(field==='accountRestricted'&&value&&restrictionReason.length<3){setError('Enter a restriction reason of at least three characters before restricting the account.');return;}
		setBusy(true);setBusyUserId(user.id);setError('');setNotice('');
		try{
			const response=await fetch('/api/admin/users',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({userId:user.id,[field]:value,...(field==='accountRestricted'&&value?{restrictionReason}: {})})});
			const result=await response.json();if(!response.ok)throw new Error(result.error||'Unable to update account controls.');
			mergeUser(result);
			if(field==='accountRestricted'&&!value)setRestrictionReasons(current=>({...current,[user.id]:''}));
			setNotice(`Account controls updated for ${user.email}.`);
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to update account controls.')}
		finally{setBusy(false);setBusyUserId('')}
	}

	async function adjustBalance(event:FormEvent<HTMLFormElement>,user:AdminUser){
		event.preventDefault();
		if(busy)return;
		const adjustment=adjustments[user.id]||emptyAdjustment(user.accountMode);
		const amount=Number(adjustment.amount);
		if(!Number.isFinite(amount)||amount<=0||adjustment.reason.trim().length<3){setError('Enter a positive amount and a reason of at least three characters.');return;}
		const idempotencyKey=adjustment.idempotencyKey||crypto.randomUUID();
		const submitted={...adjustment,idempotencyKey};
		setAdjustments(current=>({...current,[user.id]:submitted}));
		setAdjustmentReceipt(null);
		setBusy(true);setBusyUserId(user.id);setError('');setNotice('');
		try{
			const response=await fetch('/api/admin/balances',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({userId:user.id,accountMode:adjustment.accountMode,currency:adjustment.currency,amount:adjustment.amount,direction:adjustment.direction,category:adjustment.category,reason:adjustment.reason.trim(),idempotencyKey})});
			const result=await response.json();if(!response.ok)throw new Error(result.error||'Unable to record the ledger adjustment.');
			setNotice(`${result.replayed?'Previously recorded':'Recorded'} ${adjustment.direction.toLowerCase()} of ${Number(adjustment.amount).toFixed(2)} ${adjustment.currency} in ${adjustment.accountMode} for ${user.email}. Reference: ${result.reference}`);
			setAdjustmentReceipt({userId:user.id,receipt:{
				id:result.transactionId,
				reference:result.reference,
				status:'COMPLETED',
				type:adjustment.direction,
				accountMode:adjustment.accountMode,
				simulated:true,
				createdAt:result.createdAt,
				name:user.name||user.email,
				email:user.email,
				amount:adjustment.amount,
				currency:adjustment.currency,
				method:'Administrator direct internal-ledger adjustment',
				aureviaExchangeId:user.aureviaExchangeId,
				purpose:`${adjustment.category.replaceAll('_',' ')} · ${adjustment.reason.trim()}`,
			}});
			setAdjustments(current=>({...current,[user.id]:emptyAdjustment(adjustment.accountMode)}));
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to record the ledger adjustment. Retry without changing the request.')}
		finally{setBusy(false);setBusyUserId('')}
	}

	function updateAdjustment(userId:string,defaultMode:'DEMO'|'REAL',field:keyof Adjustment,value:string){
		setAdjustments(current=>{
			const existing=current[userId]||emptyAdjustment(defaultMode);
			return {...current,[userId]:{...existing,[field]:value,idempotencyKey:''}};
		});
	}

	return <div className="account-page admin-users-page">
		<header className="account-heading"><div><span className="account-kicker">WORKSPACE · ACCOUNTS</span><h1>User accounts</h1><p>Manage customer access and review deleted accounts. Admin identities are managed separately.</p></div><button className="icon-action" type="button" aria-label="Refresh user accounts" onClick={()=>void load(search.trim(),showDeleted,undefined,accountMode,statusFilter)}><RefreshCw size={15}/></button></header>
		{error&&<div className="account-callout mb-3" role="alert">{error}</div>}{notice&&<p className="mb-3 text-sm text-profit" role="status">{notice}</p>}
		<div className="mb-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_220px_220px]">
			<label className="account-label">Search users by Aurevia ID, internal ID, name, or email<div className="relative mt-1"><Search size={15} className="absolute left-3 top-3.5 muted"/><input className="input pl-9" value={search} onChange={event=>setSearch(event.target.value)} maxLength={120} autoComplete="off" placeholder="Search accounts"/></div></label>
			<label className="account-label">Account mode<select className="input mt-1" value={accountMode} onChange={event=>{const mode=event.target.value;if(mode==='ALL'||mode==='DEMO'||mode==='REAL')setAccountMode(mode)}}><option value="ALL">All account modes</option><option value="DEMO">DEMO accounts</option><option value="REAL">REAL accounts</option></select></label>
			<label className="account-label">Account status<select className="input mt-1" value={statusFilter} onChange={event=>{const status=event.target.value;if(status==='ALL'||status==='ACTIVE'||status==='INACTIVE')setStatusFilter(status)}}><option value="ALL">Active and inactive</option><option value="ACTIVE">Active accounts</option><option value="INACTIVE">Inactive / suspended</option></select></label>
		</div>
		<label className="mb-4 inline-flex min-h-11 cursor-pointer items-center gap-2 text-sm"><input type="checkbox" checked={showDeleted} onChange={event=>setShowDeleted(event.target.checked)}/>Show deleted accounts</label>
		<div className="overflow-hidden rounded-md border border-white/10">
			{loading?<p className="account-empty" role="status">Loading accounts…</p>:users.length?<div className="divide-y divide-white/10">{users.map(user=><article className="p-4" key={user.id}>
				<div className="flex flex-wrap items-center justify-between gap-3"><div className="min-w-0"><b className="block break-words">{user.name||'Unnamed account'} · {user.email}</b><small className="muted break-all">Internal ID: {user.id} · {user.role} · {user.accountMode} · {user.kycStatus} · {user.status}</small><div className="mt-1 flex flex-wrap items-center gap-2"><small className="break-all font-mono text-gold">Aurevia Exchange ID: {user.aureviaExchangeId||'Not assigned'}</small><AccountTierBadge tier={user.accountTier}/></div></div><div className="flex flex-wrap gap-2">
					<button type="button" className="btn min-h-10 bg-white/5" disabled={busy} onClick={()=>setExpandedUserId(expandedUserId===user.id?'':user.id)}><Eye size={14}/>View User</button>
					{user.status!=='DELETED'&&<button type="button" className="btn min-h-10 bg-white/5" disabled={busy||user.status==='CLOSED'} onClick={()=>{setExpandedUserId(user.id);setEditingUserId(editingUserId===user.id?'':user.id);setEditDraft({name:user.name||'',country:user.country||'',phone:user.phone||''})}}><Pencil size={14}/>Edit User</button>}
					{user.status==='DELETED'?<button type="button" className="btn min-h-10 bg-profit text-black" disabled={busy} onClick={()=>void updateDeletedStatus(user,'ACTIVE')}>{busyUserId===user.id?'Saving…':'Restore'}</button>:<><button type="button" className="btn min-h-10 bg-white/5" disabled={busy||user.status==='CLOSED'} onClick={()=>void toggleStatus(user)}>{busyUserId===user.id?'Saving…':user.status==='ACTIVE'?'Suspend Account':'Reactivate Account'}</button><button type="button" className="btn min-h-10 bg-loss text-black" disabled={busy||user.status==='CLOSED'} onClick={()=>void updateDeletedStatus(user,'DELETED')}><Trash2 size={14}/>Move to Deleted Items</button></>}
					{user.status!=='CLOSED'&&<button type="button" className="btn min-h-10 border border-loss/40 bg-loss/10 text-loss" disabled={busy} onClick={()=>void startPermanentDeletion(user)}><Trash2 size={14}/>Delete Account Permanently</button>}
				</div></div>
				{user.status==='DELETED'&&<p className="mt-3 text-sm muted">This account cannot sign in. Restore it to re-enable account access.</p>}
				<details className="mt-2" open={expandedUserId===user.id} onToggle={event=>{if(event.currentTarget.open)setExpandedUserId(user.id);else if(expandedUserId===user.id)setExpandedUserId('')}}><summary className="min-h-11 cursor-pointer py-2 text-sm gold">Account controls, verification, and ledger</summary>{expandedUserId===user.id&&<div>
					<AureviaExchangeId id={user.aureviaExchangeId} className="mt-3"/>
					{editingUserId===user.id&&<form className="mt-3 grid gap-3 rounded border border-gold/20 p-3 sm:grid-cols-3" onSubmit={event=>void saveUserProfile(event,user)}>
						<label className="account-label">Name<input className="input mt-1" maxLength={120} value={editDraft.name} onChange={event=>setEditDraft(current=>({...current,name:event.target.value}))}/></label>
						<label className="account-label">Country<input className="input mt-1" maxLength={100} value={editDraft.country} onChange={event=>setEditDraft(current=>({...current,country:event.target.value}))}/></label>
						<label className="account-label">Phone<input className="input mt-1" maxLength={40} value={editDraft.phone} onChange={event=>setEditDraft(current=>({...current,phone:event.target.value}))}/></label>
						<div className="flex gap-2 sm:col-span-3"><button className="btn bg-gold text-black" type="submit" disabled={busy}>{busyUserId===user.id?'Saving…':'Save profile'}</button><button className="btn bg-white/5" type="button" disabled={busy} onClick={()=>setEditingUserId('')}>Cancel</button></div>
					</form>}
					<dl className="mt-2 grid gap-2 text-xs sm:grid-cols-2"><div><dt className="muted">Country</dt><dd>{user.country||'Not set'}</dd></div><div><dt className="muted">Phone</dt><dd>{user.phone||'Not set'}</dd></div><div><dt className="muted">Created</dt><dd>{new Date(user.createdAt).toLocaleString()}</dd></div><div><dt className="muted">Deposit / withdrawal</dt><dd>{user.depositEnabled?'Enabled':'Disabled'} / {user.withdrawalEnabled?'Enabled':'Disabled'}</dd></div><div><dt className="muted">Account restriction</dt><dd>{user.accountRestricted?user.restrictionReason||'Restricted':'None'}</dd></div></dl>
					<AdminUserPhoto userId={user.id} name={user.name}/>
					<AdminLoginHistory userId={user.id}/>
					<div className="mt-4 flex flex-wrap gap-2">
						<button className="btn min-h-10 bg-white/5" type="button" disabled={busy||user.status==='CLOSED'} onClick={()=>void updateAccountControl(user,'depositEnabled',!user.depositEnabled)}>{user.depositEnabled?'Disable deposits':'Enable deposits'}</button>
						<button className="btn min-h-10 bg-white/5" type="button" disabled={busy||user.status==='CLOSED'} onClick={()=>void updateAccountControl(user,'withdrawalEnabled',!user.withdrawalEnabled)}>{user.withdrawalEnabled?'Disable withdrawals':'Enable withdrawals'}</button>
						<a className="btn min-h-10 bg-white/5" href="/admin/kyc">Open verification review</a>
						<a className="btn min-h-10 bg-white/5" href="/admin/tiers">Open tier reviews</a>
					</div>
					<div className="mt-4 grid gap-3 border-t border-white/10 pt-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
						<label className="account-label">Restriction reason<input className="input mt-1" maxLength={500} value={restrictionReasons[user.id]??user.restrictionReason??''} onChange={event=>setRestrictionReasons(current=>({...current,[user.id]:event.target.value}))}/></label>
						<button className="btn min-h-11 bg-loss text-black" type="button" disabled={busy||user.status==='CLOSED'} onClick={()=>void updateAccountControl(user,'accountRestricted',!user.accountRestricted)}>{user.accountRestricted?'Remove account restriction':'Restrict account'}</button>
					</div>
					<form className="mt-4 grid gap-3 border-t border-white/10 pt-4 sm:grid-cols-2 lg:grid-cols-4" onSubmit={event=>void adjustBalance(event,user)}>
						<p className="text-sm font-semibold sm:col-span-2 lg:col-span-4">Fund User Account · mode-specific ledger</p>
						<label className="account-label">Account<select className="input mt-1" value={(adjustments[user.id]||emptyAdjustment(user.accountMode)).accountMode} onChange={event=>updateAdjustment(user.id,user.accountMode,'accountMode',event.target.value)}><option value="DEMO">DEMO</option><option value="REAL">REAL · internal ledger</option></select></label>
						<label className="account-label">Direction<select className="input mt-1" value={(adjustments[user.id]||emptyAdjustment(user.accountMode)).direction} onChange={event=>updateAdjustment(user.id,user.accountMode,'direction',event.target.value)}><option value="CREDIT">Credit</option><option value="DEBIT">Debit</option></select></label>
						<label className="account-label">Category<select className="input mt-1" value={(adjustments[user.id]||emptyAdjustment(user.accountMode)).category} onChange={event=>updateAdjustment(user.id,user.accountMode,'category',event.target.value)}><option value="ADMIN_ALLOCATION">Admin allocation</option><option value="CORRECTION">Correction</option><option value="PROMOTIONAL">Promotional</option><option value="REVERSAL">Reversal</option></select></label>
						<label className="account-label">Currency<select className="input mt-1" value={(adjustments[user.id]||emptyAdjustment(user.accountMode)).currency} onChange={event=>updateAdjustment(user.id,user.accountMode,'currency',event.target.value)}>{SUPPORTED_CURRENCIES.map(currency=><option key={currency}>{currency}</option>)}</select></label>
						<label className="account-label">Amount<input className="input mt-1" type="number" min="0.01" step="0.01" required value={(adjustments[user.id]||emptyAdjustment(user.accountMode)).amount} onChange={event=>updateAdjustment(user.id,user.accountMode,'amount',event.target.value)}/></label>
						<label className="account-label sm:col-span-2">Reason<input className="input mt-1" minLength={3} maxLength={300} required value={(adjustments[user.id]||emptyAdjustment(user.accountMode)).reason} onChange={event=>updateAdjustment(user.id,user.accountMode,'reason',event.target.value)}/></label>
						<button className="btn min-h-11 bg-gold text-black" type="submit" disabled={busy||user.role!=='USER'||user.status!=='ACTIVE'} title={user.role!=='USER'||user.status!=='ACTIVE'?'Only active customer accounts can receive ledger adjustments.':'Record an audited ledger adjustment.'}>{busyUserId===user.id?'Recording…':'Record ledger adjustment'}</button>
						<p className="sm:col-span-2 lg:col-span-4 text-xs muted">Balance changes are ledger entries, audited with a reason and request key. REAL-mode entries do not move external funds.</p>
					</form>
					{adjustmentReceipt?.userId===user.id&&<section className="mt-4 border-t border-white/10 pt-4"><div className="account-panel-title"><div><h3>Direct funding receipt</h3><p className="account-panel-subtitle">Printable record of the mode-specific ledger entry.</p></div></div><ReceiptGenerator receipt={adjustmentReceipt.receipt}/></section>}
				</div>}</details>
			</article>)}</div>:<p className="account-empty">No accounts match this search.</p>}
		</div>
		{deletingUser&&<section className="account-panel mt-4 border border-loss/40 p-5" aria-labelledby="confirm-delete-heading">
			<h2 id="confirm-delete-heading" className="font-semibold text-loss">Delete Account Permanently</h2>
			<p className="mt-2 text-sm muted">This irreversible action disables sign-in and removes the account’s direct profile identifiers. The database account key remains as an anonymized retained-record anchor; financial, audit, support, KYC, and tax records are not erased. No funds are transferred or confiscated.</p>
			<div className="mt-3 rounded border border-white/10 p-3 text-sm"><b>Account ID:</b> <span className="break-all font-mono">{deletingUser.id}</span><br/><b>Email:</b> <span className="break-all">{deletingUser.email}</span></div>
			{deletionAssessmentLoading?<p className="mt-3 text-sm muted" role="status">Checking wallet balances and unresolved obligations…</p>:deletionAssessment&&<>
				<div className="mt-3 grid gap-2 text-sm sm:grid-cols-2"><div><b>Wallet balances</b>{deletionAssessment.balances.length?deletionAssessment.balances.map((item,index)=><p key={`${item.accountMode}:${item.currency}:${index}`}>{item.accountMode} {item.currency}: {item.amount}</p>):<p>None</p>}</div><div><b>Deletion blockers</b>{deletionAssessment.blockers.filter(item=>item.count>0).length?deletionAssessment.blockers.filter(item=>item.count>0).map(item=><p className="text-loss" key={item.code}>{item.code.replaceAll('_',' ').toLowerCase()}: {item.count}</p>):<p>No unresolved obligations found.</p>}</div></div>
				<p className="mt-3 text-xs muted">Retained records: {deletionAssessment.retainedRecords.kycDocuments} KYC documents, {deletionAssessment.retainedRecords.taxDocuments} tax documents, financial history, audit history, and support records. These records remain subject to applicable retention controls.</p>
				{!deletionAssessment.deletable&&<p className="mt-3 text-sm text-loss" role="alert">Deletion is blocked until every listed obligation and wallet balance is resolved. There is no force-delete override.</p>}
			</>}
			{deletionAssessment?.deletable&&<form className="mt-4 grid max-w-2xl gap-3" onSubmit={event=>void deleteAccount(event)}>
				<label className="account-label">Enter the user’s email address to confirm<input className="input mt-1" type="email" required autoComplete="off" value={deletionEmail} onChange={event=>setDeletionEmail(event.target.value)}/></label>
				<label className="account-label">Second confirmation: type DELETE PERMANENTLY<input className="input mt-1" required autoComplete="off" value={deletionPhrase} onChange={event=>setDeletionPhrase(event.target.value)}/></label>
				<label className="account-label">Re-enter your administrator password<input className="input mt-1" type="password" required autoComplete="current-password" value={adminPassword} onChange={event=>setAdminPassword(event.target.value)}/></label>
				<label className="account-label">Deletion reason<textarea className="input mt-1 min-h-20" required minLength={5} maxLength={500} value={deletionReason} onChange={event=>setDeletionReason(event.target.value)}/></label>
				<p className="text-xs muted">The system will recheck eligibility atomically before deactivation. KYC and tax files are retained; only an eligible profile image is scheduled for cleanup.</p>
				<div className="flex flex-wrap gap-2"><button className="btn bg-loss text-black" type="submit" disabled={busy||deletionEmail.trim().toLowerCase()!==deletingUser.email.trim().toLowerCase()||deletionPhrase!=='DELETE PERMANENTLY'||adminPassword.length===0||deletionReason.trim().length<5} aria-busy={busy}>{busy?'Deactivating…':'Confirm and permanently deactivate'}</button><button className="btn bg-white/5" type="button" disabled={busy} onClick={()=>{setDeletingUser(null);setDeletionAssessment(null)}}>Cancel</button></div>
			</form>}
		</section>}
		<section className="account-panel mt-5 p-5" aria-labelledby="deletion-history-heading">
			<div className="account-panel-title"><div><h2 id="deletion-history-heading">Permanent deletion audit history</h2><p className="account-panel-subtitle">Recent administrator actions, timestamps, account references, and recorded reasons.</p></div><button className="btn min-h-10 bg-white/5" type="button" onClick={()=>void loadDeletionHistory()}>Refresh</button></div>
			{deletionHistory.length?<div className="mt-3 divide-y divide-white/10">{deletionHistory.map(item=><article className="py-3 text-sm" key={item.id}><b className="break-all">Account {item.entityId||'retained record'}</b><p className="muted">{new Date(item.createdAt).toLocaleString()} · {item.actor?.name||item.actor?.email||'Administrator record unavailable'}</p><p>Reason: {item.metadata?.reason||'Not recorded'}</p></article>)}</div>:<p className="mt-3 text-sm muted">No permanent account deactivations recorded.</p>}
		</section>
	</div>;
}