'use client';

import Image from 'next/image';
import Link from 'next/link';
import {useRef,useState} from 'react';
import {ArrowDownLeft,ArrowLeft,ArrowUpRight,Check,ClipboardCopy,Download,FileText,Printer,ShieldCheck,WalletCards} from 'lucide-react';
import html2canvas from 'html2canvas-pro';
import {jsPDF} from 'jspdf';
import {formatUsd} from '@/lib/currency-format';
import {removeSimulatedLabels} from '@/lib/display-copy';

export type ReceiptData={
	id:string;
	reference:string;
	status:'PENDING'|'PENDING_REVIEW'|'PROCESSING'|'APPROVED'|'COMPLETED'|'REJECTED'|'FAILED'|'CANCELLED'|'REVERSED';
	type?:'DEPOSIT'|'WITHDRAWAL'|'CREDIT'|'DEBIT';
	accountMode?:'DEMO'|'REAL';
	simulated?:boolean;
	isWithdrawal?:boolean;
	createdAt:string;
	reviewedAt?:string|null;
	completedAt?:string|null;
	reviewedBy?:{name:string|null}|null;
	accountReference?:string|null;
	aureviaExchangeId?:string|null;
	externalReference?:string|null;
	processingReference?:string|null;
	previousBalance?:number|string|null;
	resultingBalance?:number|string|null;
	adminNote?:string|null;
	name:string;
	email:string;
	amount:number|string;
	currency:string;
	creditedCurrency?:string|null;
	method:string;
	creditedAmount?:number|string;
	recipientName?:string|null;
	recipientNumber?:string|null;
	sourceName?:string|null;
	sourceNumber?:string|null;
	destinationName?:string|null;
	destinationNumber?:string|null;
	purpose?:string|null;
	fee?:number|string|null;
	feeTreatment?:'ADDED'|'DEDUCTED';
	gateway?:string|null;
	network?:string|null;
	referenceInfo?:string|null;
	senderInfo?:string|null;
	destinationInfo?:string|null;
};

const dateLabel=(value:string)=>{
	const date=new Date(value);
	return Number.isNaN(date.getTime())?'Not recorded':new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(date);
};
const amountLabel=(value:number|string,currency:string)=>{
	const amount=Number(value);
	if(!Number.isFinite(amount))return 'Not available';
	const code=currency.toUpperCase();
	return code==='USD'?formatUsd(Math.abs(amount)):`${Math.abs(amount).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:8})} ${code}`;
};

export default function ReceiptGenerator({receipt}:{receipt:ReceiptData}){
	const receiptRef=useRef<HTMLElement>(null);
	const [busy,setBusy]=useState(false);
	const [feedback,setFeedback]=useState('');
	const currentReceipt={
		...receipt,
		reference:removeSimulatedLabels(receipt.reference),
		accountReference:receipt.accountReference?removeSimulatedLabels(receipt.accountReference):receipt.accountReference,
		externalReference:receipt.externalReference?removeSimulatedLabels(receipt.externalReference):receipt.externalReference,
		processingReference:receipt.processingReference?removeSimulatedLabels(receipt.processingReference):receipt.processingReference,
		adminNote:receipt.adminNote?removeSimulatedLabels(receipt.adminNote):receipt.adminNote,
		method:removeSimulatedLabels(receipt.method),
		purpose:receipt.purpose?removeSimulatedLabels(receipt.purpose):receipt.purpose,
		gateway:receipt.gateway?removeSimulatedLabels(receipt.gateway):receipt.gateway,
	};
	const kind=currentReceipt.type||'DEPOSIT';
	const isWithdrawal=currentReceipt.isWithdrawal===true||kind==='WITHDRAWAL';
	const isSuccessful=currentReceipt.status==='COMPLETED';
	const isFailed=currentReceipt.status==='REJECTED'||currentReceipt.status==='FAILED'||currentReceipt.status==='CANCELLED'||currentReceipt.status==='REVERSED';
	const statusLabel=currentReceipt.status==='APPROVED'&&isWithdrawal
		?'Approved · payout not confirmed'
		:currentReceipt.status==='APPROVED'?'Approved'
		:currentReceipt.status==='COMPLETED'&&isWithdrawal?'Completed · admin-recorded payout'
		:currentReceipt.status==='COMPLETED'?'Completed · ledger record'
		:currentReceipt.status==='REJECTED'?'Rejected'
		:currentReceipt.status==='FAILED'?'Failed'
		:currentReceipt.status==='REVERSED'?'Reversed'
		:currentReceipt.status==='CANCELLED'?'Cancelled'
		:currentReceipt.status==='PENDING_REVIEW'?'Pending review'
		:currentReceipt.status==='PROCESSING'?'Processing'
		:'Pending';
	const receiptTitle=kind==='WITHDRAWAL'
		?currentReceipt.status==='COMPLETED'?'Withdrawal transaction receipt':'Withdrawal request receipt'
		:kind==='DEPOSIT'
			?currentReceipt.status==='COMPLETED'?'Deposit transaction receipt':'Deposit request receipt'
			:kind==='CREDIT'?'Account credit receipt':'Account debit receipt';
	const transactionLabel=kind==='CREDIT'?'Account credit':kind==='DEBIT'?'Account debit':kind==='WITHDRAWAL'?'Withdrawal':'Deposit';
	const recipientName=currentReceipt.recipientName||currentReceipt.destinationName||(isWithdrawal?'Saved destination':'Aurevia internal ledger');
	const recipientNumber=currentReceipt.recipientNumber||currentReceipt.destinationNumber||(isWithdrawal?'Sensitive destination details are masked':'Internal account entry');
	const gateway=currentReceipt.gateway||(currentReceipt.accountMode==='REAL'?'Internal Aurevia ledger':'DEMO practice ledger');
	const fileName=`aurevia-${kind.toLowerCase()}-${currentReceipt.status.toLowerCase()}-${currentReceipt.id}`;
	const numericAmount=Number(currentReceipt.amount);
	const numericFee=currentReceipt.fee===null||currentReceipt.fee===undefined?null:Number(currentReceipt.fee);
	const total=numericFee!==null&&Number.isFinite(numericAmount)&&Number.isFinite(numericFee)?currentReceipt.feeTreatment==='DEDUCTED'?Math.abs(numericAmount):Math.abs(numericAmount)+Math.abs(numericFee):null;
	const feeLabel=numericFee!==null&&Number.isFinite(numericFee)?amountLabel(numericFee,currentReceipt.currency):'Not recorded';
	const explanation=isWithdrawal
		?currentReceipt.status==='COMPLETED'
			?'An administrator recorded the processing reference and corresponding Aurevia ledger debit. This record does not independently verify a bank or blockchain provider.'
			:currentReceipt.status==='APPROVED'
				?'The request is approved and the amount remains reserved. No external payout has been confirmed.'
				:currentReceipt.status==='PROCESSING'
					?'The request is being processed. This status is not proof of payment.'
					:currentReceipt.status==='REVERSED'
						?'The transaction was reversed in the account ledger. This receipt does not represent a current completed transfer or credit.'
					:isFailed
						?'The request did not complete. This receipt does not represent a successful payout.'
						:'This confirms receipt of your withdrawal request only. It is not proof of payment.'
		:currentReceipt.status==='COMPLETED'
			?currentReceipt.feeTreatment==='DEDUCTED'?'The transaction is recorded as completed in Aurevia’s account ledger. The shown fee was deducted from the requested amount; this is not a bank or payment-provider receipt.':'The transaction is recorded as completed in Aurevia’s account ledger. This is an internal account record, not a bank or payment-provider receipt.'
			:currentReceipt.status==='APPROVED'
				?'This request has been approved. Refer to the ledger amount, if shown, for any amount actually posted; approval alone does not confirm external funds.'
				:currentReceipt.status==='REVERSED'
					?'The transaction was reversed in the account ledger. No current completed transfer or credit is represented.'
				:isFailed
					?'The transaction did not complete. No successful transfer or credit is represented by this receipt.'
					:'This receipt confirms a request in Aurevia’s internal account workflow. No completed transfer or credit is represented.';
	const statusHeading=isSuccessful?'Transaction Successful':isFailed?`Transaction ${statusLabel}`:statusLabel;
	const subtitle=isSuccessful
		?(isWithdrawal?'The recorded withdrawal is complete.':'The recorded ledger transaction is complete.')
		:currentReceipt.status==='REVERSED'?'This ledger transaction was reversed.'
		:isFailed?'This transaction was not completed.'
			:currentReceipt.status==='APPROVED'?'The request is approved; completion is not confirmed.'
				:'Your request is recorded and its current status is shown below.';
	const rows:Array<{label:string;value:string;emphasis?:boolean}>=[
		{label:'ACCOUNT',value:`${currentReceipt.name||'Account holder'} · ${currentReceipt.accountMode||'Mode not recorded'} · ${gateway}`},
		...(currentReceipt.aureviaExchangeId?[{label:'AUREVIA EXCHANGE ID',value:currentReceipt.aureviaExchangeId}]:[]),
		{label:isWithdrawal?'GROSS WITHDRAWAL':'AMOUNT',value:amountLabel(currentReceipt.amount,currentReceipt.currency)},
		{label:'FEE',value:feeLabel},
		{label:'TOTAL',value:total===null?'Not available':amountLabel(total,currentReceipt.currency),emphasis:true},
		{label:'METHOD',value:currentReceipt.method||'Not recorded'},
		{label:'REFERENCE ID',value:currentReceipt.reference||currentReceipt.id},
		{label:'STATUS',value:statusLabel},
		{label:'DATE & TIME',value:dateLabel(currentReceipt.createdAt)},
	];
		if(currentReceipt.network==='BITCOIN_MAINNET'){
			rows.push({label:'NETWORK',value:'Bitcoin mainnet (BTC)'});
			if(currentReceipt.referenceInfo)rows.push({label:'DEPOSIT TIME SUBMITTED',value:currentReceipt.referenceInfo});
			if(currentReceipt.senderInfo)rows.push({label:'SENDER DETAILS · UNVERIFIED',value:currentReceipt.senderInfo});
			if(currentReceipt.destinationInfo)rows.push({label:'CONFIGURED BTC DESTINATION',value:currentReceipt.destinationInfo});
		}
	if(isWithdrawal)rows.splice(1,0,{label:'DESTINATION',value:`${recipientName} · ${recipientNumber}`});
	if(currentReceipt.processingReference)rows.splice(rows.length-2,0,{label:'PROCESSING REFERENCE',value:currentReceipt.processingReference});
	if(currentReceipt.creditedAmount!==undefined&&currentReceipt.creditedAmount!==null)rows.splice(2,0,{label:isWithdrawal?'NET PAYOUT':'LEDGER CREDIT',value:amountLabel(currentReceipt.creditedAmount,currentReceipt.creditedCurrency||currentReceipt.currency)});
	const description=explanation;

	async function exportPdf(){
		if(!receiptRef.current||busy)return;
		setBusy(true);setFeedback('');
		try{
			await Promise.all(Array.from(receiptRef.current.querySelectorAll('img')).map(image=>image.decode().catch(()=>undefined)));
			const canvas=await html2canvas(receiptRef.current,{scale:2,backgroundColor:'#07140f',logging:false,useCORS:true});
			const pdf=new jsPDF({orientation:'portrait',unit:'px',format:[canvas.width,canvas.height]});
			pdf.addImage(canvas.toDataURL('image/png'),'PNG',0,0,canvas.width,canvas.height);
			pdf.save(`${fileName}.pdf`);
		}catch(exception){
			console.error('Unable to export receipt:',exception instanceof Error?exception.message:'Unknown error');
			setFeedback('This receipt could not be exported. Please try again.');
		}finally{setBusy(false)}
	}

	async function copyReference(){
		try{
			await navigator.clipboard.writeText(currentReceipt.reference||currentReceipt.id);
			setFeedback('Reference number copied.');
		}catch{
			setFeedback('Copy is unavailable in this browser. Select the reference number in the receipt.');
		}
	}

	async function copyExchangeId(){
		if(!currentReceipt.aureviaExchangeId)return;
		try{
			await navigator.clipboard.writeText(currentReceipt.aureviaExchangeId);
			setFeedback('Aurevia Exchange ID copied.');
		}catch{
			setFeedback('Copy is unavailable in this browser.');
		}
	}

	return <div className="aurevia-receipt-wrap">
		<article ref={receiptRef} className="receipt-container aurevia-receipt" aria-label={`${receiptTitle} · ${statusLabel}`}>
			<div className="receipt-frame">
				<header className="receipt-brand-header">
					<div className="receipt-brand">
						<Image src="/aurevia-logo.png" alt="" width={58} height={58} className="receipt-brand-emblem"/>
						<div className="receipt-brand-copy"><b>AUREVIA</b><strong>INVEST</strong><small>BUILD WEALTH · TRADE SMART · GROW TOGETHER</small></div>
					</div>
					<div className="receipt-header-document"><span>OFFICIAL RECEIPT</span><strong>TRANSACTION<br/>CONFIRMATION</strong><div><small>RECEIPT NUMBER</small><b>{currentReceipt.reference||currentReceipt.id}</b></div></div>
				</header>
				<div className="receipt-divider"/>
				<section className="receipt-confirmation">
					<span className={`receipt-confirmation-icon ${isSuccessful?'is-success':isFailed?'is-failed':'is-pending'}`}>{isSuccessful?<Check size={27}/>:isFailed?<span aria-hidden="true">!</span>:<WalletCards size={24}/>}</span>
					<div className="receipt-confirmation-copy"><span className="receipt-kicker">TRANSACTION CONFIRMATION</span><h2>{statusHeading}</h2><p>{subtitle}</p></div>
					<div className="receipt-confirmation-date"><small>DATE &amp; TIME</small><strong>{dateLabel(currentReceipt.createdAt)}</strong></div>
				</section>
				<section className="receipt-details-card" aria-label="Transaction details">
					<header className="receipt-details-heading"><span className="receipt-transaction-icon">{kind==='DEPOSIT'||kind==='CREDIT'?<ArrowDownLeft size={17}/>:<ArrowUpRight size={17}/>}</span><div><small>TRANSACTION TYPE</small><h3>{transactionLabel}</h3></div><span className={`receipt-status ${isSuccessful?'is-success':isFailed?'is-failed':'is-pending'}`}><i aria-hidden="true"/>{statusLabel}</span></header>
					<dl className="receipt-detail-rows">{rows.map(row=><ReceiptRow key={row.label} label={row.label} value={row.value} emphasis={row.emphasis}/>)}</dl>
				</section>
				<section className="receipt-information">
					<header><FileText size={18}/><h3>Transaction Details</h3></header>
					<p>{description}</p>
					<p className="receipt-record-source">Record source: {gateway}</p>
					{currentReceipt.externalReference&&<p className="receipt-user-reference"><b>User-provided reference · unverified</b><span>{currentReceipt.externalReference}</span></p>}
					<p className="receipt-thank-you">Thank you for choosing Aurevia Exchange.</p>
					<div className="receipt-security"><ShieldCheck size={19}/><div><strong>Secure · Encrypted · Trusted</strong><small>Your transaction details are presented from the authorized account record. Keep this receipt private.</small></div></div>
				</section>
				<footer className="receipt-footer">
					<p>Your Future. Our Priority.</p>
					<div className="receipt-seal" aria-label="Aurevia Exchange seal"><Image src="/aurevia-logo.png" alt="" width={44} height={44}/><span>AUREVIA<br/>EXCHANGE</span></div>
					<small>{currentReceipt.accountMode==='REAL'?'REAL · INTERNAL LEDGER RECORD':currentReceipt.accountMode==='DEMO'?'DEMO · VIRTUAL ACCOUNT RECORD':'AUREVIA ACCOUNT RECORD'}</small>
				</footer>
			</div>
		</article>
		<div className="receipt-actions no-print" aria-label="Receipt actions">
			<button type="button" className="receipt-action" disabled={busy} onClick={()=>void exportPdf()}><Download size={15}/>{busy?'Preparing PDF…':'Download PDF'}</button>
			<button type="button" className="receipt-action" onClick={()=>window.print()}><Printer size={15}/>Print Receipt</button>
			{currentReceipt.aureviaExchangeId&&<button type="button" className="receipt-action" onClick={()=>void copyExchangeId()}><ClipboardCopy size={15}/>Copy Aurevia ID</button>}
			<button type="button" className="receipt-action" onClick={()=>void copyReference()}><ClipboardCopy size={15}/>Copy Reference Number</button>
			<Link href="/wallet" className="receipt-action"><ArrowLeft size={15}/>Return to Wallet</Link>
		</div>
		{feedback&&<p className="receipt-feedback no-print" role="status">{feedback}</p>}
	</div>;
}

function ReceiptRow({label,value,emphasis=false}:{label:string;value:string;emphasis?:boolean}){
	return <div className={`receipt-row ${emphasis?'is-total':''}`}><dt>{label}</dt><dd>{value||'Not recorded'}</dd></div>;
}
