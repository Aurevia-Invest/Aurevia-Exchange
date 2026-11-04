'use client';

import {useCallback,useEffect,useState} from 'react';
import {Monitor,RefreshCw,Smartphone,Tablet,UserRoundX} from 'lucide-react';

type SessionRecord={
	userId:string;email:string;name:string|null;phone:string|null;country:string|null;hasProfilePhoto:boolean;
	sessionRef:string;active:boolean;createdAt:string;browser:string;operatingSystem:string;device:string;
};

function DeviceIcon({device}:{device:string}){
	if(device==='Mobile')return <Smartphone size={16} aria-hidden="true"/>;
	if(device==='Tablet')return <Tablet size={16} aria-hidden="true"/>;
	return <Monitor size={16} aria-hidden="true"/>;
}

export default function AdminSessionsPanel(){
	const [sessions,setSessions]=useState<SessionRecord[]>([]);
	const [search,setSearch]=useState('');
	const [loading,setLoading]=useState(true);
	const [hasMore,setHasMore]=useState(false);
	const [page,setPage]=useState(0);
	const [busy,setBusy]=useState('');
	const [message,setMessage]=useState('');
	const [error,setError]=useState('');

	const load=useCallback(async(nextPage=0,append=false)=>{
		setLoading(true);
		try{
			const params=new URLSearchParams({page:String(nextPage)});
			if(search.trim())params.set('search',search.trim());
			const query=`?${params}`;
			const response=await fetch(`/api/admin/sessions${query}`,{cache:'no-store'});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to load sessions.');
			setSessions(current=>append?[...current,...result.sessions as SessionRecord[]]:result.sessions as SessionRecord[]);
			setPage(nextPage);
			setHasMore(Boolean(result.hasMore));
			setError('');
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to load sessions.');}
		finally{setLoading(false);}
	},[search]);

	useEffect(()=>{void load(0,false)},[load]);

	async function revoke(session:SessionRecord){
		if(!session.active||busy||!window.confirm(`Sign ${session.email} out of this active session?`))return;
		setBusy(session.sessionRef);setMessage('');setError('');
		try{
			const response=await fetch('/api/admin/sessions',{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({userId:session.userId,sessionRef:session.sessionRef})});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to revoke this session.');
			setMessage('Session revoked. The account signs out on its next request.');
			await load(0,false);
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to revoke this session.');}
		finally{setBusy('');}
	}

	return <section className="card p-4 sm:p-5">
		<header className="flex flex-wrap items-end justify-between gap-3">
			<div><h1 className="text-xl font-bold">Account sessions</h1><p className="mt-1 text-sm muted">Registered-account sign-ins only. This view does not show guest browsing, IP addresses, or precise location.</p></div>
			<button className="btn min-h-11 bg-white/5" type="button" onClick={()=>void load(0,false)} disabled={loading}><RefreshCw size={16} className={loading?'animate-spin':''}/>Refresh</button>
		</header>
		<div className="mt-4"><label className="account-label text-xs">Search account<input className="input mt-1 min-h-11 w-full sm:max-w-md" type="search" autoComplete="off" placeholder="Email, name, or account ID" value={search} onChange={event=>setSearch(event.target.value)}/></label></div>
		{message&&<p className="mt-3 text-sm text-profit" role="status">{message}</p>}
		{error&&<p className="mt-3 text-sm text-loss" role="alert">{error}</p>}
		{loading&&!sessions.length?<p className="mt-5 muted" role="status">Loading sessions…</p>:sessions.length?<div className="mt-4 overflow-x-auto"><table className="w-full min-w-[900px] text-left text-sm">
			<thead><tr className="border-b border-white/10 muted"><th className="p-3">Account</th><th className="p-3">Device</th><th className="p-3">Region</th><th className="p-3">Last sign-in</th><th className="p-3">Status</th><th className="p-3">Action</th></tr></thead>
			<tbody>{sessions.map(session=><tr className="border-b border-white/5" key={`${session.sessionRef}:${session.userId}`}>
				<td className="p-3"><p className="font-medium">{session.name||'Account'}</p><p>{session.email}</p><p className="text-xs muted">{session.phone||'No phone on file'} · {session.hasProfilePhoto?'Profile photo set':'No profile photo'}</p></td>
				<td className="p-3"><span className="inline-flex items-center gap-2"><DeviceIcon device={session.device}/>{session.device} · {session.operatingSystem} · {session.browser}</span></td>
				<td className="p-3">{session.country||'Not provided'}</td>
				<td className="p-3">{new Date(session.createdAt).toLocaleString()}</td>
				<td className="p-3"><span className="status-pill">{session.active?'Active':'Historical'}</span></td>
				<td className="p-3"><button className="btn min-h-10 bg-loss/20 text-loss disabled:opacity-50" type="button" disabled={!session.active||busy!==''} onClick={()=>void revoke(session)}><UserRoundX size={15}/>{busy===session.sessionRef?'Revoking…':'Sign out'}</button></td>
			</tr>)}</tbody>
		</table></div>:<p className="mt-5 muted">No matching sign-ins.</p>}
		{hasMore&&<div className="mt-4 flex justify-center"><button className="btn min-h-11 bg-white/5" type="button" disabled={loading} onClick={()=>void load(page+1,true)}>{loading?'Loading…':'Load older sign-ins'}</button></div>}
	</section>;
}
