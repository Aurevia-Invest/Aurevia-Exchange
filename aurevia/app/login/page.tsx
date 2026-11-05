'use client';

import {FormEvent,useEffect,useState} from 'react';
import {signIn,useSession} from 'next-auth/react';
import {useRouter} from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import {Eye,EyeOff,LoaderCircle,ShieldCheck} from 'lucide-react';
import Nav from '@/components/Nav';
import {useLocale} from '@/lib/i18n-context';
import {safeInternalPath} from '@/lib/navigation';

export default function Login(){
	const {translate}=useLocale();
	const [identifier,setIdentifier]=useState('');
	const [password,setPassword]=useState('');
	const [passwordVisible,setPasswordVisible]=useState(false);
	const [error,setError]=useState('');
	const [registered,setRegistered]=useState(false);
	const [callbackUrl,setCallbackUrl]=useState('/dashboard');
	const [busy,setBusy]=useState(false);
	const router=useRouter();
	const {update}=useSession();

	useEffect(()=>{
		const query=new URLSearchParams(window.location.search);
		try{
			const registrationEmail=window.sessionStorage.getItem('aurevia-signin-email');
			if(registrationEmail){
				setIdentifier(registrationEmail);
				window.sessionStorage.removeItem('aurevia-signin-email');
			}
		}catch(error){
			console.warn('Unable to restore the registration email for sign-in.',{
				errorName:error instanceof Error?error.name:'UnknownError',
			});
		}
		setRegistered(query.get('registered')==='1');
		setCallbackUrl(safeInternalPath(query.get('callbackUrl')||'/dashboard'));
	},[]);

	async function submit(event:FormEvent<HTMLFormElement>){
		event.preventDefault();if(busy)return;setBusy(true);setError('');
		try{
			const result=await signIn('credentials',{username:identifier,email:identifier,password,redirect:false});
			if(result?.ok){
				await update();router.replace(callbackUrl);router.refresh();
			}else if(result?.error==='CredentialsSignin'){
				setError('Email address or password is incorrect.');
			}else{
				setError(translate('unableAuth'));
			}
		}catch{setError(translate('unableAuth'))}
		finally{setBusy(false);}
	}

	return <><Nav/><main className="auth-scene"><section className="auth-card auth-signin-card" aria-labelledby="signin-title">
		<div className="auth-brand"><Image src="/aurevia-logo.png" alt="" width={52} height={52} priority/><span className="brand-copy"><strong>Aurevia</strong><small>EXCHANGE</small></span></div>
		<p className="account-kicker">{translate('secureAccess')} · PRIVATE ACCOUNT ACCESS</p>
		<h1 id="signin-title" className="auth-heading">{translate('welcomeBack')}</h1>
		<p className="auth-subtitle">Sign in to pick up where you left off. Your account is protected with secure, encrypted access.</p>
		<div className="auth-market-line" aria-hidden="true"/>
		{registered&&<p className="mt-4 text-sm text-profit" role="status">{translate('registeredSignIn')}</p>}
		<form onSubmit={submit} className="mt-5 space-y-4">
			<label className="auth-field-label">{translate('emailOrUsername')}<input className="auth-input" name="username" type="text" autoComplete="username" value={identifier} onChange={event=>{setIdentifier(event.target.value);setError('')}} required/></label>
			<div><label className="auth-field-label" htmlFor="login-password">{translate('password')}</label><div className="auth-password-wrap"><input id="login-password" className="auth-input" name="password" type={passwordVisible?'text':'password'} autoComplete="current-password" value={password} onChange={event=>{setPassword(event.target.value);setError('')}} required/><button type="button" className="auth-password-toggle" aria-label={passwordVisible?translate('hidePassword'):translate('showPassword')} aria-pressed={passwordVisible} onClick={()=>setPasswordVisible(value=>!value)}>{passwordVisible?<EyeOff size={18}/>:<Eye size={18}/>}</button></div></div>
			<div className="auth-inline-links"><span>{translate('protected')}</span><Link className="auth-link" href="/forgot-password">{translate('forgotPassword')}</Link></div>
			{error&&<p className="auth-error" role="alert">{error}</p>}
			<button type="submit" disabled={busy} className="auth-submit flex w-full items-center justify-center gap-2" aria-busy={busy}>{busy?<><LoaderCircle size={16} className="animate-spin" aria-hidden="true"/>{translate('loading')}</> : translate('signIn')}</button>
		</form>
		<p className="auth-footer">{translate('newToAurevia')} <Link className="auth-link" href="/register">{translate('createAccount')}</Link></p>
		<div className="auth-assurance"><ShieldCheck size={17} className="gold" aria-hidden="true"/><span><b>{translate('protectedSession')}</b><small>Your password stays private and is never shown in the app.</small></span></div>
	</section></main></>;
}