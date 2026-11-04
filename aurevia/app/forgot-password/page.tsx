'use client';

import {FormEvent,useState} from 'react';
import Link from 'next/link';
import Image from 'next/image';
import {ArrowRight,Mail,ShieldCheck} from 'lucide-react';
import Nav from '@/components/Nav';

export default function ForgotPassword(){
	const [email,setEmail]=useState('');
	const [message,setMessage]=useState('');
	const [error,setError]=useState('');
	const [busy,setBusy]=useState(false);
	async function submit(event:FormEvent<HTMLFormElement>){
		event.preventDefault();if(busy)return;
		setBusy(true);setMessage('');setError('');
		try{
			const response=await fetch('/api/password-reset/request',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email})});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Password recovery is unavailable.');
			setMessage(result.message||'If an eligible account matches, recovery instructions may be emailed.');
		}catch(exception){setError(exception instanceof Error?exception.message:'Password recovery is unavailable.')}
		finally{setBusy(false)}
	}
	return <><Nav/><main className="auth-scene"><section className="auth-card auth-recovery-card" aria-labelledby="forgot-title"><div className="auth-brand"><Image src="/aurevia-logo.png" alt="" width={52} height={52} priority/><span className="brand-copy"><strong>Aurevia</strong><small>EXCHANGE</small></span></div><span className="recovery-icon"><Mail size={21} aria-hidden="true"/></span><p className="account-kicker">ACCOUNT RECOVERY</p><h1 id="forgot-title" className="auth-heading">Forgot password?</h1><p className="auth-subtitle">Enter the email address linked to your account. We’ll send a private, time-limited link if an eligible account matches.</p><form onSubmit={submit} className="mt-5 space-y-4"><label className="auth-field-label">Email address<input className="auth-input" type="email" autoComplete="email" required maxLength={254} value={email} onChange={event=>setEmail(event.target.value)}/></label>{error&&<p className="auth-error" role="alert">{error}</p>}{message&&<p className="auth-success" role="status">{message}</p>}<button type="submit" className="auth-submit auth-recovery-submit w-full" disabled={busy}>{busy?'Sending…':'Send recovery link'}{!busy&&<ArrowRight size={16} aria-hidden="true"/>}</button></form><div className="auth-assurance"><ShieldCheck size={17} className="gold" aria-hidden="true"/><span><b>Private recovery</b><small>Links expire after 30 minutes and can only be used once.</small></span></div><p className="auth-footer"><Link href="/login" className="auth-link">Return to sign in</Link></p></section></main></>;
}