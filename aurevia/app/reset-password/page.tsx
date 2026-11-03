'use client';

import {FormEvent,useEffect,useState} from 'react';
import Link from 'next/link';
import Image from 'next/image';
import Nav from '@/components/Nav';

export default function ResetPassword(){
	const [token,setToken]=useState('');
	const [password,setPassword]=useState('');
	const [confirmation,setConfirmation]=useState('');
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
	return <><Nav/><main className="auth-scene"><section className="auth-card" aria-labelledby="reset-title"><div className="auth-brand"><Image src="/aurevia-logo.png" alt="" width={52} height={52} priority/><span className="brand-copy"><strong>Aurevia</strong><small>EXCHANGE</small></span></div><p className="account-kicker">ACCOUNT RECOVERY</p><h1 id="reset-title" className="auth-heading">Set a new password</h1>{complete?<><p className="text-sm text-profit" role="status">{message}</p><p className="auth-footer"><Link href="/login" className="auth-link">Continue to sign in</Link></p></>:!token?<><p className="auth-error" role="alert">This recovery link is missing or invalid.</p><p className="auth-footer"><Link href="/forgot-password" className="auth-link">Request a new link</Link></p></>:<><p className="auth-subtitle">Use at least 10 characters, including uppercase, lowercase, and a number. Recovery links expire after 30 minutes.</p><form onSubmit={submit} className="mt-5 space-y-4"><label className="auth-field-label">New password<input className="auth-input" type="password" autoComplete="new-password" minLength={10} maxLength={128} required value={password} onChange={event=>setPassword(event.target.value)}/></label><label className="auth-field-label">Confirm new password<input className="auth-input" type="password" autoComplete="new-password" minLength={10} maxLength={128} required value={confirmation} onChange={event=>setConfirmation(event.target.value)}/></label>{error&&<p className="auth-error" role="alert">{error}</p>}<button type="submit" className="auth-submit w-full" disabled={busy}>{busy?'Updating…':'Change password'}</button></form></>}</section></main></>;
}