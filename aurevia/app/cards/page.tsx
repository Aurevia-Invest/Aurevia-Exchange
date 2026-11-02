'use client';

import {useCallback,useEffect,useState} from 'react';
import Link from 'next/link';
import {CreditCard,Plus} from 'lucide-react';
import Nav from '@/components/Nav';
import AureviaCardVisual from '@/components/AureviaCardVisual';
import AureviaExchangeId from '@/components/AureviaExchangeId';

type Card={id:string;displayName:string;cardholderName:string;designTier:'SIGNATURE'|'GOLD'|'BLACK';referenceNumber:string;maskedPan:string;expiryMonth:number;expiryYear:number;status:string};
type AppRow={id:string;reference:string;status:string;designTier:string;priceSnapshot:string;currencySnapshot:string;catalogItem:{displayName:string}};

export default function CardsPage(){
	const [cards,setCards]=useState<Card[]>([]);
	const [applications,setApplications]=useState<AppRow[]>([]);
	const [aureviaExchangeId,setAureviaExchangeId]=useState<string|null>(null);
	const [error,setError]=useState('');
	const [loading,setLoading]=useState(true);

	const load=useCallback(async()=>{
		setLoading(true);
		try{
			const response=await fetch('/api/cards/mine',{cache:'no-store'});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to load cards.');
			setCards(result.cards||[]);setApplications(result.applications||[]);setAureviaExchangeId(result.aureviaExchangeId||null);setError('');
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to load cards.')}
		finally{setLoading(false)}
	},[]);

	useEffect(()=>{void load()},[load]);

	return <>
		<Nav/>
		<main className="account-page mobile-card-page">
		<header className="account-heading">
			<div><span className="account-kicker">AUREVIA · CARD CENTER</span><h1>Virtual Card</h1><p>Your Aurevia card designs and applications.</p></div>
			<Link href="/cards/apply" className="btn mobile-card-customize"><Plus size={14}/> Explore designs</Link>
		</header>
		{loading&&<p className="muted">Loading…</p>}
		{error&&<p className="text-loss text-sm" role="alert">{error}</p>}
		{!loading&&cards.length===0&&applications.length===0&&(
			<section className="card mobile-card-empty"><span className="mobile-card-empty-icon"><CreditCard size={22}/></span><h2>Your card space</h2><p>No cards are linked to your account yet. Explore available designs to review the current card options.</p><Link href="/cards/apply" className="btn mobile-card-apply"><Plus size={15}/> Explore available cards</Link></section>
		)}
		<div className="mobile-card-list">
			{cards.map(card=>(
				<section key={card.id} className="card mobile-card-item">
					<div className="mobile-card-view-heading"><span>YOUR AUREVIA CARD</span><span className="status-pill">{card.status.replaceAll('_',' ')}</span></div>
					<AureviaCardVisual designTier={card.designTier} cardholderName={card.cardholderName} maskedPan={card.maskedPan} expiryMonth={card.expiryMonth} expiryYear={card.expiryYear} displayName={card.displayName}/>
					<AureviaExchangeId id={aureviaExchangeId} className="mt-4"/>
					<div className="mobile-card-item-footer">
						<div><b>{card.displayName}</b><small>Reference · {card.referenceNumber}</small></div>
						<Link className="mobile-card-details" href={`/cards/${card.id}`}>Card details <Plus size={14}/></Link>
					</div>
					<p className="card-disclosure">Aurevia in-platform card feature. Review the card details and terms before use.</p>
				</section>
			))}
		</div>
		{applications.length>0&&(
			<section className="card mobile-card-applications">
					<h2 className="font-semibold flex items-center gap-2"><CreditCard size={16}/> Applications</h2>
					<ul className="mt-3 divide-y divide-white/10">{applications.map(app=>(
						<li key={app.id} className="py-3 text-sm flex flex-wrap justify-between gap-2">
							<span>{app.catalogItem.displayName} · {app.reference}</span>
							<span className="muted">{app.status.replaceAll('_',' ')} · {app.priceSnapshot} {app.currencySnapshot}</span>
						</li>
					))}</ul>
				</section>
			)}
		</main>
	</>;
}
