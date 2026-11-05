'use client';

import {FormEvent,useRef,useState} from 'react';
import {useRouter} from 'next/navigation';
import {signIn,useSession} from 'next-auth/react';
import Link from 'next/link';
import Image from 'next/image';
import {ArrowRight,Check,Eye,EyeOff,FlaskConical,ShieldCheck,TrendingUp} from 'lucide-react';
import Nav from '@/components/Nav';
import CountrySelector from '@/components/CountrySelector';
import {findCountry} from '@/lib/countries';
import {normalizePhoneE164,parseDateOfBirth} from '@/lib/registration-validation';
import {useLocale} from '@/lib/i18n-context';

type AccountMode='DEMO'|'REAL';
type GenderSelection='FEMALE'|'MALE'|'NON_BINARY'|'PREFER_NOT_TO_SAY';
type RegistrationDetails={firstName:string;lastName:string;dateOfBirth:string;gender:GenderSelection|'';residenceCountry:string;phoneCountry:string;phoneNumber:string;email:string;password:string;confirmPassword:string;accountMode:AccountMode};
type ExistingAccountIssue='account'|'unavailable'|'pending'|'phone';

function createRegistrationRequestId(){
	if(typeof window==='undefined'||!window.crypto?.getRandomValues)return null;
	if(window.crypto.randomUUID)return window.crypto.randomUUID();
	const bytes=window.crypto.getRandomValues(new Uint8Array(16));
	bytes[6]=(bytes[6]&0x0f)|0x40;
	bytes[8]=(bytes[8]&0x3f)|0x80;
	const hex=[...bytes].map(value=>value.toString(16).padStart(2,'0')).join('');
	return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

function isRecord(value:unknown):value is Record<string,unknown>{
	return typeof value==='object'&&value!==null&&!Array.isArray(value);
}

const initialDetails:RegistrationDetails={firstName:'',lastName:'',dateOfBirth:'',gender:'',residenceCountry:'',phoneCountry:'',phoneNumber:'',email:'',password:'',confirmPassword:'',accountMode:'DEMO'};

function dateInputMaximum(){return new Date().toISOString().slice(0,10)}

function parseGenderSelection(value:string):RegistrationDetails['gender']{
	switch(value){
		case 'FEMALE':
		case 'MALE':
		case 'NON_BINARY':
		case 'PREFER_NOT_TO_SAY':
			return value;
		default:
			return '';
	}
}

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
	const [passwordVisible,setPasswordVisible]=useState(false);
	const [confirmationVisible,setConfirmationVisible]=useState(false);
	const [busy,setBusy]=useState(false);
	const submissionInFlight=useRef(false);
	const router=useRouter();
	const {update:updateSession}=useSession();
	const residence=findCountry(details.residenceCountry);
	const registrationFormValid=Boolean(
		details.firstName.trim()
		&&details.lastName.trim()
		&&parseDateOfBirth(details.dateOfBirth)
		&&details.gender
		&&residence
		&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(details.email.trim())
		&&details.password.length>=10
		&&/[a-z]/.test(details.password)
		&&/[A-Z]/.test(details.password)
		&&/[0-9]/.test(details.password)
		&&details.password===details.confirmPassword
		&&termsAccepted,
	);

	function update<K extends keyof RegistrationDetails>(key:K,value:RegistrationDetails[K]){
		setDetails(current=>({...current,[key]:value}));
	}

	async function submit(event:FormEvent<HTMLFormElement>){
		event.preventDefault();
		if(busy||submissionInFlight.current)return;
		setError('');setExistingAccountIssue(null);setCountryError('');setDateError('');setPhoneError('');setPasswordError('');
		const date=parseDateOfBirth(details.dateOfBirth);
		const selectedPhoneCountry=findCountry(details.phoneCountry);
		const phone=selectedPhoneCountry?normalizePhoneE164(details.phoneNumber,selectedPhoneCountry.code)||'':'';
		let invalid=false;
		if(!residence){setCountryError(translate('selectCountry'));invalid=true;}
		if(!date){setDateError(translate('validDate'));invalid=true;}
		if(details.phoneNumber.trim()&&(!selectedPhoneCountry||!phone)){setPhoneError(translate('validPhone'));invalid=true;}
		if(details.password!==details.confirmPassword){setPasswordError(translate('passwordMatch'));invalid=true;}
		if(invalid||!residence)return;
		const requestId=createRegistrationRequestId();
		submissionInFlight.current=true;
		setBusy(true);
		const controller=new AbortController();
		let timedOut=false;
		const requestTimeout=window.setTimeout(()=>{
			timedOut=true;
			controller.abort();
		},30_000);
		try{
			let response:Response;
			try{
				response=await fetch('/api/register',{
					method:'POST',
					headers:{
						'content-type':'application/json',
						'accept':'application/json',
						...(requestId?{'x-aurevia-request-id':requestId}:{}),
					},
					body:JSON.stringify({name:`${details.firstName} ${details.lastName}`,email:details.email,password:details.password,country:residence.name,gender:details.gender,phone,dateOfBirth:details.dateOfBirth,accountMode:details.accountMode,termsAccepted,website:''}),
					signal:controller.signal,
				});
			}catch(exception){
				const referenceId=requestId||createRegistrationRequestId();
				const reason=timedOut?'timeout':exception instanceof Error?exception.name:'UNKNOWN_ERROR';
				console.warn('[registration] Browser request did not receive an API response.',{
					...(referenceId?{requestId:referenceId,referenceId}:{}),
					endpoint:'/api/register',
					reason,
					failureTimestamp:new Date().toISOString(),
				});
				setError(timedOut
					?`The registration request timed out. Your form details are still here; check your connection and retry.${referenceId?` Reference: ${referenceId}`:''}`
					:`Unable to connect to the registration service. Your form details are still here; check your connection and retry.${referenceId?` Reference: ${referenceId}`:''}`);
				return;
			}
			let result:Record<string,unknown>;
			try{
				const body:unknown=await response.json();
				if(!isRecord(body))throw new Error('INVALID_RESPONSE_BODY');
				result=body;
			}catch{
				console.warn('[registration] API returned a non-JSON response.',{
					...(requestId?{requestId,referenceId:requestId}:{}),
					endpoint:'/api/register',
					httpStatus:response.status,
					contentType:response.headers.get('content-type')||'unknown',
					failureTimestamp:new Date().toISOString(),
				});
				setError(`The registration service returned an unexpected response (HTTP ${response.status}). Please retry.${requestId?` Reference: ${requestId}`:''}`);
				return;
			}
			if(!response.ok){
				if(result.code==='ACCOUNT_ACCESS_REQUIRED'||result.code==='ACCOUNT_ALREADY_EXISTS')setExistingAccountIssue('account');
				else if(result.code==='ACCOUNT_UNAVAILABLE')setExistingAccountIssue('unavailable');
				else if(result.code==='REGISTRATION_IN_PROGRESS')setExistingAccountIssue('pending');
				else if(result.code==='PHONE_ALREADY_IN_USE')setExistingAccountIssue('phone');
				const diagnostics=isRecord(result.diagnostics)?result.diagnostics:{};
				const missingConfiguration=Array.isArray(diagnostics.missingConfiguration)
					?diagnostics.missingConfiguration.filter((item:unknown):item is string=>typeof item==='string')
					:[];
				const readinessDetail=result.code==='PHONE_VERIFICATION_UNAVAILABLE'&&missingConfiguration.length
					?` Configuration needs attention: ${missingConfiguration.join(', ')}.`
					:'';
				const retryAfter=Number(response.headers.get('Retry-After')||result.retryAfterSeconds);
				const retryMessage=response.status===429&&Number.isFinite(retryAfter)&&retryAfter>0
					?` You can retry in ${retryAfter>=60?`${Math.ceil(retryAfter/60)} minute(s)`:`${retryAfter} second(s)`}.`
					:'';
				const referenceId=typeof result.referenceId==='string'?result.referenceId:typeof result.requestId==='string'?result.requestId:requestId;
				const message=typeof result.error==='string'?result.error:translate('registrationFailed');
				setError(`${referenceId?`${message} (Reference: ${referenceId})`:message}${readinessDetail}${retryMessage}`);return;
			}
			if((result.created!==true&&result.accountMatched!==true)||typeof result.email!=='string'){
				console.warn('[registration] API returned an incomplete success response.',{
					...(requestId?{requestId,referenceId:requestId}:{}),
					endpoint:'/api/register',
					httpStatus:response.status,
					failureTimestamp:new Date().toISOString(),
				});
				setError(`The registration service returned an incomplete response. Please retry.${requestId?` Reference: ${requestId}`:''}`);
				return;
			}
			const login=await signIn('credentials',{
				username:result.email,
				email:result.email,
				password:details.password,
				replaceSession:'false',
				redirect:false,
			});
			if(!login?.ok){
				setExistingAccountIssue('account');
				setError('Your account was created, but automatic sign-in failed. Sign in with your new email and password to continue.');
				return;
			}
			await updateSession();
			router.replace('/dashboard');
			router.refresh();
		}catch(exception){
			const referenceId=requestId||createRegistrationRequestId();
			console.error('[registration] Client could not process the API response.',{
				...(referenceId?{requestId:referenceId,referenceId}:{}),
				endpoint:'/api/register',
				errorName:exception instanceof Error?exception.name:'UnknownError',
				failureTimestamp:new Date().toISOString(),
			});
			setError(`Registration could not continue after the service response. Please retry.${referenceId?` Reference: ${referenceId}`:''}`);
		}
		finally{
			window.clearTimeout(requestTimeout);
			submissionInFlight.current=false;
			setBusy(false);
		}
	}

	return <><Nav/><main className="auth-scene"><section className="auth-card auth-register-card" aria-labelledby="registration-title">
		<div className="register-masthead"><div><div className="auth-brand"><Image src="/aurevia-logo.png" alt="" width={48} height={48}/><span className="brand-copy"><strong>Aurevia</strong><small>EXCHANGE</small></span></div><p className="account-kicker">PRIVATE BY DESIGN · BUILT FOR YOUR NEXT MOVE</p><h1 id="registration-title" className="auth-heading">{translate('createAccountTitle')}</h1><p className="auth-subtitle">Create your secure profile and choose how you want to get started.</p></div><div className="register-masthead-badge"><ShieldCheck size={18} aria-hidden="true"/><span>Secure<br/>account setup</span></div></div>
			<nav className="register-section-jump" aria-label="Registration sections"><a href="#register-profile"><span>01</span>{translate('personalInformation')}</a><a href="#register-contact"><span>02</span>{translate('contactInformation')}</a><a href="#register-security"><span>03</span>{translate('security')}</a><a href="#register-account"><span>04</span>{translate('accountType')}</a></nav>
			<form onSubmit={submit} className="register-form space-y-4">
				<fieldset id="register-profile" className="register-form-section"><legend className="sr-only">{translate('personalInformation')}</legend><h2>{translate('personalInformation')}</h2><div className="grid gap-3 sm:grid-cols-2">
					<label className="auth-field-label">{translate('firstName')}<input className="auth-input" name="given-name" autoComplete="given-name" value={details.firstName} onChange={event=>update('firstName',event.target.value)} required maxLength={60}/></label>
					<label className="auth-field-label">{translate('lastName')}<input className="auth-input" name="family-name" autoComplete="family-name" value={details.lastName} onChange={event=>update('lastName',event.target.value)} required maxLength={59}/></label>
					<label className="auth-field-label">{translate('dateOfBirth')}<input className="auth-input auth-date-input" type="date" name="bday" autoComplete="bday" value={details.dateOfBirth} max={dateInputMaximum()} aria-describedby={dateError?'dob-error':undefined} onChange={event=>{update('dateOfBirth',event.target.value);setDateError('')}} required/></label>
					<label className="auth-field-label">{translate('gender')}<select className="auth-input" name="gender" autoComplete="sex" value={details.gender} onChange={event=>update('gender',parseGenderSelection(event.target.value))} required><option value="">{translate('selectGender')}</option><option value="FEMALE">{translate('genderFemale')}</option><option value="MALE">{translate('genderMale')}</option><option value="NON_BINARY">{translate('genderNonBinary')}</option><option value="PREFER_NOT_TO_SAY">{translate('genderPreferNotToSay')}</option></select></label>
					<div><span className="auth-field-label">{translate('countryResidence')}</span><CountrySelector label={translate('countryResidence')} value={details.residenceCountry} onChange={code=>{update('residenceCountry',code);setCountryError('')}} required invalid={Boolean(countryError)} errorId={countryError?'country-error':undefined}/>{countryError&&<p id="country-error" className="mt-1 text-xs text-loss" role="alert">{countryError}</p>}</div>
				</div>
					{dateError&&<p id="dob-error" className="mt-2 text-xs text-loss" role="alert">{dateError}</p>}
				</fieldset>
				<fieldset id="register-contact" className="register-form-section"><legend className="sr-only">{translate('contactInformation')}</legend><h2>{translate('contactInformation')}</h2><div className="space-y-3">
					<label className="auth-field-label">{translate('emailAddress')}<input className="auth-input" name="email" type="email" autoComplete="email" value={details.email} onChange={event=>update('email',event.target.value)} required maxLength={254}/></label>
					<div><label className="auth-field-label" htmlFor="registration-phone">{translate('phoneNumber')} <span className="muted font-normal">{translate('phoneOptional')}</span></label><div className="register-phone-row mt-1"><CountrySelector label="Phone country and dialing code" value={details.phoneCountry} onChange={code=>{update('phoneCountry',code);setPhoneError('')}} invalid={Boolean(phoneError)} errorId={phoneError?'phone-error':undefined}/><input id="registration-phone" className="auth-input mt-0 min-w-0" name="tel-national" type="tel" autoComplete="tel-national" inputMode="tel" value={details.phoneNumber} onChange={event=>{update('phoneNumber',event.target.value);setPhoneError('')}} placeholder={translate('phoneNumber')} aria-describedby={phoneError?'phone-error':undefined}/></div>{phoneError&&<p id="phone-error" className="mt-1 text-xs text-loss" role="alert">{phoneError}</p>}</div>
				</div></fieldset>
				<fieldset id="register-security" className="register-form-section"><legend className="sr-only">{translate('security')}</legend><h2>{translate('security')}</h2><div className="grid gap-3 sm:grid-cols-2">
					<div><label className="auth-field-label" htmlFor="registration-password">{translate('password')}</label><div className="auth-password-wrap"><input id="registration-password" className="auth-input" name="new-password" type={passwordVisible?'text':'password'} autoComplete="new-password" value={details.password} onChange={event=>{update('password',event.target.value);setPasswordError('')}} required minLength={10} maxLength={128} pattern="(?=.*[a-z])(?=.*[A-Z])(?=.*[0-9]).{10,128}" aria-describedby="password-requirements"/><button type="button" className="auth-password-toggle" aria-label={passwordVisible?translate('hidePassword'):translate('showPassword')} aria-pressed={passwordVisible} onClick={()=>setPasswordVisible(value=>!value)}>{passwordVisible?<EyeOff size={17}/>:<Eye size={17}/>}</button></div></div>
					<div><label className="auth-field-label" htmlFor="registration-confirm-password">{translate('confirmPassword')}</label><div className="auth-password-wrap"><input id="registration-confirm-password" className="auth-input" name="confirm-password" type={confirmationVisible?'text':'password'} autoComplete="new-password" value={details.confirmPassword} onChange={event=>{update('confirmPassword',event.target.value);setPasswordError('')}} required maxLength={128} aria-describedby={passwordError?'password-error':undefined}/><button type="button" className="auth-password-toggle" aria-label={confirmationVisible?translate('hidePassword'):translate('showPassword')} aria-pressed={confirmationVisible} onClick={()=>setConfirmationVisible(value=>!value)}>{confirmationVisible?<EyeOff size={17}/>:<Eye size={17}/>}</button></div></div>
				</div><p id="password-requirements" className="mt-2 text-xs muted">{translate('passwordRequirements')}</p>{passwordError&&<p id="password-error" className="mt-1 text-xs text-loss" role="alert">{passwordError}</p>}</fieldset>
				<fieldset id="register-account" className="register-form-section"><legend className="sr-only">{translate('accountType')}</legend><h2>{translate('accountType')}</h2>
					<p className="account-mode-intro">Choose a starting account. You can explore the platform in DEMO mode, or create a REAL profile for eligible funding features.</p>
					<div className="account-mode-options" role="radiogroup" aria-label={translate('accountType')}>
						<label className={`account-mode-card ${details.accountMode==='DEMO'?'is-selected':''}`}><input type="radio" name="accountMode" value="DEMO" checked={details.accountMode==='DEMO'} onChange={()=>update('accountMode','DEMO')}/><span className="account-mode-icon"><FlaskConical size={20} aria-hidden="true"/></span><span className="account-mode-content"><span className="account-mode-eyebrow">PRACTICE · NO REAL FUNDS</span><b>{translate('demoAccount')}</b><span>{translate('demoAccountCopy')}</span></span><span className="account-mode-check" aria-hidden="true"><Check size={15}/></span></label>
						<label className={`account-mode-card ${details.accountMode==='REAL'?'is-selected':''}`}><input type="radio" name="accountMode" value="REAL" checked={details.accountMode==='REAL'} onChange={()=>update('accountMode','REAL')}/><span className="account-mode-icon"><TrendingUp size={20} aria-hidden="true"/></span><span className="account-mode-content"><span className="account-mode-eyebrow">PERSONAL PROFILE · REVIEW REQUIRED</span><b>{translate('realAccount')}</b><span>{translate('realAccountCopy')}</span></span><span className="account-mode-check" aria-hidden="true"><Check size={15}/></span></label>
					</div>
					<p className="mt-3 text-xs leading-5 muted">Registration is free. Tier 3 KYC requires phone verification. We use your email for account contact and password recovery.</p>
					{details.accountMode==='REAL'&&<p className="mt-2 flex items-center gap-2 text-xs leading-5 muted" role="status"><span className="tier-badge">Tier 1</span><span>Starting account status. Higher tiers follow the existing review process.</span></p>}
					<label className="mt-4 flex min-h-11 items-start gap-2 text-xs leading-5 muted"><input className="mt-1" type="checkbox" checked={termsAccepted} onChange={event=>setTermsAccepted(event.target.checked)} required/><span>{translate('termsConsent')} <Link className="auth-link" href="/terms">{translate('terms')}</Link>, <Link className="auth-link" href="/privacy">{translate('privacyPolicy')}</Link>, {translate('riskDisclosure')}</span></label>
				</fieldset>
				<div className="sr-only" aria-hidden="true"><label htmlFor="registration-website">Leave this field empty</label><input id="registration-website" name="website" type="text" tabIndex={-1} autoComplete="off" value="" readOnly/></div>
				{error&&<p className="auth-error" role="alert">{error}</p>}
				{existingAccountIssue==='account'&&<p className="text-sm leading-6 muted">You can <Link href="/login" className="auth-link" onClick={()=>{try{window.sessionStorage.setItem('aurevia-signin-email',details.email.trim())}catch(exception){console.warn('Unable to preserve email for registration sign-in handoff.',{errorName:exception instanceof Error?exception.name:'UnknownError'})}}}>Sign in</Link> or <Link href="/forgot-password" className="auth-link">reset your password</Link> if you already have an account.</p>}
				{existingAccountIssue==='unavailable'&&<p className="text-sm leading-6 muted">This account was not changed or reactivated. <Link href="/support" className="auth-link">Contact support</Link> for account-specific help.</p>}
				{existingAccountIssue==='pending'&&<p className="text-sm leading-6 muted">Your account may already have been created. Try signing in or wait briefly before retrying.</p>}
				{existingAccountIssue==='phone'&&<p className="text-sm leading-6 muted">Use a phone number not associated with another account.</p>}
				<button type="submit" disabled={busy||!registrationFormValid} aria-busy={busy} className="auth-submit flex w-full items-center justify-center gap-2">{busy?translate('creatingAccount'):translate('createAccountButton')}<ArrowRight size={16} aria-hidden="true"/></button>
			</form>
				<p className="auth-footer">{translate('alreadyRegistered')} <Link href="/login" className="auth-link">{translate('signIn')}</Link></p>
		<div className="mt-5 flex items-center gap-2 border-t border-white/10 pt-4 text-xs muted"><ShieldCheck size={15} className="gold" aria-hidden="true"/>{translate('accountPrivate')}</div>
	</section></main></>;
}