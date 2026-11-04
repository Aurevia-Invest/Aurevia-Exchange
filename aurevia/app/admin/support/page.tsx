'use client';

import {FormEvent,useCallback,useEffect,useState} from 'react';
import Link from 'next/link';
import {ArrowLeft,CheckCheck,MessageSquareText,RefreshCw,Send,Sparkles,Trash2} from 'lucide-react';
import AdminNav from '@/components/AdminNav';

type Conversation={id:string;user:{id:string;email:string;name:string|null};accountMode:'DEMO'|'REAL';subject:string;status:string;priority:string;category:string;isComplaint:boolean;hasAttachment:boolean;createdAt:string;updatedAt:string;lastMessageAt:string;transaction:{id:string;type:string;accountMode:'DEMO'|'REAL';status:string;amount:string;currency:string}|null;messages:Array<{id:string;authorType:string;body:string;createdAt:string}>};
type TicketStatus='OPEN'|'IN_REVIEW'|'WAITING_FOR_USER'|'RESOLVED'|'CLOSED';
type TicketPriority='LOW'|'NORMAL'|'HIGH'|'URGENT';
type Classification={category:string;priority:string;rationale:string};

export default function AdminSupport(){
	const [items,setItems]=useState<Conversation[]>([]);
	const [selectedId,setSelectedId]=useState('');
	const [message,setMessage]=useState('');
	const [notice,setNotice]=useState('');
	const [error,setError]=useState('');
	const [busy,setBusy]=useState(false);
	const [draftBusy,setDraftBusy]=useState(false);
	const [classificationBusy,setClassificationBusy]=useState(false);
	const [classification,setClassification]=useState<{conversationId:string;suggestion:Classification}|null>(null);
	const [loading,setLoading]=useState(true);
	const [search,setSearch]=useState('');
	const [query,setQuery]=useState('');
	const [statusFilter,setStatusFilter]=useState('');
	const [priorityFilter,setPriorityFilter]=useState('');
	const selected=items.find(item=>item.id===selectedId);

	const load=useCallback(async()=>{
		setLoading(true);
		try{const params=new URLSearchParams();if(query)params.set('q',query);if(statusFilter)params.set('status',statusFilter);if(priorityFilter)params.set('priority',priorityFilter);const response=await fetch(`/api/admin/support?${params}`);const result=await response.json();if(!response.ok)throw new Error('Administrator authorization required.');setItems(result);setError('');setSelectedId(current=>result.some((item:Conversation)=>item.id===current)?current:result[0]?.id||'')}
		catch(exception){setError(exception instanceof Error?exception.message:'Unable to load support inbox.')}
		finally{setLoading(false)}
	},[query,statusFilter,priorityFilter]);
	useEffect(()=>{void load()},[load]);

	
	async function draftWithAi(){
		if(!selected||draftBusy)return;
		setDraftBusy(true);setError('');setNotice('');
		try{
			const thread=selected.messages.slice(-6).map(item=>`${item.authorType}: ${item.body}`).join('\n');
			const response=await fetch('/api/admin/ai-draft',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({purpose:'support_reply',context:`Ticket subject: ${selected.subject}\nUser: ${selected.user.email}\nStatus: ${selected.status}\nRecent thread:\n${thread}\n\nDraft a reply the admin can edit before sending.`})});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to draft reply.');
			setMessage(result.draft||'');
			setNotice('AI draft inserted — review before sending.');
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to draft reply.');}
		finally{setDraftBusy(false)}
	}

	async function classifyWithAi(){
		if(!selected||classificationBusy)return;
		setClassificationBusy(true);setError('');setNotice('');setClassification(null);
		try{
			const response=await fetch('/api/admin/support/classify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({conversationId:selected.id})});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to classify ticket.');
			if(result.applied!==false)throw new Error('Unexpected ticket-classification response.');
			setClassification({conversationId:selected.id,suggestion:result.suggestion});
			setNotice('AI suggestion only — no ticket fields were changed.');
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to classify ticket.')}
		finally{setClassificationBusy(false)}
	}

	async function update(action:'reply'|'resolve'|'status'|'priority',value?:string,event?:FormEvent<HTMLFormElement>){
		event?.preventDefault();if(!selected||busy)return;setBusy(true);setError('');setNotice('');
		try{
			const response=await fetch('/api/admin/support',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({action,conversationId:selected.id,...(action==='reply'?{message}:action==='status'?{status:value}:action==='priority'?{priority:value}:{})})});
			const result=await response.json();if(!response.ok)throw new Error(result.error||'Unable to update ticket.');
			setMessage('');setNotice(action==='reply'?'Response sent to the user.':action==='priority'?'Ticket priority updated.':'Ticket updated.');await load();
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to update ticket.')}
		finally{setBusy(false)}
	}

	async function deleteConversation(){
		if(!selected||busy||!window.confirm('Permanently delete this support conversation, its messages, and attached file?'))return;
		setBusy(true);setError('');setNotice('');
		try{
			const response=await fetch('/api/admin/support',{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({conversationId:selected.id,confirmation:'DELETE'})});
			const result=await response.json();if(!response.ok)throw new Error(result.error||'Unable to delete this conversation.');
			setSelectedId('');setClassification(null);setNotice('Support conversation deleted.');await load();
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to delete this conversation.')}
		finally{setBusy(false)}
	}

	async function openAttachment(conversationId:string){
		try{const response=await fetch(`/api/admin/support/${encodeURIComponent(conversationId)}/attachment`,{cache:'no-store'});const result=await response.json();if(!response.ok)throw new Error(result.error||'Attachment unavailable.');window.open(result.url,'_blank','noopener,noreferrer')}
		catch(exception){setError(exception instanceof Error?exception.message:'Attachment unavailable.')}
	}

	return <><AdminNav/><main className="account-page">
		<header className="account-heading"><div><span className="account-kicker">ADMINISTRATION · CUSTOMER SUPPORT</span><h1>Support inbox</h1><p>Review private Nova escalations and respond using the recorded account context.</p></div><div className="flex gap-2"><Link className="button-secondary" href="/admin"><ArrowLeft size={14}/> Admin home</Link><button className="icon-action" type="button" aria-label="Refresh support inbox" onClick={()=>void load()}><RefreshCw size={15}/></button></div></header>
		{notice&&<p className="mb-3 text-sm text-profit" role="status">{notice}</p>}{error&&<p className="mb-3 text-sm text-loss" role="alert">{error}</p>}
		<div className="admin-support-layout">
			<aside className="account-panel card p-4"><div className="account-panel-title"><div><h2>Conversations</h2><p className="account-panel-subtitle">{items.length} tickets</p></div><MessageSquareText size={18} className="gold"/></div><form className="admin-support-filters" onSubmit={event=>{event.preventDefault();setQuery(search.trim())}}><input className="input" value={search} onChange={event=>setSearch(event.target.value)} placeholder="Search subject or user"/><select className="input" value={statusFilter} onChange={event=>setStatusFilter(event.target.value)} aria-label="Filter tickets by status"><option value="">All statuses</option><option value="OPEN">Open</option><option value="IN_REVIEW">In review</option><option value="WAITING_FOR_USER">Waiting for user</option><option value="RESOLVED">Resolved</option><option value="CLOSED">Closed</option></select><select className="input" value={priorityFilter} onChange={event=>setPriorityFilter(event.target.value)} aria-label="Filter tickets by priority"><option value="">All priorities</option><option value="LOW">Low</option><option value="NORMAL">Normal</option><option value="HIGH">High</option><option value="URGENT">Urgent</option></select><button className="btn bg-white/5" type="submit">Search</button></form>{loading?<p className="account-empty">Loading inbox…</p>:items.length?<div className="support-ticket-list">{items.map(item=><button type="button" key={item.id} className={`support-inbox-item ${selectedId===item.id?'is-selected':''}`} onClick={()=>{setSelectedId(item.id);setClassification(null)}}><b>{item.subject}</b><span>{item.user.name||item.user.email}</span><small>{item.isComplaint?`Complaint · ${item.category}`:`${item.category} · ${item.priority}`} · {item.accountMode} · {item.status.replaceAll('_',' ')}</small><small>{item.messages[0]?.body||'No messages yet'}</small><small>{new Date(item.lastMessageAt).toLocaleString()}</small></button>)}</div>:<p className="account-empty">No support tickets match these filters.</p>}</aside>
			<section className="account-panel card p-5">{!selected?<div className="account-empty">Choose a ticket to review.</div>:<>
				<div className="account-panel-title"><div><span className={`status-pill ${selected.accountMode==='DEMO'?'mode-demo':'mode-real'}`}>{selected.accountMode} ACCOUNT</span><h2 className="mt-3">{selected.subject}</h2><p className="account-panel-subtitle">Ticket {selected.id} · {selected.status.replaceAll('_',' ')} · {selected.category}</p></div><span className="muted text-xs">{new Date(selected.createdAt).toLocaleString()}</span></div>
				<div className="admin-support-ticket-controls"><label className="account-label">Status<select className="input" value={selected.status} onChange={event=>void update('status',event.target.value)}>{(['OPEN','IN_REVIEW','WAITING_FOR_USER','RESOLVED','CLOSED'] as TicketStatus[]).map(value=><option value={value} key={value}>{value.replaceAll('_',' ')}</option>)}</select></label><label className="account-label">Priority<select className="input" value={selected.priority||'NORMAL'} onChange={event=>void update('priority',event.target.value)}>{(['LOW','NORMAL','HIGH','URGENT'] as TicketPriority[]).map(value=><option value={value} key={value}>{value}</option>)}</select></label><button type="button" className="btn bg-white/5" disabled={classificationBusy} onClick={()=>void classifyWithAi()}>{classificationBusy?'Classifying…':<><Sparkles size={14}/>Suggest classification</>}</button><button type="button" className="btn border border-loss/40 bg-loss/10 text-loss" disabled={busy} onClick={()=>void deleteConversation()}><Trash2 size={14}/>Delete conversation</button></div>
				{classification?.conversationId===selected.id&&<div className="account-callout mt-3" role="status"><strong>AI suggestion — review manually</strong><p>Category: {classification.suggestion.category} · Priority: {classification.suggestion.priority}</p><p>{classification.suggestion.rationale}</p><small>No ticket fields were changed.</small></div>}
				<dl className="support-context"><div><dt>User</dt><dd>{selected.user.name||'Name not provided'} · {selected.user.email}</dd></div><div><dt>User ID</dt><dd className="font-mono">{selected.user.id}</dd></div>{selected.transaction&&<div><dt>Related transaction</dt><dd><span className="font-mono">{selected.transaction.id}</span><span className="muted"> · {selected.transaction.type} · {selected.transaction.accountMode} · {selected.transaction.status}</span></dd></div>}</dl>
				{selected.hasAttachment&&<button type="button" className="text-link" onClick={()=>void openAttachment(selected.id)}>View private attachment</button>}
				<div className="support-admin-messages">{selected.messages.slice().reverse().map(item=><article key={item.id}><div><b>{item.authorType}</b><time>{new Date(item.createdAt).toLocaleString()}</time></div><p>{item.body}</p></article>)}</div>
				{!['RESOLVED','CLOSED'].includes(selected.status)&&<form className="support-admin-reply" onSubmit={event=>void update('reply',undefined,event)}><label className="account-label">Admin response<textarea className="input min-h-24" required minLength={1} maxLength={4000} value={message} onChange={event=>setMessage(event.target.value)}/></label><div className="flex flex-wrap gap-2"><button type="button" className="btn bg-white/5" disabled={draftBusy||busy} onClick={()=>void draftWithAi()}>{draftBusy?'Drafting…':'Draft with AI'}</button><button className="btn bg-gold text-black" disabled={busy||!message.trim()}><Send size={14} className="mr-1 inline"/>{busy?'Sending…':'Send response'}</button><button type="button" className="btn bg-white/5" disabled={busy} onClick={()=>void update('resolve')}><CheckCheck size={14} className="mr-1 inline"/>Resolve</button></div></form>}
			</>}</section>
		</div>
	</main></>;
}