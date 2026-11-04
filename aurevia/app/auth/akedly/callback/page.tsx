'use client';

import {useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import Nav from '@/components/Nav';

type CallbackState='checking'|'verified-phone'|'failed'|'invalid'|'unavailable';

export default function AkedlyCallbackPage(){
	const [state,setState]=useState<CallbackState>('checking');
	const started=useRef(false);

	useEffect(()=>{
		if(started.current)return;
		started.current=true;
		const params=new URLSearchParams(window.location.search);
		const attemptId=params.get('attemptId');
		const status=params.get('status');
		if(!attemptId||!['success','failed'].includes(status||'')){
			setState('invalid');
			return;
		}
		void fetch('/api/auth/akedly/callback',{
			method:'POST',
			headers:{'content-type':'application/json'},
			body:JSON.stringify({attemptId,status}),
		}).then(async response=>{
			if(!response.ok)throw new Error('CALLBACK_UNAVAILABLE');
			const result=await response.json();
			if(!result.verified){
				setState('failed');
				return;
			}
			setState('verified-phone');
		}).catch(()=>setState('unavailable'));
	},[]);

	const title=state==='checking'?'Confirming your verification':state==='verified-phone'?'Phone verified':state==='failed'?'Verification not confirmed':state==='invalid'?'Invalid verification callback':'Verification temporarily unavailable';
	const description=state==='checking'
		?'Aurevia is checking the result directly with Akedly. The redirect alone cannot verify your account.'
		:state==='verified-phone'
				?'Your phone verification is confirmed. Return to your KYC page.'
				:state==='failed'
					?'Akedly has not confirmed a successful verification for this attempt.'
					:state==='invalid'
						?'This callback is missing valid verification information.'
						:'Aurevia could not confirm this result. Return to the verification page and try checking again.';

	return <><Nav/><main className="auth-scene"><section className="auth-card auth-register-card" aria-labelledby="akedly-callback-title">
		<div className="gold text-sm font-semibold">Aurevia secure verification</div>
		<h1 id="akedly-callback-title" className="auth-heading mt-3">{title}</h1>
		<p className="mt-3 text-sm leading-6 muted" role="status">{description}</p>
		{state==='verified-phone'&&<Link className="auth-submit mt-5 block w-full text-center" href="/kyc">Return to phone verification</Link>}
		{['failed','invalid','unavailable'].includes(state)&&<Link className="auth-submit mt-5 block w-full text-center" href="/kyc">Return to KYC</Link>}
	</section></main></>;
}
