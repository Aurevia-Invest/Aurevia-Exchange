'use client';

import {useCallback,useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {ShieldCheck} from 'lucide-react';
import Nav from '@/components/Nav';

type Attempt={attemptId:string;iframeUrl:string;expiresAt:string;channel?:'EMAIL'|'SMS'};
const ATTEMPT_STORAGE_KEY='aurevia-akedly-registration-attempt';

function safeWidgetUrl(value:string){
	try{return new URL(value).origin==='https://auth.akedly.io'}catch{return false}
}

export default function VerifyEmailPage(){
	const router=useRouter();
	const [email,setEmail]=useState('');
	const [phone,setPhone]=useState('');
	const [existingAccount,setExistingAccount]=useState(false);
	const [attempt,setAttempt]=useState<Attempt|null>(null);
	const [emailCodeMode,setEmailCodeMode]=useState(false);
	const [code,setCode]=useState('');
	const [message,setMessage]=useState('');
	const [error,setError]=useState('');
	const [phoneConflict,setPhoneConflict]=useState(false);
	const [sessionRestoreFailed,setSessionRestoreFailed]=useState(false);
	const [busy,setBusy]=useState(false);
	const busyRef=useRef(false);

	useEffect(()=>{
		const params=new URLSearchParams(window.location.search);
		const nextEmail=(params.get('email')||'').trim().toLowerCase();
		setExistingAccount(params.get('existing')==='1');
		const registrationToken=new URLSearchParams(window.location.hash.slice(1)).get('registrationToken');
		if(!registrationToken){
			setEmail(nextEmail);
			void fetch(`/api/register/session?email=${encodeURIComponent(nextEmail)}`,{cache:'no-store'})
				.then(response=>response.ok?response.json():null)
				.then(result=>{if(typeof result?.phone==='string')setPhone(result.phone);})
				.catch(()=>undefined);
			return;
		}
		window.history.replaceState(null,'',`${window.location.pathname}${window.location.search}`);
		void fetch('/api/register/session',{
			method:'POST',
			headers:{'content-type':'application/json'},
			body:JSON.stringify({email:nextEmail,registrationToken}),
		}).then(async response=>{
			if(!response.ok)throw new Error('This registration session is invalid or expired.');
			const session=await fetch(`/api/register/session?email=${encodeURIComponent(nextEmail)}`,{cache:'no-store'});
			if(session.ok){
				const details=await session.json();
				if(typeof details.phone==='string')setPhone(details.phone);
			}
			setEmail(nextEmail);
		}).catch(()=>{
			setSessionRestoreFailed(true);
			setError('This registration session is invalid or expired. Start a new registration to continue.');
			setEmail(nextEmail);
		});
	},[]);

	const startVerification=useCallback(async()=>{
		if(!email||sessionRestoreFailed||busyRef.current)return;
		busyRef.current=true;
		setBusy(true);setError('');setMessage('');
		try{
			const response=await fetch('/api/register/resend',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email}),signal:AbortSignal.timeout(15_000)});
			const result=await response.json();
			if(result.phoneConflict){
				window.sessionStorage.removeItem(ATTEMPT_STORAGE_KEY);
				setAttempt(null);
				setEmailCodeMode(false);
				setPhoneConflict(true);
				setMessage(result.error||'That phone number is already associated with another account. Restart without it or use a different one.');
				return;
			}
			if(result.verified){
				window.sessionStorage.removeItem(ATTEMPT_STORAGE_KEY);
				router.replace(result.authenticated?'/dashboard':'/login?verified=1');
				return;
			}
			if(!response.ok){
				if(result.code==='EMAIL_DELIVERY_STATUS_UNKNOWN'){
					setEmailCodeMode(false);
					const retryAfter=Number(response.headers.get('Retry-After')||result.retryAfterSeconds);
					const retryMessage=Number.isFinite(retryAfter)&&retryAfter>0
						?` You can request another code in ${retryAfter>=60?`${Math.ceil(retryAfter/60)} minute(s)`:`${retryAfter} second(s)`}.`
						:'';
					setMessage(`${result.error||'Delivery status is uncertain. If the code arrives, enter it here; retrying will not send another code during the cooldown.'}${retryMessage}`);
					return;
				}
				const retryAfter=Number(response.headers.get('Retry-After')||result.retryAfterSeconds);
				const retryMessage=Number.isFinite(retryAfter)&&retryAfter>0
					?` You can retry in ${retryAfter>=60?`${Math.ceil(retryAfter/60)} minute(s)`:`${retryAfter} second(s)`}.`
					:'';
				throw new Error(`${result.error||'Unable to start registration verification.'}${retryMessage}`);
			}
			if(result.method==='email-code'){
				window.sessionStorage.setItem(ATTEMPT_STORAGE_KEY,JSON.stringify({email,method:'email-code'}));
				setAttempt(null);
				setEmailCodeMode(true);
				setMessage(result.message||'Enter the six-digit code sent to your email.');
				return;
			}
			if(typeof result.attemptId==='string'&&typeof result.iframeUrl==='string'&&safeWidgetUrl(result.iframeUrl)&&typeof result.expiresAt==='string'){
				const nextAttempt:Attempt={attemptId:result.attemptId,iframeUrl:result.iframeUrl,expiresAt:result.expiresAt,channel:result.channel==='SMS'?'SMS':'EMAIL'};
				window.sessionStorage.setItem(ATTEMPT_STORAGE_KEY,JSON.stringify({email,...nextAttempt}));
				setAttempt(nextAttempt);
				setEmailCodeMode(false);
				setMessage(`Complete secure ${nextAttempt.channel==='SMS'?'phone':'email'} verification below. This attempt expires in five minutes.`);
				return;
			}
			setMessage(result.message||'If the registration is eligible, verification can continue after the resend cooldown.');
		}catch(exception){
			setError(exception instanceof Error?exception.message:'Unable to start registration verification.');
		}finally{
			busyRef.current=false;
			setBusy(false);
		}
	},[email,router,sessionRestoreFailed]);

	const verifyEmailCode=async()=>{
		if(!email||!/^\d{6}$/.test(code)||busyRef.current)return;
		busyRef.current=true;
		setBusy(true);setError('');setMessage('');
		try{
			const response=await fetch('/api/register/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,code}),signal:AbortSignal.timeout(15_000)});
			const result=await response.json();
			if(!response.ok){
				if(result.code==='PHONE_ALREADY_IN_USE'){
					window.sessionStorage.removeItem(ATTEMPT_STORAGE_KEY);
					setEmailCodeMode(false);
					setPhoneConflict(true);
				}
				if(result.code==='VERIFICATION_CODE_EXPIRED'){
					setCode('');
					setMessage('This verification code expired. Request a new code to continue.');
					return;
				}
				if(result.code==='INVALID_VERIFICATION_CODE'){
					setError(result.error||'That verification code is incorrect. Check the email and try again.');
					return;
				}
				if(result.code==='VERIFICATION_ATTEMPTS_EXHAUSTED'){
					setCode('');
					setError(result.error||'Too many incorrect codes. Request a new verification code to continue.');
					return;
				}
				throw new Error(result.error||'Unable to verify this email address.');
			}
			window.sessionStorage.removeItem(ATTEMPT_STORAGE_KEY);
			router.replace('/login?verified=1');
		}catch(exception){
			setError(exception instanceof Error&&exception.name==='TimeoutError'
				?'Verification is taking longer than expected. Check your connection and retry; no new code was requested.'
				:exception instanceof Error?exception.message:'Unable to verify this email address.');
		}finally{
			busyRef.current=false;
			setBusy(false);
		}
	};

	useEffect(()=>{
		if(!email||sessionRestoreFailed)return;
		try{
			const saved=window.sessionStorage.getItem(ATTEMPT_STORAGE_KEY);
			if(saved){
				const stored=JSON.parse(saved) as {email?:unknown;method?:unknown;attemptId?:unknown;iframeUrl?:unknown;expiresAt?:unknown;channel?:unknown};
				if(stored.email===email&&stored.method==='email-code'){
					setEmailCodeMode(true);
					setMessage('Enter the six-digit code sent to your email.');
					return;
				}
				if(stored.email===email&&typeof stored.attemptId==='string'&&typeof stored.iframeUrl==='string'&&safeWidgetUrl(stored.iframeUrl)&&typeof stored.expiresAt==='string'&&Date.parse(stored.expiresAt)>Date.now()){
					setAttempt({attemptId:stored.attemptId,iframeUrl:stored.iframeUrl,expiresAt:stored.expiresAt,channel:stored.channel==='SMS'?'SMS':'EMAIL'});
					return;
				}
			}
		}catch{
			window.sessionStorage.removeItem(ATTEMPT_STORAGE_KEY);
		}
		void startVerification();
	},[email,startVerification,sessionRestoreFailed]);

	useEffect(()=>{
		if(!attempt||!email)return;
		let cancelled=false;
		let timeout:ReturnType<typeof setTimeout>;
		const check=async()=>{
			if(Date.parse(attempt.expiresAt)<=Date.now()){
				window.sessionStorage.removeItem(ATTEMPT_STORAGE_KEY);
				setAttempt(null);
				setMessage('This verification attempt expired. Request a fresh attempt to continue.');
				return;
			}
			try{
				const response=await fetch('/api/register/status',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,attemptId:attempt.attemptId}),signal:AbortSignal.timeout(10_000)});
				if(response.ok){
					const result=await response.json();
					if(result.verified){
						window.sessionStorage.removeItem(ATTEMPT_STORAGE_KEY);
						router.replace(result.authenticated?'/dashboard':'/login?verified=1');
						return;
					}
					if(result.phoneConflict){
						window.sessionStorage.removeItem(ATTEMPT_STORAGE_KEY);
						setAttempt(null);
						setEmailCodeMode(false);
						setPhoneConflict(true);
						setMessage('That phone number is already associated with another account. Your temporary registration was removed; restart without that number or use a different one.');
						return;
					}
					if(result.expired){
						window.sessionStorage.removeItem(ATTEMPT_STORAGE_KEY);
						setAttempt(null);
						setMessage(result.sessionExpired
							?'This registration session expired. Start a new registration to continue.'
							:'This verification attempt expired. Request a fresh code or provider attempt to continue.');
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
					router.replace(result.authenticated?'/dashboard':'/login?verified=1');
				}
			})
			.catch(()=>setMessage('The provider redirect was received, but verification is not complete until Akedly confirms it.'));
	},[attempt,email,router]);

	const emailVerification=emailCodeMode||attempt?.channel==='EMAIL';

	return <><Nav/><main className="auth-scene"><section className="auth-card auth-register-card" aria-labelledby="verify-email-title">
		<div className="flex items-center gap-2 gold"><ShieldCheck size={20} aria-hidden="true"/><span className="text-sm font-semibold">{emailVerification?'Email verification':'Phone verification'}</span></div>
		<h1 id="verify-email-title" className="auth-heading mt-3">{emailVerification?'Verify your email address':'Verify your phone number'}</h1>
		<p className="mt-2 text-sm leading-6 muted">Your registration is temporary. No user or financial account is created until registration verification succeeds. {attempt?`Complete the secure Akedly ${attempt.channel==='SMS'?'phone':'email'} verification below.`:emailCodeMode?'Enter the six-digit email code to continue.':'Start phone verification to receive a code through the configured Akedly pipeline.'} Email remains your account contact for KYC communications and password recovery. Verification does not approve KYC or authorize financial activity.</p>
		{existingAccount&&<p className="mt-3 text-sm leading-6 muted">We found an existing unverified account. Verification will not change its password; sign in afterward with the password originally set for that account.</p>}
		<label className="auth-field-label mt-5">Email address<input className="auth-input" type="email" autoComplete="email" value={email} onChange={event=>{window.sessionStorage.removeItem(ATTEMPT_STORAGE_KEY);setAttempt(null);setEmailCodeMode(false);setSessionRestoreFailed(false);setExistingAccount(false);setCode('');setPhone('');setEmail(event.target.value.trim().toLowerCase());setMessage('')}} required maxLength={254}/></label>
		{phone&&<p className="mt-3 text-sm muted">Phone number for registration verification: <strong className="text-white">{phone}</strong></p>}
		{attempt&&<div className="mt-5 overflow-hidden rounded-lg border border-white/10 bg-black/30">
			<iframe className="block h-[700px] w-full max-w-full" src={attempt.iframeUrl} title={`Akedly secure ${attempt.channel==='SMS'?'phone':'email'} verification`} allow="clipboard-write; publickey-credentials-get *; publickey-credentials-create *"/>
			<p className="px-4 pb-4 text-sm leading-6 muted">
				If the security check stalls in this embedded view, <a className="auth-link" href={attempt.iframeUrl} target="_blank" rel="noopener noreferrer">open secure verification in a new tab</a>. Keep this page open; it checks verification status with Aurevia.
			</p>
		</div>}
		{email&&emailCodeMode&&<div className="mt-5">
			<p className="mb-3 text-sm muted">Verification code for <strong className="text-white">{email}</strong></p>
			<label className="auth-field-label">Six-digit email verification code<input className="auth-input" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={event=>setCode(event.target.value.replace(/\D/g,'').slice(0,6))}/></label>
			<button className="auth-submit mt-3 w-full" type="button" disabled={busy||code.length!==6||sessionRestoreFailed||phoneConflict} onClick={()=>void verifyEmailCode()}>{busy?'Verifying…':'Verify email address'}</button>
		</div>}
		{error&&<p className="auth-error mt-4" role="alert">{error}</p>}
		{message&&<p className="mt-4 text-sm muted" role="status">{message}</p>}
		{phoneConflict&&<p className="mt-4 text-center text-sm"><Link href="/register" className="auth-link">Restart registration</Link></p>}
		<button className="auth-submit mt-5 w-full" type="button" disabled={busy||!email||phoneConflict||sessionRestoreFailed} onClick={()=>void startVerification()}>{busy?'Starting verification…':attempt||emailCodeMode?'Resend verification code':'Start phone verification'}</button>
		{!emailCodeMode&&!attempt&&<p className="mt-4 text-center text-sm muted"><Link href="/register" className="auth-link">Start a new registration</Link></p>}
		<p className="auth-footer mt-5">Already verified? <Link href="/login" className="auth-link">Sign in</Link></p>
	</section></main></>;
}
