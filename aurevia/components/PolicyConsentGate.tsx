'use client';

import {useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import {usePathname} from 'next/navigation';
import {createPolicyConsent,POLICY_CONSENT_KEY,readPolicyConsent,type PolicyConsentChoice} from '@/lib/policy-consent';

type ChoiceView='prompt'|'rejected'|'deferred'|'storage-error'|'accepted'|'pending';
const policyPaths=new Set(['/terms','/privacy','/risk-disclosure','/about-me']);

export default function PolicyConsentGate(){
	const pathname=usePathname();
	const dialogRef=useRef<HTMLDialogElement>(null);
	const [view,setView]=useState<ChoiceView>('pending');
	const [storageError,setStorageError]=useState('');
	const isPolicyPage=policyPaths.has(pathname);
	const visible=!isPolicyPage&&view!=='accepted'&&view!=='pending';

	useEffect(()=>{
		try{
			const record=readPolicyConsent(window.localStorage.getItem(POLICY_CONSENT_KEY));
			setView(record?.choice==='accepted'?'accepted':record?.choice==='rejected'?'rejected':'prompt');
		}catch{
			setStorageError('Your browser did not allow this device to save your choice. Enable local storage and reload to continue.');
			setView('storage-error');
		}
		const syncChoice=(event:StorageEvent)=>{
			if(event.key!==POLICY_CONSENT_KEY)return;
			const record=readPolicyConsent(event.newValue);
			setView(record?.choice==='accepted'?'accepted':record?.choice==='rejected'?'rejected':'prompt');
		};
		window.addEventListener('storage',syncChoice);
		return()=>window.removeEventListener('storage',syncChoice);
	},[]);

	useEffect(()=>{
		const dialog=dialogRef.current;
		if(!dialog)return;
		if(visible&&!dialog.open)dialog.showModal();
		if(!visible&&dialog.open)dialog.close();
	},[visible]);

	function saveChoice(choice:PolicyConsentChoice){
		try{
			window.localStorage.setItem(POLICY_CONSENT_KEY,JSON.stringify(createPolicyConsent(choice)));
			setStorageError('');
			setView(choice);
		}catch{
			setStorageError('Your browser could not save this choice. Enable local storage and try again; access remains paused until your choice can be saved.');
			setView('storage-error');
		}
	}

	function deferChoice(){
		setView('deferred');
	}

	function returnToPrompt(){
		setView('prompt');
	}

	const acceptedChoice=()=>saveChoice('accepted');

	return <dialog
		ref={dialogRef}
		className="policy-consent-dialog"
		aria-labelledby="policy-consent-title"
		aria-describedby="policy-consent-description"
		onCancel={event=>{event.preventDefault();deferChoice()}}
	>
		<div className="policy-consent-content">
			<p className="policy-consent-eyebrow">FIRST VISIT · PLATFORM POLICIES</p>
			<h2 id="policy-consent-title">{view==='prompt'?'Review before continuing':view==='rejected'?'Access paused':view==='storage-error'?'Choice could not be saved':'Choice deferred'}</h2>
			{view==='prompt'?<>
				<p id="policy-consent-description">Please review the platform terms and policies before continuing. Accepting records your choice in this browser on this device. You can reopen policy details at any time from About me.</p>
				<ul className="policy-consent-links">
					<li><Link href="/terms">Terms of use</Link> — account, platform and ledger terms</li>
					<li><Link href="/privacy">Privacy overview</Link> — information handling and storage</li>
					<li><Link href="/risk-disclosure">Risk disclosure</Link> — trading and account limitations</li>
					<li><Link href="/about-me">Withdrawal policy and theme preferences</Link></li>
				</ul>
				<p className="policy-consent-summary">Important: DEMO is for practice. When enabled, eligible REAL orders route to the Alpaca sandbox environment. REAL withdrawals require an administrator-approved request and a minimum balance remaining after reservations. A 10% commission is deducted internally only after administrator-confirmed payout. No separate advance crypto payment is required.</p>
				<div className="policy-consent-actions">
					<button type="button" className="btn bg-gold text-black" onClick={acceptedChoice}>Accept terms &amp; policies</button>
					<button type="button" className="btn bg-white/5" onClick={()=>saveChoice('rejected')}>Reject</button>
					<button type="button" className="policy-consent-cancel" onClick={deferChoice}>Cancel</button>
				</div>
			</>:view==='rejected'?<>
				<p id="policy-consent-description">You rejected the platform terms. Access is paused; this choice is not recorded as acceptance. Review the policies and choose again if you want to continue.</p>
				<PolicyLinks/>
				<div className="policy-consent-actions"><button type="button" className="btn bg-gold text-black" onClick={acceptedChoice}>Accept terms &amp; continue</button><button type="button" className="btn bg-white/5" onClick={returnToPrompt}>Review my choice</button></div>
			</>:view==='storage-error'?<>
				<p id="policy-consent-description" role="alert">{storageError}</p>
				<PolicyLinks/>
				<button type="button" className="btn bg-white/5" onClick={()=>window.location.reload()}>Reload after enabling storage</button>
			</>:<>
				<p id="policy-consent-description">You cancelled without making a choice. Access remains paused until you accept. You can read the policies without accepting, or return to the choice.</p>
				<PolicyLinks/>
				<div className="policy-consent-actions"><button type="button" className="btn bg-gold text-black" onClick={acceptedChoice}>Accept terms &amp; continue</button><button type="button" className="btn bg-white/5" onClick={returnToPrompt}>Return to choices</button></div>
			</>}
		</div>
	</dialog>;
}

function PolicyLinks(){
	return <ul className="policy-consent-links">
		<li><Link href="/terms">Read Terms of use</Link></li>
		<li><Link href="/privacy">Read Privacy overview</Link></li>
		<li><Link href="/risk-disclosure">Read Risk disclosure</Link></li>
		<li><Link href="/about-me">Read withdrawal policy</Link></li>
	</ul>;
}
