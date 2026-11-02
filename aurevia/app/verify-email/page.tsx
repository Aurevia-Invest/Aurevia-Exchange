'use client';

import {useCallback,useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {ShieldCheck} from 'lucide-react';
import Nav from '@/components/Nav';

type Attempt={attemptId:string;iframeUrl:string;expiresAt:string};
const ATTEMPT_STORAGE_KEY='aurevia-akedly-email-attempt';

function safeWidgetUrl(value:string){
	try{return new URL(value).origin==='https://auth.akedly.io'}catch{return false}
}

export default function VerifyEmailPage(){
	const router=useRouter();
	const [email,setEmail]=useState('');
	const [attempt,setAttempt]=useState<Attempt|null>(null);
	const [emailCodeMode,setEmailCodeMode]=useState(false);
	const [code,setCode]=useState('');
	const [message,setMessage]=useState('');
	const [error,setError]=useState('');
	const [busy,setBusy]=useState(false);
	const busyRef=useRef(false);

	useEffect(()=>{
		const params=new URLSearchParams(window.location.search);
		setEmail((params.get('email')||'').trim().toLowerCase());
	},[]);

	const startVerification=useCallback(async()=>{
		if(!email||busyRef.current)return;
		busyRef.current=true;
		setBusy(true);setError('');setMessage('');
		try{
			const response=await fetch('/api/register/resend',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email})});
			const result=await response.json();
			if(result.verified){
				window.sessionStorage.removeItem(ATTEMPT_STORAGE_KEY);
				router.replace('/login?verified=1');
				return;
			}
			if(!response.ok)throw new Error(result.error||'Unable to start email verification.');
			if(result.method==='email-code'){
				window.sessionStorage.setItem(ATTEMPT_STORAGE_KEY,JSON.stringify({email,method:'email-code'}));
				setAttempt(null);
				setEmailCodeMode(true);
				setMessage(result.message||'Enter the six-digit verification code sent to your email.');
				return;
			}
			if(typeof result.attemptId==='string'&&typeof result.iframeUrl==='string'&&safeWidgetUrl(result.iframeUrl)&&typeof result.expiresAt==='string'){
				const nextAttempt:Attempt={attemptId:result.attemptId,iframeUrl:result.iframeUrl,expiresAt:result.expiresAt};
				window.sessionStorage.setItem(ATTEMPT_STORAGE_KEY,JSON.stringify({email,...nextAttempt}));
				setAttempt(nextAttempt);
				setEmailCodeMode(false);
				setMessage('Complete the secure verification below. This attempt expires in five minutes.');
				return;
			}
			setMessage(result.message||'If an eligible account exists, you can continue verification after the resend cooldown.');
		}catch(exception){
			setError(exception instanceof Error?exception.message:'Unable to start email verification.');
		}finally{
			busyRef.current=false;
			setBusy(false);
		}
	},[email,router]);

	const verifyEmailCode=async()=>{
		if(!email||!/^\d{6}$/.test(code)||busyRef.current)return;
		busyRef.current=true;
		setBusy(true);setError('');setMessage('');
		try{
			const response=await fetch('/api/register/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,code})});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to verify this email address.');
			window.sessionStorage.removeItem(ATTEMPT_STORAGE_KEY);
			router.replace('/login?verified=1');
		}catch(exception){
			setError(exception instanceof Error?exception.message:'Unable to verify this email address.');
		}finally{
			busyRef.current=false;
			setBusy(false);
		}
	};

	useEffect(()=>{
		if(!email)return;
		try{
			const saved=window.sessionStorage.getItem(ATTEMPT_STORAGE_KEY);
			if(saved){
				const stored=JSON.parse(saved) as {email?:unknown;method?:unknown;attemptId?:unknown;iframeUrl?:unknown;expiresAt?:unknown};
				if(stored.email===email&&stored.method==='email-code'){
					setEmailCodeMode(true);
					setMessage('Enter the six-digit verification code sent to your email.');
					return;
				}
				if(stored.email===email&&typeof stored.attemptId==='string'&&typeof stored.iframeUrl==='string'&&safeWidgetUrl(stored.iframeUrl)&&typeof stored.expiresAt==='string'&&Date.parse(stored.expiresAt)>Date.now()){
					setAttempt({attemptId:stored.attemptId,iframeUrl:stored.iframeUrl,expiresAt:stored.expiresAt});
					return;
				}
			}
		}catch{
			window.sessionStorage.removeItem(ATTEMPT_STORAGE_KEY);
		}
		void startVerification();
	},[email,startVerification]);

	useEffect(()=>{
		if(!attempt||!email)return;
		let cancelled=false;
		let timeout:ReturnType<typeof setTimeout>;
		const check=async()=>{
			try{
				const response=await fetch('/api/register/status',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,attemptId:attempt.attemptId})});
				if(response.ok){
					const result=await response.json();
					if(result.verified){
						window.sessionStorage.removeItem(ATTEMPT_STORAGE_KEY);
						router.replace('/login?verified=1');
						return;
					}
					if(result.expired){
						window.sessionStorage.removeItem(ATTEMPT_STORAGE_KEY);
						setAttempt(null);
						setMessage('This verification attempt expired. Request a new one to continue.');
						return;
					}
				}
			}catch{
				if(!cancelled)setMessage('Verification is still being checked. Keep this page open or check again shortly.');
			}
			if(!cancelled)timeout=setTimeout(()=>void check(),3000);
		};
		timeout=setTimeout(()=>void check(),3000);
		return ()=>{cancelled=true;clearTimeout(timeout);};
	},[attempt,email,router]);

	useEffect(()=>{
		if(!attempt||!email)return;
		const params=new URLSearchParams(window.location.search);
		const callbackAttemptId=params.get('attemptId');
		if(params.get('status')!=='success'||callbackAttemptId!==attempt.attemptId)return;
		void fetch('/api/register/confirm',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,attemptId:attempt.attemptId})})
			.then(async response=>{
				if(!response.ok)return;
				const result=await response.json();
				if(result.verified){
					window.sessionStorage.removeItem(ATTEMPT_STORAGE_KEY);
					router.replace('/login?verified=1');
				}
			})
			.catch(()=>setMessage('The provider redirect was received, but verification is not complete until Akedly confirms it.'));
	},[attempt,email,router]);

	return <><Nav/><main className="auth-scene"><section className="auth-card auth-register-card" aria-labelledby="verify-email-title">
		<div className="flex items-center gap-2 gold"><ShieldCheck size={20} aria-hidden="true"/><span className="text-sm font-semibold">Email verification</span></div>
		<h1 id="verify-email-title" className="auth-heading mt-3">Verify your email address</h1>
		<p className="mt-2 text-sm leading-6 muted">Your account is pending email verification. {emailCodeMode?'Enter the six-digit code sent to your email to continue.':'Complete the secure verification experience to continue.'} Email verification does not approve KYC or authorize financial activity.</p>
		<label className="auth-field-label mt-5">Email address<input className="auth-input" type="email" autoComplete="email" value={email} onChange={event=>{window.sessionStorage.removeItem(ATTEMPT_STORAGE_KEY);setAttempt(null);setEmailCodeMode(false);setCode('');setEmail(event.target.value.trim().toLowerCase());setMessage('')}} required maxLength={254}/></label>
		{attempt&&<div className="mt-5 overflow-hidden rounded-lg border border-white/10 bg-black/30">
			<iframe className="block h-[700px] w-full max-w-full" src={attempt.iframeUrl} title="Akedly secure email verification" allow="clipboard-write; publickey-credentials-get *; publickey-credentials-create *"/>
		</div>}
		{emailCodeMode&&<div className="mt-5"><label className="auth-field-label">Six-digit email verification code<input className="auth-input" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={event=>setCode(event.target.value.replace(/\D/g,'').slice(0,6))}/></label><button className="auth-submit mt-3 w-full" type="button" disabled={busy||code.length!==6} onClick={()=>void verifyEmailCode()}>{busy?'Verifying…':'Verify email address'}</button></div>}
		{error&&<p className="auth-error mt-4" role="alert">{error}</p>}
		{message&&<p className="mt-4 text-sm muted" role="status">{message}</p>}
		<button className="auth-submit mt-5 w-full" type="button" disabled={busy||!email} onClick={()=>void startVerification()}>{busy?'Starting verification…':attempt||emailCodeMode?'Request another verification code':'Start email verification'}</button>
		<p className="auth-footer mt-5">Already verified? <Link href="/login" className="auth-link">Sign in</Link></p>
	</section></main></>;
}
