'use client';

import {type FormEvent,useCallback,useEffect,useRef,useState} from 'react';
import Image from 'next/image';
import Link from 'next/link';
import {signOut,useSession} from 'next-auth/react';
import {usePathname,useRouter,useSearchParams} from 'next/navigation';
import {Activity,ArrowLeft,ArrowRight,BadgeCheck,Bell,BriefcaseBusiness,Building2,ClipboardCheck,CreditCard,FileCheck2,Handshake,LayoutDashboard,LogOut,Menu,MessageSquareText,Newspaper,Radio,ReceiptText,Search,Settings2,ShieldCheck,SlidersHorizontal,Sparkles,Trash2,UsersRound,X} from 'lucide-react';
import ProfileAvatar from '@/components/ProfileAvatar';
import ThemeToggle from '@/components/ThemeToggle';

const groups=[
	{title:'Dashboards',links:[
		{href:'/admin',label:'CRM Dashboard',icon:LayoutDashboard},
	]},
	{title:'Accounts',links:[
		{href:'/admin/users',label:'Users',icon:UsersRound},
		{href:'/admin/sessions',label:'Account sessions',icon:Activity},
		{href:'/admin/users?mode=DEMO',label:'Demo Accounts',icon:Building2},
		{href:'/admin/users?mode=REAL',label:'Real Accounts',icon:Building2},
		{href:'/admin/kyc',label:'KYC Verification',icon:ClipboardCheck},
		{href:'/admin/verified-accounts',label:'Verified accounts',icon:BadgeCheck},
		{href:'/admin/tiers',label:'Tier reviews',icon:FileCheck2},
	]},
	{title:'Operations',links:[
		{href:'/admin/payments',label:'Funding',icon:ReceiptText},
		{href:'/admin/payments?type=WITHDRAWAL',label:'Withdrawals',icon:ReceiptText},
		{href:'/admin/approved-deposits',label:'Approved deposits',icon:ReceiptText},
		{href:'/admin/approved-withdrawals',label:'Approved withdrawals',icon:ReceiptText},
		{href:'/admin/settlements',label:'Settlements',icon:ReceiptText},
		{href:'/admin/investments',label:'Investments',icon:BriefcaseBusiness},
		{href:'/admin/community',label:'Community finance',icon:Handshake},
		{href:'/admin/operations',label:'Orders & ledger',icon:Activity},
		{href:'/admin/positions',label:'Positions',icon:BriefcaseBusiness},
		{href:'/admin/markets',label:'Markets',icon:Settings2},
	]},
	{title:'Services',links:[
		{href:'/admin/support',label:'Support',icon:MessageSquareText},
		{href:'/admin/cards',label:'Cards',icon:CreditCard},
		{href:'/admin/tax-services',label:'Tax services',icon:ShieldCheck},
		{href:'/admin/news-feed',label:'News feed posts',icon:Newspaper},
		{href:'/admin/stories',label:'Stories',icon:Radio},
		{href:'/admin/content',label:'Client stories',icon:Radio},
		{href:'/admin/broadcasts',label:'Broadcasts',icon:Radio},
		{href:'/admin/waitlist',label:'Waitlist',icon:UsersRound},
		{href:'/admin/providers',label:'Provider health',icon:Settings2},
		{href:'/admin/receipts',label:'Receipt review',icon:ReceiptText},
	]},
	{title:'System',links:[
		{href:'/admin/command-center',label:'AI & API command center',icon:Sparkles},
		{href:'/admin/activity',label:'Activity Management',icon:Activity},
		{href:'/admin/audit-logs',label:'Notifications & audit',icon:Bell},
		{href:'/admin/settings',label:'Settings',icon:SlidersHorizontal},
		{href:'/admin/deleted-items',label:'Deleted items',icon:Trash2},
		{href:'/admin/nova',label:'Nova activity',icon:MessageSquareText},
	]},
];

export default function AdminNav(){
	const {data,status}=useSession();
	const pathname=usePathname();
	const searchParams=useSearchParams();
	const router=useRouter();
	const [open,setOpen]=useState(false);
	const [loggingOut,setLoggingOut]=useState(false);
	const [search,setSearch]=useState('');
	const [searchOpen,setSearchOpen]=useState(false);
	const [now,setNow]=useState<Date|null>(null);
	const [hasUnreadActivity,setHasUnreadActivity]=useState(false);
	const latestActivityRef=useRef<string|null>(null);
	const currentQuery=searchParams.toString();
	const isAdmin=status==='authenticated'&&data?.user?.role==='ADMIN';
	const matchingDestinations=search.trim()?groups.flatMap(group=>group.links
		.filter(link=>`${link.label} ${group.title}`.toLowerCase().includes(search.trim().toLowerCase()))
		.map(link=>({...link,group:group.title}))).slice(0,6):[];
	const close=()=>setOpen(false);
	const title=groups.flatMap(group=>group.links).find(link=>{
		const [path,query]=link.href.split('?');
		const expected=new URLSearchParams(query);
		const actual=new URLSearchParams(currentQuery);
		return pathname===path&&['mode','type'].every(key=>expected.get(key)===actual.get(key))&&([...expected.keys()].length>0||![...actual.keys()].some(key=>key==='mode'||key==='type'));
	})?.label||'Admin workspace';
	const goBack=useCallback(()=>{
		if(window.history.length>1)router.back();
		else if(pathname!=='/admin')router.push('/admin');
	},[pathname,router]);

	useEffect(()=>{setOpen(false)},[pathname]);
	useEffect(()=>{
		const update=()=>setNow(new Date());
		update();
		const timer=window.setInterval(update,60_000);
		return ()=>window.clearInterval(timer);
	},[]);
	useEffect(()=>{
		if(!isAdmin||!data?.user?.id)return;
		const storageKey=`aurevia-admin-activity-seen:${data.user.id}`;
		let active=true;
		async function refreshActivity(){
			try{
				const response=await fetch('/api/admin/activity/unread',{cache:'no-store'});
				const result=await response.json();
				if(!response.ok)throw new Error(result.error||'Unable to check new admin activity.');
				if(!active)return;
				const latest=typeof result.latestActivityAt==='string'?result.latestActivityAt:null;
				latestActivityRef.current=latest;
				if(pathname==='/admin/audit-logs'){
					if(latest)localStorage.setItem(storageKey,latest);
					setHasUnreadActivity(false);
					return;
				}
				const seen=localStorage.getItem(storageKey);
				setHasUnreadActivity(Boolean(latest&&(!seen||latest>seen)));
			}catch(error){
				if(active)console.error('Admin activity notification status unavailable.',error instanceof Error?error.name:'UnknownError');
			}
		}
		void refreshActivity();
		const timer=window.setInterval(()=>void refreshActivity(),30_000);
		const onStorage=(event:StorageEvent)=>{if(event.key===storageKey&&event.newValue)setHasUnreadActivity(Boolean(latestActivityRef.current&&latestActivityRef.current>event.newValue))};
		window.addEventListener('storage',onStorage);
		return()=>{active=false;window.clearInterval(timer);window.removeEventListener('storage',onStorage)};
	},[data?.user?.id,isAdmin,pathname]);
	useEffect(()=>{
		function handleBackShortcut(event:KeyboardEvent){
			const target=event.target;
			const editing=target instanceof HTMLElement&&(target.isContentEditable||target.matches('input,textarea,select,[role="textbox"]'));
			if(editing)return;
			if((event.altKey&&event.key==='ArrowLeft')||event.key==='Backspace'){
				event.preventDefault();
				goBack();
			}
		}
		window.addEventListener('keydown',handleBackShortcut);
		return ()=>window.removeEventListener('keydown',handleBackShortcut);
	},[goBack]);

	function submitSearch(event:FormEvent<HTMLFormElement>){
		event.preventDefault();
		const query=search.trim();
		if(!query)return;
		if(matchingDestinations[0]){
			router.push(matchingDestinations[0].href);
			setSearch('');
			setSearchOpen(false);
			return;
		}
		router.push(`/admin/users?search=${encodeURIComponent(query)}`);
		setSearchOpen(false);
	}

	function openDestination(href:string){
		router.push(href);
		setSearch('');
		setSearchOpen(false);
	}

	async function logout(){
		if(loggingOut)return;
		setLoggingOut(true);
		try{await signOut({callbackUrl:'/admin/login'})}
		catch{setLoggingOut(false)}
	}

	return <div className="admin-shell-chrome">
		{open&&<button type="button" className="admin-sidebar-backdrop" aria-label="Close admin navigation" onClick={close}/>}
		<aside className={`admin-sidebar ${open?'is-open':''}`}>
			<Link href="/admin" className="admin-brand" onClick={close}>
				<span className="admin-brand-mark"><Image src="/aurevia-logo.png" alt="" width={34} height={34}/></span>
				<span className="admin-brand-type"><b>AUREVIA</b><small>INVEST · ADMIN</small></span>
			</Link>
			<nav id="admin-navigation" aria-label="Administrator navigation" className="admin-sidebar-navigation">
				{status==='loading'?<p className="admin-nav-loading" role="status">Restoring administrator session…</p>:isAdmin?<div className="admin-command-groups">{groups.map(group=><section className="admin-command-group" key={group.title} aria-label={group.title}>
					<h2>{group.title}</h2>
					{group.links.map(({href,label,icon:Icon})=>{
						const [path,query]=href.split('?');
						const expected=new URLSearchParams(query);
						const actual=new URLSearchParams(currentQuery);
						const isActive=pathname===path&&['mode','type'].every(key=>expected.get(key)===actual.get(key))&&([...expected.keys()].length>0||![...actual.keys()].some(key=>key==='mode'||key==='type'));
						return <Link key={href} href={href} title={label} onClick={close} aria-current={isActive?'page':undefined}><Icon size={16} aria-hidden="true"/><span>{label}</span>{href==='/admin/audit-logs'&&hasUnreadActivity&&<span className="admin-unread-dot" aria-label="New admin activity"/>}</Link>;
					})}
				</section>)}</div>:<p className="admin-nav-loading">Administrator access required</p>}
			</nav>
			<div className="admin-sidebar-footer">
				<ProfileAvatar className="admin-profile-avatar" size={34} alt="Administrator profile picture"/>
				<span className="admin-profile-copy"><b>{data?.user?.name||'Administrator'}</b><small>ADMINISTRATOR</small></span>
				<div className="admin-theme-preference"><span>Appearance</span><ThemeToggle/></div>
				<button type="button" className="admin-sidebar-logout" disabled={!isAdmin||loggingOut} onClick={()=>void logout()} aria-label="Sign out" title="Sign out"><LogOut size={16}/></button>
			</div>
		</aside>
		<header className="admin-topbar">
			<button className="admin-menu-button" type="button" aria-label={open?'Close admin menu':'Open admin menu'} aria-expanded={open} aria-controls="admin-navigation" onClick={()=>setOpen(value=>!value)}>{open?<X size={19}/>:<Menu size={19}/>}</button>
			<button type="button" className="admin-back-button" onClick={goBack} aria-label="Go back" title="Go back · Alt+Left"><ArrowLeft size={16}/><span>Back</span></button>
			<div className="admin-topbar-heading"><span>ADMINISTRATION</span><b>{title}</b></div>
			<form className="admin-global-search" role="search" onSubmit={submitSearch}>
				<Search size={16} aria-hidden="true"/>
				<input aria-label="Search admin pages or users" autoComplete="off" placeholder="Search admin pages or users" value={search} onFocus={()=>setSearchOpen(true)} onBlur={()=>setSearchOpen(false)} onChange={event=>setSearch(event.target.value)}/>
				<button type="submit">Search</button>
				{searchOpen&&search.trim()&&<div className="admin-search-results" role="region" aria-label="Administrator search results">
					{matchingDestinations.length>0?<section aria-label="Admin pages"><h2>Admin pages</h2>{matchingDestinations.map(item=><button type="button" key={item.href} onMouseDown={event=>event.preventDefault()} onClick={()=>openDestination(item.href)}><span><b>{item.label}</b><small>{item.group}</small></span><ArrowRight size={13}/></button>)}</section>:<p>No admin pages match. Press Enter to search users by name, email, or ID.</p>}
				</div>}
			</form>
			<div className="admin-topbar-meta">
				<time className="admin-clock" dateTime={now?.toISOString()}>{now?now.toLocaleString(undefined,{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'—'}</time>
				<ThemeToggle/>
				<Link href="/admin/audit-logs" className="admin-topbar-icon" aria-label={hasUnreadActivity?'View notifications and audit activity, new activity':'View notifications and audit activity'} title="Notifications & audit"><Bell size={17}/>{hasUnreadActivity&&<span className="admin-unread-dot" aria-label="New admin activity"/>}</Link>
				<span className="admin-topbar-profile"><ProfileAvatar className="admin-profile-avatar" size={30} alt="Administrator profile picture"/><span><b>{data?.user?.name||'Administrator'}</b><small>ADMIN</small></span></span>
			</div>
		</header>
	</div>;
}
