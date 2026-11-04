'use client';

import {useCallback,useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import {useSession} from 'next-auth/react';
import {ArrowDownLeft,ArrowLeft,ArrowUpRight,RefreshCw,WalletCards} from 'lucide-react';
import Nav from '@/components/Nav';
import DisplayCurrencyPanel from '@/components/DisplayCurrencyPanel';
import {formatUsd} from '@/lib/currency-format';

type FundingRecord={id:string;type:'DEPOSIT'|'WITHDRAWAL';method:string;amount:string|number;currency:string;status:string;accountMode:'DEMO'|'REAL';createdAt:string;updatedAt:string};
type WalletData={accountMode:'DEMO'|'REAL';transactions:FundingRecord[]};
type Filter='ALL'|'DEPOSIT'|'WITHDRAWAL';

const statusLabels:Record<string,string>={PENDING:'Pending',PENDING_REVIEW:'Pending review',PROCESSING:'Processing',APPROVED:'Approved',COMPLETED:'Completed',REJECTED:'Rejected',CANCELLED:'Cancelled'};
const money=(value:string|number,currency:string)=>currency.toUpperCase()==='USD'?formatUsd(value):`${Number(value).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:8})} ${currency}`;

export default function TransactionsPage(){
	const {data:session,status:sessionStatus}=useSession();
	const activeMode=session?.user?.accountMode;
	const [data,setData]=useState<WalletData|null>(null);
	const [filter,setFilter]=useState<Filter>('ALL');
	const [loading,setLoading]=useState(true);
	const [error,setError]=useState('');
	const [historyHidden,setHistoryHidden]=useState(false);
	const [historyPreferenceReady,setHistoryPreferenceReady]=useState(false);
	const [preferenceError,setPreferenceError]=useState('');
	const latestRequest=useRef(0);
	const preferenceKey=session?.user?.id&&activeMode?`aurevia:funding-history:hidden:${session.user.id}:${activeMode}`:null;

	const load=useCallback(async(showLoading=false)=>{
		const requestId=++latestRequest.current;
		if(showLoading)setLoading(true);
		setError('');
		try{const response=await fetch('/api/wallet',{cache:'no-store'});const result=await response.json();if(!response.ok)throw new Error(result.error||'Unable to load transaction history.');if(requestId===latestRequest.current)setData(result)}
		catch(exception){if(requestId===latestRequest.current)setError(exception instanceof Error?exception.message:'Unable to load transaction history.')}
		finally{if(requestId===latestRequest.current)setLoading(false)}
	},[]);
	useEffect(()=>{
		if(sessionStatus!=='authenticated')return;
		setData(null);
		void load(true);
		const refresh=()=>{if(document.visibilityState==='visible')void load()};
		const timer=window.setInterval(refresh,5_000);
		window.addEventListener('focus',refresh);
		document.addEventListener('visibilitychange',refresh);
		return()=>{window.clearInterval(timer);window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh)};
	},[load,sessionStatus,activeMode]);
	useEffect(()=>{
		setHistoryPreferenceReady(false);
		setPreferenceError('');
		if(sessionStatus==='loading')return;
		if(sessionStatus!=='authenticated'||!preferenceKey){setHistoryPreferenceReady(true);return}
		try{setHistoryHidden(window.localStorage.getItem(preferenceKey)==='true')}
		catch{setPreferenceError('History visibility could not be loaded from this browser.')}
		finally{setHistoryPreferenceReady(true)}
	},[preferenceKey,sessionStatus]);
	const setHistoryVisibility=(hidden:boolean)=>{
		if(!preferenceKey){setPreferenceError('Sign in again to change transaction history visibility.');return}
		try{window.localStorage.setItem(preferenceKey,String(hidden));setHistoryHidden(hidden);setPreferenceError('')}
		catch{setPreferenceError('History visibility could not be saved in this browser.')}
	};
	const transactions=data?.transactions.filter(item=>filter==='ALL'||item.type===filter)||[];
	const displayValues=transactions.filter(item=>item.currency.toUpperCase()==='USD').slice(0,5).map(item=>({label:`${item.type==='DEPOSIT'?'Deposit':'Withdrawal'} · ${item.method}`,amount:String(item.amount)}));

	return <><Nav/><main className="account-page transaction-history-page">
		<Link href="/dashboard" className="text-link"><ArrowLeft size={15}/> Back to account</Link>
		<header className="account-heading mt-5"><div><span className="account-kicker">{data?.accountMode||'ACCOUNT'} · WALLET</span><h1>Transaction history</h1><p>Funding requests and their recorded review states for the active account.</p></div><span className={`status-pill ${data?.accountMode==='REAL'?'mode-real':'mode-demo'}`}>{data?`${data.accountMode} ACCOUNT`:'Loading account'}</span></header>
		{preferenceError&&<div className="account-callout mb-3" role="alert">{preferenceError}</div>}
		{!historyPreferenceReady?<section className="account-panel card p-5" role="status">Loading transaction history preference…</section>:historyHidden?<section className="account-panel card p-5"><div className="account-panel-title"><div><h2>Transaction history is hidden</h2><p className="account-panel-subtitle">Your funding and ledger records remain unchanged. Restore this list whenever you want.</p></div><button type="button" className="btn min-h-10 bg-white/5" onClick={()=>setHistoryVisibility(false)}>Restore history</button></div></section>:<>
		<DisplayCurrencyPanel values={displayValues}/>
		<section className="account-panel card p-5"><div className="account-panel-title"><div><h2><WalletCards size={17} className="gold"/> Funding requests</h2><p className="account-panel-subtitle">No request is a payment confirmation until its recorded review state says so.</p></div><button type="button" className="icon-action" aria-label="Refresh transaction history" onClick={()=>void load()}><RefreshCw size={15}/></button></div>
			<div className="mb-3 flex justify-end"><button type="button" className="text-link" disabled={!historyPreferenceReady} onClick={()=>setHistoryVisibility(true)}>Hide transaction list</button></div>
			<div className="transaction-history-filters" role="group" aria-label="Filter transactions">{(['ALL','DEPOSIT','WITHDRAWAL'] as const).map(value=><button key={value} type="button" aria-pressed={filter===value} onClick={()=>setFilter(value)}>{value==='ALL'?'All':value==='DEPOSIT'?'Deposits':'Withdrawals'}</button>)}</div>
			{error?<div className="account-empty transaction-history-error" role="alert"><p>{error}</p><button type="button" className="text-link" onClick={()=>void load(true)}><RefreshCw size={14}/> Retry</button></div>:loading&&!data?<div className="account-empty" role="status">Loading transaction history…</div>:transactions.length?<div className="transaction-history-list">{transactions.map(item=><Link className="transaction-history-row" href={`/wallet/transactions/${encodeURIComponent(item.id)}`} key={item.id}><span className={`transaction-history-icon ${item.type==='DEPOSIT'?'is-deposit':'is-withdrawal'}`}>{item.type==='DEPOSIT'?<ArrowDownLeft size={17}/>:<ArrowUpRight size={17}/>}</span><span className="transaction-history-main"><b>{item.type==='DEPOSIT'?'Deposit':'Withdrawal'} · {item.method}</b><small>{item.id}</small><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time></span><span className="transaction-history-amount">{money(item.amount,item.currency)}<small className={`status-pill status-${item.status.toLowerCase().replaceAll('_','-')}`}>{statusLabels[item.status]||item.status.replaceAll('_',' ')}</small></span></Link>)}</div>:<div className="notification-empty-state"><WalletCards size={25} aria-hidden="true"/><h3>{data?.transactions.length?'No matching requests':'No transactions yet'}</h3><p>{data?.transactions.length?'Choose another filter to see your requests.':'Funding requests will appear here after you submit them.'}</p><Link href="/wallet" className="text-link">Open wallet</Link></div>}
		</section>
		</>}
	</main></>;
}