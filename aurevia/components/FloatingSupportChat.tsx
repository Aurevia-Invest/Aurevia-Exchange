'use client';

import {FormEvent,useCallback,useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import {useSession} from 'next-auth/react';
import {LifeBuoy,MessageCircle,Minus,Move,Send,X} from 'lucide-react';
import {clampSupportChatPosition,dockSupportChatPosition,nearestSupportChatSide,SupportChatSide} from '@/lib/support-chat-position';

type SupportMessage={id:string;authorType:string;body:string;createdAt:string};
type Conversation={id:string;subject:string;status:string;messages:SupportMessage[]};
type Position={left:number;top:number};
type SavedPosition=Position&{side?:SupportChatSide};
type DragState={pointerId:number;startX:number;startY:number;left:number;top:number};

const positionKey='aurevia-support-chat-position';
const launcherSize=56;
const seenMessageKey='aurevia-support-chat-seen';

export default function FloatingSupportChat(){
	const {data:session,status}=useSession();
	const [open,setOpen]=useState(false);
	const [dockSide,setDockSide]=useState<SupportChatSide>('right');
	const [launcherRevealed,setLauncherRevealed]=useState(false);
	const [hasUnread,setHasUnread]=useState(false);
	const [position,setPosition]=useState<Position|null>(null);
	const [conversations,setConversations]=useState<Conversation[]>([]);
	const [selectedId,setSelectedId]=useState('');
	const [subject,setSubject]=useState('');
	const [message,setMessage]=useState('');
	const [reply,setReply]=useState('');
	const [busy,setBusy]=useState(false);
	const [error,setError]=useState('');
	const [notice,setNotice]=useState('');
	const drag=useRef<DragState|null>(null);
	const dragged=useRef(false);
	const animationFrame=useRef<number|null>(null);
	const messageList=useRef<HTMLDivElement>(null);
	const latestActivity=useRef<string|null>(null);
	const selected=conversations.find(conversation=>conversation.id===selectedId);
	const userId=session?.user?.id;

	const clamp=useCallback((next:Position)=>clampSupportChatPosition(next,open,{width:window.innerWidth,height:window.innerHeight}),[open]);
	const load=useCallback(async()=>{
		if(status!=='authenticated'||!userId)return;
		try{
			const [response,notificationResponse]=await Promise.all([
				fetch('/api/support',{cache:'no-store'}),
				fetch('/api/notifications?limit=20',{cache:'no-store'}),
			]);
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Support messages are temporarily unavailable.');
			const nextConversations=result as Conversation[];
			setConversations(nextConversations);
			const newestAdminMessage=nextConversations.flatMap(item=>item.messages).filter(item=>item.authorType==='ADMIN').reduce<string|null>((latest,item)=>!latest||item.createdAt>latest?item.createdAt:latest,null);
			let newestUnreadNotification:string|null=null;
			if(notificationResponse.ok){
				const notifications=await notificationResponse.json() as {latestUnreadAt?:string|null};
				newestUnreadNotification=notifications.latestUnreadAt??null;
			}else{
				console.error('Chat notification indicator could not refresh.',notificationResponse.status);
			}
			const newestActivity=[newestAdminMessage,newestUnreadNotification].filter((value):value is string=>Boolean(value)).sort().at(-1)??null;
			latestActivity.current=newestActivity;
			const key=`${seenMessageKey}:${userId}`;
			try{
				const seenAt=localStorage.getItem(key);
				if(open){
					localStorage.setItem(key,newestActivity||new Date().toISOString());
					setHasUnread(false);
				}else if(newestActivity&&(!seenAt||newestActivity>seenAt)){
					setHasUnread(true);
				}else{
					setHasUnread(false);
				}
			}catch{}
			setError(notificationResponse.ok?'':'Unread notification status is temporarily unavailable.');
		}catch(exception){setError(exception instanceof Error?exception.message:'Support messages are temporarily unavailable.')}
	},[open,status,userId]);

	useEffect(()=>{
		let saved:SavedPosition|null=null;
		try{
			const value=localStorage.getItem(positionKey);
			if(value){
				const parsed=JSON.parse(value) as SavedPosition;
				if(Number.isFinite(parsed.left)&&Number.isFinite(parsed.top))saved=parsed;
			}
		}catch{}
		const viewport={width:window.innerWidth,height:window.innerHeight};
		const initial=saved||{left:window.innerWidth-launcherSize-12,top:window.innerHeight-84};
		const side=saved?.side==='left'||saved?.side==='right'
			?saved.side
			:nearestSupportChatSide(initial.left,false,viewport);
		setDockSide(side);
		setPosition(dockSupportChatPosition(initial,side,false,viewport));
	},[]);
	useEffect(()=>{
		if(!position)return;
		const next=clamp(position);
		if(next.left!==position.left||next.top!==position.top){setPosition(next);return}
		try{localStorage.setItem(positionKey,JSON.stringify({...position,side:dockSide}))}catch{}
	},[position,clamp,dockSide]);
	useEffect(()=>{
		setPosition(current=>current?dockSupportChatPosition(current,dockSide,open,{width:window.innerWidth,height:window.innerHeight}):current);
	},[dockSide,open]);
	useEffect(()=>{
		const resize=()=>setPosition(current=>current?dockSupportChatPosition(current,dockSide,open,{width:window.innerWidth,height:window.innerHeight}):current);
		window.addEventListener('resize',resize);
		return()=>window.removeEventListener('resize',resize);
	},[open,dockSide]);
	useEffect(()=>{
		function moveDrag(event:PointerEvent){
			const active=drag.current;
			if(!active||active.pointerId!==event.pointerId)return;
			if(Math.abs(event.clientX-active.startX)+Math.abs(event.clientY-active.startY)>4)dragged.current=true;
			if(dragged.current){
				const next=clampSupportChatPosition({left:active.left+event.clientX-active.startX,top:active.top+event.clientY-active.startY},open,{width:window.innerWidth,height:window.innerHeight});
				if(animationFrame.current!==null)window.cancelAnimationFrame(animationFrame.current);
				animationFrame.current=window.requestAnimationFrame(()=>{animationFrame.current=null;setPosition(next)});
			}
		}
		function endDrag(event:PointerEvent){
			const active=drag.current;
			if(active?.pointerId!==event.pointerId)return;
			if(animationFrame.current!==null){window.cancelAnimationFrame(animationFrame.current);animationFrame.current=null}
			if(dragged.current){
				const viewport={width:window.innerWidth,height:window.innerHeight};
				const draggedPosition={left:active.left+event.clientX-active.startX,top:active.top+event.clientY-active.startY};
				const side=nearestSupportChatSide(draggedPosition.left,open,viewport);
				const next=dockSupportChatPosition(draggedPosition,side,open,viewport);
				setDockSide(side);
				setPosition(next);
			}
			drag.current=null;
		}
		window.addEventListener('pointermove',moveDrag);
		window.addEventListener('pointerup',endDrag);
		window.addEventListener('pointercancel',endDrag);
		return()=>{
			if(animationFrame.current!==null)window.cancelAnimationFrame(animationFrame.current);
			window.removeEventListener('pointermove',moveDrag);
			window.removeEventListener('pointerup',endDrag);
			window.removeEventListener('pointercancel',endDrag);
		};
	},[open]);
	useEffect(()=>{if(status!=='authenticated')return;void load();const timer=window.setInterval(()=>void load(),10_000);return()=>window.clearInterval(timer)},[status,load]);
	useEffect(()=>{if(messageList.current)messageList.current.scrollTop=messageList.current.scrollHeight},[selected?.messages.length,open]);

	function beginDrag(event:React.PointerEvent<HTMLElement>){
		if(event.button!==0||!position)return;
		const interactiveTarget=event.target instanceof Element?event.target.closest('button,a,input,textarea,select'):null;
		if(interactiveTarget&&interactiveTarget!==event.currentTarget)return;
		dragged.current=false;
		drag.current={pointerId:event.pointerId,startX:event.clientX,startY:event.clientY,left:position.left,top:position.top};
	}
	function toggleOpen(){
		if(dragged.current){dragged.current=false;return}
		if(!open&&userId){
			try{if(latestActivity.current)localStorage.setItem(`${seenMessageKey}:${userId}`,latestActivity.current)}catch{}
			setHasUnread(false);
		}
		setOpen(!open);
	}
	function closeChat(){
		setOpen(false);
		setLauncherRevealed(false);
	}

	async function createTicket(event:FormEvent<HTMLFormElement>){
		event.preventDefault();if(busy)return;
		setBusy(true);setError('');setNotice('');
		try{
			const form=new FormData();form.set('action','ticket');form.set('category','GENERAL');form.set('subject',subject);form.set('message',message);
			const response=await fetch('/api/support/ticket',{method:'POST',body:form});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to contact admin support.');
			setSubject('');setMessage('');setNotice('Your message was sent to the admin support inbox.');setSelectedId(result.id);await load();
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to contact admin support.')}
		finally{setBusy(false)}
	}

	async function sendReply(event:FormEvent<HTMLFormElement>){
		event.preventDefault();if(!selected||!reply.trim()||busy)return;
		setBusy(true);setError('');setNotice('');
		try{
			const response=await fetch('/api/support',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'reply',conversationId:selected.id,message:reply})});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to send your reply.');
			setReply('');setNotice('Reply sent.');await load();
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to send your reply.')}
		finally{setBusy(false)}
	}

	if(!position)return null;
	return <aside className={`floating-support ${open?'is-open':''}`} style={{left:0,top:0,transform:`translate3d(${position.left}px,${position.top}px,0)`}} aria-label="Chat support">
		{!open?(launcherRevealed?<button className="floating-support-launcher" type="button" aria-label={hasUnread?'Open chat support, new messages':'Open chat support'} title="Drag to move, click to open" onPointerDown={beginDrag} onClick={toggleOpen}><MessageCircle size={21}/><Move size={12} aria-hidden="true"/>{hasUnread&&<span className="floating-support-unread-dot" aria-label="Unread support message"/>}</button>:<button className="floating-support-peek" type="button" aria-label="Show chat support" title="Show chat support" onClick={()=>setLauncherRevealed(true)}><MessageCircle size={18}/><span>Chat</span>{hasUnread&&<span className="floating-support-unread-dot" aria-label="Unread support message"/>}</button>):<section className="floating-support-panel" aria-label="Admin chat support">
			<header className="floating-support-header" onPointerDown={beginDrag}>
				<span className="floating-support-icon"><LifeBuoy size={17}/></span><div><b>Admin support</b><small>Private account conversation</small></div>
				<button type="button" aria-label="Minimize chat support" onClick={closeChat}><Minus size={16}/></button><button type="button" aria-label="Close chat support" onClick={closeChat}><X size={16}/></button>
			</header>
			{status!=='authenticated'?<div className="floating-support-guest"><p>Sign in to send a private message to admin support.</p><Link href="/login" className="button-primary">Sign in</Link><Link href="/support" className="text-link">Visit support</Link></div>:<>
				{conversations.length>0&&<label className="floating-support-select"><span>Conversation</span><select className="input" aria-label="Support conversation" value={selectedId} onChange={event=>setSelectedId(event.target.value)}><option value="">New message</option>{conversations.map(item=><option value={item.id} key={item.id}>{item.subject} · {item.status.replaceAll('_',' ')}</option>)}</select></label>}
				{selected?<><div className="floating-support-messages" ref={messageList}>{selected.messages.map(item=><article className={`floating-support-message ${item.authorType==='USER'?'is-user':''}`} key={item.id}><small>{item.authorType==='USER'?'You':'Admin'} · {new Date(item.createdAt).toLocaleString()}</small><p>{item.body}</p></article>)}</div>{!['RESOLVED','CLOSED'].includes(selected.status)?<form className="floating-support-compose" onSubmit={sendReply}><textarea aria-label="Reply to admin support" className="input" required maxLength={4000} value={reply} onChange={event=>setReply(event.target.value)} placeholder="Write a reply"/><button className="button-primary" type="submit" disabled={busy||!reply.trim()} aria-label="Send reply"><Send size={16}/></button></form>:<p className="floating-support-hint">This conversation is closed. Start a new message to contact support.</p>}</>:<form className="floating-support-new" onSubmit={createTicket}><label>Subject<input className="input" required minLength={3} maxLength={120} value={subject} onChange={event=>setSubject(event.target.value)} placeholder="How can admin help?"/></label><label>Message<textarea className="input" required minLength={3} maxLength={4000} value={message} onChange={event=>setMessage(event.target.value)} placeholder="Describe what you need help with"/></label><button className="button-primary" type="submit" disabled={busy||!subject.trim()||!message.trim()}><Send size={15}/>{busy?'Sending…':'Send to admin'}</button></form>}
				{notice&&<p className="floating-support-notice" role="status">{notice}</p>}{error&&<p className="floating-support-error" role="alert">{error}</p>}
			</>}
		</section>}
	</aside>;
}