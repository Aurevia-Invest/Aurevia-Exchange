'use client';

import {useEffect,useState} from 'react';
import type {CardDesignTier,SimulatedCardStatus} from '@prisma/client';
import Link from 'next/link';
import {useParams} from 'next/navigation';
import Nav from '@/components/Nav';
import AureviaCardVisual from '@/components/AureviaCardVisual';
import AureviaExchangeId from '@/components/AureviaExchangeId';

type CardDetails={
	designTier:CardDesignTier;
	aureviaExchangeId:string|null;
	cardholderName:string;
	maskedPan:string;
	expiryMonth:number;
	expiryYear:number;
	displayName:string;
	status:SimulatedCardStatus;
	referenceNumber:string;
	application:{reference:string;priceSnapshot:string;currencySnapshot:string}|null;
};

export default function CardDetailPage(){
	const {id}=useParams<{id:string}>();
	const [card,setCard]=useState<CardDetails|null>(null);
	const [error,setError]=useState('');

	useEffect(()=>{
		void fetch(`/api/cards/${id}`,{cache:'no-store'}).then(async r=>{
			const j=await r.json() as CardDetails&{error?:string};
			if(!r.ok)throw new Error(j.error||'Not found');
			setCard(j);
		}).catch(e=>setError(e instanceof Error?e.message:'Unable to load'));
	},[id]);

	return <>
		<Nav/>
		<main className="account-page mobile-card-page">
			<header className="account-heading"><div><span className="account-kicker">CARD</span><h1>Card details</h1></div><Link href="/cards" className="text-link">All cards</Link></header>
			{error&&<p className="text-loss text-sm">{error}</p>}
			{card&&(
				<section className="card p-5 max-w-xl mobile-card-item">
					<AureviaCardVisual designTier={card.designTier} cardholderName={card.cardholderName} maskedPan={card.maskedPan} expiryMonth={card.expiryMonth} expiryYear={card.expiryYear} displayName={card.displayName}/>
					<AureviaExchangeId id={card.aureviaExchangeId} className="mt-4"/>
					<dl className="mt-4 grid gap-2 text-sm">
						<div className="flex justify-between"><dt className="muted">Status</dt><dd>{card.status.replaceAll('_',' ')}</dd></div>
						<div className="flex justify-between"><dt className="muted">Reference</dt><dd className="font-mono">{card.referenceNumber}</dd></div>
						<div className="flex justify-between"><dt className="muted">Application</dt><dd className="font-mono">{card.application?.reference}</dd></div>
						<div className="flex justify-between"><dt className="muted">Order price (snapshot)</dt><dd>{card.application?.priceSnapshot} {card.application?.currencySnapshot}</dd></div>
					</dl>
					<p className="card-disclosure">Virtual account card for use within Aurevia Exchange. Terms were accepted at application.</p>
				</section>
			)}
		</main>
	</>;
}
