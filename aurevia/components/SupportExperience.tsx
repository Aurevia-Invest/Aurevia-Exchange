'use client';

import {FormEvent,useCallback,useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import {useSession} from 'next-auth/react';
import {Bot,ChevronDown,Send,ShieldAlert,TicketCheck} from 'lucide-react';
import Nav from '@/components/Nav';

type ChatMessage={speaker:'user'|'nova';text:string};
type Conversation={id:string;subject:string;status:string;category:string;isComplaint:boolean;hasAttachment:boolean;createdAt:string;lastMessageAt:string;transaction?:{id:string;type:string;status:string;amount:string;currency:string}|null;messages:Array<{id:string;authorType:string;body:string;createdAt:string}>};
type Transaction={id:string;type:string;status:string;amount:string;currency:string};
type SupportContact={email:string;complaintsEmail:string;phone:string};
type DemoOrderDraft={instrumentId:string;symbol:string;side:'BUY'|'SELL';type:'MARKET';quantity:number;expectedPrice:number;observedAt:string;estimatedValue:number;accountMode:'DEMO';idempotencyKey:string};

function answerFor(question:string,mode:'DEMO'|'REAL'|null){
	const text=question.toLowerCase();
	if(/demo|real|account mode/.test(text))return 'DEMO and REAL accounts use separate Aurevia ledgers. DEMO trades are practice activity and do not affect REAL balances. Eligible REAL orders route to the Alpaca sandbox when enabled; provider-confirmed fills update the Aurevia ledger. Submit funding or withdrawal requests in Wallet for review. These requests remain internal ledger records; the application does not send an external payment or payout.';
	if(/deposit|payment|bitcoin|bank/.test(text))return 'Open Wallet to submit an available funding request. Approved REAL credits are posted to Aurevia’s internal ledger after review. A request or ledger credit is not confirmation of an external payment; no payment processor transfer is initiated here.';
	if(/withdraw|payout/.test(text))return 'Open Wallet, choose Withdraw, and provide the destination details. The amount is reserved while review is pending. It is debited only after administrator approval; this application does not send bank or cryptocurrency payouts.';
	if(/kyc|identity|verification/.test(text))return 'Open Verification to submit your identity details and supported identity documents for administrator review. REAL-account access may require approved verification. External identity verification is not configured.';
	if(/status|transaction|reference|id/.test(text))return 'Open Wallet and select the request reference to see its status, timestamps, review note, and recorded history. I cannot verify payment receipt or invent an external transaction ID.';
	if(/setting|profile|password|security/.test(text))return 'Open Settings to review your profile and available account controls. Use Logout in the navigation when you want to end your session.';
	if(/trade|market|order/.test(text))return mode==='DEMO'?'Open Trade to use the DEMO market workspace. DEMO prices and orders are for practice and remain separate from REAL activity.':mode==='REAL'?'Open Trade to submit an eligible REAL-mode order through the Alpaca sandbox when provider access is enabled. Order status follows provider confirmation; check the provider status if submission is unavailable.':'Sign in to select an account mode and review the trading features available to your account.';
	return 'I can help with account modes, deposits, withdrawals, verification, settings, and transaction statuses. For account-specific review, choose Contact Admin to open a support ticket.';
}

export default function SupportExperience(){
	const {data,status}=useSession();
	const mode=data?.user?.accountMode??null;
	const [messages,setMessages]=useState<ChatMessage[]>([{speaker:'nova',text:'Hello, I’m Nova AI, Aurevia’s platform support assistant. I can explain platform workflows, but I cannot verify payments or alter accounts.'}]);
	const conversationId=useRef<string|undefined>(undefined);
	const [question,setQuestion]=useState('');
	const [conversations,setConversations]=useState<Conversation[]>([]);
	const [transactions,setTransactions]=useState<Transaction[]>([]);
	const [selectedConversation,setSelectedConversation]=useState('');
	const [showEscalation,setShowEscalation]=useState(false);
	const [isComplaint,setIsComplaint]=useState(false);
	const [complaintCategory,setComplaintCategory]=useState<'GENERAL'|'FUNDING'|'WITHDRAWAL'|'ACCOUNT'|'SECURITY'>('GENERAL');
	const [ticketAttachment,setTicketAttachment]=useState<File|null>(null);
	const [subject,setSubject]=useState('');
	const [ticketMessage,setTicketMessage]=useState('');
	const [transactionId,setTransactionId]=useState('');
	const [reply,setReply]=useState('');
	const [notice,setNotice]=useState('');
	const [error,setError]=useState('');
	const [historyError,setHistoryError]=useState('');
	const [historyLoading,setHistoryLoading]=useState(false);
	const [busy,setBusy]=useState(false);
	const [aiAssisted,setAiAssisted]=useState<boolean|null>(null);
	const [contact,setContact]=useState<SupportContact>({email:'',complaintsEmail:'',phone:''});
	const [orderDraft,setOrderDraft]=useState<DemoOrderDraft|null>(null);

	useEffect(()=>{let active=true;fetch('/api/support/contact').then(response=>response.ok?response.json():null).then(result=>{if(active&&result)setContact(result)}).catch(()=>{});return()=>{active=false}},[]);

	const load=useCallback(async(showLoading=false)=>{
		if(status!=='authenticated')return;
		if(showLoading){setHistoryLoading(true);setConversations([]);setTransactions([]);setSelectedConversation('');setReply('')}
		try{
			const [supportResponse,walletResponse]=await Promise.all([fetch('/api/support'),fetch('/api/wallet')]);
			const [supportData,walletData]=await Promise.all([supportResponse.json(),walletResponse.json()]);
			if(!supportResponse.ok||!walletResponse.ok)throw new Error('Unable to load account support history.');
			setConversations(supportData);setTransactions(walletData.transactions);setHistoryError('');
		}catch(exception){setHistoryError(exception instanceof Error?exception.message:'Unable to load account support history.')}
		finally{if(showLoading)setHistoryLoading(false)}
	},[status]);
	useEffect(()=>{void load(true)},[load,mode]);

	const selected=conversations.find(item=>item.id===selectedConversation);
	async function ask(event:FormEvent<HTMLFormElement>){event.preventDefault();const text=question.trim();if(!text||busy)return;conversationId.current??=crypto.randomUUID();setBusy(true);setError('');setAiAssisted(false);setOrderDraft(null);setQuestion('');setMessages(current=>[...current,{speaker:'user',text}]);try{const response=await fetch('/api/support/nova',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({question:text,conversationId:conversationId.current})});const result=await response.json();if(!response.ok)throw new Error(result.error||'Nova is temporarily unavailable.');setAiAssisted(result.aiAssisted===true);setMessages(current=>[...current,{speaker:'nova',text:result.answer}]);setOrderDraft(result.orderDraft?{...result.orderDraft,idempotencyKey:crypto.randomUUID()}:null);}catch(exception){setError(exception instanceof Error?exception.message:'Nova is temporarily unavailable.');setMessages(current=>[...current,{speaker:'nova',text:answerFor(text,mode)}]);}finally{setBusy(false)}}

	async function confirmDemoOrder(){
		if(!orderDraft||busy||mode!=='DEMO')return;
		setBusy(true);setError('');setNotice('');
		try{
			const response=await fetch('/api/orders',{method:'POST',headers:{'content-type':'application/json','Idempotency-Key':orderDraft.idempotencyKey},body:JSON.stringify({
				instrumentId:orderDraft.instrumentId,
				side:orderDraft.side,
				type:orderDraft.type,
				quantity:orderDraft.quantity,
				expectedPrice:orderDraft.expectedPrice,
				observedAt:orderDraft.observedAt,
			})});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'The DEMO order could not be submitted.');
			setMessages(current=>[...current,{speaker:'nova',text:`Your explicitly confirmed DEMO order was accepted by the practice trading system. Recorded status: ${String(result.status||'unknown').replaceAll('_',' ').toLowerCase()}. Order reference: ${result.id}. This is not a REAL trade.`}]);
			setOrderDraft(null);
		}catch(exception){setError(exception instanceof Error?exception.message:'The DEMO order could not be submitted.');}
		finally{setBusy(false)}
	}

	async function escalate(event:FormEvent<HTMLFormElement>){
		event.preventDefault();if(status!=='authenticated'||busy)return;
		setBusy(true);setError('');setNotice('');
		try{
			const body=new FormData();body.append('action',isComplaint?'complaint':'ticket');body.append('category',complaintCategory);body.append('subject',subject);body.append('message',ticketMessage);if(transactionId)body.append('transactionId',transactionId);if(ticketAttachment)body.append('file',ticketAttachment);
			const response=await fetch('/api/support/ticket',{method:'POST',body});
			const result=await response.json();if(!response.ok)throw new Error(result.error||'Unable to create support ticket.');
			const delivery=result.emailDelivery==='sent'?'Support email sent.':result.emailDelivery==='failed'?'Email delivery failed; the ticket is still available in the admin queue.':'Email is not configured; the ticket is still available in the admin queue.';
			setNotice(`${isComplaint?'Complaint':'Ticket'} ${result.id} created. ${delivery}`);setSubject('');setTicketMessage('');setTransactionId('');setTicketAttachment(null);setShowEscalation(false);setIsComplaint(false);await load();
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to create support ticket.')}
		finally{setBusy(false)}
	}

	async function sendReply(event:FormEvent<HTMLFormElement>){
		event.preventDefault();if(!selected||!reply.trim()||busy)return;
		setBusy(true);setError('');
		try{
			const response=await fetch('/api/support',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'reply',conversationId:selected.id,message:reply})});
			const result=await response.json();if(!response.ok)throw new Error(result.error||'Unable to send support message.');
			setReply('');await load();
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to send support message.')}
		finally{setBusy(false)}
	}

	async function openAttachment(conversationId:string){
		try{const response=await fetch(`/api/support/${encodeURIComponent(conversationId)}/attachment`,{cache:'no-store'});const result=await response.json();if(!response.ok)throw new Error(result.error||'Attachment unavailable.');window.open(result.url,'_blank','noopener,noreferrer')}
		catch(exception){setError(exception instanceof Error?exception.message:'Attachment unavailable.')}
	}

	return <><Nav/><main className="account-page support-page">
		<header className="account-heading"><div><span className="account-kicker">AUREVIA CUSTOMER CARE</span><h1>Nova AI</h1><p>Aurevia’s AI support assistant for platform questions and account workflow guidance.</p></div><span className={`status-pill ${mode==='DEMO'?'mode-demo':mode==='REAL'?'mode-real':''}`}>{status==='authenticated'?`${mode||'ACCOUNT'} ACCOUNT`:'PUBLIC HELP'}</span></header>
		<div className="account-content-grid support-layout">
			<section id="nova" className="account-panel card p-5"><div className="account-panel-title"><div><h2><Bot size={17} className="gold"/> Nova AI assistant</h2><p className="account-panel-subtitle">{aiAssisted===null?'Open-ended questions may use configured AI; each reply identifies when AI was used.':aiAssisted?'AI-assisted response · verify important details against Aurevia records.':'Platform response · AI was not used for the latest answer.'}</p></div><div className="flex flex-wrap gap-2"><button type="button" className="text-link" onClick={()=>{setIsComplaint(false);setShowEscalation(!showEscalation)}}><ShieldAlert size={15}/> Contact Admin</button><button type="button" className="text-link" onClick={()=>{setIsComplaint(true);setShowEscalation(true)}}>File complaint</button></div></div>
				<div className="nova-thread" aria-live="polite">{messages.map((message,index)=><div className={`nova-message ${message.speaker==='user'?'is-user':''}`} key={`${message.speaker}-${index}`}><span>{message.speaker==='nova'?'NOVA AI':'YOU'}</span><p>{message.text}</p></div>)}</div>
				{orderDraft&&<div className="account-callout mt-3" role="group" aria-label="DEMO order confirmation"><div><b>DEMO order preview</b><p className="mt-1 text-sm">{orderDraft.side} {orderDraft.quantity} {orderDraft.symbol} · MARKET · internal reference {orderDraft.expectedPrice} · estimated notional {orderDraft.estimatedValue}</p><p className="mt-1 text-xs muted">This sends a DEMO order only. The reference price may change; the API revalidates the order. No REAL order will be sent.</p></div><button className="btn bg-gold text-black" type="button" disabled={busy||mode!=='DEMO'} onClick={()=>void confirmDemoOrder()}>{busy?'Submitting…':'Confirm DEMO order'}</button><button className="btn bg-white/5" type="button" disabled={busy} onClick={()=>setOrderDraft(null)}>Cancel</button></div>}
				<form onSubmit={ask} className="nova-input-row"><input className="input" value={question} maxLength={800} onChange={event=>setQuestion(event.target.value)} placeholder="Ask about accounts, funding, or verification" aria-label="Ask Nova AI"/><button className="btn bg-gold text-black" type="submit" aria-label="Send question" disabled={!question.trim()}><Send size={15}/></button></form>
				<p className="mt-3 text-xs leading-5 muted">Nova cannot approve transactions, change balances, bypass verification, or confirm receipt of funds.</p>
				{showEscalation&&<form onSubmit={escalate} className="account-form-grid mt-5 border-t border-white/10 pt-5"><div className="md:col-span-2"><h3 className="text-sm font-semibold">{isComplaint?'File a complaint':'Escalate to Admin'}</h3><p className="mt-1 text-xs muted">Your authenticated user ID and active account mode are attached by the server.</p></div>{status==='authenticated'?<>
					<label className="account-label">Category<select className="input" value={complaintCategory} onChange={event=>setComplaintCategory(event.target.value as typeof complaintCategory)}><option value="GENERAL">General</option><option value="FUNDING">Funding</option><option value="WITHDRAWAL">Withdrawal</option><option value="ACCOUNT">Account</option><option value="SECURITY">Security</option></select></label>
					<label className="account-label">Subject<input className="input" required minLength={3} maxLength={120} value={subject} onChange={event=>setSubject(event.target.value)}/></label>
					<label className="account-label">Related transaction (optional)<select className="input" value={transactionId} onChange={event=>setTransactionId(event.target.value)}><option value="">No transaction selected</option>{transactions.map(transaction=><option key={transaction.id} value={transaction.id}>{transaction.type} · {transaction.id} · {transaction.status}</option>)}</select></label>
					<label className="account-label md:col-span-2">Message<textarea className="input min-h-24" required minLength={3} maxLength={4000} value={ticketMessage} onChange={event=>setTicketMessage(event.target.value)}/></label>
					<label className="account-label md:col-span-2">Attachment (optional)<input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={event=>setTicketAttachment(event.target.files?.[0]||null)}/><small className="muted">Private PDF or image · maximum 5 MB</small></label>
					<div className="md:col-span-2"><button className="btn bg-gold text-black" disabled={busy}>{busy?'Sending…':'Create support ticket'}</button></div>
				</>:<p className="muted md:col-span-2">Sign in to create a ticket tied to your account. <Link className="gold" href="/login">Sign in</Link></p>}</form>}
				{notice&&<p className="mt-3 text-sm text-profit" role="status">{notice}</p>}{error&&<p className="mt-3 text-sm text-loss" role="alert">{error}</p>}
			</section>
			<aside className="account-panel card p-5"><div className="account-panel-title"><div><h2><TicketCheck size={17} className="gold"/> Your support tickets</h2><p className="account-panel-subtitle">Private to your account and selected mode</p></div></div>{status!=='authenticated'?<p className="account-empty">Sign in to view your support history.</p>:historyLoading?<p className="account-empty" role="status">Loading support tickets…</p>:historyError?<div className="account-empty transaction-history-error" role="alert"><span>{historyError}</span><button type="button" className="text-link" onClick={()=>void load(true)}>Retry</button></div>:conversations.length?<div className="support-ticket-list">{conversations.map(conversation=><article className="support-ticket" key={conversation.id}><button type="button" className="support-ticket-toggle" aria-expanded={selectedConversation===conversation.id} onClick={()=>setSelectedConversation(selectedConversation===conversation.id?'':conversation.id)}><span>{conversation.subject}</span><small>{conversation.isComplaint?'Complaint · ':''}{conversation.status.replaceAll('_',' ')} · {new Date(conversation.lastMessageAt||conversation.createdAt).toLocaleString()}</small>{conversation.transaction&&<small>Reference {conversation.transaction.id}</small>}<ChevronDown size={14}/></button>{selectedConversation===conversation.id&&<div className="support-message-list"><div className="support-message-history">{conversation.messages.map(item=><div key={item.id}><b>{item.authorType.replaceAll('_',' ')}</b><p>{item.body}</p></div>)}</div>{conversation.hasAttachment&&<button type="button" className="text-link" onClick={()=>void openAttachment(conversation.id)}>View private attachment</button>}{!['RESOLVED','CLOSED'].includes(conversation.status)&&<form onSubmit={sendReply} className="support-reply"><input className="input" value={reply} onChange={event=>setReply(event.target.value)} maxLength={4000} placeholder="Reply to support ticket" aria-label="Reply to support ticket"/><button className="btn bg-gold text-black" type="submit" disabled={busy||!reply.trim()} aria-label="Send reply"><Send size={14}/></button></form>}</div>}</article>)}</div>:<p className="account-empty">No support tickets yet.</p>}</aside>
			<section className="account-panel card p-5 support-contact-panel"><div className="account-panel-title"><div><h2>Contact support</h2><p className="account-panel-subtitle">Reach the support team directly or create a ticket for admin review.</p></div><ShieldAlert size={18} className="gold"/></div>{contact.email?<a href={`mailto:${contact.email}`}>{contact.email}</a>:<p className="text-sm muted">Direct email is not configured. Authenticated support tickets remain available.</p>}{contact.complaintsEmail&&contact.complaintsEmail!==contact.email&&<a href={`mailto:${contact.complaintsEmail}`}>Complaints: {contact.complaintsEmail}</a>}{contact.phone&&<a href={`tel:${contact.phone.replaceAll(/[^+\d]/g,'')}`}>Call or text {contact.phone}</a>}<p className="text-xs muted">Nova cannot confirm or perform payments. Human review is available through support tickets.</p></section>
		</div>
	</main></>;
}