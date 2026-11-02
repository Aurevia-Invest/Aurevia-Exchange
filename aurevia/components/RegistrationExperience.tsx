'use client';

import {FormEvent,useCallback,useEffect,useRef,useState} from 'react';
import {useRouter} from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import {ArrowRight,ShieldCheck} from 'lucide-react';
import type {CountryCode} from 'libphonenumber-js';
import Nav from '@/components/Nav';
import CountrySelector from '@/components/CountrySelector';
import {findCountry} from '@/lib/countries';
import {normalizePhoneE164,parseDateOfBirth} from '@/lib/registration-validation';
import {useLocale} from '@/lib/i18n-context';

type AccountMode='DEMO'|'REAL';
type RegistrationDetails={firstName:string;lastName:string;dateOfBirth:string;residenceCountry:string;phoneCountry:string;phoneNumber:string;email:string;password:string;confirmPassword:string;accountMode:AccountMode};
type TurnstileStatus='loading'|'ready'|'verifying'|'verified'|'expired'|'failed';
type ExistingAccountIssue='account'|'unavailable'|'pending'|'phone';
type TurnstileOptions={
	sitekey:string;
	action:string;
	callback:(token:string)=>void;
	'before-interactive-callback':()=>void;
	'after-interactive-callback':()=>void;
	'expired-callback':()=>void;
	'timeout-callback':()=>void;
	'error-callback':()=>void;
};

declare global {
	interface Window {
		turnstile?:{
			render:(container:HTMLElement,options:TurnstileOptions)=>string;
			reset:(widgetId:string)=>void;
			remove:(widgetId:string)=>void;
		};
	}
}

let turnstileScriptPromise:Promise<void>|null=null;
const TURNSTILE_SCRIPT_URL='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

function loadTurnstileScript(){
	if(window.turnstile)return Promise.resolve();
	if(turnstileScriptPromise)return turnstileScriptPromise;
	turnstileScriptPromise=new Promise<void>((resolve,reject)=>{
		const existing=document.querySelector<HTMLScriptElement>('script[data-aurevia-turnstile]');
		const script=existing||document.createElement('script');
		let settled=false;
		const finish=(error?:Error)=>{
			if(settled)return;
			settled=true;
			clearTimeout(timeout);
			script.removeEventListener('load',onLoad);
			script.removeEventListener('error',onError);
			if(error){
				script.remove();
				turnstileScriptPromise=null;
				reject(error);
			}else resolve();
		};
		const onLoad=()=>window.turnstile?finish():finish(new Error('Turnstile did not initialize.'));
		const onError=()=>finish(new Error('Turnstile script failed to load.'));
		const timeout=setTimeout(()=>finish(new Error('Turnstile script loading timed out.')),15_000);
		script.addEventListener('load',onLoad,{once:true});
		script.addEventListener('error',onError,{once:true});
		if(!existing){
			script.src=TURNSTILE_SCRIPT_URL;
			script.async=true;
			script.defer=true;
			script.dataset.aureviaTurnstile='true';
			document.head.appendChild(script);
		}else if(window.turnstile){
			finish();
		}
	});
	return turnstileScriptPromise;
}

const initialDetails:RegistrationDetails={firstName:'',lastName:'',dateOfBirth:'',residenceCountry:'',phoneCountry:'US',phoneNumber:'',email:'',password:'',confirmPassword:'',accountMode:'DEMO'};

function dateInputMaximum(){return new Date().toISOString().slice(0,10)}

export default function RegistrationExperience(){
	const {translate}=useLocale();
	const [details,setDetails]=useState(initialDetails);
	const [termsAccepted,setTermsAccepted]=useState(false);
	const [error,setError]=useState('');
	const [existingAccountIssue,setExistingAccountIssue]=useState<ExistingAccountIssue|null>(null);
	const [countryError,setCountryError]=useState('');
	const [dateError,setDateError]=useState('');
	const [phoneError,setPhoneError]=useState('');
	const [passwordError,setPasswordError]=useState('');
	const [busy,setBusy]=useState(false);
	const [captchaToken,setCaptchaToken]=useState('');
	const [captchaLoaded,setCaptchaLoaded]=useState(false);
	const [captchaUnavailable,setCaptchaUnavailable]=useState(false);
	const [captchaConfigLoaded,setCaptchaConfigLoaded]=useState(false);
	const [captchaStatus,setCaptchaStatus]=useState<TurnstileStatus>('loading');
	const [captchaRetry,setCaptchaRetry]=useState(0);
	const [captchaSiteKey,setCaptchaSiteKey]=useState('');
	const captchaContainer=useRef<HTMLDivElement>(null);
	const captchaWidgetId=useRef<string|null>(null);
	const captchaVerificationTimeout=useRef<ReturnType<typeof setTimeout>|null>(null);
	const submissionInFlight=useRef(false);
	const router=useRouter();
	const residence=findCountry(details.residenceCountry);
	const registrationFormValid=Boolean(
		details.firstName.trim()
		&&details.lastName.trim()
		&&parseDateOfBirth(details.dateOfBirth)
		&&residence
		&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(details.email.trim())
		&&details.password.length>=10
		&&/[a-z]/.test(details.password)
		&&/[A-Z]/.test(details.password)
		&&/[0-9]/.test(details.password)
		&&details.password===details.confirmPassword
		&&Boolean(normalizePhoneE164(details.phoneNumber,details.phoneCountry as CountryCode))
		&&termsAccepted,
	);

	const clearCaptchaVerificationTimeout=useCallback(()=>{
		if(captchaVerificationTimeout.current){
			clearTimeout(captchaVerificationTimeout.current);
			captchaVerificationTimeout.current=null;
		}
	},[]);

	const resetTurnstileAfterFailure=useCallback((status:'expired'|'failed',message:string)=>{
		clearCaptchaVerificationTimeout();
		setCaptchaToken('');
		setCaptchaStatus(status);
		setError(message);
		const widgetId=captchaWidgetId.current;
		if(widgetId)window.setTimeout(()=>window.turnstile?.reset(widgetId),0);
	},[clearCaptchaVerificationTimeout]);

	useEffect(()=>{
		let cancelled=false;
		void fetch('/api/register/security',{cache:'no-store',headers:{accept:'application/json'}})
			.then(async response=>{
				if(!response.ok)throw new Error('SECURITY_CONFIGURATION_UNAVAILABLE');
				return response.json() as Promise<{available?:unknown;siteKey?:unknown}>;
			})
			.then(result=>{
				if(cancelled)return;
				if(result.available!==true||typeof result.siteKey!=='string'||!result.siteKey.trim()){
					setCaptchaUnavailable(true);
					return;
				}
				setCaptchaSiteKey(result.siteKey);
			})
			.catch(()=>{
				if(!cancelled)setCaptchaUnavailable(true);
			})
			.finally(()=>{
				if(!cancelled)setCaptchaConfigLoaded(true);
			});
		return ()=>{cancelled=true};
	},[captchaRetry]);

	useEffect(()=>{
		if(!captchaSiteKey||captchaUnavailable)return;
		let active=true;
		setCaptchaLoaded(false);
		setCaptchaStatus('loading');
		void loadTurnstileScript().then(()=>{
			if(active)setCaptchaLoaded(true);
		}).catch(()=>{
			if(active){
				setCaptchaUnavailable(true);
				setCaptchaStatus('failed');
			}
		});
		return()=>{active=false};
	},[captchaSiteKey,captchaRetry,captchaUnavailable]);

	useEffect(()=>{
		if(!captchaLoaded||!captchaSiteKey||!captchaContainer.current||captchaUnavailable)return;
		if(!window.turnstile){
			setCaptchaUnavailable(true);
			return;
		}
		let active=true;
		queueMicrotask(()=>{
			if(!active||!captchaContainer.current||!window.turnstile||captchaWidgetId.current)return;
			try{
				const widgetId=window.turnstile.render(captchaContainer.current,{
					sitekey:captchaSiteKey,
					action:'register',
					callback:token=>{
						clearCaptchaVerificationTimeout();
						setCaptchaToken(token);
						setCaptchaStatus('verified');
						setError('');
					},
					'before-interactive-callback':()=>{
						clearCaptchaVerificationTimeout();
						captchaVerificationTimeout.current=setTimeout(
							()=>resetTurnstileAfterFailure('failed','Security verification took too long. Retry the security check.'),
							90_000,
						);
						setCaptchaToken('');
						setCaptchaStatus('verifying');
					},
					'after-interactive-callback':()=>{
						clearCaptchaVerificationTimeout();
						setCaptchaStatus('ready');
					},
					'expired-callback':()=>resetTurnstileAfterFailure('expired','The security check expired. Please retry it.'),
					'timeout-callback':()=>resetTurnstileAfterFailure('failed','Security verification took too long. Retry the security check.'),
					'error-callback':()=>resetTurnstileAfterFailure('failed','Security verification could not be completed. Retry the security check.'),
				});
				captchaWidgetId.current=widgetId;
				setCaptchaStatus('ready');
			}catch{
				setCaptchaUnavailable(true);
				setCaptchaStatus('failed');
			}
		});
		return()=>{
			active=false;
			clearCaptchaVerificationTimeout();
			const widgetId=captchaWidgetId.current;
			if(widgetId){
				window.turnstile?.remove(widgetId);
				captchaWidgetId.current=null;
			}
		};
	},[captchaLoaded,captchaSiteKey,captchaUnavailable,clearCaptchaVerificationTimeout,resetTurnstileAfterFailure]);

	function retryCaptcha(){
		clearCaptchaVerificationTimeout();
		setCaptchaToken('');
		setError('');
		if(captchaUnavailable){
			setCaptchaUnavailable(false);
			setCaptchaConfigLoaded(false);
			setCaptchaRetry(value=>value+1);
			return;
		}
		const widgetId=captchaWidgetId.current;
		if(widgetId&&window.turnstile){
			window.turnstile.reset(widgetId);
			setCaptchaStatus('ready');
		}
	}

	function update<K extends keyof RegistrationDetails>(key:K,value:RegistrationDetails[K]){
		setDetails(current=>({...current,[key]:value}));
	}

	async function submit(event:FormEvent<HTMLFormElement>){
		event.preventDefault();
		if(busy||submissionInFlight.current)return;
		setError('');setExistingAccountIssue(null);setCountryError('');setDateError('');setPhoneError('');setPasswordError('');
		const date=parseDateOfBirth(details.dateOfBirth);
		const phone=normalizePhoneE164(details.phoneNumber,details.phoneCountry as CountryCode)||'';
		let invalid=false;
		if(!residence){setCountryError(translate('selectCountry'));invalid=true;}
		if(!date){setDateError(translate('validDate'));invalid=true;}
		if(!phone){setPhoneError(translate('validPhone'));invalid=true;}
		if(details.password!==details.confirmPassword){setPasswordError(translate('passwordMatch'));invalid=true;}
		if(invalid||!residence)return;
		if(!captchaToken){setError('Complete the registration security check before creating your account.');return;}
		const submittedCaptchaToken=captchaToken;
		submissionInFlight.current=true;
		setBusy(true);
		try{
			const response=await fetch('/api/register',{method:'POST',headers:{'content-type':'application/json','accept':'application/json'},body:JSON.stringify({name:`${details.firstName.trim()} ${details.lastName.trim()}`.trim(),email:details.email,password:details.password,country:residence.name,phone,dateOfBirth:details.dateOfBirth,accountMode:details.accountMode,termsAccepted,captchaToken:submittedCaptchaToken})});
			const result=await response.json().catch(()=>({}));
			if(!response.ok){
				if(result.code==='ACCOUNT_ALREADY_VERIFIED'||result.code==='ACCOUNT_ALREADY_EXISTS')setExistingAccountIssue('account');
				else if(result.code==='ACCOUNT_UNAVAILABLE')setExistingAccountIssue('unavailable');
				else if(result.code==='REGISTRATION_IN_PROGRESS')setExistingAccountIssue('pending');
				else if(result.code==='PHONE_ALREADY_IN_USE')setExistingAccountIssue('phone');
				const retryAfter=Number(response.headers.get('Retry-After')||result.retryAfterSeconds);
				const retryMessage=response.status===429&&Number.isFinite(retryAfter)&&retryAfter>0
					?` You can retry in ${retryAfter>=60?`${Math.ceil(retryAfter/60)} minute(s)`:`${retryAfter} second(s)`}.`
					:'';
				setError(`${result.requestId?`${result.error||translate('registrationFailed')} (Reference: ${result.requestId})`:result.error||translate('registrationFailed')}${retryMessage}`);return;
			}
			const verificationParams=new URLSearchParams({email:result.email||details.email});
			if(result.existingVerification)verificationParams.set('existing','1');
			router.replace(`/verify-email?${verificationParams.toString()}`);
			router.refresh();
		}catch{setError(translate('unableRegistration'));}
		finally{
			submissionInFlight.current=false;
			setBusy(false);
			setCaptchaToken('');
			const widgetId=captchaWidgetId.current;
			if(widgetId)window.turnstile?.reset(widgetId);
			if(captchaStatus==='verified')setCaptchaStatus('ready');
		}
	}

	return <><Nav/><main className="auth-scene"><section className="auth-card auth-register-card" aria-labelledby="registration-title">
		<div className="auth-brand"><Image src="/aurevia-logo.png" alt="" width={48} height={48}/><span className="brand-copy"><strong>Aurevia</strong><small>EXCHANGE</small></span></div>
			<h1 id="registration-title" className="auth-heading">{translate('createAccountTitle')}</h1>
			<nav className="register-section-jump" aria-label="Registration sections"><a href="#register-profile">{translate('personalInformation')}</a><a href="#register-contact">{translate('contactInformation')}</a><a href="#register-security">{translate('security')}</a><a href="#register-account">{translate('accountType')}</a></nav>
			<form onSubmit={submit} className="register-form space-y-4">
				<fieldset id="register-profile" className="register-form-section"><legend className="sr-only">{translate('personalInformation')}</legend><h2>{translate('personalInformation')}</h2><div className="grid gap-3 sm:grid-cols-2">
					<label className="auth-field-label">{translate('firstName')}<input className="auth-input" name="given-name" autoComplete="given-name" value={details.firstName} onChange={event=>update('firstName',event.target.value)} required maxLength={60}/></label>
					<label className="auth-field-label">{translate('lastName')}<input className="auth-input" name="family-name" autoComplete="family-name" value={details.lastName} onChange={event=>update('lastName',event.target.value)} required maxLength={59}/></label>
					<label className="auth-field-label">{translate('dateOfBirth')}<input className="auth-input auth-date-input" type="date" name="bday" autoComplete="bday" value={details.dateOfBirth} max={dateInputMaximum()} aria-describedby={dateError?'dob-error':undefined} onChange={event=>{update('dateOfBirth',event.target.value);setDateError('')}} required/></label>
					<div><span className="auth-field-label">{translate('countryResidence')}</span><CountrySelector label={translate('countryResidence')} value={details.residenceCountry} onChange={code=>{update('residenceCountry',code);setCountryError('')}} required invalid={Boolean(countryError)} errorId={countryError?'country-error':undefined}/>{countryError&&<p id="country-error" className="mt-1 text-xs text-loss" role="alert">{countryError}</p>}</div>
				</div>
					{dateError&&<p id="dob-error" className="mt-2 text-xs text-loss" role="alert">{dateError}</p>}
				</fieldset>
				<fieldset id="register-contact" className="register-form-section"><legend className="sr-only">{translate('contactInformation')}</legend><h2>{translate('contactInformation')}</h2><div className="space-y-3">
					<label className="auth-field-label">{translate('emailAddress')}<input className="auth-input" name="email" type="email" autoComplete="email" value={details.email} onChange={event=>update('email',event.target.value)} required maxLength={254}/></label>
					<div><label className="auth-field-label" htmlFor="registration-phone">{translate('phoneNumber')} <span className="muted font-normal">{translate('phoneOptional')}</span></label><div className="register-phone-row mt-1"><CountrySelector label="Phone country and dialing code" value={details.phoneCountry} onChange={code=>update('phoneCountry',code)}/><input id="registration-phone" className="auth-input mt-0 min-w-0" name="tel-national" type="tel" autoComplete="tel-national" inputMode="tel" value={details.phoneNumber} onChange={event=>{update('phoneNumber',event.target.value);setPhoneError('')}} placeholder={translate('phoneNumber')} aria-describedby={phoneError?'phone-error':undefined} required/></div>{phoneError&&<p id="phone-error" className="mt-1 text-xs text-loss" role="alert">{phoneError}</p>}</div>
				</div></fieldset>
				<fieldset id="register-security" className="register-form-section"><legend className="sr-only">{translate('security')}</legend><h2>{translate('security')}</h2><div className="grid gap-3 sm:grid-cols-2">
					<label className="auth-field-label">{translate('password')}<input className="auth-input" name="new-password" type="password" autoComplete="new-password" value={details.password} onChange={event=>{update('password',event.target.value);setPasswordError('')}} required minLength={10} maxLength={128} pattern="(?=.*[a-z])(?=.*[A-Z])(?=.*[0-9]).{10,128}" aria-describedby="password-requirements"/></label>
					<label className="auth-field-label">{translate('confirmPassword')}<input className="auth-input" name="confirm-password" type="password" autoComplete="new-password" value={details.confirmPassword} onChange={event=>{update('confirmPassword',event.target.value);setPasswordError('')}} required maxLength={128} aria-describedby={passwordError?'password-error':undefined}/></label>
				</div><p id="password-requirements" className="mt-2 text-xs muted">{translate('passwordRequirements')}</p>{passwordError&&<p id="password-error" className="mt-1 text-xs text-loss" role="alert">{passwordError}</p>}</fieldset>
				<fieldset id="register-account" className="register-form-section"><legend className="sr-only">{translate('accountType')}</legend><h2>{translate('accountType')}</h2>
					<div className="grid gap-2 sm:grid-cols-2"><label className={`block cursor-pointer rounded-md border p-3 ${details.accountMode==='DEMO'?'border-gold/40 bg-white/5':'border-white/10'}`}><span className="flex min-h-11 items-center gap-3"><input type="radio" name="accountMode" value="DEMO" checked={details.accountMode==='DEMO'} onChange={()=>update('accountMode','DEMO')}/><b>{translate('demoAccount')}</b></span><span className="block pl-7 text-xs leading-5 muted">{translate('demoAccountCopy')}</span></label><label className={`block cursor-pointer rounded-md border p-3 ${details.accountMode==='REAL'?'border-gold/40 bg-white/5':'border-white/10'}`}><span className="flex min-h-11 items-center gap-3"><input type="radio" name="accountMode" value="REAL" checked={details.accountMode==='REAL'} onChange={()=>update('accountMode','REAL')}/><b>{translate('realAccount')}</b></span><span className="block pl-7 text-xs leading-5 muted">{translate('realAccountCopy')}</span></label></div>
					<p className="mt-3 text-xs leading-5 muted">Registration is free. Verify your phone number before signing in. Your email remains the account contact for KYC updates and password recovery. New accounts start on <span className="tier-badge">Tier 1</span>; identity review remains separate for eligible account services.</p>
					<label className="mt-4 flex min-h-11 items-start gap-2 text-xs leading-5 muted"><input className="mt-1" type="checkbox" checked={termsAccepted} onChange={event=>setTermsAccepted(event.target.checked)} required/><span>{translate('termsConsent')} <Link className="auth-link" href="/terms">{translate('terms')}</Link>, <Link className="auth-link" href="/privacy">{translate('privacyPolicy')}</Link>, {translate('riskDisclosure')}</span></label>
				</fieldset>
				<div ref={captchaContainer} aria-label="Registration security check"/>
				{!captchaConfigLoaded||captchaSiteKey&&!captchaLoaded&&!captchaUnavailable?<p className="text-sm muted" role="status">Loading the secure registration check…</p>:null}
				{captchaUnavailable&&<div className="flex items-center gap-3"><p className="text-sm text-loss" role="alert">We couldn’t load the security check. Your form details are preserved; try loading it again.</p><button className="auth-link text-sm" type="button" onClick={retryCaptcha}>Retry</button></div>}
				{captchaLoaded&&!captchaUnavailable&&<p className="text-sm muted" role="status">{captchaStatus==='verifying'?'Verifying the security check…':captchaStatus==='verified'?'Security verification successful.':captchaStatus==='expired'?'Security verification expired. Retry to continue.':captchaStatus==='failed'?'Security verification failed. Retry to continue.':'Complete the security check to continue.'}</p>}
				{captchaLoaded&&!captchaUnavailable&&(captchaStatus==='expired'||captchaStatus==='failed')&&<button className="auth-link text-sm" type="button" onClick={retryCaptcha}>Retry security check</button>}
				{error&&<p className="auth-error" role="alert">{error}</p>}
				{existingAccountIssue==='account'&&<p className="text-sm leading-6 muted">Already have an account? <Link href="/login" className="auth-link">Sign in</Link> or <Link href="/forgot-password" className="auth-link">reset your password</Link>.</p>}
				{existingAccountIssue==='unavailable'&&<p className="text-sm leading-6 muted">This account was not changed or reactivated. <Link href="/support" className="auth-link">Contact support</Link> for account-specific help.</p>}
				{existingAccountIssue==='pending'&&<p className="text-sm leading-6 muted">Your existing registration details were not changed. Retry with the original registration password or use the verification link sent to your email.</p>}
				{existingAccountIssue==='phone'&&<p className="text-sm leading-6 muted">Use a phone number not associated with another account.</p>}
				<button type="submit" disabled={busy||!captchaToken||!registrationFormValid} aria-busy={busy} className="auth-submit flex w-full items-center justify-center gap-2">{busy?translate('creatingAccount'):translate('createAccountButton')}<ArrowRight size={16} aria-hidden="true"/></button>
			</form>
				<p className="auth-footer">{translate('alreadyRegistered')} <Link href="/login" className="auth-link">{translate('signIn')}</Link></p>
		<div className="mt-5 flex items-center gap-2 border-t border-white/10 pt-4 text-xs muted"><ShieldCheck size={15} className="gold" aria-hidden="true"/>{translate('accountPrivate')}</div>
	</section></main></>;
}