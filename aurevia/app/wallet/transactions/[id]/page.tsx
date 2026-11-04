'use client';

import {useEffect,useState} from 'react';
import Link from 'next/link';
import {useParams} from 'next/navigation';
import {useSession} from 'next-auth/react';
import {ArrowLeft,Clock3,FileClock,ShieldCheck} from 'lucide-react';
import Nav from '@/components/Nav';
import DisplayCurrencyPanel from '@/components/DisplayCurrencyPanel';
import ReceiptGenerator,{type ReceiptData} from '@/components/ReceiptGenerator';
import {formatUsd} from '@/lib/currency-format';

type FundingTransaction={
	id:string;
	aureviaExchangeId:string|null;
	accountMode:'DEMO'|'REAL';
	type:'DEPOSIT'|'WITHDRAWAL';
	amount:string|number;
	creditedAmount:string|number|null;
	creditedCurrency:string|null;
	feeAmount:string|number|null;
	feePercent:string|number|null;
	currency:string;
	status:string;
	method:string;
	createdAt:string;
	updatedAt:string;
	settledAt:string|null;
	settlementReference:string|null;
	processingReference:string|null;
	transactionReference:string|null;
	referenceInfo:string|null;
		senderInfo:string|null;
		destinationInfo:string|null;
	note:string|null;
	reviewedAt:string|null;
	network:string|null;
	withdrawalDestination:{nickname:string;maskedLabel:string}|null;
	hasEvidence:boolean;
	adminNote:string|null;
};
type Detail={transaction:FundingTransaction;history:Array<{action:string;createdAt:string;actor?:{name?:string|null;role:string}|null}>};

const labels:Record<string,string>={PENDING:'Pending',PENDING_REVIEW:'Pending review',PROCESSING:'Processing',APPROVED:'Approved',COMPLETED:'Completed',FAILED:'Failed',REVERSED:'Reversed',REJECTED:'Rejected',CANCELLED:'Cancelled'};
const formatDate=(value?:string|null)=>value?new Date(value).toLocaleString():'Not recorded';
const formatAmount=(value:string|number,currency:string)=>currency.toUpperCase()==='USD'?formatUsd(value):`${Number(value).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:8})} ${currency}`;
const receiptStatus=(status:string):ReceiptData['status']|null=>{
	switch(status){
		case 'PENDING':case 'PENDING_REVIEW':case 'PROCESSING':case 'APPROVED':case 'COMPLETED':case 'REJECTED':case 'CANCELLED':case 'FAILED':case 'REVERSED':return status;
		default:return null;
	}
};

export default function TransactionDetailPage(){
	const {id}=useParams<{id:string}>();
	const {data:session}=useSession();
	const [data,setData]=useState<Detail|null>(null);
	const [error,setError]=useState('');
	useEffect(()=>{
		let active=true;
		const load=async()=>{try{const response=await fetch(`/api/funding/${encodeURIComponent(id)}`,{cache:'no-store'});const result=await response.json();if(!response.ok)throw new Error(result.error||'Unable to load transaction.');if(active)setData(result);if(active)setError('')}catch(exception){if(active)setError(exception instanceof Error?exception.message:'Unable to load transaction.')}};
		setData(null);setError('');void load();
		const refresh=()=>{if(document.visibilityState==='visible')void load()};
		const timer=window.setInterval(refresh,5_000);
		window.addEventListener('focus',refresh);
		document.addEventListener('visibilitychange',refresh);
		return()=>{active=false;window.clearInterval(timer);window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh)};
	},[id,session?.user?.accountMode]);
	const transaction=data?.transaction;
	const status=transaction?receiptStatus(transaction.status):null;
	const displayValues=transaction?.currency?.toUpperCase()==='USD'?[{label:'Amount requested',amount:String(transaction.amount)},...(transaction.feeAmount!==null&&transaction.feeAmount!==undefined?[{label:`Deposit fee (${transaction.feePercent??10}%)`,amount:String(transaction.feeAmount)}]:[]),...(transaction.creditedAmount!==null&&transaction.creditedAmount!==undefined?[{label:'Amount credited',amount:String(transaction.creditedAmount)}]:[])]:[];
	return <><Nav/><main className="account-page">
		<Link href="/wallet" className="text-link"><ArrowLeft size={15}/> Back to wallet</Link>
		{error?<section className="account-panel card mt-4 p-5"><p className="text-loss" role="alert">{error}</p></section>:!transaction?<section className="account-panel card mt-4 p-5" role="status">Loading transaction details…</section>:<>
			<header className="account-heading mt-5"><div><span className="account-kicker">{transaction.accountMode} ACCOUNT · Transaction detail</span><h1>{transaction.type==='DEPOSIT'?'Deposit':'Withdrawal'} request</h1><p>Internal request reference <span className="font-mono">{transaction.id}</span></p></div><span className="status-pill">{labels[transaction.status]||transaction.status}</span></header>
			<DisplayCurrencyPanel values={displayValues}/>
			{status?<section className="mt-5" aria-label="Printable transaction receipt"><ReceiptGenerator receipt={{
				id:transaction.id,
				reference:transaction.settlementReference||transaction.id,
				status,
				type:transaction.type,
				accountMode:transaction.accountMode,
				simulated:transaction.accountMode==='DEMO',
				createdAt:transaction.createdAt,
				reviewedAt:transaction.reviewedAt,
				completedAt:transaction.settledAt,
				accountReference:`USER:${session?.user?.id||'account'}:${transaction.accountMode}:${transaction.currency}`,
								externalReference:transaction.transactionReference,
								network:transaction.network,
								referenceInfo:transaction.referenceInfo,
								senderInfo:transaction.senderInfo,
								destinationInfo:transaction.destinationInfo,
				processingReference:transaction.processingReference,
				aureviaExchangeId:transaction.aureviaExchangeId,
				name:session?.user?.name||'',
				email:session?.user?.email||'',
				amount:transaction.amount,
				currency:transaction.currency,
				creditedAmount:transaction.creditedAmount??undefined,
				creditedCurrency:transaction.creditedCurrency,
				fee:transaction.feeAmount??undefined,
				feeTreatment:transaction.feeAmount!==null?'DEDUCTED':undefined,
				method:transaction.method,
				recipientName:transaction.withdrawalDestination?.nickname,
				recipientNumber:transaction.withdrawalDestination?.maskedLabel,
				purpose:transaction.note,
				adminNote:transaction.adminNote,
			}}/></section>:<div className="account-callout mt-4" role="status">A receipt is not available for this transaction status. The authenticated transaction record remains available below.</div>}
			<div className="account-content-grid">
				<section className="account-panel card p-5"><div className="account-panel-title"><div><h2>Request details</h2><p className="account-panel-subtitle">This request is recorded for Aurevia’s internal paper ledger only. No payment processor, broker, bank, or cryptocurrency network is contacted.</p></div><FileClock size={18} className="gold" aria-hidden="true"/></div><dl className="transaction-detail-grid"><Detail label="Amount requested" value={formatAmount(transaction.amount,transaction.currency)}/>{transaction.feeAmount!==null&&transaction.feeAmount!==undefined&&<Detail label={`Deposit fee (${transaction.feePercent??10}%)`} value={formatAmount(transaction.feeAmount,transaction.currency)}/ >}{transaction.creditedAmount!==null&&transaction.creditedAmount!==undefined&&<Detail label="Ledger amount posted" value={formatAmount(transaction.creditedAmount,transaction.creditedCurrency||transaction.currency)}/>}<Detail label="Operation" value={transaction.method}/><Detail label="Submitted" value={formatDate(transaction.createdAt)}/><Detail label="Last updated" value={formatDate(transaction.updatedAt)}/><Detail label={transaction.network==='BITCOIN_MAINNET'?'Bitcoin TXID':'User-submitted reference'} value={transaction.transactionReference||(transaction.network==='BITCOIN_MAINNET'?'Not provided':transaction.referenceInfo||'Not provided')}/>{transaction.network==='BITCOIN_MAINNET'&&<><Detail label="BTC network" value="Bitcoin mainnet (BTC)"/><Detail label="Reported deposit date/time" value={transaction.referenceInfo||'Not provided'}/><Detail label="Sender details · unverified" value={transaction.senderInfo||'Not provided'}/><Detail label="Configured BTC destination" value={transaction.destinationInfo||'Unavailable'}/></>}{transaction.note&&<Detail label="Your note" value={transaction.note}/>}</dl></section>
				<aside className="account-panel card p-5"><div className="account-panel-title"><div><h2>Review status</h2><p className="account-panel-subtitle">{transaction.status==='COMPLETED'?'The internal ledger debit was posted on administrator approval.':transaction.status==='APPROVED'?'The administrator approved this request and the internal ledger was updated.':transaction.status==='REJECTED'?'The request was rejected; no ledger amount was posted.':'This request awaits administrator review; no ledger amount has been posted.'}</p></div><ShieldCheck size={18} className="gold" aria-hidden="true"/></div><dl className="space-y-4"><Detail label="Reviewed" value={formatDate(transaction.reviewedAt)}/><Detail label="Attachment" value={transaction.hasEvidence?'User-submitted information for administrator review; not independently verified.':'None'}/><Detail label="Administrator note" value={transaction.adminNote||'No note recorded'}/></dl><p className="mt-5 text-xs leading-5 muted">Aurevia records internal paper-ledger entries only. This request does not represent funds received, held assets, broker execution, or an external transfer.</p></aside>
		</div>
		<section className="account-panel card mt-4 p-5"><div className="account-panel-title"><div><h2>Status history</h2><p className="account-panel-subtitle">Submission and administrator review events.</p></div><Clock3 size={18} className="gold" aria-hidden="true"/></div>{data.history.length?<ol className="activity-list">{data.history.map((entry,index)=><li className="activity-row" key={`${entry.action}-${entry.createdAt}-${index}`}><span className="activity-type">{entry.action.replaceAll('_',' ')}</span><span className="activity-reference">{formatDate(entry.createdAt)}</span><span className="muted">{entry.actor?.role==='ADMIN'?entry.actor.name||'Administrator':'You'}</span></li>)}</ol>:<p className="account-empty">Submitted {formatDate(transaction.createdAt)} · awaiting review.</p>}</section>
		</>}
	</main></>;
}

function Detail({label,value}:{label:string;value:string}){return <div><dt className="muted text-xs">{label}</dt><dd className="mt-1 break-words text-sm">{value}</dd></div>}