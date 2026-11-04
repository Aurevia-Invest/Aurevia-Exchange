'use client';

import {useEffect,useState} from 'react';
import {ArrowDown,ArrowUp,ExternalLink,RefreshCw,Trash2} from 'lucide-react';
import {formatUsd} from '@/lib/currency-format';

type FundingRecord={id:string;type:string;method:string;amount:string|number;creditedAmount:string|number|null;creditedCurrency:string|null;feeAmount:string|number|null;feePercent:string|number|null;currency:string;status:string;accountMode:string;transactionReference:string|null;referenceInfo:string|null;senderInfo:string|null;destinationInfo:string|null;network:string|null;note:string|null;verifiedAt:string|null;createdAt:string;reviewedAt:string|null;settledAt:string|null;settlementReference:string|null;hasReceipt:boolean;user:{id:string;name:string|null;email:string};paymentMethod:{name:string}|null};
type Result={items:FundingRecord[];total:number;page:number;pageSize:number;totalPages:number};
type Props={title:string;description:string;type:'DEPOSIT'|'WITHDRAWAL';initialStatuses:string};

const statuses=['PENDING','PENDING_REVIEW','PROCESSING','APPROVED','COMPLETED','REJECTED','FAILED','CANCELLED','REVERSED'];

export default function AdminFundingRecordsPanel({title,description,type,initialStatuses}:Props){
	const [result,setResult]=useState<Result>({items:[],total:0,page:1,pageSize:25,totalPages:0});
	const [status,setStatus]=useState(initialStatuses);
	const [search,setSearch]=useState('');
	const [page,setPage]=useState(1);
	const [sort,setSort]=useState<'asc'|'desc'>('desc');
	const [loading,setLoading]=useState(true);
	const [error,setError]=useState('');
	const [refresh,setRefresh]=useState(0);

	useEffect(()=>{
		const controller=new AbortController();
		const timer=window.setTimeout(async()=>{
			setLoading(true);setError('');
			const params=new URLSearchParams({type,page:String(page),sort});
			if(status)params.set('status',status);
			if(search.trim())params.set('search',search.trim());
			try{
				const response=await fetch(`/api/admin/funding/records?${params}`,{cache:'no-store',signal:controller.signal});
				const data=await response.json();if(!response.ok)throw new Error(data.error||'Unable to load funding records.');
				setResult(data);
			}catch(exception){if(!(exception instanceof DOMException&&exception.name==='AbortError'))setError(exception instanceof Error?exception.message:'Unable to load funding records.')}
			finally{if(!controller.signal.aborted)setLoading(false)}
		},180);
		return()=>{window.clearTimeout(timer);controller.abort()};
	},[page,refresh,search,sort,status,type]);

	async function openReceipt(id:string){
		try{
			const response=await fetch(`/api/admin/funding/${encodeURIComponent(id)}/receipt`,{cache:'no-store'});
			const data=await response.json();if(!response.ok)throw new Error(data.error||'Receipt unavailable.');
			window.open(data.url,'_blank','noopener,noreferrer');
		}catch(exception){setError(exception instanceof Error?exception.message:'Receipt unavailable.')}
	}

	async function deleteFunding(id:string){
		if(!window.confirm('Delete this funding request and receipt permanently?'))return;
		try{
			const response=await fetch(`/api/admin/funding/${encodeURIComponent(id)}`,{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({confirmation:'DELETE'})});
			const data=await response.json();if(!response.ok)throw new Error(data.error||'Unable to delete this funding request.');
			setRefresh(value=>value+1);
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to delete this funding request.')}
	}

	return <div className="account-page">
		<header className="account-heading"><div><span className="account-kicker">WORKSPACE · FUNDING RECORDS</span><h1>{title}</h1><p>{description}</p></div><button className="icon-action" type="button" aria-label="Refresh records" onClick={()=>setRefresh(value=>value+1)}><RefreshCw size={15}/></button></header>
		<div className="mb-4 grid gap-3 sm:grid-cols-[minmax(14rem,1fr)_minmax(12rem,0.5fr)_auto]">
			<label className="account-label">Search<input className="input mt-1" value={search} onChange={event=>{setPage(1);setSearch(event.target.value)}} placeholder="Name, email, request ID, reference" maxLength={120}/></label>
			<label className="account-label">Status<select className="input mt-1" value={status} onChange={event=>{setPage(1);setStatus(event.target.value)}}><option value="">All statuses</option>{statuses.map(value=><option value={value} key={value}>{value.replaceAll('_',' ')}</option>)}</select></label>
			<button className="btn mt-auto min-h-11 bg-white/5" type="button" onClick={()=>setSort(value=>value==='desc'?'asc':'desc')} aria-label={`Sort by date ${sort==='desc'?'oldest first':'newest first'}`}>{sort==='desc'?<ArrowDown size={15}/>:<ArrowUp size={15}/>}Date</button>
		</div>
		{error&&<div className="account-callout mb-3" role="alert">{error}</div>}
		<div className="mb-2 text-sm muted" aria-live="polite">{loading?'Loading records…':`${result.total} records`}</div>
		<div className="overflow-x-auto rounded-md border border-white/10">
			<table className="account-table min-w-[940px]"><thead><tr><th>Request</th><th>User</th><th>Method</th><th>Amount</th><th>Status</th><th>Recorded</th><th>Receipt</th><th>Actions</th></tr></thead><tbody>
                {result.items.map(item=><tr key={item.id}>
					<td><span className="font-mono text-xs">{item.id}</span>{item.transactionReference&&<small className="block break-all muted">{item.transactionReference}</small>}{item.network==='BITCOIN_MAINNET'&&<details className="mt-1"><summary className="text-link">BTC submission details</summary><dl className="mt-2 grid gap-1 text-xs"><div><dt className="muted">Network</dt><dd>Bitcoin mainnet (BTC)</dd></div>{item.referenceInfo&&<div><dt className="muted">Reported deposit time</dt><dd className="break-words">{item.referenceInfo}</dd></div>}{item.senderInfo&&<div><dt className="muted">Sender details · unverified</dt><dd className="whitespace-pre-wrap break-words">{item.senderInfo}</dd></div>}{item.destinationInfo&&<div><dt className="muted">Configured destination</dt><dd className="break-all">{item.destinationInfo}</dd></div>}{item.note&&<div><dt className="muted">User note</dt><dd className="break-words">{item.note}</dd></div>}</dl></details>}</td>
					<td>{item.user.name||item.user.email}<small className="block muted">{item.user.email} · {item.accountMode}</small></td>
					<td>{item.paymentMethod?.name||item.method}</td>
					<td>{item.currency==='USD'?formatUsd(item.amount):`${Number(item.amount).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:8})} ${item.currency}`}{item.feeAmount!==null&&item.feeAmount!==undefined&&<small className="block muted">Fee {item.feePercent??10}% · {item.currency==='USD'?formatUsd(item.feeAmount):`${Number(item.feeAmount).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:8})} ${item.currency}`}</small>}{item.creditedAmount!==null&&item.creditedCurrency&&<small className="block muted">Credited {item.creditedCurrency==='USD'?formatUsd(item.creditedAmount):`${Number(item.creditedAmount).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:8})} ${item.creditedCurrency}`}</small>}</td>
					<td><span className="status-pill">{item.status.replaceAll('_',' ')}{item.verifiedAt?' · VERIFIED':''}</span></td>
					<td>{new Date(item.settledAt||item.reviewedAt||item.createdAt).toLocaleString()}{item.settlementReference&&<small className="block break-all muted">{item.settlementReference}</small>}</td>
					<td>{item.hasReceipt?<button type="button" className="text-link" onClick={()=>void openReceipt(item.id)}><ExternalLink size={13}/> Open</button>:'—'}</td>
					<td><button type="button" className="text-link text-loss" aria-label="Delete funding request" onClick={()=>void deleteFunding(item.id)}><Trash2 size={14}/><span className="sr-only">Delete funding request</span></button></td>
				</tr>)}
				{!loading&&!result.items.length&&<tr><td colSpan={8} className="account-empty">No matching funding records.</td></tr>}
			</tbody></table>
		</div>
		<div className="mt-3 flex items-center justify-between gap-3"><span className="text-xs muted">Page {result.totalPages?result.page:0} of {result.totalPages}</span><div className="flex gap-2"><button type="button" className="btn min-h-10 bg-white/5" disabled={loading||page<=1} onClick={()=>setPage(value=>Math.max(1,value-1))}>Previous</button><button type="button" className="btn min-h-10 bg-white/5" disabled={loading||page>=result.totalPages} onClick={()=>setPage(value=>Math.min(result.totalPages,value+1))}>Next</button></div></div>
	</div>;
}