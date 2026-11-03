'use client';

import {useCallback,useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import Image from 'next/image';
import {useRouter} from 'next/navigation';
import {ShieldCheck} from 'lucide-react';
import {parsePhoneNumberFromString} from 'libphonenumber-js';
import Nav from '@/components/Nav';

type Attempt={attemptId:string;iframeUrl:string;expiresAt:string;channel?:'EMAIL'|'SMS'};
const ATTEMPT_STORAGE_KEY='aurevia-akedly-registration-attempt';
const REGISTRATION_REQUEST_ID_KEY='aurevia-registration-request-id';
const REGISTRATION_EMAIL_KEY='aurevia-verification-email';

function safeWidgetUrl(value:string){
	try{return new URL(value).origin==='https://auth.akedly.io'}catch{return false}
}

function maskPhoneNumber(value:string){
	const parsed=parsePhoneNumberFromString(value);
	if(!parsed)return '';
	const digits=parsed.nationalNumber;
	const visibleSuffix=digits.slice(-4);
	const maskedPrefix='•'.repeat(Math.max(0,digits.length-7));
	const maskedMiddle='•'.repeat(Math.min(3,Math.max(0,digits.length-4-maskedPrefix.length)));
	return `+${parsed.countryCallingCode} ${[maskedPrefix,maskedMiddle,visibleSuffix].filter(Boolean).join(' ')}`;
}

export default function VerifyEmailPage(){
	const router=useRouter();
	const [email,setEmail]=useState('');
	const [contactEmail,setContactEmail]=useState('');
	const [phone,setPhone]=useState('');
	const [registrationRequestId,setRegistrationRequestId]=useState('');
	const [existingAccount,setExistingAccount]=useState(false);
	const [attempt,setAttempt]=useState<Attempt|null>(null);
	const [emailCodeMode,setEmailCodeMode]=useState(false);
	const [cooldownSeconds,setCooldownSeconds]=useState(0);
	const [code,setCode]=useState('');
	const [message,setMessage]=useState('');
	const [error,setError]=useState('');
	const [phoneConflict,setPhoneConflict]=useState(false);
	const [sessionRestoreFailed,setSessionRestoreFailed]=useState(false);
	const [busy,setBusy]=useState(false);
	const busyRef=useRef(false);

	useEffect(()=>{
		const params=new URLSearchParams(window.location.search);
		let nextEmail=(params.get('email')||'').trim().toLowerCase();
		if(!nextEmail){
			try{nextEmail=(window.sessionStorage.getItem(REGISTRATION_EMAIL_KEY)||'').trim().toLowerCase()}catch{}
		}
		setExistingAccount(params.get('existing')==='1');
		try{
			const correlation=window.sessionStorage.getItem(REGISTRATION_REQUEST_ID_KEY);
			if(correlation){
				const stored=JSON.parse(correlation) as {requestId?:unknown};
				if(typeof stored.requestId==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(stored.requestId)){
					setRegistrationRequestId(stored.requestId);
				}
			}
		}catch{
			window.sessionStorage.removeItem(REGISTRATION_REQUEST_ID_KEY);
		}
		const registrationToken=new URLSearchParams(window.location.hash.slice(1)).get('registrationToken');
		if(!registrationToken){
			void fetch('/api/register/session',{cache:'no-store'})
				.then(async response=>{
					if(!response.ok)throw new Error('Registration session not found.');
					return response.json();
				})
				.then(result=>{
					if(typeof result?.email==='string'){
						setEmail(result.email);
						setContactEmail(result.email);
					}
					if(typeof result?.phone==='string')setPhone(result.phone);
				})
				.catch(()=>{
					setEmail(nextEmail);
					setContactEmail(nextEmail);
					if(!nextEmail)setEmailCodeMode(true);
				});
			return;
		}
		window.history.replaceState(null,'',`${window.location.pathname}${window.location.search}`);
		void fetch('/api/register/session',{
			method:'POST',
			headers:{'content-type':'application/json'},
			body:JSON.stringify({registrationToken}),
		}).then(async response=>{
			if(!response.ok)throw new Error('This registration session is invalid or expired.');
			const details=await response.json();
			if(typeof details.email==='string'){
				setEmail(details.email);
				setContactEmail(details.email);
			}
			if(typeof details.phone==='string')setPhone(details.phone);
		}).catch(()=>{
			setSessionRestoreFailed(true);
			setError('This registration session is invalid or expired. Start a new registration to continue.');
			setEmail(nextEmail);
			setContactEmail(nextEmail);
		});
	},[]);

	const startVerification=useCallback(async()=>{
		if(!email||sessionRestoreFailed||busyRef.current)return;
		busyRef.current=true;
		setBusy(true);setError('');setMessage('');
		try{
			const response=await fetch('/api/register/resend',{
				method:'POST',
				headers:{
					'content-type':'application/json',
					...(registrationRequestId?{'x-aurevia-registration-request-id':registrationRequestId}:{}),
				},
				body:JSON.stringify({email}),
				signal:AbortSignal.timeout(15_000),
			});
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
				window.sessionStorage.removeItem(REGISTRATION_REQUEST_ID_KEY);
				window.sessionStorage.removeItem(REGISTRATION_EMAIL_KEY);
				router.replace(result.authenticated?'/dashboard':'/login?verified=1');
				return;
			}
			if(!response.ok){
				const retryAfter=Number(response.headers.get('Retry-After')||result.retryAfterSeconds);
				if(Number.isFinite(retryAfter)&&retryAfter>0)setCooldownSeconds(Math.ceil(retryAfter));
				const referenceId=typeof result.referenceId==='string'?result.referenceId:typeof result.requestId==='string'?result.requestId:'';
				const referenceMessage=referenceId?` Reference: ${referenceId}.`:'';
				if(result.code==='EMAIL_DELIVERY_STATUS_UNKNOWN'){
					setEmailCodeMode(false);
					const retryMessage=Number.isFinite(retryAfter)&&retryAfter>0
						?` You can request another code in ${retryAfter>=60?`${Math.ceil(retryAfter/60)} minute(s)`:`${retryAfter} second(s)`}.`
						:'';
					setMessage(`${result.error||'Delivery status is uncertain. If the code arrives, enter it here; retrying will not send another code during the cooldown.'}${referenceMessage}${retryMessage}`);
					return;
				}
				const retryMessage=Number.isFinite(retryAfter)&&retryAfter>0
					?` You can retry in ${retryAfter>=60?`${Math.ceil(retryAfter/60)} minute(s)`:`${retryAfter} second(s)`}.`
					:'';
				throw new Error(`${result.error||'Unable to start registration verification.'}${referenceMessage}${retryMessage}`);
			}
			if(result.method==='email-code'){
				window.sessionStorage.setItem(ATTEMPT_STORAGE_KEY,JSON.stringify({email,method:'email-code'}));
				setAttempt(null);
				setEmailCodeMode(true);
				if(Number.isFinite(Number(result.resendAfterSeconds)))setCooldownSeconds(Math.max(0,Number(result.resendAfterSeconds)));
				setMessage(result.message||'Enter the six-digit code sent to your email.');
				return;
			}
			if(typeof result.attemptId==='string'&&typeof result.iframeUrl==='string'&&safeWidgetUrl(result.iframeUrl)&&typeof result.expiresAt==='string'){
				const nextAttempt:Attempt={attemptId:result.attemptId,iframeUrl:result.iframeUrl,expiresAt:result.expiresAt,channel:result.channel==='SMS'?'SMS':'EMAIL'};
				const nextCooldown=Math.max(0,Number(result.resendAfterSeconds)||0);
				setCooldownSeconds(nextCooldown);
				window.sessionStorage.setItem(ATTEMPT_STORAGE_KEY,JSON.stringify({email,...nextAttempt,resendAvailableAt:Date.now()+nextCooldown*1000}));
				setAttempt(nextAttempt);
				setEmailCodeMode(false);
				setMessage(nextAttempt.channel==='SMS'
					?'Complete the security check, then enter the code sent to your registered phone number.'
					:'Complete the secure email verification below.');
				return;
			}
			setMessage(result.message||'If the registration is eligible, verification can continue after the resend cooldown.');
		}catch(exception){
			setError(exception instanceof Error?exception.message:'Unable to start registration verification.');
		}finally{
			busyRef.current=false;
			setBusy(false);
		}
	},[email,registrationRequestId,router,sessionRestoreFailed]);

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
			window.sessionStorage.removeItem(REGISTRATION_REQUEST_ID_KEY);
			window.sessionStorage.removeItem(REGISTRATION_EMAIL_KEY);
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
				const stored=JSON.parse(saved) as {email?:unknown;method?:unknown;attemptId?:unknown;iframeUrl?:unknown;expiresAt?:unknown;channel?:unknown;resendAvailableAt?:unknown};
				if(stored.email===email&&stored.method==='email-code'){
					setEmailCodeMode(true);
					setMessage('Enter the six-digit code sent to your email.');
					return;
				}
				if(stored.email===email&&typeof stored.attemptId==='string'&&typeof stored.iframeUrl==='string'&&safeWidgetUrl(stored.iframeUrl)&&typeof stored.expiresAt==='string'&&Date.parse(stored.expiresAt)>Date.now()){
					setAttempt({attemptId:stored.attemptId,iframeUrl:stored.iframeUrl,expiresAt:stored.expiresAt,channel:stored.channel==='SMS'?'SMS':'EMAIL'});
					const resendAvailableAt=typeof stored.resendAvailableAt==='number'?stored.resendAvailableAt:0;
					setCooldownSeconds(Math.max(0,Math.ceil((resendAvailableAt-Date.now())/1000)));
					return;
				}
			}
		}catch{
			window.sessionStorage.removeItem(ATTEMPT_STORAGE_KEY);
		}
		void startVerification();
	},[email,startVerification,sessionRestoreFailed]);

	useEffect(()=>{
		if(cooldownSeconds<=0)return;
		const timer=window.setInterval(()=>setCooldownSeconds(seconds=>Math.max(0,seconds-1)),1000);
		return()=>window.clearInterval(timer);
	},[cooldownSeconds]);

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
						window.sessionStorage.removeItem(REGISTRATION_REQUEST_ID_KEY);
						window.sessionStorage.removeItem(REGISTRATION_EMAIL_KEY);
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
					window.sessionStorage.removeItem(REGISTRATION_REQUEST_ID_KEY);
					window.sessionStorage.removeItem(REGISTRATION_EMAIL_KEY);
					router.replace(result.authenticated?'/dashboard':'/login?verified=1');
				}
			})
			.catch(()=>setMessage('The provider redirect was received, but verification is not complete until Akedly confirms it.'));
	},[attempt,email,router]);

	const emailVerification=emailCodeMode||attempt?.channel==='EMAIL';
	const maskedPhone=phone?maskPhoneNumber(phone):'';

	return <><Nav/><main className="auth-scene phone-verification-scene"><section className="auth-card phone-verification-card" aria-labelledby="verify-email-title">
		<div className="phone-verification-brand"><Image src="/aurevia-logo.png" alt="" width={30} height={30}/><span>AUREVIA EXCHANGE</span></div>
		<div className="flex items-center gap-2 gold"><ShieldCheck size={17} aria-hidden="true"/><span className="text-xs font-semibold">{emailVerification?'Email verification':'Phone verification'}</span></div>
		<h1 id="verify-email-title" className="auth-heading mt-2">{emailVerification?'Verify your email':'Verify your phone number'}</h1>
		<p className="mt-2 text-sm leading-5 muted">{emailVerification
			?'Enter the verification code sent to the email address on your account.'
			:attempt
				?'Complete the security check, then enter the code sent to your registered phone number.'
				:'A code will be sent after you complete the secure phone verification.'}</p>
		{maskedPhone&&!emailVerification&&<p className="phone-verification-number" aria-label="Masked registered phone number">{maskedPhone}</p>}
		{existingAccount&&<p className="mt-2 text-xs leading-5 muted">This is an existing unverified account. Its password will not be changed by verification.</p>}
		{emailCodeMode&&!email&&<div className="phone-verification-code">
			<label className="auth-field-label">Email address<input className="auth-input" type="email" autoComplete="email" value={contactEmail} onChange={event=>setContactEmail(event.target.value)}/></label>
			<button className="auth-submit w-full" type="button" disabled={busy} onClick={()=>{
				const value=contactEmail.trim().toLowerCase();
				if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)){setError('Enter a valid email address to continue.');return}
				setError('');
				setEmail(value);
			}}>Continue</button>
		</div>}
		{attempt&&<div className="phone-verification-widget">
			<iframe src={attempt.iframeUrl} title={`Akedly secure ${attempt.channel==='SMS'?'phone':'email'} verification`} allow="clipboard-write; publickey-credentials-get *; publickey-credentials-create *"/>
			<p className="phone-verification-fallback">Security check not loading? <a className="auth-link" href={attempt.iframeUrl} target="_blank" rel="noopener noreferrer">Open secure verification in a new tab</a>.</p>
		</div>}
		{email&&emailCodeMode&&<div className="phone-verification-code">
			<label className="auth-field-label">Six-digit verification code<input className="auth-input" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={event=>setCode(event.target.value.replace(/\D/g,'').slice(0,6))}/></label>
			<button className="auth-submit w-full" type="button" disabled={busy||code.length!==6||sessionRestoreFailed||phoneConflict} onClick={()=>void verifyEmailCode()}>{busy?'Verifying…':'Verify email code'}</button>
		</div>}
		{error&&<p className="auth-error mt-3" role="alert">{error}</p>}
		{message&&<p className="mt-3 text-xs leading-5 muted" role="status">{message}</p>}
		{phoneConflict&&<p className="mt-3 text-center text-sm"><Link href="/register" className="auth-link">Restart registration</Link></p>}
		<button className="auth-submit phone-verification-resend w-full" type="button" disabled={busy||!email||phoneConflict||sessionRestoreFailed||cooldownSeconds>0} onClick={()=>void startVerification()}>{busy?'Starting verification…':cooldownSeconds>0?`Resend code in ${cooldownSeconds}s`:attempt||emailCodeMode?'Resend code':'Start phone verification'}</button>
		<div className="phone-verification-footer">
			<Link href="/support" className="auth-link">Need help?</Link>
			<Link href="/login" className="auth-link">Already have an account? Sign in</Link>
		</div>
	</section></main></>;
}
