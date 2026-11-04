'use client';

import {FormEvent,useEffect,useState} from 'react';
import {signOut,useSession} from 'next-auth/react';
import Link from 'next/link';
import {Activity,Bell,Check,ChevronRight,CreditCard,Download,HeartHandshake,KeyRound,Search,Settings2,ShieldCheck,Store,Trash2,UserRound,WalletCards} from 'lucide-react';
import Nav from '@/components/Nav';
import BrowserPushSettings from '@/components/BrowserPushSettings';
import ThemeToggle from '@/components/ThemeToggle';
import ProfileAvatar,{notifyProfileAvatarUpdated} from '@/components/ProfileAvatar';
import AccountTierBadge from '@/components/AccountTierBadge';
import AureviaExchangeId from '@/components/AureviaExchangeId';
import {useAccountTier} from '@/components/useAccountTier';
import {useLocale} from '@/lib/i18n-context';

type Profile={id:string;aureviaExchangeId:string|null;email:string;name:string|null;firstName:string;lastName:string;label:string;phone:string|null;phoneVerified:boolean;country:string|null;address:string|null;hasAvatar:boolean;twoFactorEnabled:boolean;role:'USER'|'ADMIN';status:string;kycStatus:string;profileLocked:boolean;profileLockAt:string|null};

export default function Settings(){
	const [profile,setProfile]=useState<Profile|null>(null);
	const [section,setSection]=useState<'profile'|'security'|'preferences'>('profile');
	const [mobileHome,setMobileHome]=useState(true);
	const [settingsSearch,setSettingsSearch]=useState('');
	const [message,setMessage]=useState('');
	const [error,setError]=useState('');
	const [loading,setLoading]=useState(true);
	const [saving,setSaving]=useState(false);
	const [avatarFile,setAvatarFile]=useState<File|null>(null);
	const [avatarSaving,setAvatarSaving]=useState(false);
	const [showDeleteForm,setShowDeleteForm]=useState(false);
	const [deletePassword,setDeletePassword]=useState('');
	const [deleteConfirmation,setDeleteConfirmation]=useState('');
	const [deleting,setDeleting]=useState(false);
	const [retryCount,setRetryCount]=useState(0);
	const {data:session}=useSession();
	const accountTier=useAccountTier(session?.user?.role==='USER');
	const {translate}=useLocale();

	useEffect(()=>{
		let active=true;
		fetch('/api/profile').then(async response=>{
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to load your profile.');
			if(active){
				setProfile(result);
			}
		}).catch(exception=>{if(active)setError(exception instanceof Error?exception.message:'Unable to load your profile.')}).finally(()=>{if(active)setLoading(false)});
		return()=>{active=false};
	},[retryCount]);

	useEffect(()=>{
		const syncSection=()=>{
			const hash=window.location.hash.slice(1);
			if(hash==='profile'||hash==='security'||hash==='preferences')setSection(hash);
		};
		syncSection();
		window.addEventListener('hashchange',syncSection);
		return()=>window.removeEventListener('hashchange',syncSection);
	},[]);

	function selectSection(nextSection:'profile'|'security'|'preferences'){
		setSection(nextSection);
		setMobileHome(false);
		window.history.replaceState(null,'',`${window.location.pathname}#${nextSection}`);
		window.dispatchEvent(new Event('hashchange'));
	}

	const settingsGroups=[
		{title:'Basic',tone:'basic',links:[
			{label:'Account Details',description:'Your personal profile and verification',href:'/settings#profile',icon:UserRound},
			{label:'Preferences',description:'Notification delivery preferences',href:'/settings#preferences',icon:Settings2},
			{label:'Notifications',description:'View your account notifications',href:'/notifications',icon:Bell},
			{label:'Applications',description:'Card applications and designs',href:'/cards',icon:CreditCard},
			{label:'Activity history',description:'Review wallet transactions',href:'/wallet/transactions',icon:Activity},
		]},
		{title:'Payments',tone:'payments',links:[
			{label:'Wallet & payout methods',description:'Manage wallet requests and destinations',href:'/wallet',icon:WalletCards},
			{label:'Transaction history',description:'View wallet deposits and withdrawals',href:'/wallet/transactions',icon:Download},
		]},
		{title:'More',tone:'more',links:[
			{label:'Community finance',description:'Campaign contributions and loan eligibility',href:'/community',icon:HeartHandshake},
			{label:'Explore markets',description:'Browse supported exchange markets',href:'/markets',icon:Store},
			{label:'Support',description:'Get help with your account',href:'/support',icon:ShieldCheck},
		]},
	].map(group=>({...group,links:group.links.filter(link=>`${link.label} ${link.description} ${group.title}`.toLowerCase().includes(settingsSearch.trim().toLowerCase()))})).filter(group=>group.links.length>0);

	async function save(event:FormEvent<HTMLFormElement>){
		event.preventDefault();
		if(!profile||saving)return;
		setSaving(true);setMessage('');setError('');
		try{
			const response=await fetch('/api/profile',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({firstName:profile.firstName,lastName:profile.lastName,phone:profile.phone||'',country:profile.country||'',address:profile.address||'',twoFactorEnabled:profile.twoFactorEnabled})});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to save profile.');
			const refreshed=await fetch('/api/profile',{cache:'no-store'});
			const freshProfile=await refreshed.json();
			if(!refreshed.ok)throw new Error(freshProfile.error||'Profile saved, but could not be reloaded.');
			setProfile(freshProfile);window.dispatchEvent(new Event('aurevia:tier-updated'));setMessage('Profile saved successfully.');
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to save profile.')}
		finally{setSaving(false)}
	}

	async function uploadAvatar(){
		if(!avatarFile||avatarSaving)return;
		setAvatarSaving(true);setError('');setMessage('');
		try{
			const body=new FormData();body.append('file',avatarFile);
			const response=await fetch('/api/profile/avatar',{method:'POST',body});
			const result=await response.json();if(!response.ok)throw new Error(result.error||'Profile photo upload failed.');
			const view=await fetch('/api/profile/avatar',{cache:'no-store'});if(!view.ok)throw new Error('Profile photo saved but could not be loaded.');
			const signed=await view.json();notifyProfileAvatarUpdated(signed.url);setAvatarFile(null);setProfile(current=>current?{...current,hasAvatar:true}:current);setMessage('Profile photo updated.');
		}catch(exception){setError(exception instanceof Error?exception.message:'Profile photo upload failed.')}
		finally{setAvatarSaving(false)}
	}

	async function deleteAccount(event:FormEvent<HTMLFormElement>){
		event.preventDefault();
		if(deleting)return;
		setDeleting(true);setError('');
		try{
			const response=await fetch('/api/account/delete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:deletePassword,confirmation:deleteConfirmation})});
			const result=await response.json();
			if(!response.ok)throw new Error(result?.error||'Account deletion could not be completed.');
			await signOut({callbackUrl:'/'});
		}catch(exception){setError(exception instanceof Error?exception.message:'Account deletion could not be completed.');setDeleting(false)}
	}

	const verification=profile?.kycStatus==='APPROVED'?'Approved':profile?.kycStatus==='REJECTED'?'Needs attention':'Pending';

	return <><Nav/><main className="account-page mobile-settings-page" data-mobile-home={mobileHome}>
		<section className="mobile-settings-home" aria-label="Settings menu">
			<header className="mobile-settings-heading"><div><span>YOUR ACCOUNT</span><h1>Settings</h1><p className="settings-profile-name">{profile?.name||session?.user?.name||session?.user?.email}</p><AccountTierBadge tier={accountTier||profile?.label||''}/></div><ProfileAvatar className="mobile-settings-avatar" size={44} alt="Your profile picture"/></header>
			<label className="mobile-settings-search"><Search size={18}/><span className="sr-only">Search settings</span><input type="search" placeholder="Search settings" value={settingsSearch} onChange={event=>setSettingsSearch(event.target.value)}/></label>
			{settingsGroups.length?settingsGroups.map(group=><section className={`mobile-settings-group mobile-settings-group--${group.tone}`} key={group.title} aria-label={group.title}><h2>{group.title}</h2><div>{group.links.map(({label,description,href,icon:Icon})=><Link className="mobile-settings-row" href={href} key={label} onClick={()=>{if(href.startsWith('/settings#')){setMobileHome(false);setSection(href.endsWith('security')?'security':href.endsWith('preferences')?'preferences':'profile')}}}><span className="mobile-settings-icon"><Icon size={19}/></span><span><b>{label}</b><small>{description}</small></span><ChevronRight size={17} className="mobile-settings-chevron"/></Link>)}</div></section>):<p className="mobile-settings-empty">No settings match “{settingsSearch}”.</p>}
		</section>
		<header className="account-heading"><div><span className="account-kicker">{translate('accountCenter')} · {session?.user?.accountMode||'ACCOUNT'}</span><h1>{translate('settingsTitle')}</h1><p>{translate('settingsSubtitle')}</p></div><div className="flex flex-wrap items-center gap-2"><span className={`status-pill ${session?.user?.accountMode==='REAL'?'mode-real':'mode-demo'}`}>{session?.user?.accountMode||'ACCOUNT'}</span><span className="status-pill">{loading?translate('loading'):profile?.status||translate('unavailable')}</span></div></header>
		{!mobileHome&&<button type="button" className="mobile-settings-back" onClick={()=>setMobileHome(true)}><ChevronRight size={16}/>All settings</button>}
		{error&&<div className="account-callout mb-4" role="alert"><span>{error}</span><button type="button" className="text-link" disabled={loading} onClick={()=>{setError('');setLoading(true);setRetryCount(value=>value+1)}}>{translate('retry')}</button></div>}
		<div className="settings-layout">
			<nav className="settings-tabs" aria-label={translate('settingsSections')} role="tablist">
				<button type="button" role="tab" aria-selected={section==='profile'} className={section==='profile'?'is-active':''} onClick={()=>selectSection('profile')}><UserRound size={16}/>{translate('profileLabel')}</button>
				<button type="button" role="tab" aria-selected={section==='security'} className={section==='security'?'is-active':''} onClick={()=>selectSection('security')}><KeyRound size={16}/>{translate('security')}</button>
				<button type="button" role="tab" aria-selected={section==='preferences'} className={section==='preferences'?'is-active':''} onClick={()=>selectSection('preferences')}><Bell size={16}/>{translate('preferences')}</button>
			</nav>
			<div className="settings-content">
				{section==='profile'&&<section className="account-panel card p-5" role="tabpanel"><div className="account-panel-title"><div><h2>{translate('personalProfile')}</h2><p className="account-panel-subtitle">{translate('profileDetailsSubtitle')}</p></div><UserRound size={18} className="gold" aria-hidden="true"/></div>
					{profile&&<form onSubmit={save} className="account-form-grid">
						{profile.profileLocked&&<div className="account-callout md:col-span-2" role="status"><ShieldCheck size={16}/><span>Verified profile details are locked as of {profile.profileLockAt?new Date(profile.profileLockAt).toLocaleDateString():''}. Contact support to request a correction.</span></div>}
						{profile.aureviaExchangeId&&<AureviaExchangeId id={profile.aureviaExchangeId} className="md:col-span-2"/>}
						<div className="account-label md:col-span-2"><span>{translate('profilePhoto')}</span><div className="account-profile-identity mt-2"><ProfileAvatar className="profile-avatar" size={72} alt={translate('profilePhotoAlt')}/><span><b>{profile.name||'Your profile'}</b><AccountTierBadge tier={accountTier||profile.label}/></span><input type="file" accept="image/png,image/jpeg,image/webp" aria-label={translate('chooseProfilePhoto')} onChange={event=>setAvatarFile(event.target.files?.[0]||null)}/><button className="btn min-h-11 bg-white/5" type="button" disabled={!avatarFile||avatarSaving} onClick={()=>void uploadAvatar()}>{avatarSaving?translate('uploading'):translate('uploadPhoto')}</button></div><small className="mt-1 block muted">{translate('privateImage')}</small><Link className="profile-tier-link" href="/tier">View tier requirements</Link></div>
						<label className="account-label md:col-span-2">{translate('emailAddress')}<input className="input" type="email" autoComplete="email" value={profile.email} disabled/></label>
						<label className="account-label">{translate('firstName')}<input className="input" autoComplete="given-name" required maxLength={60} value={profile.firstName} disabled={profile.profileLocked} onChange={event=>setProfile({...profile,firstName:event.target.value})}/></label>
						<label className="account-label">{translate('lastName')}<input className="input" autoComplete="family-name" maxLength={60} value={profile.lastName} disabled={profile.profileLocked} onChange={event=>setProfile({...profile,lastName:event.target.value})}/></label>
						<label className="account-label">{translate('phone')}<input className="input" type="tel" autoComplete="tel" maxLength={40} value={profile.phone||''} disabled={profile.profileLocked} onChange={event=>setProfile({...profile,phone:event.target.value})}/></label>
						<p className="muted text-xs">{translate('phoneVerification')}: {profile.phoneVerified?translate('verifiedThroughSms'):translate('notVerified')}</p>
						<label className="account-label">{translate('country')}<input className="input" autoComplete="country-name" required minLength={2} maxLength={80} value={profile.country||''} disabled={profile.profileLocked} onChange={event=>setProfile({...profile,country:event.target.value})}/></label>
						<label className="account-label md:col-span-2">{translate('addressOptional')}<input className="input" autoComplete="street-address" maxLength={500} value={profile.address||''} disabled={profile.profileLocked} onChange={event=>setProfile({...profile,address:event.target.value})}/></label>
						<div className="account-callout md:col-span-2"><ShieldCheck size={16}/><span>{translate('verificationStatus')}: <b>{verification}</b>. {translate('reviewYourDetails')} <a className="gold" href="/kyc">{translate('verificationPage')}</a>.</span></div>
						<div className="md:col-span-2"><button type="submit" className="btn bg-gold text-black" disabled={profile.profileLocked||saving||loading} aria-busy={saving}>{saving?translate('saving'):translate('saveProfile')}</button>{message&&<p className="mt-3 text-sm text-profit" role="status">{message}</p>}</div>
					</form>}
					{loading&&!profile&&<div className="account-empty" role="status">{translate('loadingProfile')}</div>}
				</section>}
				{section==='security'&&<section className="account-panel card p-5" role="tabpanel"><div className="account-panel-title"><div><h2>{translate('securityOverview')}</h2><p className="account-panel-subtitle">{translate('securitySubtitle')}</p></div><ShieldCheck size={18} className="gold" aria-hidden="true"/></div>
					<div className="security-row"><span className="security-icon"><Check size={16}/></span><div><b>{translate('passwordSignIn')}</b><p>{translate('credentialAuthentication')}</p></div><span className="status-pill">{translate('enabled')}</span></div>
					<div className="security-row"><span className="security-icon"><KeyRound size={16}/></span><div><b>{translate('twoFactorFlag')}</b><p>{translate('twoFactorSimulation')}</p></div><span className="status-pill">{profile?.twoFactorEnabled?translate('flagOn'):translate('notEnabled')}</span></div>
					<div className="security-row"><span className="security-icon"><UserRound size={16}/></span><div><b>{translate('currentServerSession')}</b><p>{translate('sessionIdCopy',{sessionId:session?.user.sessionId||translate('loading')})}</p></div><span className="status-pill">{translate('oneActiveSession')}</span></div>
					<div className="account-callout mt-4"><Bell size={16}/><span>{translate('notificationBellCopy')}</span></div>
					<section className="mt-6 border-t border-white/10 pt-5" aria-labelledby="delete-account-heading"><div className="flex items-center gap-2"><Trash2 size={17} className="text-loss"/><h3 id="delete-account-heading" className="font-semibold">Delete My Account</h3></div><p className="mt-2 max-w-2xl text-sm muted">This permanently deletes your account and its related records and uploaded files. Deletion is blocked while you have pending or approved funding requests or a non-zero balance. Re-enter your current password and type DELETE to confirm.</p>
						{!showDeleteForm?<button type="button" className="btn mt-4 bg-loss text-black" onClick={()=>setShowDeleteForm(true)}>Delete My Account</button>:<form className="mt-4 grid max-w-xl gap-3" onSubmit={event=>void deleteAccount(event)}>
							<label className="account-label">Current password<input className="input" type="password" autoComplete="current-password" required maxLength={128} value={deletePassword} onChange={event=>setDeletePassword(event.target.value)}/></label>
							<label className="account-label">Type DELETE to confirm<input className="input" autoComplete="off" required value={deleteConfirmation} onChange={event=>setDeleteConfirmation(event.target.value)}/></label>
							<div className="flex flex-wrap gap-2"><button type="submit" className="btn bg-loss text-black" disabled={deleting||deleteConfirmation!=='DELETE'} aria-busy={deleting}>{deleting?'Deleting account…':'Confirm account deletion'}</button><button type="button" className="btn bg-white/5" disabled={deleting} onClick={()=>{setShowDeleteForm(false);setDeletePassword('');setDeleteConfirmation('')}}>Cancel</button></div>
						</form>}
					</section>
				</section>}
				{section==='preferences'&&<div className="settings-preferences">
					<section className="account-panel card settings-appearance-panel" aria-labelledby="settings-appearance-title">
						<div className="account-panel-title"><div><h2 id="settings-appearance-title">Appearance</h2><p className="account-panel-subtitle">Choose the theme used across Aurevia.</p></div><Settings2 size={18} className="gold" aria-hidden="true"/></div>
						<div className="settings-appearance-control"><div><b>Display theme</b><p>Switch between light and dark mode. Your choice is saved on this device.</p></div><ThemeToggle/></div>
					</section>
					<BrowserPushSettings/>
				</div>}
			</div>
		</div>
	</main></>;
}
