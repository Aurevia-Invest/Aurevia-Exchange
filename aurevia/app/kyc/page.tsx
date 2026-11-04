'use client';

import {FormEvent,useCallback,useEffect,useState} from 'react';
import {useSession} from 'next-auth/react';
import {FileCheck2,Info,ShieldCheck,Upload} from 'lucide-react';
import Nav from '@/components/Nav';
import {useLocale} from '@/lib/i18n-context';
import type {TranslationKey} from '@/lib/i18n';

type VerificationStatus='PENDING'|'APPROVED'|'REJECTED'|'NEEDS_CHANGES';
type VerificationForm={legalName:string;dob:string;address:string;idType:string;idNumber:string};
type KycDocument={id:string;kind:string;filename:string;mimeType:string;size:number;status:string;uploadedAt:string;reviewedAt:string|null;reviewNote:string|null};
type AkedlyPhoneAttempt={attemptId:string;iframeUrl:string;expiresAt:string;smsFallbackAvailable:boolean};
const emptyForm:VerificationForm={legalName:'',dob:'',address:'',idType:'PASSPORT',idNumber:''};

const statusCopy:Record<VerificationStatus,{label:TranslationKey;description:TranslationKey}>={
  PENDING:{label:'pendingReview',description:'pendingReviewDescription'},
  APPROVED:{label:'adminApproved',description:'adminApprovedDescription'},
  REJECTED:{label:'needsAttention',description:'needsAttentionDescription'},
  NEEDS_CHANGES:{label:'changesRequested',description:'changesRequestedDescription'},
};

export default function Kyc(){
  const {data:session,status:sessionStatus}=useSession();
  const {translate}=useLocale();
  const isRealAccount=session?.user?.accountMode==='REAL';
  const [form,setForm]=useState<VerificationForm>(emptyForm);
  const [status,setStatus]=useState<VerificationStatus>('PENDING');
  const [message,setMessage]=useState('');
  const [phoneMessage,setPhoneMessage]=useState('');
  const [error,setError]=useState('');
  const [loading,setLoading]=useState(true);
  const [submitting,setSubmitting]=useState(false);
  const [documents,setDocuments]=useState<KycDocument[]>([]);
  const [currentTier,setCurrentTier]=useState(1);
  const [retryCount,setRetryCount]=useState(0);
  const [uploadKind,setUploadKind]=useState<'IDENTITY_DOCUMENT'|'SELFIE'|'PROOF_OF_ADDRESS'>('IDENTITY_DOCUMENT');
  const [uploadFile,setUploadFile]=useState<File|null>(null);
  const [uploading,setUploading]=useState(false);
  const [phone,setPhone]=useState('');
  const [phoneCode,setPhoneCode]=useState('');
  const [phoneAttempt,setPhoneAttempt]=useState<AkedlyPhoneAttempt|null>(null);
  const [phoneVerified,setPhoneVerified]=useState(false);
  const [sendingPhoneCode,setSendingPhoneCode]=useState(false);
  const [verifyingPhoneCode,setVerifyingPhoneCode]=useState(false);

  const load=useCallback(async(active:()=>boolean)=>{
    if(sessionStatus==='loading')return;
    if(sessionStatus!=='authenticated'||!isRealAccount){
      if(active()){setError('');setLoading(false)}
      return;
    }
    setLoading(true);setError('');
    try{
      const responses=await Promise.all([fetch('/api/kyc'),fetch('/api/profile'),fetch('/api/kyc/documents',{cache:'no-store'}),fetch('/api/tier-requests',{cache:'no-store'})]);
      if(responses.some(response=>!response.ok))throw new Error(translate('unableLoadVerification'));
      const [kyc,profile,uploadedDocuments,tier]=await Promise.all(responses.map(response=>response.json()));
      if(!active())return;
      if(kyc)setForm({legalName:kyc.legalName||'',dob:kyc.dob?String(kyc.dob).slice(0,10):'',address:kyc.address||'',idType:kyc.idType||'PASSPORT',idNumber:kyc.idNumber||''});
      setPhone(profile.phone||'');
      setPhoneVerified(Boolean(profile.phoneVerified));
      setCurrentTier(typeof tier.currentTier==='number'?tier.currentTier:1);
      if(['PENDING','APPROVED','REJECTED','NEEDS_CHANGES'].includes(profile.kycStatus))setStatus(profile.kycStatus);
      setDocuments(uploadedDocuments);
    }catch(exception){if(active())setError(exception instanceof Error?exception.message:translate('unableLoadVerification'))}
    finally{if(active())setLoading(false)}
  },[isRealAccount,sessionStatus,translate]);

  useEffect(()=>{
    let active=true;
    void load(()=>active);
    return()=>{active=false};
  },[load,retryCount]);

  useEffect(()=>{
    if(!phoneAttempt)return;
    let active=true;
    let timeout:ReturnType<typeof setTimeout>;
    const check=async()=>{
      try{
        const response=await fetch('/api/kyc/phone/status',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({attemptId:phoneAttempt.attemptId})});
        if(response.ok){
          const result=await response.json();
          if(result.verified){
            if(active){setPhoneVerified(true);setPhoneMessage('Your phone number is verified.');setPhoneAttempt(null)}
            return;
          }
          if(result.expired){
            if(active){setPhoneAttempt(null);setPhoneMessage('This phone verification attempt expired. Start a new attempt to continue.')}
            return;
          }
        }
      }catch{
        if(active)setPhoneMessage('Phone verification is still being checked. Keep this page open or check again shortly.');
      }
      if(active)timeout=setTimeout(()=>void check(),3000);
    };
    timeout=setTimeout(()=>void check(),3000);
    return()=>{active=false;clearTimeout(timeout)};
  },[phoneAttempt]);

  const completed=[form.legalName,form.dob,form.address,form.idType,form.idNumber].filter(Boolean).length;
  const completion=Math.round(completed/5*100);
  const state={label:translate(statusCopy[status].label),description:translate(statusCopy[status].description)};
  const showTierThreePhoneVerification=isRealAccount&&currentTier>=2;

  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(submitting)return;
    setSubmitting(true);setMessage('');setError('');
    try{
      const response=await fetch('/api/kyc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(form)});
      const result=await response.json();
      if(!response.ok)throw new Error(result.error||translate('unableSubmitVerification'));
      setStatus('PENDING');setMessage(translate('verificationSubmitted'));
    }catch(exception){setError(exception instanceof Error?exception.message:translate('unableSubmitVerification'))}
    finally{setSubmitting(false)}
  }

  async function sendPhoneCode(delivery:'automatic'|'sms'='automatic'){
    if(sendingPhoneCode||!phone.trim())return;
    setSendingPhoneCode(true);setError('');setPhoneMessage('');
    try{
      const response=await fetch('/api/kyc/phone/send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phone:phone.trim(),delivery})});
      const result=await response.json();
      if(!response.ok)throw new Error(result.error||'Unable to send a phone verification code.');
      setPhoneVerified(false);setPhoneCode('');setPhoneMessage(result.message||'A verification code was sent to your phone.');
      if(result.provider==='akedly'&&typeof result.attemptId==='string'&&typeof result.iframeUrl==='string'&&typeof result.expiresAt==='string'){
        setPhoneAttempt({
          attemptId:result.attemptId,
          iframeUrl:result.iframeUrl,
          expiresAt:result.expiresAt,
          smsFallbackAvailable:result.smsFallbackAvailable===true,
        });
      }else setPhoneAttempt(null);
    }catch(exception){setError(exception instanceof Error?exception.message:'Unable to send a phone verification code.')}
    finally{setSendingPhoneCode(false)}
  }

  async function verifyPhoneCode(){
    if(verifyingPhoneCode||phoneCode.length!==6)return;
    setVerifyingPhoneCode(true);setError('');setPhoneMessage('');
    try{
      const response=await fetch('/api/kyc/phone/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:phoneCode})});
      const result=await response.json();
      if(!response.ok)throw new Error(result.error||'Unable to verify this phone number.');
      setPhoneVerified(true);setPhoneMessage(result.message||'Your phone number is verified.');
    }catch(exception){setError(exception instanceof Error?exception.message:'Unable to verify this phone number.')}
    finally{setVerifyingPhoneCode(false)}
  }

  async function uploadDocument(){
    if(!uploadFile||uploading)return;
    setUploading(true);setMessage('');setError('');
    try{
      const body=new FormData();body.append('file',uploadFile);body.append('kind',uploadKind);
      const response=await fetch('/api/kyc/documents',{method:'POST',body});
      const result=await response.json();if(!response.ok)throw new Error(result.error||translate('unableUploadDocument'));
      const documentResponse=await fetch('/api/kyc/documents',{cache:'no-store'});const uploadedDocuments=await documentResponse.json();
      if(!documentResponse.ok)throw new Error(uploadedDocuments.error||translate('documentRefreshFailed'));
      setDocuments(uploadedDocuments);setUploadFile(null);if(uploadKind!=='PROOF_OF_ADDRESS')setStatus('PENDING');setMessage(translate('documentUploaded'));
    }catch(exception){setError(exception instanceof Error?exception.message:translate('unableUploadDocument'))}
    finally{setUploading(false)}
  }

  return <><Nav/><main className="account-page">
    <header className="account-heading"><div><span className="account-kicker">{translate('accountVerification')}</span><h1>{translate('kycTitle')}</h1><p>{translate('verificationWorkflow')}</p></div>{status==='APPROVED'?<span className="verified-badge"><ShieldCheck size={14} aria-hidden="true"/> Profile verified</span>:<span className="status-pill">{loading?translate('loadingStatus'):state.label}</span>}</header>
    {sessionStatus==='authenticated'&&!isRealAccount?<section className="account-panel card p-5" role="status"><h2 className="font-semibold">REAL mode required</h2><p className="mt-2 text-sm leading-6 muted">Identity verification and private document uploads are available only in REAL mode. Switch account mode from the navigation to continue.</p></section>:<>
    <section className="account-panel card mb-4 p-5" aria-labelledby="kyc-tier-requirements">
      <h2 id="kyc-tier-requirements" className="text-lg font-semibold">KYC tier requirements</h2>
      <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[720px] text-left text-sm"><thead><tr className="border-b border-white/10"><th className="py-2 pr-4">Tier</th><th className="py-2 pr-4">Requirements</th><th className="py-2 pr-4">Verification</th><th className="py-2">Limits / benefits</th></tr></thead><tbody>
        <tr className="border-b border-white/10"><th className="py-3 pr-4">Tier 1</th><td className="py-3 pr-4">Full name, date of birth, and country</td><td className="py-3 pr-4">None</td><td className="py-3">Basic access; lower configured withdrawal limits</td></tr>
        <tr className="border-b border-white/10"><th className="py-3 pr-4">Tier 2</th><td className="py-3 pr-4">Tier 1 + government-issued ID and selfie</td><td className="py-3 pr-4">Identity review; no OTP</td><td className="py-3">Medium configured withdrawal limits</td></tr>
        <tr><th className="py-3 pr-4">Tier 3</th><td className="py-3 pr-4">Tier 2 + proof of address</td><td className="py-3 pr-4">Phone OTP required</td><td className="py-3">Highest configured limits and full account access</td></tr>
      </tbody></table></div>
      <p className="mt-3 text-xs leading-5 muted">REAL trading and deposits are available before KYC. Withdrawals remain subject to approved KYC and existing account controls.</p>
    </section>
    {error&&<div className="account-callout mb-4" role="alert"><span>{error}</span><button type="button" className="text-link" disabled={loading} onClick={()=>setRetryCount(value=>value+1)}>Retry</button></div>}
    <section className="account-panel card p-5">
      <div className="account-panel-title"><div><h2>{translate('verificationProgress')}</h2><p className="account-panel-subtitle">{state.description}</p></div><ShieldCheck size={20} className="gold" aria-hidden="true"/></div>
      <div className="progress-track" role="progressbar" aria-label={translate('verificationDetailsCompleted')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={completion}><span style={{width:`${completion}%`}}/></div>
      <p className="mt-2 text-right text-xs muted">{translate('completionPercent',{percent:completion})}</p>
      <div className="verification-steps mt-5">
        <div className={`verification-step ${form.legalName&&form.dob?'is-current':''}`}><i>1</i><span>{translate('personalDetails')}</span></div>
        <div className={`verification-step ${form.address?'is-current':''}`}><i>2</i><span>{translate('address')}</span></div>
        <div className="verification-step"><i>3</i><span>{translate('employmentFinance')}</span></div>
        <div className={`verification-step ${form.idNumber?'is-current':''}`}><i>4</i><span>{translate('identityDetails')}</span></div>
        <div className={`verification-step ${status==='PENDING'?'is-current':''}`}><i>5</i><span>{translate('reviewResult')}</span></div>
      </div>
    </section>
    <div className="account-content-grid">
      {showTierThreePhoneVerification&&<section className="account-panel card p-5 md:col-span-2"><div className="account-panel-title"><div><h2>Verify your phone before KYC document review</h2><p className="account-panel-subtitle">You can verify your phone before submitting identity documents for administrator review. Phone verification confirms phone ownership only; identity and Tier 3 approval remain subject to administrator review.</p></div><ShieldCheck size={18} className="gold" aria-hidden="true"/></div>
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <label className="account-label">Phone number<input className="input" type="tel" autoComplete="tel" inputMode="tel" value={phone} onChange={event=>{setPhone(event.target.value);setPhoneVerified(false);setPhoneCode('');setPhoneAttempt(null)}} placeholder="+12125550123" required/></label>
          <button className="btn bg-gold text-black self-end" type="button" disabled={sendingPhoneCode||loading||!phone.trim()} onClick={()=>void sendPhoneCode()}>{sendingPhoneCode?'Sending…':phoneAttempt?'Restart verification':'Start verification'}</button>
        </div>
        {phoneAttempt?<div className="mt-4 overflow-hidden rounded-lg border border-white/10 bg-black/30"><iframe className="block h-[700px] w-full max-w-full" src={phoneAttempt.iframeUrl} title="Akedly secure phone verification" allow="clipboard-write; publickey-credentials-get *; publickey-credentials-create *"/></div>:<div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto]">
          <label className="account-label">Six-digit verification code<input className="input" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={phoneCode} onChange={event=>setPhoneCode(event.target.value.replace(/\D/g,'').slice(0,6))}/></label>
          <button className="btn bg-gold text-black self-end" type="button" disabled={verifyingPhoneCode||loading||phoneCode.length!==6||phoneVerified} onClick={()=>void verifyPhoneCode()}>{verifyingPhoneCode?'Verifying…':phoneVerified?'Phone verified':'Verify phone'}</button>
        </div>}
        {phoneAttempt?.smsFallbackAvailable&&<button className="mt-3 text-link text-sm" type="button" disabled={sendingPhoneCode||loading} onClick={()=>void sendPhoneCode('sms')}>{sendingPhoneCode?'Requesting SMS code…':'Can’t use the widget? Send me an SMS code instead'}</button>}
        <p className="mt-3 text-xs muted" role="status">{phoneVerified?'Phone number verified for Tier 3.':'Verify your phone number to continue with Tier 3.'}</p>
        {phoneMessage&&<p className="mt-2 text-sm text-profit" role="status">{phoneMessage}</p>}
        {phoneVerified&&<p className="mt-3 text-sm text-profit" role="status">Phone verified. Complete and submit your identity information and documents below for administrator review.</p>}
      </section>
      }
      <section className="account-panel card p-5"><div className="account-panel-title"><div><h2>{translate('personalInformation')}</h2><p className="account-panel-subtitle">{translate('useIdentityDocument')}</p></div><FileCheck2 size={18} className="gold" aria-hidden="true"/></div>
        <form onSubmit={submit} className="account-form-grid">
          <label className="account-label">{translate('legalName')}<input className="input" autoComplete="name" required minLength={2} maxLength={160} value={form.legalName} onChange={event=>setForm({...form,legalName:event.target.value})}/></label>
          <label className="account-label">{translate('dateOfBirth')}<input className="input" type="date" required value={form.dob} onChange={event=>setForm({...form,dob:event.target.value})}/></label>
          <label className="account-label md:col-span-2">Residential address<input className="input" autoComplete="street-address" minLength={5} maxLength={500} required value={form.address} onChange={event=>setForm({...form,address:event.target.value})}/></label>
          <label className="account-label">{translate('identityDocumentType')}<select className="input" value={form.idType} onChange={event=>setForm({...form,idType:event.target.value})}><option value="PASSPORT">{translate('passport')}</option><option value="NATIONAL_ID">{translate('nationalId')}</option><option value="DRIVERS_LICENSE">{translate('driversLicense')}</option></select></label>
          <label className="account-label">{translate('documentNumber')}<input className="input" required minLength={3} maxLength={100} autoComplete="off" value={form.idNumber} onChange={event=>setForm({...form,idNumber:event.target.value})}/></label>
          <div className="account-callout md:col-span-2"><Info size={16}/><span>{translate('identityFilesCopy')}</span></div>
          <div className="md:col-span-2"><button className="btn bg-gold text-black" type="submit" disabled={submitting||loading} aria-busy={submitting}>{submitting?translate('submitting'):translate('submitForReview')}</button><p className="mt-2 text-xs muted">Submit your identity profile first. You can then verify your phone and upload proof of address before administrator review. Phone verification is only required for Tier 3.</p>{message&&<p className="mt-3 text-sm text-profit" role="status">{message}</p>}</div>
        </form>
      </section>
      <aside className="account-panel card p-5"><div className="account-panel-title"><div><h2>{translate('reviewStatus')}</h2><p className="account-panel-subtitle">{translate('currentAccountStatus')}</p></div></div><span className="status-pill">{loading?translate('loading'):state.label}</span><p className="mt-4 text-sm leading-6 muted">{state.description}</p><div className="mt-5 border-t border-white/10 pt-4"><h3 className="text-sm font-semibold">{translate('identityDocuments')}</h3><p className="mt-2 text-xs leading-5 muted">{translate('documentTypes')}</p><div className="mt-3 grid gap-3"><label className="account-label">{translate('documentType')}<select className="input" value={uploadKind} onChange={event=>setUploadKind(event.target.value as 'IDENTITY_DOCUMENT'|'SELFIE'|'PROOF_OF_ADDRESS')}><option value="IDENTITY_DOCUMENT">Government-issued ID</option><option value="SELFIE">Selfie</option><option value="PROOF_OF_ADDRESS" disabled={!showTierThreePhoneVerification||!phoneVerified}>Proof of address (Tier 3)</option></select></label><label className="account-label">{translate('chooseFile')}<input className="input" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={event=>setUploadFile(event.target.files?.[0]||null)}/></label><button className="btn bg-gold text-black" type="button" disabled={!uploadFile||uploading||loading||(uploadKind==='PROOF_OF_ADDRESS'&&(!showTierThreePhoneVerification||!phoneVerified))} onClick={()=>void uploadDocument()}><Upload size={15}/>{uploading?translate('uploadingDocument'):translate('uploadDocument')}</button></div>{documents.length?<ul className="mt-4 divide-y divide-white/10">{documents.map(document=><li className="py-3 text-sm" key={document.id}><div className="flex flex-wrap items-center justify-between gap-2"><span className="break-all">{document.filename}</span><span className="status-pill">{document.status.replaceAll('_',' ')}</span></div><p className="mt-1 text-xs muted">{document.kind.replaceAll('_',' ')} · {new Date(document.uploadedAt).toLocaleDateString()}{document.reviewNote?` · ${document.reviewNote}`:''}</p></li>)}</ul>:<p className="mt-3 text-sm muted">{translate('noDocumentsSubmitted')}</p>}</div></aside>
    </div>
    </>}
  </main></>;
}