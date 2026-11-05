'use client';

import {useEffect,useState} from 'react';
import {CalendarDays,ChevronLeft,ChevronRight,RefreshCw,Search} from 'lucide-react';

type AuditEvent={
	id:string;
	actorId?:string|null;
	actorName?:string|null;
	action:string;
	entity:string;
	entityId?:string|null;
	metadata?:unknown;
	summary?:string|null;
	createdAt:string;
};

type AuditResponse={items:AuditEvent[];total:number;page:number;pageSize:number;totalPages:number};
const pageWindow=5;

function metadataEntries(metadata:unknown){
	if(!metadata||typeof metadata!=='object'||Array.isArray(metadata))return [];
	return Object.entries(metadata);
}

function metadataText(value:unknown){
	if(value===null)return '—';
	if(typeof value==='string')return value;
	if(typeof value==='object')return JSON.stringify(value);
	return String(value);
}

function utcDateLabel(date:string|null){
	if(!date)return 'All activity dates';
	return new Intl.DateTimeFormat(undefined,{timeZone:'UTC',dateStyle:'full'}).format(new Date(`${date}T00:00:00.000Z`));
}

export function utcTimestamp(value:string){
	return new Intl.DateTimeFormat(undefined,{timeZone:'UTC',dateStyle:'medium',timeStyle:'medium'}).format(new Date(value));
}

export default function AdminAuditLogPanel(){
	const [events,setEvents]=useState<AuditEvent[]>([]);
	const [search,setSearch]=useState('');
	const [selectedDate,setSelectedDate]=useState<string|null>(null);
	const [page,setPage]=useState(1);
	const [total,setTotal]=useState(0);
	const [totalPages,setTotalPages]=useState(0);
	const [loading,setLoading]=useState(true);
	const [error,setError]=useState('');
	const [refresh,setRefresh]=useState(0);

	useEffect(()=>{
		const controller=new AbortController();
		const params=new URLSearchParams({page:String(page),search});
		if(selectedDate)params.set('date',selectedDate);
		setLoading(true);
		setError('');
		fetch(`/api/admin/audit?${params}`,{cache:'no-store',signal:controller.signal}).then(async response=>{
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to load audit records.');
			if(!controller.signal.aborted){
				const data=result as AuditResponse;
				setEvents(data.items);
				setTotal(data.total);
				setTotalPages(data.totalPages);
				if(data.page!==page)setPage(data.page);
			}
		}).catch(exception=>{
			if(!controller.signal.aborted)setError(exception instanceof Error?exception.message:'Unable to load audit records.');
		}).finally(()=>{
			if(!controller.signal.aborted)setLoading(false);
		});
		return()=>controller.abort();
	},[page,search,selectedDate,refresh]);

	const today=new Date();
	const changeDate=(date:string|null)=>{setSelectedDate(date);setPage(1)};
	const moveDay=(amount:number)=>{
		const date=selectedDate?new Date(`${selectedDate}T00:00:00.000Z`):new Date(Date.UTC(today.getUTCFullYear(),today.getUTCMonth(),today.getUTCDate()));
		date.setUTCDate(date.getUTCDate()+amount);
		changeDate(date.toISOString().slice(0,10));
	};
	const firstPage=Math.max(1,Math.min(page-Math.floor(pageWindow/2),Math.max(1,totalPages-pageWindow+1)));
	const pageNumbers=Array.from({length:Math.min(pageWindow,totalPages)},(_,index)=>firstPage+index);
	const firstRecord=total?(page-1)*10+1:0;
	const lastRecord=Math.min(page*10,total);

	return <div className="account-page">
		<header className="account-heading"><div><span className="account-kicker">SERVICE &amp; SYSTEM</span><h1>Administrative audit log</h1><p>Persisted administrator actions and internal notification events.</p></div><button type="button" className="icon-action" aria-label="Refresh audit log" onClick={()=>setRefresh(value=>value+1)}><RefreshCw size={15}/></button></header>

		<section className="mb-4 rounded-md border border-white/10 bg-white/[0.025] p-3 sm:p-4" aria-label="Activity date filter">
			<div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
				<div className="min-w-0">
					<label className="account-label block" htmlFor="audit-date"><span className="inline-flex items-center gap-2"><CalendarDays size={15} className="gold"/>Activity date</span></label>
					<div className="mt-2 flex flex-wrap items-center gap-2">
						<input id="audit-date" aria-label="Select activity date (UTC)" type="date" value={selectedDate??''} onChange={event=>changeDate(event.target.value||null)} className="input min-h-10 w-auto max-w-full"/>
						<button type="button" className="btn min-h-10 bg-white/5" onClick={()=>moveDay(-1)}><ChevronLeft size={15}/>Previous day</button>
						<button type="button" className="btn min-h-10 bg-white/5" onClick={()=>moveDay(1)}><ChevronRight size={15}/>Next day</button>
						{selectedDate&&<button type="button" className="btn min-h-10 bg-white/5" onClick={()=>changeDate(null)}>View all dates</button>}
					</div>
				</div>
				<div className="text-sm md:text-right">
					<div className="muted text-xs">Currently showing · UTC</div>
					<div className="mt-1 font-medium text-white">{utcDateLabel(selectedDate)}</div>
				</div>
			</div>
		</section>

		<label className="account-label mb-4 block">Search history<div className="relative mt-1"><Search size={15} className="absolute left-3 top-3.5 muted"/><input className="input pl-9" value={search} onChange={event=>{setPage(1);setSearch(event.target.value)}} placeholder="Action, entity, account ID" maxLength={160}/></div></label>
		{error&&<div className="account-callout mb-3" role="alert">{error}</div>}
		<div className="overflow-x-auto rounded-md border border-white/10"><table className="account-table min-w-[820px]"><thead><tr><th>Time (UTC)</th><th>Activity</th><th>Type</th><th>Administrator / account</th><th>Reference</th><th>Details</th></tr></thead><tbody>
			{events.map(event=>{
				const details=metadataEntries(event.metadata);
				return <tr key={event.id}>
					<td className="whitespace-nowrap text-xs">{utcTimestamp(event.createdAt)}</td>
					<td><span className="gold">{event.action}</span>{event.summary&&<small className="block max-w-[24rem] break-words muted">{event.summary}</small>}</td>
					<td>{event.entity}</td>
					<td>{event.actorName&&<span className="block">{event.actorName}</span>}<span className="font-mono text-xs">{event.actorId||'System'}</span></td>
					<td className="font-mono text-xs">{event.entityId||event.id}</td>
					<td>{details.length?<details className="max-w-[18rem]"><summary className="cursor-pointer text-xs gold">{details.length} detail{details.length===1?'':'s'}</summary><dl className="mt-2 space-y-1 text-xs">{details.map(([key,value])=><div key={key} className="grid grid-cols-[auto_1fr] gap-x-2"><dt className="muted">{key}</dt><dd className="break-all">{metadataText(value)}</dd></div>)}</dl></details>:<span className="muted text-xs">—</span>}</td>
				</tr>;
			})}
			{!loading&&!events.length&&<tr><td colSpan={6} className="account-empty">{selectedDate?'No activities were recorded on this date.':'No matching activities found.'}</td></tr>}
			{loading&&!events.length&&<tr><td colSpan={6} className="account-empty">Loading activity history…</td></tr>}
		</tbody></table></div>

		<div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
			<div className="text-xs muted" aria-live="polite">
				{loading?'Loading activity history…':`Showing ${firstRecord}–${lastRecord} of ${total} activities`}
				<span className="ml-2">· Page {total? page:0} of {totalPages}</span>
			</div>
			<nav className="flex flex-wrap items-center gap-2" aria-label="Activity log pages">
				<button type="button" className="btn min-h-10 bg-white/5" disabled={page<=1||loading} onClick={()=>setPage(value=>Math.max(1,value-1))}><ChevronLeft size={15}/>Previous</button>
				{pageNumbers.map(pageNumber=><button key={pageNumber} type="button" className={`btn min-h-10 min-w-10 ${pageNumber===page?'border border-[#c9a96e] bg-[#c9a96e]/10 text-[#e2c88f]':'bg-white/5'}`} aria-label={`Page ${pageNumber}`} aria-current={pageNumber===page?'page':undefined} disabled={loading} onClick={()=>setPage(pageNumber)}>{pageNumber}</button>)}
				<button type="button" className="btn min-h-10 bg-white/5" disabled={!totalPages||page>=totalPages||loading} onClick={()=>setPage(value=>Math.min(totalPages,value+1))}>Next<ChevronRight size={15}/></button>
			</nav>
		</div>
	</div>;
}
