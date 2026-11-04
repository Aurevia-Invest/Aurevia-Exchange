'use client';

import {FormEvent,useCallback,useEffect,useState} from 'react';
import Link from 'next/link';
import {useSession} from 'next-auth/react';
import {BadgeCheck,Check,Clock3,Crown,LockKeyhole,MailCheck,ShieldCheck,Sparkles,UserRound} from 'lucide-react';
import Nav from '@/components/Nav';
import OnboardingAssistant from '@/components/OnboardingAssistant';

type TierRequest={id:string;currentTier:number;requestedTier:number;status:string;userMessage:string|null;adminReason:string|null;createdAt:string;reviewedAt:string|null};
type TierData={
	tier:string;currentTier:number;progress:number;accountMode:'DEMO'|'REAL';canRequest:boolean;
	requirements:{nameComplete:boolean;countryComplete:boolean;phoneComplete:boolean;phoneVerified:boolean;profileComplete:boolean;verificationSubmitted:boolean;identityDocumentUploaded:boolean;selfieUploaded:boolean;proofOfAddressUploaded:boolean};
	permissions:{basicAccountAccess:boolean;profileManagement:boolean;identityVerification:boolean;tierBenefits:boolean;verifiedAccount:boolean;realMoneyServices:boolean};
	requests:TierRequest[];
};
const tiers=[
	{number:1,title:'Registered account',icon:UserRound,description:'Sign in, use your dashboard, and manage core account features.'},
	{number:2,title:'Identity reviewed',icon:Sparkles,description:'Submit a government-issued ID and selfie for admin review. Phone OTP is not required.'},
	{number:3,title:'Verified account',icon:Crown,description:'Submit proof of address, verify your phone, and get admin approval.'},
];

export default function AccountTierPanel(){
	const {data:session}=useSession();
	const [data,setData]=useState<TierData|null>(null);
	const [message,setMessage]=useState('');
	const [error,setError]=useState('');
	const [notice,setNotice]=useState('');
	const [busy,setBusy]=useState(false);
	const [loading,setLoading]=useState(true);
	const load=useCallback(async()=>{
		setLoading(true);
		try{
			const response=await fetch('/api/tier-requests',{cache:'no-store'});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to load tier status.');
			setData(result);setError('');
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to load tier status.')}
		finally{setLoading(false)}
	},[]);
	useEffect(()=>{void load()},[load]);

	async function requestUpgrade(event:FormEvent<HTMLFormElement>){
		event.preventDefault();if(busy)return;setBusy(true);setError('');setNotice('');
		try{
			const response=await fetch('/api/tier-requests',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message})});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to submit your tier review request.');
			setNotice('Your Tier 3 request is awaiting administrator review.');
			setMessage('');await load();
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to submit your tier review request.')}
		finally{setBusy(false)}
	}

	async function submitAdditionalInformation(event:FormEvent<HTMLFormElement>){
		event.preventDefault();
		const latest=data?.requests[0];
		if(!latest||busy)return;
		setBusy(true);setError('');setNotice('');
		try{
			const response=await fetch('/api/tier-requests',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({id:latest.id,message})});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to submit additional information.');
			setNotice('Your additional information was sent to the administrator for review.');
			setMessage('');await load();
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to submit additional information.')}
		finally{setBusy(false)}
	}

	const currentTier=data?.currentTier||1;
	const latest=data?.requests[0];
	const requirements=data?.requirements;
	const checks=[
		{label:'Full name provided',complete:requirements?.nameComplete,href:'/settings#profile'},
		{label:'Country selected',complete:requirements?.countryComplete,href:'/settings#profile'},
		{label:'Valid phone number added',complete:requirements?.phoneComplete,href:'/settings#profile'},
		{label:'Phone number verified for KYC',complete:requirements?.phoneVerified,href:'/kyc'},
		{label:'Identity information submitted',complete:requirements?.verificationSubmitted,href:'/kyc'},
		{label:'Identity document uploaded',complete:requirements?.identityDocumentUploaded,href:'/kyc'},
		{label:'Selfie uploaded',complete:requirements?.selfieUploaded,href:'/kyc'},
		{label:'Residential address provided',complete:requirements?.verificationSubmitted,href:'/kyc'},
		{label:'Proof of address uploaded',complete:requirements?.proofOfAddressUploaded,href:'/kyc'},
	];

	return <><Nav/><main className="account-page tier-page">
		<header className="account-heading tier-heading"><div><span className="account-kicker">AUREVIA · ACCOUNT PROGRESSION</span><h1>Account tiers</h1><p>See your current tier and what you need to advance.</p></div><span className={`status-pill ${data?.accountMode==='REAL'?'mode-real':'mode-demo'}`}>{data?.accountMode||session?.user?.accountMode||'ACCOUNT'} · TIER {currentTier}</span></header>
		{loading&&!data&&<p className="account-empty" role="status">Loading your tier progress…</p>}
		{error&&<div className="account-callout mb-3" role="alert"><span>{error}</span><button className="text-link" type="button" disabled={loading} onClick={()=>void load()}>Retry</button></div>}
		{notice&&<p className="mb-3 text-sm text-profit" role="status">{notice}</p>}
		{data&&<>
			<section className="tier-summary" aria-label="Current tier progress">
				<div className="tier-summary-copy"><span>YOUR CURRENT STATUS</span><strong>{data.tier}</strong><p>{data.accountMode==='REAL'?'Your tier is separate from REAL account and financial eligibility.':'Your profile can progress through Tier 2 in DEMO; identity approval requires REAL mode.'}</p></div>
				<div className="tier-progress-wrap"><div className="tier-progress-label"><span>Progression</span><b>{data.progress}%</b></div><div className="tier-progress-track" role="progressbar" aria-label="Account tier progression" aria-valuemin={0} aria-valuemax={100} aria-valuenow={data.progress}><span style={{width:`${data.progress}%`}}/></div><span className="tier-progress-caption">Tier {currentTier} of 3</span></div>
			</section>

			<section className="tier-progression" aria-label="Three account tiers">
				{tiers.map(tier=>{
					const Icon=tier.icon;
					const current=tier.number===currentTier;
					const complete=tier.number<currentTier;
					const awaiting=tier.number===3&&latest&&['PENDING_REVIEW','NEEDS_INFORMATION'].includes(latest.status);
					const state=current?'Current':complete?'Achieved':awaiting?'In review':tier.number===2?'Complete your profile':'Submit Tier 3 requirements for review';
					return <article className={`tier-step ${current?'is-current':''} ${complete?'is-complete':''}`} key={tier.number}>
						<div className={`tier-icon tier-icon-${tier.number}`} aria-hidden="true"><span/><Icon size={20}/></div>
						<div className="tier-step-heading"><span>TIER {tier.number}</span><b>{current?<BadgeCheck size={15}/>:complete?<Check size={15}/>:awaiting?<Clock3 size={15}/>:<LockKeyhole size={14}/>}</b></div>
						<h2>{tier.title}</h2><p>{tier.description}</p>
						<div className="tier-step-status">{state}</div>
					</article>;
				})}
			</section>

			<div className="tier-details-grid">
				<section className="tier-panel">
					<div className="tier-panel-heading"><div><span>YOUR CHECKLIST</span><h2>Completed and outstanding</h2></div><ShieldCheck size={18}/></div>
					<div className="tier-checklist">{checks.map(item=><div className={`tier-check ${item.complete?'is-done':''}`} key={item.label}><span>{item.complete?<Check size={14}/>:<Clock3 size={14}/>}</span><span>{item.label}</span>{!item.complete&&<Link href={item.href}>Complete</Link>}</div>)}</div>
					{data.accountMode==='REAL'&&<p className="mt-3 text-xs leading-5 muted">Complete your submissions and phone verification before review. An administrator reviews identity documents separately; OTP confirms your phone only and does not approve your identity.</p>}
					<OnboardingAssistant/>
					<div className="tier-panel-actions"><Link className="button-secondary" href="/settings#profile">Edit profile</Link>{data.accountMode==='REAL'&&<Link className="button-secondary" href="/kyc">Identity verification</Link>}{data.accountMode==='DEMO'&&<p>Switch to REAL mode to submit identity verification for Tier 3.</p>}</div>
				</section>
				<section className="tier-panel">
					<div className="tier-panel-heading"><div><span>AVAILABLE ACCESS</span><h2>Account permissions</h2></div><LockKeyhole size={18}/></div>
					<ul className="tier-permissions"><li><Check size={14}/>Dashboard and basic account access</li><li><Check size={14}/>Profile and account settings</li><li className={data.permissions.tierBenefits?'is-enabled':''}>{data.permissions.tierBenefits?<Check size={14}/>:<LockKeyhole size={14}/>}Configured Tier 2 account benefits</li><li className={data.permissions.identityVerification?'is-enabled':''}>{data.permissions.identityVerification?<Check size={14}/>:<LockKeyhole size={14}/>}Identity verification submission</li><li className={data.permissions.verifiedAccount?'is-enabled':''}>{data.permissions.verifiedAccount?<Check size={14}/>:<LockKeyhole size={14}/>}Verified-account status</li><li className={data.permissions.realMoneyServices?'is-enabled':''}>{data.permissions.realMoneyServices?<Check size={14}/>:<LockKeyhole size={14}/>}REAL trading and deposits before KYC</li><li><LockKeyhole size={14}/>Withdrawals after approved KYC</li></ul>
					<p className="tier-disclosure"><MailCheck size={14}/> Tier status never bypasses KYC, account restrictions, provider configuration, or financial controls.</p>
				</section>
			</div>

			{data.canRequest&&<form className="tier-request-form" onSubmit={event=>void requestUpgrade(event)}><div><span>TIER 3 · ADMIN REVIEW</span><h2>Ready for Tier 3 review?</h2><p>Your KYC profile, identity documents, proof of address, and phone verification are submitted. An administrator reviews the identity packet and Tier 3 request; Tier 3 is activated only after approval.</p></div><label className="account-label">Optional note for the reviewer<textarea className="input min-h-20" maxLength={1000} value={message} onChange={event=>setMessage(event.target.value)} placeholder="Add context for your review."/></label><button className="btn bg-gold text-black" disabled={busy}>{busy?'Submitting…':'Request Tier 3 review'}</button></form>}

			{latest&&<section className="tier-panel tier-request-history"><div className="tier-panel-heading"><div><span>REVIEW HISTORY</span><h2>Latest Tier {latest.requestedTier} request · {latest.status.replaceAll('_',' ')}</h2></div><Clock3 size={18}/></div><p className="text-sm muted">Submitted {new Date(latest.createdAt).toLocaleString()}{latest.reviewedAt?` · Reviewed ${new Date(latest.reviewedAt).toLocaleString()}`:''}</p>{latest.adminReason&&<p className="mt-2 text-sm muted">Administrator note: {latest.adminReason}</p>}{latest.status==='NEEDS_INFORMATION'&&<form className="mt-3 grid gap-3" onSubmit={event=>void submitAdditionalInformation(event)}><label className="account-label">Additional information<textarea className="input min-h-20" required minLength={3} maxLength={1000} value={message} onChange={event=>setMessage(event.target.value)}/></label><button className="btn bg-gold text-black justify-self-start" disabled={busy||message.trim().length<3}>{busy?'Submitting…':'Send information for review'}</button></form>}{data.requests.length>1&&<div className="mt-3 grid gap-2">{data.requests.slice(1).map(request=><p className="text-xs muted" key={request.id}>Tier {request.requestedTier} · {request.status.replaceAll('_',' ')} · {new Date(request.createdAt).toLocaleDateString()}</p>)}</div>}</section>}
		</>}
	</main></>;
}
