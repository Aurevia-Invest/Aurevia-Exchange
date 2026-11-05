'use client';

import {FormEvent,useCallback,useEffect,useState} from 'react';
import {signOut,useSession} from 'next-auth/react';
import Image from 'next/image';
import {Eye,EyeOff,KeyRound,LogOut,RefreshCw,ShieldCheck,Trash2} from 'lucide-react';

type SecuritySession={id:string;deviceLabel:string|null;createdAt:string;lastActivityAt:string;expiresAt:string;current:boolean};
type TotpSetup={qrCode:string;manualKey:string;expiresInSeconds:number};
type SessionAction={action:'revoke-session'|'logout-others'|'logout-all';sessionId?:string};

function GoldLockIcon(){
	return <svg className="security-center-3d-icon" viewBox="0 0 48 48" aria-hidden="true">
		<defs>
			<linearGradient id="security-lock-gold" x1="0" x2="1" y1="0" y2="1"><stop stopColor="#fff5c5"/><stop offset=".24" stopColor="#d7a93e"/><stop offset=".48" stopColor="#fff0a0"/><stop offset=".72" stopColor="#a66c14"/><stop offset="1" stopColor="#f6d875"/></linearGradient>
			<linearGradient id="security-lock-side" x1="0" x2="1"><stop stopColor="#5e3b12"/><stop offset="1" stopColor="#c28a24"/></linearGradient>
			<filter id="security-lock-shadow" x="-30%" y="-30%" width="160%" height="170%"><feGaussianBlur in="SourceAlpha" stdDeviation="1.6"/><feOffset dy="2"/><feComponentTransfer><feFuncA type="linear" slope=".45"/></feComponentTransfer><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>
		</defs>
		<g filter="url(#security-lock-shadow)">
			<path d="M15 21v-7a9 9 0 0 1 18 0v7" fill="none" stroke="url(#security-lock-side)" strokeWidth="6.5" strokeLinecap="round"/>
			<path d="M15 20v-6a9 9 0 0 1 18 0v6" fill="none" stroke="url(#security-lock-gold)" strokeWidth="4.3" strokeLinecap="round"/>
			<path d="m9 21 24-2 7 5v18L16 44l-7-5z" fill="url(#security-lock-side)"/>
			<path d="M9 21h25v18L9 42z" fill="url(#security-lock-gold)"/>
			<path d="m11 23 21 .2v2.2l-21-.2z" fill="#fff5c8" opacity=".8"/>
			<circle cx="22" cy="30" r="3" fill="#594016"/>
			<path d="M20.5 31.7h3L25 37h-6z" fill="#594016"/>
			<path d="m34 21 6 3v18l-6-3z" fill="#704914" opacity=".75"/>
		</g>
	</svg>;
}

function GoldShieldIcon(){
	return <svg className="security-center-3d-icon" viewBox="0 0 48 48" aria-hidden="true">
		<defs>
			<linearGradient id="security-shield-gold" x1=".1" x2=".9" y1="0" y2="1"><stop stopColor="#fff5c5"/><stop offset=".23" stopColor="#d6a53c"/><stop offset=".49" stopColor="#ffe99a"/><stop offset=".76" stopColor="#a66c14"/><stop offset="1" stopColor="#f5d477"/></linearGradient>
			<linearGradient id="security-shield-side" x1="0" x2="1"><stop stopColor="#63400f"/><stop offset="1" stopColor="#d5a440"/></linearGradient>
			<filter id="security-shield-shadow" x="-30%" y="-25%" width="160%" height="170%"><feGaussianBlur in="SourceAlpha" stdDeviation="1.5"/><feOffset dy="2"/><feComponentTransfer><feFuncA type="linear" slope=".4"/></feComponentTransfer><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>
		</defs>
		<g filter="url(#security-shield-shadow)">
			<path d="m24 3 17 6v13c0 10-7 17-17 23C14 39 7 32 7 22V9z" fill="url(#security-shield-side)"/>
			<path d="m24 3 14 5v14c0 9-5.8 15-14 20z" fill="#9b6818"/>
			<path d="m9 10 15-5v37C14.8 36 9 30 9 21z" fill="url(#security-shield-gold)"/>
			<path d="m12 11 12-4v2l-12 4z" fill="#fff4c0" opacity=".78"/>
			<circle cx="21" cy="21" r="5.4" fill="none" stroke="#503811" strokeWidth="3.3"/>
			<path d="M25 24.5 34 33l-2.6 2.6-2-2-2.3 2.2-2-2 2.2-2.4-5.1-4.9z" fill="#503811"/>
			<path d="m25 24.5 8.6 8.1-1.6 1.6-8.6-8.1z" fill="#fff0a1" opacity=".85"/>
			<circle cx="21" cy="21" r="2" fill="#503811"/>
		</g>
	</svg>;
}

function PasswordInput({label,value,onChange,autoComplete='current-password'}:{label:string;value:string;onChange:(value:string)=>void;autoComplete?:string}){
	const [visible,setVisible]=useState(false);
	return <label className="account-label">{label}<span className="security-center-password-wrap"><input className="input" type={visible?'text':'password'} autoComplete={autoComplete} maxLength={128} value={value} onChange={event=>onChange(event.target.value)} required/><button type="button" className="security-center-visibility" aria-label={visible?'Hide password':'Show password'} aria-pressed={visible} onClick={()=>setVisible(current=>!current)}>{visible?<EyeOff size={17}/>:<Eye size={17}/>}</button></span></label>;
}

function strength(password:string){
	const score=[password.length>=10,/[a-z]/.test(password),/[A-Z]/.test(password),/\d/.test(password),/[^A-Za-z0-9]/.test(password)].filter(Boolean).length;
	return {score,label:score<3?'Weak':score<4?'Fair':score<5?'Good':'Strong'};
}

export default function SecurityCenter({email,twoFactorEnabled:initialTwoFactorEnabled,twoFactorAvailable}:{email:string;twoFactorEnabled:boolean;twoFactorAvailable:boolean}){
	const {update}=useSession();
	const [twoFactorEnabled,setTwoFactorEnabled]=useState(initialTwoFactorEnabled);
	const [sessions,setSessions]=useState<SecuritySession[]>([]);
	const [loadingSessions,setLoadingSessions]=useState(true);
	const [busy,setBusy]=useState(false);
	const [error,setError]=useState('');
	const [message,setMessage]=useState('');
	const [passwordExpanded,setPasswordExpanded]=useState(false);
	const [currentPassword,setCurrentPassword]=useState('');
	const [newPassword,setNewPassword]=useState('');
	const [confirmPassword,setConfirmPassword]=useState('');
	const [totpExpanded,setTotpExpanded]=useState(false);
	const [totpPassword,setTotpPassword]=useState('');
	const [totpCode,setTotpCode]=useState('');
	const [totpSetup,setTotpSetup]=useState<TotpSetup|null>(null);
	const [recoveryCodes,setRecoveryCodes]=useState<string[]>([]);
	const [sessionAction,setSessionAction]=useState<SessionAction|null>(null);
	const [sessionPassword,setSessionPassword]=useState('');

	const loadSessions=useCallback(async()=>{
		setLoadingSessions(true);
		try{
			const response=await fetch('/api/security/sessions',{cache:'no-store'});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to load active sessions.');
			setSessions(result.sessions||[]);
		}catch(exception){
			setError(exception instanceof Error?exception.message:'Unable to load active sessions.');
		}finally{setLoadingSessions(false);}
	},[]);

	useEffect(()=>{void loadSessions();},[loadSessions]);

	async function submitPasswordChange(event:FormEvent<HTMLFormElement>){
		event.preventDefault();
		setBusy(true);setError('');setMessage('');
		try{
			const response=await fetch('/api/security/password',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({currentPassword,newPassword,confirmPassword})});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to change your password.');
			await update();
			setCurrentPassword('');setNewPassword('');setConfirmPassword('');
			setPasswordExpanded(false);setMessage(result.message||'Password changed successfully.');
			await loadSessions();
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to change your password.');}
		finally{setBusy(false);}
	}

	async function beginTotpEnrollment(){
		setBusy(true);setError('');setMessage('');
		try{
			const response=await fetch('/api/security/totp',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'start',password:totpPassword})});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to begin two-factor enrollment.');
			setTotpSetup(result);setTotpCode('');
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to begin two-factor enrollment.');}
		finally{setBusy(false);}
	}

	async function updateTotp(event:FormEvent<HTMLFormElement>){
		event.preventDefault();
		setBusy(true);setError('');setMessage('');
		try{
			const response=await fetch('/api/security/totp',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:totpSetup?'confirm':'disable',password:totpPassword,...(totpSetup?{secondFactorCode:totpCode}:{})})});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to update two-factor security.');
			setTwoFactorEnabled(Boolean(result.enabled));
			if(result.recoveryCodes)setRecoveryCodes(result.recoveryCodes);
			setTotpSetup(null);setTotpCode('');setTotpPassword('');
			if(!result.enabled)await update();
			setMessage(result.enabled?'Two-factor authentication is enabled. Save your recovery codes now.':'Two-factor authentication has been disabled.');
			await loadSessions();
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to update two-factor security.');}
		finally{setBusy(false);}
	}

	function startSessionAction(action:SessionAction['action'],sessionId?:string){
		setSessionAction({action,sessionId});setSessionPassword('');setError('');setMessage('');
	}

	async function submitSessionAction(event:FormEvent<HTMLFormElement>){
		event.preventDefault();
		if(!sessionAction)return;
		setBusy(true);setError('');setMessage('');
		try{
			const response=await fetch('/api/security/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...sessionAction,password:sessionPassword})});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to update active sessions.');
			setSessionAction(null);setSessionPassword('');
			setMessage('Active sessions updated.');
			if(result.currentRevoked)await signOut({callbackUrl:'/login'});
			else await loadSessions();
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to update active sessions.');}
		finally{setBusy(false);}
	}

	const passwordStrength=strength(newPassword);
	const activeCount=sessions.length;
	const needsSessionConfirmation=sessionAction?.action==='logout-all'||sessionAction?.action==='logout-others';

	return <section className="account-panel card p-5 security-center" aria-labelledby="security-center-title">
		<div className="account-panel-title"><div><h2 id="security-center-title">Financial Account Security Center</h2><p className="account-panel-subtitle">Manage the protections that secure your Aurevia account.</p></div><ShieldCheck size={18} className="gold" aria-hidden="true"/></div>
		{error&&<p className="account-callout security-center-alert" role="alert">{error}</p>}
		{message&&<p className="account-callout security-center-success" role="status">{message}</p>}

		<article className="security-center-card">
			<div className="security-center-row"><span className="security-center-icon"><GoldLockIcon/></span><div className="security-center-copy"><b>Password Sign-in</b><p>Your account uses password-protected sign-in. Passwords are securely hashed on the server.</p></div><span className="status-pill">ENABLED</span></div>
			{!passwordExpanded?<button className="security-center-action" type="button" onClick={()=>setPasswordExpanded(true)}>Change password</button>:<form className="security-center-form" onSubmit={event=>void submitPasswordChange(event)}>
				<PasswordInput label="Current password" value={currentPassword} onChange={setCurrentPassword}/>
				<PasswordInput label="New password" value={newPassword} onChange={setNewPassword} autoComplete="new-password"/>
				<div className="security-password-strength" role="status" aria-label={`Password strength: ${passwordStrength.label}`}><span><i style={{width:`${passwordStrength.score*20}%`}}/></span><b>{passwordStrength.label}</b></div>
				<PasswordInput label="Confirm new password" value={confirmPassword} onChange={setConfirmPassword} autoComplete="new-password"/>
				<p className="text-xs muted">Password must be at least 10 characters and include an uppercase letter, a lowercase letter, and a number.</p>
				<div className="flex flex-wrap gap-2"><button className="btn bg-gold text-black" type="submit" disabled={busy}>{busy?'Updating…':'Update password'}</button><button className="btn bg-white/5" type="button" disabled={busy} onClick={()=>setPasswordExpanded(false)}>Cancel</button></div>
			</form>}
		</article>

		<article className="security-center-card">
			<div className="security-center-row"><span className="security-center-icon"><GoldShieldIcon/></span><div className="security-center-copy"><b>Two-Factor Authentication</b><p>{twoFactorEnabled?'Your authenticator is managed here and does not change password-only sign-in.':'Optional authenticator setup is managed here and is never required for registration or sign-in.'}</p></div><span className={`status-pill ${twoFactorEnabled?'security-status-enabled':''}`}>{twoFactorEnabled?'ENABLED':'DISABLED'}</span></div>
			{!twoFactorAvailable&&<p className="security-center-unavailable" role="status">Authenticator setup is unavailable until the server-side TOTP encryption key is configured.</p>}
			{twoFactorAvailable&&!totpExpanded&&!recoveryCodes.length&&<button className="security-center-action" type="button" disabled={busy} onClick={()=>{setTotpExpanded(true);setTotpSetup(null);setTotpPassword('');setTotpCode('')}}>{twoFactorEnabled?'Disable two-factor authentication':'Enable two-factor authentication'}</button>}
			{totpExpanded&&<form className="security-center-form" onSubmit={event=>void updateTotp(event)}>
				{!totpSetup&&<PasswordInput label="Current password" value={totpPassword} onChange={setTotpPassword}/>}
				{!twoFactorEnabled&&!totpSetup&&<p className="text-xs muted">You will scan an authenticator QR code and verify one code before protection is enabled.</p>}
				{!totpSetup&&!twoFactorEnabled&&<div className="flex flex-wrap gap-2"><button className="btn bg-gold text-black" type="button" disabled={busy||!totpPassword} onClick={()=>void beginTotpEnrollment()}>{busy?'Preparing…':'Continue enrollment'}</button><button className="btn bg-white/5" type="button" disabled={busy} onClick={()=>setTotpExpanded(false)}>Cancel</button></div>}
				{totpSetup&&<><div className="security-center-qr"><Image src={totpSetup.qrCode} width={176} height={176} unoptimized alt="Scan this QR code with your authenticator application"/><p>Scan the QR code in a compatible authenticator app, or enter this setup key manually:</p><code>{totpSetup.manualKey}</code><small>This enrollment expires in 10 minutes. Keep the setup key private.</small></div><label className="account-label">Authenticator verification code<input className="input" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={totpCode} onChange={event=>setTotpCode(event.target.value)} required/></label><div className="flex flex-wrap gap-2"><button className="btn bg-gold text-black" type="submit" disabled={busy||!totpPassword||totpCode.length!==6}>{busy?'Verifying…':'Verify and enable'}</button><button className="btn bg-white/5" type="button" disabled={busy} onClick={()=>{setTotpSetup(null);setTotpExpanded(false)}}>Cancel</button></div></>}
				{twoFactorEnabled&&<><p className="text-xs muted">Disabling two-factor protection requires your current password.</p><div className="flex flex-wrap gap-2"><button className="btn bg-loss text-black" type="submit" disabled={busy||!totpPassword}>{busy?'Updating…':'Disable two-factor authentication'}</button><button className="btn bg-white/5" type="button" disabled={busy} onClick={()=>setTotpExpanded(false)}>Cancel</button></div></>}
			</form>}
			{recoveryCodes.length>0&&<div className="security-recovery-codes" role="alert"><b>Save these one-time recovery codes now</b><p>Each code works once. They will not be shown again.</p><ul>{recoveryCodes.map(code=><li key={code}><code>{code}</code></li>)}</ul><button className="btn bg-gold text-black" type="button" onClick={()=>{setRecoveryCodes([]);setTotpExpanded(false)}}>I’ve saved my recovery codes</button></div>}
		</article>

		<article className="security-center-card">
			<div className="security-center-row"><span className="security-center-session-icon"><KeyRound size={17}/></span><div className="security-center-copy"><b>Current Server Session</b><p>{activeCount} active {activeCount===1?'session':'sessions'} · Session identifiers are not displayed.</p></div><button type="button" className="icon-action" aria-label="Refresh active sessions" disabled={loadingSessions} onClick={()=>void loadSessions()}><RefreshCw size={15} className={loadingSessions?'animate-spin':''}/></button></div>
			{loadingSessions?<p className="security-center-empty" role="status">Loading active sessions…</p>:sessions.length===0?<p className="security-center-empty">No active sessions are currently listed.</p>:<ul className="security-session-list">{sessions.map(activeSession=><li key={activeSession.id}><div><b>{activeSession.deviceLabel||'Unknown device'}{activeSession.current&&<span className="security-current-badge">CURRENT</span>}</b><small>Created {new Date(activeSession.createdAt).toLocaleString()}</small><small>Last activity {new Date(activeSession.lastActivityAt).toLocaleString()}</small></div><div className="security-session-actions">{!activeSession.current&&<button type="button" className="icon-action" aria-label={`Revoke ${activeSession.deviceLabel||'session'}`} onClick={()=>startSessionAction('revoke-session',activeSession.id)}><Trash2 size={15}/></button>}{activeSession.current&&<span className="muted text-xs">This device</span>}</div></li>)}</ul>}
			{sessions.length>0&&<div className="security-center-session-buttons"><button type="button" className="btn bg-white/5" disabled={busy||activeCount<2} onClick={()=>startSessionAction('logout-others')}><LogOut size={15}/> Log out other sessions</button><button type="button" className="btn bg-loss text-black" disabled={busy} onClick={()=>startSessionAction('logout-all')}><LogOut size={15}/> Log out all devices</button></div>}
			{sessionAction&&<form className="security-center-form security-session-reauth" onSubmit={event=>void submitSessionAction(event)}>
				<p className="text-sm">{needsSessionConfirmation?'Confirm this session change with your current password.':'Verify your identity before revoking this session.'}</p>
				<PasswordInput label="Current password" value={sessionPassword} onChange={setSessionPassword}/>
				<div className="flex flex-wrap gap-2"><button className="btn bg-gold text-black" type="submit" disabled={busy||!sessionPassword}>{busy?'Verifying…':needsSessionConfirmation?'Confirm session change':'Revoke session'}</button><button className="btn bg-white/5" type="button" disabled={busy} onClick={()=>setSessionAction(null)}>Cancel</button></div>
			</form>}
		</article>
		<div className="account-callout security-center-notice"><span>Security alerts are recorded in your Aurevia notifications. Approximate location is not shown because reliable location data is not available.</span></div>
		<p className="security-center-account">Account: {email}</p>
	</section>;
}
