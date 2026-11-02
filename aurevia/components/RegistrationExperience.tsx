'use client';

import {FormEvent,useState} from 'react';
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

const initialDetails:RegistrationDetails={firstName:'',lastName:'',dateOfBirth:'',residenceCountry:'',phoneCountry:'US',phoneNumber:'',email:'',password:'',confirmPassword:'',accountMode:'DEMO'};

function dateInputMaximum(){return new Date().toISOString().slice(0,10)}

export default function RegistrationExperience(){
	const {translate}=useLocale();
	const [details,setDetails]=useState(initialDetails);
	const [termsAccepted,setTermsAccepted]=useState(false);
	const [error,setError]=useState('');
	const [countryError,setCountryError]=useState('');
	const [dateError,setDateError]=useState('');
	const [phoneError,setPhoneError]=useState('');
	const [passwordError,setPasswordError]=useState('');
	const [busy,setBusy]=useState(false);
	const router=useRouter();
	const residence=findCountry(details.residenceCountry);

	function update<K extends keyof RegistrationDetails>(key:K,value:RegistrationDetails[K]){
		setDetails(current=>({...current,[key]:value}));
	}

	async function submit(event:FormEvent<HTMLFormElement>){
		event.preventDefault();
		if(busy)return;
		setError('');setCountryError('');setDateError('');setPhoneError('');setPasswordError('');
		const date=parseDateOfBirth(details.dateOfBirth);
		const phone=details.phoneNumber.trim()?normalizePhoneE164(details.phoneNumber,details.phoneCountry as CountryCode):'';
		let invalid=false;
		if(!residence){setCountryError(translate('selectCountry'));invalid=true;}
		if(!date){setDateError(translate('validDate'));invalid=true;}
		if(details.phoneNumber.trim()&&!phone){setPhoneError(translate('validPhone'));invalid=true;}
		if(details.password!==details.confirmPassword){setPasswordError(translate('passwordMatch'));invalid=true;}
		if(invalid||!residence)return;
		setBusy(true);
		try{
			const response=await fetch('/api/register',{method:'POST',headers:{'content-type':'application/json','accept':'application/json'},body:JSON.stringify({name:`${details.firstName.trim()} ${details.lastName.trim()}`.trim(),email:details.email,password:details.password,country:residence.name,phone,dateOfBirth:details.dateOfBirth,accountMode:details.accountMode,termsAccepted})});
			const result=await response.json().catch(()=>({}));
			if(!response.ok){
				setError(result.requestId?`${result.error||translate('registrationFailed')} (Reference: ${result.requestId})`:result.error||translate('registrationFailed'));return;
			}
			router.replace(`/verify-email?email=${encodeURIComponent(result.email||details.email)}`);
			router.refresh();
		}catch{setError(translate('unableRegistration'));}
		finally{setBusy(false);}
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
					<div><label className="auth-field-label" htmlFor="registration-phone">{translate('phoneNumber')} <span className="muted font-normal">{translate('phoneOptional')}</span></label><div className="register-phone-row mt-1"><CountrySelector label="Phone country and dialing code" value={details.phoneCountry} onChange={code=>update('phoneCountry',code)}/><input id="registration-phone" className="auth-input mt-0 min-w-0" name="tel-national" type="tel" autoComplete="tel-national" inputMode="tel" value={details.phoneNumber} onChange={event=>{update('phoneNumber',event.target.value);setPhoneError('')}} placeholder={translate('phoneNumber')} aria-describedby={phoneError?'phone-error':undefined}/></div>{phoneError&&<p id="phone-error" className="mt-1 text-xs text-loss" role="alert">{phoneError}</p>}</div>
				</div></fieldset>
				<fieldset id="register-security" className="register-form-section"><legend className="sr-only">{translate('security')}</legend><h2>{translate('security')}</h2><div className="grid gap-3 sm:grid-cols-2">
					<label className="auth-field-label">{translate('password')}<input className="auth-input" name="new-password" type="password" autoComplete="new-password" value={details.password} onChange={event=>{update('password',event.target.value);setPasswordError('')}} required minLength={10} maxLength={128} pattern="(?=.*[a-z])(?=.*[A-Z])(?=.*[0-9]).{10,128}" aria-describedby="password-requirements"/></label>
					<label className="auth-field-label">{translate('confirmPassword')}<input className="auth-input" name="confirm-password" type="password" autoComplete="new-password" value={details.confirmPassword} onChange={event=>{update('confirmPassword',event.target.value);setPasswordError('')}} required maxLength={128} aria-describedby={passwordError?'password-error':undefined}/></label>
				</div><p id="password-requirements" className="mt-2 text-xs muted">{translate('passwordRequirements')}</p>{passwordError&&<p id="password-error" className="mt-1 text-xs text-loss" role="alert">{passwordError}</p>}</fieldset>
				<fieldset id="register-account" className="register-form-section"><legend className="sr-only">{translate('accountType')}</legend><h2>{translate('accountType')}</h2>
					<div className="grid gap-2 sm:grid-cols-2"><label className={`block cursor-pointer rounded-md border p-3 ${details.accountMode==='DEMO'?'border-gold/40 bg-white/5':'border-white/10'}`}><span className="flex min-h-11 items-center gap-3"><input type="radio" name="accountMode" value="DEMO" checked={details.accountMode==='DEMO'} onChange={()=>update('accountMode','DEMO')}/><b>{translate('demoAccount')}</b></span><span className="block pl-7 text-xs leading-5 muted">{translate('demoAccountCopy')}</span></label><label className={`block cursor-pointer rounded-md border p-3 ${details.accountMode==='REAL'?'border-gold/40 bg-white/5':'border-white/10'}`}><span className="flex min-h-11 items-center gap-3"><input type="radio" name="accountMode" value="REAL" checked={details.accountMode==='REAL'} onChange={()=>update('accountMode','REAL')}/><b>{translate('realAccount')}</b></span><span className="block pl-7 text-xs leading-5 muted">{translate('realAccountCopy')}</span></label></div>
					<p className="mt-3 text-xs leading-5 muted">Registration is free. Verify your email before signing in. New accounts start on <span className="tier-badge">Tier 1</span>; identity review remains separate for eligible account services.</p>
					<label className="mt-4 flex min-h-11 items-start gap-2 text-xs leading-5 muted"><input className="mt-1" type="checkbox" checked={termsAccepted} onChange={event=>setTermsAccepted(event.target.checked)} required/><span>{translate('termsConsent')} <Link className="auth-link" href="/terms">{translate('terms')}</Link>, <Link className="auth-link" href="/privacy">{translate('privacyPolicy')}</Link>, {translate('riskDisclosure')}</span></label>
				</fieldset>
				{error&&<p className="auth-error" role="alert">{error}</p>}
				<button type="submit" disabled={busy} className="auth-submit flex w-full items-center justify-center gap-2">{busy?translate('creatingAccount'):translate('createAccountButton')}<ArrowRight size={16} aria-hidden="true"/></button>
			</form>
				<p className="auth-footer">{translate('alreadyRegistered')} <Link href="/login" className="auth-link">{translate('signIn')}</Link></p>
		<div className="mt-5 flex items-center gap-2 border-t border-white/10 pt-4 text-xs muted"><ShieldCheck size={15} className="gold" aria-hidden="true"/>{translate('accountPrivate')}</div>
	</section></main></>;
}