'use client';

import {FormEvent,useEffect,useState} from 'react';
import Link from 'next/link';
import Image from 'next/image';
import {ArrowRight,Eye,EyeOff,KeyRound,ShieldCheck} from 'lucide-react';
import Nav from '@/components/Nav';

export default function ResetPassword(){
	const [token,setToken]=useState('');
	const [password,setPassword]=useState('');
	const [confirmation,setConfirmation]=useState('');
	const [passwordVisible,setPasswordVisible]=useState(false);
	const [confirmationVisible,setConfirmationVisible]=useState(false);
	const [message,setMessage]=useState('');
	const [error,setError]=useState('');
	const [busy,setBusy]=useState(false);
	const [complete,setComplete]=useState(false);
	useEffect(()=>{
		const fragmentToken=new URLSearchParams(window.location.hash.slice(1)).get('token');
		const queryToken=new URLSearchParams(window.location.search).get('token');
		setToken(fragmentToken||queryToken||'');
		if(fragmentToken||queryToken)window.history.replaceState(null,'',window.location.pathname);
	},[]);
	async function submit(event:FormEvent<HTMLFormElement>){
		event.preventDefault();if(busy||!token)return;
		setError('');setMessage('');
		if(password!==confirmation){setError('The passwords do not match.');return;}
		setBusy(true);
		try{
			const response=await fetch('/api/password-reset/confirm',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token,password})});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Password reset failed.');
			setComplete(true);setPassword('');setConfirmation('');setMessage('Password changed. Other active sessions were signed out.');
		}catch(exception){setError(exception instanceof Error?exception.message:'Password reset failed.')}
		finally{setBusy(false)}
	}
	return <><Nav/><main className="auth-scene"><section className="auth-card auth-recovery-card" aria-labelledby="reset-title"><div className="auth-brand"><Image src="/aurevia-logo.png" alt="" width={52} height={52} priority/><span className="brand-copy"><strong>Aurevia</strong><small>EXCHANGE</small></span></div><span className="recovery-icon"><KeyRound size={21} aria-hidden="true"/></span><p className="account-kicker">ACCOUNT RECOVERY</p><h1 id="reset-title" className="auth-heading">Set a new password</h1>{complete?<><p className="auth-success" role="status">{message}</p><p className="auth-footer"><Link href="/login" className="auth-link">Continue to sign in</Link></p></>:!token?<><p className="auth-error" role="alert">This recovery link is missing or invalid.</p><p className="auth-footer"><Link href="/forgot-password" className="auth-link">Request a new link</Link></p></>:<><p className="auth-subtitle">Choose a strong password with at least 10 characters, including uppercase, lowercase, and a number. Your recovery link expires after 30 minutes.</p><form onSubmit={submit} className="mt-5 space-y-4"><div><label className="auth-field-label" htmlFor="reset-new-password">New password</label><div className="auth-password-wrap"><input id="reset-new-password" className="auth-input" type={passwordVisible?'text':'password'} autoComplete="new-password" minLength={10} maxLength={128} required value={password} onChange={event=>setPassword(event.target.value)}/><button type="button" className="auth-password-toggle" aria-label={passwordVisible?'Hide password':'Show password'} aria-pressed={passwordVisible} onClick={()=>setPasswordVisible(value=>!value)}>{passwordVisible?<EyeOff size={18}/>:<Eye size={18}/>}</button></div></div><div><label className="auth-field-label" htmlFor="reset-confirm-password">Confirm new password</label><div className="auth-password-wrap"><input id="reset-confirm-password" className="auth-input" type={confirmationVisible?'text':'password'} autoComplete="new-password" minLength={10} maxLength={128} required value={confirmation} onChange={event=>setConfirmation(event.target.value)}/><button type="button" className="auth-password-toggle" aria-label={confirmationVisible?'Hide password':'Show password'} aria-pressed={confirmationVisible} onClick={()=>setConfirmationVisible(value=>!value)}>{confirmationVisible?<EyeOff size={18}/>:<Eye size={18}/>}</button></div></div>{error&&<p className="auth-error" role="alert">{error}</p>}<button type="submit" className="auth-submit auth-recovery-submit w-full" disabled={busy}>{busy?'Updating…':'Change password'}{!busy&&<ArrowRight size={16} aria-hidden="true"/>}</button></form><div className="auth-assurance"><ShieldCheck size={17} className="gold" aria-hidden="true"/><span><b>One-time recovery link</b><small>Changing your password signs out other active sessions.</small></span></div></>}</section></main></>;
}