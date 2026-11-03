'use client';

import {useCallback,useEffect,useMemo,useState} from 'react';
import {Archive,RefreshCw,RotateCcw,Search,ShieldAlert,Trash2} from 'lucide-react';
import type {ActivityCategory,ActivityRecord} from '@/lib/activity';
import {groupByLocalDate,localDateBoundary} from '@/lib/local-date';

type UserOption={id:string;name:string|null;email:string;accountMode:'DEMO'|'REAL';status:string};
type StateFilter='active'|'archived'|'hidden'|'all';
type ActivityData={items:ActivityRecord[];total:number;hasMore:boolean};

export default function AdminActivityManagementPanel(){
	const [search,setSearch]=useState('');
	const [users,setUsers]=useState<UserOption[]>([]);
	const [target,setTarget]=useState<UserOption|null>(null);
	const [mode,setMode]=useState<'DEMO'|'REAL'>('DEMO');
	const [category,setCategory]=useState<ActivityCategory>('all');
	const [state,setState]=useState<StateFilter>('active');
	const [statusFilter,setStatusFilter]=useState('');
	const [dateFrom,setDateFrom]=useState('');
	const [dateTo,setDateTo]=useState('');
	const [activitySearch,setActivitySearch]=useState('');
	const [data,setData]=useState<ActivityData|null>(null);
	const [selected,setSelected]=useState<Set<string>>(new Set());
	const [loading,setLoading]=useState(false);
	const [busy,setBusy]=useState(false);
	const [error,setError]=useState('');
	const [notice,setNotice]=useState('');

	const searchUsers=useCallback(async(value:string)=>{
		if(value.trim().length<2){setUsers([]);return}
		try{
			const response=await fetch(`/api/admin/activity?search=${encodeURIComponent(value.trim())}`,{cache:'no-store'});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to search user accounts.');
			setUsers(result.users as UserOption[]);
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to search user accounts.')}
	},[]);

	useEffect(()=>{const timer=window.setTimeout(()=>void searchUsers(search),250);return()=>window.clearTimeout(timer)},[search,searchUsers]);

	const load=useCallback(async(offset=0,append=false)=>{
		if(!target)return;
		setLoading(true);setError('');
		try{
			const params=new URLSearchParams({userId:target.id,accountMode:mode,category,limit:'30',offset:String(offset),state});
			if(activitySearch.trim())params.set('search',activitySearch.trim());
			if(statusFilter)params.set('status',statusFilter);
			if(dateFrom){const boundary=localDateBoundary(dateFrom);if(boundary)params.set('dateFrom',boundary)}
			if(dateTo){const boundary=localDateBoundary(dateTo,true);if(boundary)params.set('dateTo',boundary)}
			const response=await fetch(`/api/admin/activity?${params.toString()}`,{cache:'no-store'});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to load activity records.');
			setData(current=>append&&current?{...result.data,items:[...current.items,...result.data.items]}:result.data);
			setSelected(new Set());setNotice('');
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to load activity records.')}
		finally{setLoading(false)}
	},[activitySearch,category,dateFrom,dateTo,mode,state,statusFilter,target]);

	useEffect(()=>{setData(null);if(target)void load()},[load,target]);

	const selectedItems=useMemo(()=>data?.items.filter(item=>selected.has(`${item.source}:${item.id}`))||[],[data,selected]);
	const groupedActivity=groupByLocalDate(data?.items||[]);
	function toggle(item:ActivityRecord){
		const key=`${item.source}:${item.id}`;
		setSelected(current=>{const next=new Set(current);if(next.has(key))next.delete(key);else next.add(key);return next});
	}

	async function act(action:'archive'|'restore'|'hide'|'unhide'|'permanently-delete',items=selectedItems,immediate=false){
		if(!target||!items.length||busy)return;
		if(action==='hide'&&!immediate&&!window.confirm(`Remove ${items.length} selected item${items.length===1?'':'s'} from this user's activity feed? Source records will be retained.`))return;
		if(action==='permanently-delete'&&!window.confirm(`Permanently delete ${items.length} selected read notification${items.length===1?'':'s'}? Financial records and delivery history cannot be deleted here.`))return;
		setBusy(true);setError('');setNotice('');
		try{
			const response=await fetch('/api/admin/activity',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,targetUserId:target.id,accountMode:mode,reason:'Administrator activity management',items:items.map(item=>({source:item.source,id:item.id}))})});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to manage activity records.');
			const denied=(result.results||[]).filter((item:{eligible:boolean})=>!item.eligible);
			setNotice(`${result.affected} record${result.affected===1?'':'s'} updated and audited.${denied.length?` ${denied.length} protected or unavailable record${denied.length===1?' was':'s were'} retained.`:''}`);
			await load();
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to manage activity records.')}
		finally{setBusy(false)}
	}

	async function clearHistory(){
		if(!target||busy||!window.confirm(`Remove all eligible completed ${mode} activity from ${target.email}'s visible feed? Financial, security and business records will remain intact.`))return;
		setBusy(true);setError('');setNotice('');
		try{
			const response=await fetch('/api/admin/activity',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'clear',targetUserId:target.id,accountMode:mode,reason:'Administrator cleared eligible activity history'})});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to clear eligible activity.');
			setNotice(`${result.affected} eligible record${result.affected===1?' was':'s were'} removed from the feed and audited.${result.capped?' Safety limit reached; repeat Clear feed to continue.':''}`);
			await load();
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to clear eligible activity.')}
		finally{setBusy(false)}
	}

	return <div className="account-page admin-activity-management">
		<header className="account-heading"><div><span className="account-kicker">OPERATIONS · RECORD RETENTION</span><h1>Activity Management</h1><p>Manage user-visible activity without changing protected financial or compliance records.</p></div><button className="icon-action" type="button" aria-label="Refresh activity" onClick={()=>void load()} disabled={!target||loading}><RefreshCw size={15}/></button></header>
		<div className="account-callout mb-4"><ShieldAlert size={17}/><span>Deposits, withdrawals, ledger entries, executed trades, investments and security records are retained. Feed removal and archive actions never reverse or erase the underlying record.</span></div>
		<section className="account-panel card p-4">
			<div className="grid gap-3 md:grid-cols-[minmax(240px,1fr)_180px]">
				<label className="relative"><Search size={14} className="absolute left-3 top-3.5 muted"/><input className="input pl-9" value={search} onChange={event=>{setSearch(event.target.value);setTarget(null);setData(null)}} placeholder="Search user name, email or account ID" aria-label="Search users" maxLength={120}/></label>
				<select className="input" value={mode} onChange={event=>setMode(event.target.value as 'DEMO'|'REAL')} aria-label="Account mode"><option value="DEMO">DEMO activity</option><option value="REAL">REAL activity</option></select>
			</div>
			{users.length>0&&!target&&<div className="mt-3 grid gap-2">{users.map(user=><button type="button" className="flex min-h-12 items-center justify-between gap-3 rounded border border-white/10 bg-white/[.025] px-3 text-left hover:border-amber-300/30" key={user.id} onClick={()=>{setTarget(user);setMode(user.accountMode);setUsers([])}}><span className="min-w-0"><b className="block truncate">{user.name||user.email}</b><small className="muted">{user.email} · {user.id}</small></span><span className={`status-pill ${user.accountMode==='REAL'?'mode-real':'mode-demo'}`}>{user.accountMode}</span></button>)}</div>}
			{search.trim().length>=2&&!users.length&&!target&&<p className="mt-3 text-sm muted">No matching user accounts.</p>}
			{target&&<div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-white/10 pt-3"><span><b>{target.name||target.email}</b><small className="ml-2 muted">{target.email} · {target.id} · {target.status}</small></span><button type="button" className="text-link" onClick={()=>{setTarget(null);setData(null);setSearch('')}}>Choose another user</button></div>}
			{target&&<div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
				<input className="input lg:col-span-2" value={activitySearch} onChange={event=>setActivitySearch(event.target.value)} placeholder="Search activity records" aria-label="Search activity records"/>
				<select className="input" value={category} onChange={event=>setCategory(event.target.value as ActivityCategory)} aria-label="Activity type">{['all','trade','personal-trade','investment','deposit','withdrawal','order','position','account','security','login-history'].map(value=><option key={value} value={value}>{value==='all'?'All activity':value==='login-history'?'Login history':value.replaceAll('-',' ')}</option>)}</select>
				<input className="input" value={statusFilter} onChange={event=>setStatusFilter(event.target.value)} placeholder="Status" aria-label="Filter by status"/>
				<input className="input" type="date" aria-label="From date" value={dateFrom} onChange={event=>setDateFrom(event.target.value)}/>
				<input className="input" type="date" aria-label="To date" value={dateTo} onChange={event=>setDateTo(event.target.value)}/>
				<select className="input lg:col-span-2" value={state} onChange={event=>setState(event.target.value as StateFilter)} aria-label="Visibility state"><option value="active">Visible activity</option><option value="archived">Archived</option><option value="hidden">Removed from feed</option><option value="all">All activity</option></select>
			</div>}
			{target&&<div className="mt-3 flex flex-wrap gap-2">
				<button type="button" className="button-secondary" disabled={!selectedItems.length||busy} onClick={()=>void act(state==='archived'?'restore':'archive')}><Archive size={14}/>{state==='archived'?'Restore selected':'Archive selected'}</button>
				<button type="button" className="button-secondary" disabled={!selectedItems.length||busy} onClick={()=>void act(state==='hidden'?'restore':'hide')}><Trash2 size={14}/>{state==='hidden'?'Restore to feed':'Remove from feed'}</button>
				{selectedItems.length>0&&selectedItems.every(item=>item.source==='notification'&&item.permanentDeletionAllowed)&&<button type="button" className="button-secondary" disabled={busy} onClick={()=>void act('permanently-delete')}><Trash2 size={14}/>Delete selected notifications</button>}
				<button type="button" className="button-secondary" disabled={busy} onClick={()=>void clearHistory()}>Clear user feed</button>
			</div>}
		</section>
		{error&&<p className="account-callout mt-4" role="alert">{error}</p>}{notice&&<p className="mt-3 text-sm text-profit" role="status">{notice}</p>}
		<section className="account-panel card mt-4 overflow-hidden">
			<div className="account-panel-title px-4 pt-4"><div><h2>{target?`${mode} activity records`:'Select a user account'}</h2><p className="account-panel-subtitle">{data?`${data.items.length} records loaded · ${data.total} matches in current page window`:'Activity details are loaded only after an administrator selects an account.'}</p></div></div>
			{loading?<div className="account-empty" role="status">Loading activity records…</div>:data?.items.length?<div className="activity-feed">{groupedActivity.map(group=><div key={group.key}><h3 className="px-4 py-2 text-xs font-semibold muted">{group.label}</h3>{group.items.map(item=><article className="activity-feed-row activity-managed-row" key={`${item.source}:${item.id}`}>
				<label><input type="checkbox" checked={selected.has(`${item.source}:${item.id}`)} onChange={()=>toggle(item)} disabled={item.source==='audit'} aria-label={`Select ${item.action}`}/></label>
				<div className="activity-feed-main"><div><b>{item.action}</b><span>{item.asset}</span>{item.archivedAt&&<small>ARCHIVED</small>}{item.hidden&&<small>REMOVED FROM FEED</small>}{item.permanentDeletionAllowed&&<small>ELIGIBLE FOR PERMANENT DELETION</small>}</div><p>{item.sourceLabel} · {item.status} · {new Date(item.timestamp).toLocaleString()}</p><details><summary>Record and retention details</summary><dl><div><dt>Source ID</dt><dd>{item.id}</dd></div><div><dt>Record type</dt><dd>{item.source}</dd></div><div><dt>Account mode</dt><dd>{mode}</dd></div><div><dt>Retention</dt><dd>{item.protectionReason||'Financial/business source record retained.'}</dd></div></dl></details></div>
				<span className={`status-pill ${item.permanentDeletionAllowed?'':'mode-real'}`}>{item.permanentDeletionAllowed?'Eligible':'Protected'}</span>
				{item.source!=='audit'&&<button type="button" className="icon-action" disabled={busy} onClick={()=>void act(item.hidden||item.archivedAt?'restore':'hide',[item],true)} aria-label={item.hidden||item.archivedAt?`Restore ${item.action}`:`Remove ${item.action} from feed`} title={item.hidden||item.archivedAt?'Restore activity':'Remove from feed'}>{item.hidden||item.archivedAt?<RotateCcw size={15}/>:<Trash2 size={15}/>}</button>}
			</article>)}</div>)}</div>:<div className="account-empty">{target?'No activity matches the selected filters.':'Search for and select a user to review activity.'}</div>}
			{data?.hasMore&&<div className="activity-pagination"><button type="button" className="button-secondary" onClick={()=>void load(data.items.length,true)} disabled={loading}>Load more</button></div>}
		</section>
	</div>;
}
