'use client';
import Link from 'next/link';
import Image from 'next/image';
import {useSession,signOut} from 'next-auth/react';
import {usePathname,useRouter} from 'next/navigation';
import {ArrowLeft,ArrowLeftRight,ArrowRight,Award,Bell,BookOpen,Bot,BriefcaseBusiness,ChartNoAxesCombined,CreditCard,FileText,HeartHandshake,History,House,LayoutDashboard,LineChart,LogOut,Mail,Menu,MoreHorizontal,Newspaper,PhoneCall,Radio,Search,Settings,ShieldCheck,UserRound,Wallet,X} from 'lucide-react';
import {useEffect,useRef,useState} from 'react';
import NotificationBell from '@/components/NotificationBell';
import LanguageSelector from '@/components/LanguageSelector';
import ProfileAvatar from '@/components/ProfileAvatar';
import AccountTierBadge from '@/components/AccountTierBadge';
import {useAccountTier} from '@/components/useAccountTier';
import {useLocale} from '@/lib/i18n-context';
import {MARKET_ASSETS} from '@/lib/live-market';

const moreMenuGroups=[
 {title:'Overview',links:[
  {href:'/dashboard',label:'Dashboard',icon:House},
 ]},
 {title:'Markets & trading',links:[
  {href:'/markets',label:'Markets',icon:LineChart},
  {href:'/trade',label:'Trade',icon:ArrowLeftRight},
  {href:'/portfolio',label:'Portfolio',icon:ChartNoAxesCombined},
  {href:'/investments',label:'Investments',icon:BriefcaseBusiness},
  {href:'/orders',label:'Orders',icon:History},
 ]},
 {title:'Wallet & funding',links:[
  {href:'/wallet',label:'Wallet',icon:Wallet},
  {href:'/wallet?action=DEPOSIT',label:'Deposits',icon:ArrowRight},
  {href:'/wallet?action=WITHDRAWAL',label:'Withdrawals',icon:ArrowLeft},
  {href:'/wallet/transactions',label:'Transaction history',icon:FileText},
  {href:'/wallet/convert',label:'Currency conversion',icon:ArrowLeftRight},
 ]},
 {title:'Updates & membership',links:[
  {href:'/notifications',label:'Notifications',icon:Bell},
  {href:'/tier',label:'Tier / membership',icon:Award},
  {href:'/stories',label:'Stories',icon:Radio},
  {href:'/client-stories',label:'Testimonials',icon:HeartHandshake},
  {href:'/community',label:'Community finance',icon:HeartHandshakeIcon},
 ]},
 {title:'Learning & updates',links:[
  {href:'/education',label:'Investment education',icon:BookOpen},
  {href:'/news',label:'News & updates',icon:Newspaper},
  {href:'/activity',label:'Account activity',icon:History},
 ]},
 {title:'Account',links:[
  {href:'/about-me',label:'About me · policies & themes',icon:UserRound},
  {href:'/kyc',label:'Identity verification / KYC',icon:ShieldCheck},
  {href:'/cards',label:'Digital cards',icon:CreditCard},
  {href:'/settings#preferences',label:'Account settings',icon:Settings},
  {href:'/settings#security',label:'Security',icon:ShieldCheck},
 ]},
 {title:'Support',links:[
  {href:'/support#nova',label:'AI Assistant',icon:Bot},
  {href:'/support',label:'Help and support',icon:Mail},
 ]},
];
const realOnlyNavigationPaths=new Set(['/investments','/wallet/transactions','/kyc','/cards','/tax-services']);

export default function Nav(){
 const {data,status,update}=useSession(); const pathname=usePathname(); const router=useRouter(); const {translate}=useLocale(); const [open,setOpen]=useState(false); const [modeError,setModeError]=useState(''); const [modeBusy,setModeBusy]=useState(false); const [loggingOut,setLoggingOut]=useState(false); const [taxServicesAvailable,setTaxServicesAvailable]=useState(false); const [marketSearch,setMarketSearch]=useState(''); const [marketSearchOpen,setMarketSearchOpen]=useState(false); const [currentHash,setCurrentHash]=useState(''); const userNavRef=useRef<HTMLElement>(null); const userMenuButtonRef=useRef<HTMLButtonElement>(null);
 const tierLabel=useAccountTier(status==='authenticated'&&data?.user?.role==='USER');
 const close=()=>setOpen(false);
 const active=(href:string)=>{
  const [pathWithQuery,hash]=href.split('#');
  if(pathWithQuery.includes('?'))return false;
  const path=pathWithQuery.split('?')[0];
  if(pathname!==path&&!pathname.startsWith(`${path}/`))return false;
  return !hash||pathname!==path||(currentHash||'#profile')===`#${hash}`;
 };
 const userMode=status==='authenticated'&&data?.user?.role==='USER';
 const userDestinations=[
  {href:'/dashboard',label:'Dashboard',group:'Overview'},
   {href:'/markets',label:'Markets',group:'Investing'},
   {href:'/trade',label:'Trade',group:'Investing'},
   {href:'/portfolio',label:'Portfolio',group:'Investing'},
   {href:'/investments',label:'Investments',group:'Investing'},
   {href:'/orders',label:'Orders & activity',group:'Investing'},
   {href:'/wallet',label:'Wallet',group:'Account'},
   {href:'/wallet?action=DEPOSIT',label:'Deposits',group:'Wallet & funding'},
   {href:'/wallet?action=WITHDRAWAL',label:'Withdrawals',group:'Wallet & funding'},
   {href:'/wallet/transactions',label:'Transaction history',group:'Wallet & funding'},
   {href:'/wallet/convert',label:'Currency conversion',group:'Wallet & funding'},
   {href:'/notifications',label:'Notifications',group:'Account'},
   {href:'/tier',label:'Tier / membership',group:'Account'},
   {href:'/stories',label:'Stories',group:'Explore'},
   {href:'/client-stories',label:'Testimonials',group:'Explore'},
   {href:'/community',label:'Community finance',group:'Community'},
   {href:'/education',label:'Investment education',group:'Explore'},
   {href:'/news',label:'News & updates',group:'Explore'},
   {href:'/activity',label:'Account activity',group:'Account'},
   {href:'/kyc',label:'Identity verification',group:'Account'},
   {href:'/cards',label:'Cards',group:'Account'},
   {href:'/tax-services',label:'Tax services',group:'Account'},
  {href:'/about-me',label:'About me · policies & themes',group:'Profile & support'},
  {href:'/settings#profile',label:'Profile',group:'Profile & support'},
  {href:'/settings#security',label:'Settings',group:'Profile & support'},
  {href:'/support',label:'Help & support',group:'Profile & support'},
  {href:'/support#nova',label:'AI Assistant',group:'Profile & support'},
 ];
 const currentMode=data?.user?.accountMode;
 const visibleDestinations=userDestinations.filter(item=>
  (currentMode!=='DEMO'||!realOnlyNavigationPaths.has(item.href))&&
  (item.href!=='/tax-services'||taxServicesAvailable),
 );
 const visibleMoreMenuGroups=moreMenuGroups.map(group=>({...group,links:group.links.filter(item=>currentMode!=='DEMO'||!realOnlyNavigationPaths.has(item.href))})).filter(group=>group.links.length>0);
 const matchingPages=marketSearch.trim()?visibleDestinations.filter(item=>`${item.label} ${item.group}`.toLowerCase().includes(marketSearch.trim().toLowerCase())).slice(0,5):[];
 const matchingMarkets=marketSearch.trim()?MARKET_ASSETS.filter(asset=>`${asset.id} ${asset.name} ${asset.ticker}`.toLowerCase().includes(marketSearch.trim().toLowerCase())).slice(0,6):[];
 async function changeMode(accountMode:'DEMO'|'REAL'){
  if(modeBusy)return;
  setModeBusy(true);setModeError('');
  try{
   const response=await fetch('/api/account/mode',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({accountMode})});
   if(!response.ok){setModeError('Mode update failed');return;}
   await update();router.refresh();close();
  }catch{setModeError('Mode update failed');}
  finally{setModeBusy(false)}
 }
 async function logout(){
  close();setLoggingOut(true);
  try{await signOut({callbackUrl:'/login'})}
  catch{setLoggingOut(false);setModeError('Unable to sign out. Please try again.')}
 }
 useEffect(()=>{setOpen(false)},[pathname]);
 useEffect(()=>{
  const syncHash=()=>setCurrentHash(window.location.hash);
  syncHash();
  window.addEventListener('hashchange',syncHash);
  return()=>window.removeEventListener('hashchange',syncHash);
 },[pathname]);
 useEffect(()=>{
  if(status!=='authenticated'||!data?.user){
   setTaxServicesAvailable(false);
   return;
  }
  let active=true;
  setTaxServicesAvailable(false);
  const checkAccess=async()=>{
   if(document.visibilityState!=='visible')return;
   try{
    const response=await fetch('/api/tax-services/access',{cache:'no-store'});
    if(!response.ok){
     if(response.status!==401&&response.status!==403)console.error('Unable to check tax-service navigation access.',response.status);
     if(active)setTaxServicesAvailable(false);
     return;
    }
    const result=await response.json();
    if(active)setTaxServicesAvailable(result.hasAccess===true);
   }catch(exception){
    console.error('Unable to check tax-service navigation access.',exception instanceof Error?exception.name:'UnknownError');
   }
  };
  void checkAccess();
  const interval=window.setInterval(()=>void checkAccess(),30_000);
  window.addEventListener('focus',checkAccess);
  return()=>{
   active=false;
   window.clearInterval(interval);
   window.removeEventListener('focus',checkAccess);
  };
 },[status,data?.user]);
 useEffect(()=>{
  if(!userMode)return;
  const viewport=window.visualViewport;
  const updateKeyboardInset=()=>{
   const inset=viewport?Math.max(0,window.innerHeight-viewport.height-viewport.offsetTop):0;
   document.documentElement.style.setProperty('--user-keyboard-inset',`${inset>120?inset:0}px`);
  };
  updateKeyboardInset();
  viewport?.addEventListener('resize',updateKeyboardInset);
  viewport?.addEventListener('scroll',updateKeyboardInset);
  window.addEventListener('resize',updateKeyboardInset);
  return()=>{
   viewport?.removeEventListener('resize',updateKeyboardInset);
   viewport?.removeEventListener('scroll',updateKeyboardInset);
   window.removeEventListener('resize',updateKeyboardInset);
   document.documentElement.style.removeProperty('--user-keyboard-inset');
  };
 },[userMode]);
 useEffect(()=>{
  if(!open)return;
  const nav=userNavRef.current;
  const focusable=()=>nav?.querySelectorAll<HTMLElement>('a[href],button:not(:disabled),input:not(:disabled)');
  const previous=document.activeElement instanceof HTMLElement?document.activeElement:null;
  focusable()?.[0]?.focus();
  const onKeyDown=(event:KeyboardEvent)=>{
   if(event.key==='Escape'){setOpen(false);userMenuButtonRef.current?.focus();return}
   if(event.key!=='Tab')return;
   const items=focusable();
   if(!items?.length)return;
   const first=items[0],last=items[items.length-1];
   if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus()}
   else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus()}
  };
  document.addEventListener('keydown',onKeyDown);
  return()=>{document.removeEventListener('keydown',onKeyDown);previous?.focus()};
 },[open]);
 function submitMarketSearch(event:React.FormEvent<HTMLFormElement>){
  event.preventDefault();
  if(matchingPages[0]){openPage(matchingPages[0].href);return}
  const match=matchingMarkets[0];
  if(match)openMarket(match.id);
  else if(marketSearch.trim())setMarketSearchOpen(true);
 }
 function openPage(href:string){
  router.push(href);
  setMarketSearch('');
  setMarketSearchOpen(false);
  close();
 }
 function openMarket(symbol:string){
  openPage(`/markets?symbol=${encodeURIComponent(symbol)}`);
 }
 function goBack(){
  if(window.history.length>1)router.back();
  else router.push('/dashboard');
 }
 if(userMode&&data?.user)return <>
  <header className="site-nav site-nav-authenticated site-nav-user-shell">
  <div className="nav-inner">
   <Link href="/dashboard" className="brand" onClick={close} aria-label="Aurevia Exchange home"><Image className="brand-logo-image" src="/aurevia-logo.png" alt="" width={36} height={36}/><span className="brand-copy"><strong>Aurevia</strong><small>EXCHANGE</small></span></Link>
   <form className="user-market-search" role="search" onSubmit={submitMarketSearch}>
    <Search size={16} aria-hidden="true"/>
    <input aria-label="Search markets and account pages" autoComplete="off" value={marketSearch} onFocus={()=>setMarketSearchOpen(true)} onBlur={()=>setMarketSearchOpen(false)} onChange={event=>setMarketSearch(event.target.value)} placeholder="Search markets or pages"/>
    {marketSearch&&<button type="button" className="user-search-clear" onClick={()=>setMarketSearch('')} aria-label="Clear market search"><X size={14}/></button>}
    {marketSearchOpen&&marketSearch&&<div className="user-market-results" role="region" aria-label="Navigation search results">
     {matchingPages.length>0&&<section aria-label="Account pages"><h2>Account pages</h2>{matchingPages.map(item=><button type="button" key={item.href} onMouseDown={event=>event.preventDefault()} onClick={()=>openPage(item.href)}><span><b>{item.label}</b><small>{item.group}</small></span><ArrowRight size={14}/></button>)}</section>}
     {matchingMarkets.length>0&&<section aria-label="Markets"><h2>Markets</h2>{matchingMarkets.map(asset=><button type="button" key={asset.id} onMouseDown={event=>event.preventDefault()} onClick={()=>openMarket(asset.id)}><span><b>{asset.id}</b><small>{asset.name}</small></span><ArrowRight size={14}/></button>)}</section>}
     {!matchingPages.length&&!matchingMarkets.length&&<p>No pages or supported markets match that search.</p>}
    </div>}
   </form>
   <div className="user-mode-control" role="group" aria-label={translate('accountMode')}>
    <button type="button" aria-pressed={data.user.accountMode==='DEMO'} disabled={modeBusy||loggingOut||data.user.accountMode==='DEMO'} onClick={()=>void changeMode('DEMO')}>Demo</button>
    <button type="button" aria-pressed={data.user.accountMode==='REAL'} disabled={modeBusy||loggingOut||data.user.accountMode==='REAL'} onClick={()=>void changeMode('REAL')}>Real</button>
   </div>
   <div className="user-topbar-actions"><button type="button" className="user-account-back" onClick={goBack} aria-label="Go back to previous page" title="Go back to previous page"><ArrowLeft size={16} aria-hidden="true"/></button><NotificationBell/><button ref={userMenuButtonRef} type="button" className={`user-account-back${open||moreMenuGroups.some(group=>group.links.some(item=>active(item.href)))?' is-active':''}`} aria-label="More account navigation" aria-expanded={open} aria-controls="user-more-menu" onClick={()=>setOpen(value=>!value)}><MoreHorizontal size={17} aria-hidden="true"/></button><LanguageSelector/></div>
   <span className="user-topbar-identity"><ProfileAvatar className="user-topbar-avatar" size={32} alt="Your profile picture"/><span><b>{data.user.name||data.user.email}</b><AccountTierBadge tier={tierLabel}/></span></span>
   {modeError&&<span className="user-mode-error" role="alert">{modeError}</span>}
  </div>
  </header>
  <nav aria-label="Primary account navigation" className="user-bottom-navigation">
   <Link href="/dashboard" aria-label="Dashboard" aria-current={pathname==='/dashboard'?'page':undefined} className={pathname==='/dashboard'?'is-active':''}><House size={20} strokeWidth={1.8}/><span>Dashboard</span></Link>
   <Link href="/markets" aria-current={active('/markets')?'page':undefined} className={active('/markets')?'is-active':''}><LineChart size={20} strokeWidth={1.8}/><span>Markets</span></Link>
   <Link href="/trade" aria-label="Trade markets" aria-current={active('/trade')?'page':undefined} className={`user-bottom-trade ${active('/trade')?'is-active':''}`}><ArrowLeftRight size={22} strokeWidth={2}/><span>Trade</span></Link>
   <Link href="/portfolio" aria-current={active('/portfolio')?'page':undefined} className={active('/portfolio')?'is-active':''}><ChartNoAxesCombined size={20} strokeWidth={1.8}/><span>Portfolio</span></Link>
   <button type="button" className={open?'is-active':''} aria-label="Open account navigation menu" aria-expanded={open} aria-controls="user-more-menu" onClick={()=>setOpen(value=>!value)}><MoreHorizontal size={20} strokeWidth={1.8}/><span>More</span></button>
  </nav>
  {open&&<button type="button" className="user-more-backdrop" aria-label="Close More menu" tabIndex={-1} onClick={close}/>}
  <section ref={userNavRef} id="user-more-menu" className="user-more-menu" role="dialog" aria-modal={open||undefined} aria-labelledby="user-more-title" hidden={!open}>
   <header className="user-more-heading"><div><span>ACCOUNT NAVIGATION</span><h2 id="user-more-title">More</h2></div><button type="button" className="user-more-close" aria-label="Close More menu" onClick={close}><X size={18}/></button></header>
   <div className="user-more-profile"><ProfileAvatar className="user-topbar-avatar" size={36} alt="Your profile picture"/><span><b>{data.user.name||data.user.email}</b><AccountTierBadge tier={tierLabel}/></span><Link href="/settings#profile" onClick={close}>Profile</Link></div>
   <div className="user-more-groups">{visibleMoreMenuGroups.map(group=><section className="user-more-group" key={group.title} aria-label={group.title}><h3>{group.title}</h3>{group.links.map(({href,label,icon:Icon})=><Link href={href} key={href} aria-current={active(href)?'page':undefined} onClick={close}><Icon size={17} strokeWidth={1.7}/><span>{label}</span></Link>)}</section>)}
    {currentMode!=='DEMO'&&<section className="user-more-group" aria-label="Additional account pages"><h3>Additional</h3><Link href="/tax-services" aria-current={active('/tax-services')?'page':undefined} onClick={close}><FileText size={17}/><span>Tax services</span></Link></section>}
   </div>
   <button type="button" className="user-more-logout" disabled={loggingOut} aria-busy={loggingOut} onClick={()=>void logout()}><LogOut size={17}/>{loggingOut?translate('signingOut'):translate('logout')}</button>
  </section>
 </>;
 return <header className={`site-nav ${status==='authenticated'?'site-nav-authenticated':''} ${status==='authenticated'&&data?.user?.role==='ADMIN'?'site-nav-admin':''}`}><div className="nav-inner">
   <Link href="/" className="brand" onClick={close} aria-label="Aurevia Exchange home"><Image className="brand-logo-image" src="/aurevia-logo.png" alt="" width={38} height={38}/><span className="brand-copy"><strong>Aurevia</strong><small>EXCHANGE</small></span></Link>
   <nav id="primary-navigation" aria-label="Primary navigation" className={`nav-links ${open?'nav-open':''}`} onKeyDown={event=>{if(event.key==='Escape')close()}}>
    {status==='loading'?<span className="muted text-sm" aria-live="polite">{translate('restoringSession')}</span>:<>
     {status==='unauthenticated'&&<section className="nav-menu-group" aria-labelledby="nav-access-heading">
      <h2 className="nav-menu-section" id="nav-access-heading">ACCOUNT ACCESS</h2>
      <Link href="/login" onClick={close}>{translate('signIn')}</Link>
      <Link href="/register" className="nav-cta" onClick={close}>{translate('createAccount')}</Link>
     </section>}
    {status==='authenticated'&&data?.user&&<div className="nav-account-snapshot"><ProfileAvatar className="nav-account-monogram" size={36} alt="Your profile picture"/><span className="nav-account-copy"><small>ACCOUNT SPACE</small><b>{data.user.name||data.user.email}</b><AccountTierBadge tier={tierLabel}/><em>{data.user.accountMode} ACCOUNT</em></span></div>}
     <section className="nav-menu-group" aria-labelledby="nav-overview-heading">
      <h2 className="nav-menu-section" id="nav-overview-heading">OVERVIEW</h2>
      <Link href="/" onClick={close} aria-current={pathname==='/'?'page':undefined}>{translate('home')}</Link>
      <Link href="/dashboard" onClick={close} aria-current={active('/dashboard')?'page':undefined}><LayoutDashboard size={16} aria-hidden="true"/>{translate('dashboard')}</Link>
      {status==='authenticated'&&data?.user?.role==='ADMIN'&&<Link href="/admin" className="nav-admin-entry" onClick={close} aria-current={active('/admin')?'page':undefined}><ShieldCheck size={16} aria-hidden="true"/>Open Admin Console</Link>}
     </section>
     <section className="nav-menu-group" aria-labelledby="nav-explore-heading">
      <h2 className="nav-menu-section" id="nav-explore-heading">EXPLORE</h2>
      <Link href="/stories" onClick={close} aria-current={active('/stories')?'page':undefined}><Radio size={16} aria-hidden="true"/>Stories</Link>
     </section>
     <section className="nav-menu-group" aria-labelledby="nav-investing-heading">
      <h2 className="nav-menu-section" id="nav-investing-heading">INVESTING</h2>
      <Link href="/markets" onClick={close} aria-current={active('/markets')?'page':undefined}><LineChart size={16} aria-hidden="true"/>{translate('markets')}</Link>
      <Link href="/trade" onClick={close} aria-current={active('/trade')?'page':undefined}><ActivityIcon/>{translate('trade')}</Link>
      <Link href="/investments" onClick={close} aria-current={active('/investments')?'page':undefined}><BriefcaseBusiness size={16} aria-hidden="true"/>Opportunities</Link>
     </section>
     <section className="nav-menu-group" aria-labelledby="nav-portfolio-heading">
      <h2 className="nav-menu-section" id="nav-portfolio-heading">PORTFOLIO</h2>
      <Link href="/orders" onClick={close} aria-current={active('/orders')?'page':undefined}>{translate('orders')}</Link>
      <Link href="/wallet/transactions" onClick={close} aria-current={active('/wallet/transactions')?'page':undefined}><History size={16} aria-hidden="true"/>History</Link>
        <Link href="/broadcasts" onClick={close} aria-current={active('/broadcasts')?'page':undefined}><Radio size={16} aria-hidden="true"/>Live broadcasts</Link>
     </section>
     <section className="nav-menu-group" aria-labelledby="nav-account-heading">
      <h2 className="nav-menu-section" id="nav-account-heading">ACCOUNT &amp; SUPPORT</h2>
      <Link href="/wallet" onClick={close} aria-current={active('/wallet')?'page':undefined}><Wallet size={16} aria-hidden="true"/>{translate('wallet')}</Link>
      <Link href="/cards" onClick={close} aria-current={active('/cards')?'page':undefined}><CreditCard size={16} aria-hidden="true"/>Cards</Link>
      {status==='authenticated'&&taxServicesAvailable&&<Link href="/tax-services" onClick={close} aria-current={active('/tax-services')?'page':undefined}><FileText size={16} aria-hidden="true"/>Tax Services</Link>}
      <Link href="/kyc" onClick={close} aria-current={active('/kyc')?'page':undefined}><ShieldCheck size={16} aria-hidden="true"/>{translate('verification')}</Link>
      <Link href="/settings" onClick={close} aria-current={active('/settings')?'page':undefined}><Settings size={16} aria-hidden="true"/>{translate('settings')}</Link>
      <Link href="/notifications" onClick={close} aria-current={active('/notifications')?'page':undefined}>{translate('notifications')}</Link>
      <Link href="/support" onClick={close} aria-current={active('/support')?'page':undefined}>{translate('support')}</Link>
      <a className="nav-contact" href="tel:+12105047697" onClick={close}><PhoneCall size={16} aria-hidden="true"/><span><b>Call Support</b><small>+1 (210) 504-7697</small></span></a>
      <a className="nav-contact" href="mailto:aureviainvest@gmail.com" onClick={close}><Mail size={16} aria-hidden="true"/><span><b>Email</b><small>aureviainvest@gmail.com</small></span></a>
     </section>
     {status==='authenticated'&&data?.user&&<div className="nav-menu-tools">
      <div className="mode-switch-wrap">
        <span className="mode-switch-label">{translate('accountMode')}</span>
        <div className={`mode-toggle ${data.user.accountMode==='DEMO'?'is-demo':'is-real'} ${modeBusy?'is-busy':''}`} role="group" aria-label={translate('accountMode')}>
          <button
            type="button"
            className={`mode-toggle-option ${data.user.accountMode==='DEMO'?'is-active':''}`}
            aria-pressed={data.user.accountMode==='DEMO'}
            disabled={modeBusy||loggingOut||data.user.accountMode==='DEMO'}
            onClick={()=>void changeMode('DEMO')}
          >
            <span className="mode-toggle-dot" aria-hidden="true"/>
            {translate('demo')}
          </button>
          <button
            type="button"
            className={`mode-toggle-option ${data.user.accountMode==='REAL'?'is-active':''}`}
            aria-pressed={data.user.accountMode==='REAL'}
            disabled={modeBusy||loggingOut||data.user.accountMode==='REAL'}
            onClick={()=>void changeMode('REAL')}
          >
            <span className="mode-toggle-dot" aria-hidden="true"/>
            {translate('real')}
          </button>
          <span className="mode-toggle-slider" aria-hidden="true"/>
        </div>
        <p className="mode-toggle-hint">{data.user.accountMode==='DEMO'?'Demo account space':'Real account space'}</p>
      </div>
      {modeError&&<span className="text-xs text-loss" role="alert">{modeError}</span>}
      <button type="button" className="nav-logout" disabled={loggingOut} aria-busy={loggingOut} onClick={()=>void logout()}><LogOut size={16} aria-hidden="true"/>{loggingOut?translate('signingOut'):translate('logout')}</button>
     </div>}
    </>}
   </nav>
   <div className="nav-actions"><NotificationBell/><LanguageSelector/><button className="menu-button" type="button" aria-label={open?translate('closeMenu'):translate('openMenu')} aria-expanded={open} aria-controls="primary-navigation" onClick={()=>setOpen(!open)}>{open?<X aria-hidden="true"/>:<Menu aria-hidden="true"/>}</button></div>
 </div></header>
}

function ActivityIcon(){return <LineChart size={15} aria-hidden="true"/>}
function HeartHandshakeIcon(){return <HeartHandshake size={16} aria-hidden="true"/>}
