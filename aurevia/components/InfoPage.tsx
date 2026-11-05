import type {ReactNode} from 'react';
import Link from 'next/link';
import {ArrowLeft,ArrowRight} from 'lucide-react';
import Nav from '@/components/Nav';

type Section={title:string;content:ReactNode};

export default function InfoPage({eyebrow,title,lead,sections,updated='September 30, 2026',importantNote='DEMO activity is for practice. REAL order routing, when enabled, is limited to the Alpaca sandbox. Wallet funding and withdrawal requests remain Aurevia ledger records; external provider balances are not Aurevia wallet cash.'}:{eyebrow:string;title:string;lead:string;sections:Section[];updated?:string;importantNote?:string}){
  return <><Nav/><main className="info-page">
    <Link href="/" className="info-back"><ArrowLeft size={14}/> Back to Aurevia Exchange</Link>
    <header className="info-header"><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{lead}</p><span>Platform information · Updated {updated}</span></header>
    <div className="info-layout"><nav className="info-contents" aria-label="On this page"><span>ON THIS PAGE</span>{sections.map((section,index)=><a key={section.title} href={`#section-${index+1}`}>{section.title}</a>)}</nav><article className="info-article">{sections.map((section,index)=><section id={`section-${index+1}`} key={section.title}><h2>{section.title}</h2><div>{section.content}</div></section>)}{importantNote&&<div className="info-note"><strong>Important</strong><p>{importantNote}</p></div>}<Link href="/" className="info-home-link">Return to the platform <ArrowRight size={15}/></Link></article></div>
  </main></>;
}