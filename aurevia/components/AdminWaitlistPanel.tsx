'use client';

import {useCallback,useEffect,useMemo,useState} from 'react';
import {Download,RefreshCw,Trash2} from 'lucide-react';

type WaitlistEntry={id:string;email:string;name:string|null;country:string;investorType:string;phone:string|null;status:string;source:string|null;notes:string|null;createdAt:string;updatedAt:string;user?:{email:string;name:string|null}};

const statuses=['WAITING','INVITED','REGISTERED','REMOVED'];

export default function AdminWaitlistPanel(){
  const [entries,setEntries]=useState<WaitlistEntry[]>([]);
  const [loading,setLoading]=useState(true);
  const [saving,setSaving]=useState('');
  const [error,setError]=useState('');
  const [search,setSearch]=useState('');
  const [status,setStatus]=useState('ALL');

  const load=useCallback(async()=>{
    setLoading(true);setError('');
    try{
      const response=await fetch('/api/admin/waitlist',{cache:'no-store'});
      if(!response.ok)throw new Error('Administrator authorization required.');
      setEntries(await response.json());
    }catch(exception){setError(exception instanceof Error?exception.message:'Unable to load waitlist entries.');}
    finally{setLoading(false)}
  },[]);

  useEffect(()=>{void load()},[load]);

  const filtered=useMemo(()=>entries.filter(entry=>{
    const query=search.toLowerCase();
    return (status==='ALL'||entry.status===status)&&(!query||entry.email.toLowerCase().includes(query)||entry.name?.toLowerCase().includes(query));
  }),[entries,search,status]);

  async function update(entry:WaitlistEntry,nextStatus:string){
    setSaving(entry.id);setError('');
    try{
      const response=await fetch('/api/admin/waitlist',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({id:entry.id,status:nextStatus,notes:entry.notes||undefined})});
      if(!response.ok)throw new Error((await response.json()).error||'Unable to update the waitlist entry.');
      await load();
    }catch(exception){setError(exception instanceof Error?exception.message:'Unable to update the waitlist entry.');}
    finally{setSaving('')}
  }

  async function remove(entry:WaitlistEntry){
    if(!window.confirm(`Move ${entry.email} to Deleted Items? You can restore it later.`))return;
    setSaving(entry.id);setError('');
    try{
      const response=await fetch('/api/admin/waitlist',{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({id:entry.id})});
      if(!response.ok)throw new Error((await response.json()).error||'Unable to move the waitlist entry to Deleted Items.');
      await load();
    }catch(exception){setError(exception instanceof Error?exception.message:'Unable to move the waitlist entry to Deleted Items.');}
    finally{setSaving('')}
  }

  function exportCsv(){
    const header=['id','email','name','country','investorType','phone','status','source','notes','createdAt'];
    const rows=filtered.map(entry=>header.map(key=>entry[key as keyof WaitlistEntry] ?? ''));
    const csv=[header,...rows].map(row=>row.map(value=>`"${String(value).replaceAll('"','""')}"`).join(',')).join('\n');
    const blob=new Blob([csv],{type:'text/csv;charset=utf-8'});
    const url=URL.createObjectURL(blob);
    const link=document.createElement('a');link.href=url;link.download='aurevia-waitlist.csv';link.click();URL.revokeObjectURL(url);
  }

  return <section id="waitlist" className="mx-auto w-full min-w-0 max-w-7xl px-4 py-6"><header className="account-heading"><div><span className="account-kicker">ADMINISTRATION · CUSTOMER ACCESS</span><h1>Customer waitlist</h1><p>Review submissions, change status, move records to Deleted Items, or export the list. Status changes are audited and do not grant account access.</p></div><div className="flex gap-2"><button className="btn min-h-11 bg-white/5" type="button" onClick={()=>void load()} disabled={loading}><RefreshCw size={15}/>Refresh</button><button className="btn min-h-11 bg-white/5" type="button" onClick={exportCsv} disabled={!filtered.length}><Download size={15}/>Export CSV</button></div></header>
    <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><div className="card p-4"><span className="muted text-xs">Total entries</span><strong className="mt-1 block text-2xl">{entries.length}</strong></div><div className="card p-4"><span className="muted text-xs">Awaiting review</span><strong className="mt-1 block text-2xl">{entries.filter(entry=>entry.status==='WAITING').length}</strong></div><div className="card p-4"><span className="muted text-xs">Invited</span><strong className="mt-1 block text-2xl">{entries.filter(entry=>entry.status==='INVITED').length}</strong></div><div className="card p-4"><span className="muted text-xs">Registered</span><strong className="mt-1 block text-2xl">{entries.filter(entry=>entry.status==='REGISTERED').length}</strong></div></div>
    <section className="card mt-5 min-w-0 p-4 sm:p-5"><div className="flex min-w-0 flex-wrap gap-2"><input className="input min-w-0 flex-1" value={search} onChange={event=>setSearch(event.target.value)} placeholder="Search email or name" aria-label="Search waitlist entries"/><select className="input min-w-44" value={status} onChange={event=>setStatus(event.target.value)} aria-label="Filter waitlist status"><option value="ALL">All statuses</option>{statuses.map(item=><option key={item} value={item}>{item}</option>)}</select></div>{error&&<p className="mt-3 text-sm text-loss" role="alert">{error}</p>}
      {loading?<p className="mt-5 muted" role="status">Loading waitlist…</p>:filtered.length?<div className="mt-4 divide-y divide-white/10">{filtered.map(entry=><article className="grid gap-3 py-4 lg:grid-cols-[1fr_auto]" key={entry.id}><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><b className="break-all">{entry.name||entry.email}</b><span className="status-pill">{entry.status}</span><span className="muted text-xs">{entry.country} · {entry.investorType}</span></div><p className="mt-1 break-all text-sm muted">{entry.email}{entry.phone?` · ${entry.phone}`:''} · {entry.source||'unspecified'}</p>{entry.notes&&<p className="mt-2 max-w-4xl break-words text-xs muted">Notes: {entry.notes}</p>}</div><div className="flex flex-wrap items-center gap-2"><select className="input min-w-40" value={entry.status} disabled={saving===entry.id} onChange={event=>void update(entry,event.target.value)} aria-label={`Change status for ${entry.email}`}>{statuses.map(item=><option key={item} value={item}>{item}</option>)}</select><button className="btn min-h-11 bg-loss px-4" type="button" disabled={saving===entry.id} onClick={()=>void remove(entry)}><Trash2 size={14}/>Remove</button></div></article>)}</div>:<p className="mt-5 muted">No waitlist entries match the current filters.</p>}</section></section>;
}
