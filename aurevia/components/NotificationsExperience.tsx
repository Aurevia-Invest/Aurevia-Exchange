'use client';

import {useCallback,useEffect,useState} from 'react';
import {useRouter} from 'next/navigation';
import {Activity,Archive,Bell,Check,CheckCheck,CircleDollarSign,Info,LifeBuoy,RefreshCw,ShieldCheck,Trash2,Undo2,UserRound,WalletCards} from 'lucide-react';
import Nav from '@/components/Nav';
import AureviaLoading from '@/components/AureviaLoading';
import {relativeTime} from '@/components/NotificationBell';
import {useLocale} from '@/lib/i18n-context';

type NotificationItem={id:string;type:string;title:string;message:string;isRead:boolean;archivedAt:string|null;canDelete:boolean;createdAt:string;relatedEntity:string|null;relatedId:string|null;actionUrl:string|null};
type NotificationResponse={notifications:NotificationItem[];unreadCount:number};
type NotificationAction={action:'read';id:string}|{action:'read-all'}|{action:'archive'|'restore';id:string};
const iconByType:Record<string,typeof Bell>={ACCOUNT:UserRound,SECURITY:ShieldCheck,KYC:ShieldCheck,DEPOSIT:CircleDollarSign,WITHDRAWAL:WalletCards,TRADE:Activity,MARKET:Activity,SUPPORT:LifeBuoy,SYSTEM:Info};

export default function NotificationsExperience(){
	const router=useRouter();
	const {translate}=useLocale();
	const [data,setData]=useState<NotificationResponse>({notifications:[],unreadCount:0});
	const [loading,setLoading]=useState(true);
	const [error,setError]=useState('');
	const [busy,setBusy]=useState(false);
	const [state,setState]=useState<'active'|'archived'>('active');

	const load=useCallback(async()=>{
		setLoading(true);setError('');
		try{const response=await fetch(`/api/notifications?limit=100&state=${state}`,{cache:'no-store'});const result=await response.json();if(!response.ok)throw new Error(result.error||'Unable to load notifications.');setData(result)}
		catch(exception){setError(exception instanceof Error?exception.message:'Unable to load notifications.')}
		finally{setLoading(false)}
	},[state]);
	useEffect(()=>{void load()},[load]);

	async function mark(action:NotificationAction){
		if(busy)return;setBusy(true);setError('');
		try{const response=await fetch('/api/notifications',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(action)});const result=await response.json();if(!response.ok)throw new Error(result.error||'Unable to update notifications.');if(action.action==='archive'||action.action==='restore')await load();else setData(current=>({unreadCount:result.unreadCount,notifications:current.notifications.map(item=>action.action==='read-all'||item.id===action.id?{...item,isRead:true}:item)}));window.dispatchEvent(new Event('aurevia:notifications'))}
		catch(exception){setError(exception instanceof Error?exception.message:'Unable to update notifications.')}
		finally{setBusy(false)}
	}
	async function permanentlyDelete(item:NotificationItem){
		if(!item.isRead||!window.confirm(`Permanently delete the read notification “${item.title}”? This does not delete the related account record.`))return;
		setBusy(true);setError('');
		try{const response=await fetch('/api/notifications',{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({ids:[item.id]})});const result=await response.json();if(!response.ok)throw new Error(result.error||'Unable to delete notification.');setData(current=>({...current,notifications:current.notifications.filter(candidate=>candidate.id!==item.id)}))}
		catch(exception){setError(exception instanceof Error?exception.message:'Unable to delete notification.')}
		finally{setBusy(false)}
	}

	async function open(item:NotificationItem){if(!item.isRead)await mark({action:'read',id:item.id});if(item.actionUrl)router.push(item.actionUrl)}

	return <><Nav/><main className="account-page notifications-page">
		<header className="account-heading"><div><span className="account-kicker">{translate('notificationCenter')}</span><h1>{translate('notifications')}</h1><p>{translate('notificationSubtitle')}</p></div><button type="button" className="icon-action" aria-label={translate('refreshNotifications')} onClick={()=>void load()}><RefreshCw size={15}/></button></header>
		{error&&<p className="mb-3 text-sm text-loss" role="alert">{error}</p>}
		<section className="account-panel card p-5"><div className="account-panel-title"><div><h2><Bell size={17} className="gold"/> {translate('notificationHistory')}</h2><p className="account-panel-subtitle">{data.unreadCount?translate('unreadCount',{count:data.unreadCount}):translate('allCaughtUp')}</p></div><div className="flex flex-wrap gap-2"><button type="button" className={`button-secondary ${state==='active'?'is-active':''}`} aria-pressed={state==='active'} onClick={()=>setState('active')}>Inbox</button><button type="button" className={`button-secondary ${state==='archived'?'is-active':''}`} aria-pressed={state==='archived'} onClick={()=>setState('archived')}>Archived</button><button type="button" className="text-link notification-mark-all" disabled={busy||!data.unreadCount} onClick={()=>void mark({action:'read-all'})}><CheckCheck size={15}/> {translate('markAllRead')}</button></div></div>
			{loading?<AureviaLoading variant="inline" label={translate('loadingNotifications')} className="account-empty"/>:data.notifications.length?<div className="notification-history-list">{data.notifications.map(item=>{const Icon=iconByType[item.type]||Info;return <article className={`notification-history-item ${item.isRead?'is-read':'is-unread'}`} key={item.id}><span className={`notification-icon notification-type-${item.type.toLowerCase()}`}><Icon size={17}/></span><button type="button" className="notification-history-copy" onClick={()=>void open(item)}><span className="notification-history-heading"><b>{item.title}</b>{!item.isRead&&<i>{translate('new')}</i>}</span><span>{item.message}</span><time dateTime={item.createdAt} title={new Date(item.createdAt).toLocaleString()}>{relativeTime(item.createdAt)} · {new Date(item.createdAt).toLocaleString()}</time></button><div className="flex gap-1">{!item.isRead&&<button type="button" className="icon-action notification-read-action" aria-label={translate('markAsRead',{title:item.title})} disabled={busy} onClick={()=>void mark({action:'read',id:item.id})}><Check size={15}/></button>}<button type="button" className="icon-action" aria-label={`${state==='archived'?'Restore':'Archive'} ${item.title}`} disabled={busy} onClick={()=>void mark({action:state==='archived'?'restore':'archive',id:item.id})}>{state==='archived'?<Undo2 size={15}/>:<Archive size={15}/>}</button>{item.canDelete?<button type="button" className="icon-action" aria-label={`Permanently delete ${item.title}`} disabled={busy} onClick={()=>void permanentlyDelete(item)}><Trash2 size={15}/></button>:item.isRead&&<span className="text-xs muted">Delivery history retained</span>}</div></article>})}</div>:<div className="notification-empty-state"><Bell size={25} aria-hidden="true"/><h3>{state==='archived'?'No archived notifications':translate('noNotificationsYet')}</h3><p>{translate('updatesAppears')}</p></div>}
		</section>
	</main></>;
}