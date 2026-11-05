'use client';

import {useEffect,useMemo,useState} from 'react';
import Link from 'next/link';
import {ArrowRight,Radio,WalletCards} from 'lucide-react';
import {formatUsd} from '@/lib/currency-format';
import {calculateInvestmentDisplay} from '@/lib/investment-display';

type InvestmentProgress={
	id:string;
	title:string;
	accountMode:'DEMO'|'REAL';
	amount:string;
	status:string;
	activatedAt:string|null;
	maturesAt:string|null;
	durationDays:number;
	displayTargetPayout:string|null;
	simulatedPayout?:string|null;
};

function remainingText(seconds:number){
	const days=Math.floor(seconds/86_400);
	const hours=Math.floor(seconds%86_400/3_600);
	const minutes=Math.floor(seconds%3_600/60);
	const remainingSeconds=seconds%60;
	if(days)return `${days}d ${hours}h remaining`;
	if(hours)return `${hours}h ${minutes}m remaining`;
	if(minutes)return `${minutes}m ${remainingSeconds}s remaining`;
	return `${remainingSeconds}s remaining`;
}

export function InvestmentProgressCard({investment,onMaturity}:{investment:InvestmentProgress;onMaturity?:()=>void}){
	const active=investment.status==='ACTIVE';
	const start=investment.activatedAt?new Date(investment.activatedAt).getTime():Number.NaN;
	const end=investment.maturesAt?new Date(investment.maturesAt).getTime():Number.NaN;
	const principal=Number(investment.amount);
	const targetPayout=Number(investment.displayTargetPayout);
	const [now,setNow]=useState(()=>Date.now());

	useEffect(()=>{
		if(!active||!Number.isFinite(end))return;
		const timer=window.setInterval(()=>{
			const current=Date.now();
			setNow(current);
			if(current>=end)window.clearInterval(timer);
		},1000);
		return()=>window.clearInterval(timer);
	},[active,end]);

	useEffect(()=>{
		if(!active||!onMaturity||!Number.isFinite(end)||now<end)return;
		onMaturity();
		const timer=window.setInterval(onMaturity,5000);
		return()=>window.clearInterval(timer);
	},[active,end,now,onMaturity]);

	const display=useMemo(()=>calculateInvestmentDisplay({principal,targetPayout,activatedAt:start,maturesAt:end,now}),[principal,targetPayout,start,end,now]);
	const earningsPerDay=investment.durationDays>0?(targetPayout-principal)/investment.durationDays:0;
	const targetEarnings=targetPayout-principal;
	const targetReturnPercent=principal>0?targetEarnings/principal*100:0;

	return <article className="investment-live-card">
		<header className="investment-live-heading">
			<div><span className="investment-live-kicker">{investment.accountMode} · {investment.accountMode==='REAL'?'LEDGER':'PRACTICE'}</span><h3>{investment.title}</h3></div>
			<span className="investment-live-badge"><Radio size={12}/>{display.matured?'Maturity reached':'Estimate in progress'}</span>
		</header>
		<div className="investment-live-metrics">
			<div><span>Principal</span><b>{formatUsd(investment.amount)}</b></div>
			<div><span>Estimated earnings so far</span><b>{formatUsd(display.earnings.toFixed(2))}</b></div>
			<div><span>Estimated daily return</span><b>{formatUsd(earningsPerDay.toFixed(2))}</b></div>
			<div><span>Target return at maturity</span><b>{formatUsd(targetEarnings.toFixed(2))} ({targetReturnPercent.toFixed(2)}%)</b></div>
			<div><span>Illustrative maturity payout</span><b>{formatUsd(investment.displayTargetPayout||investment.amount)}</b></div>
		</div>
		<div className="investment-live-progress" role="progressbar" aria-label={`${investment.title} maturity progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(display.progress*100)}>
			<span style={{width:`${display.progress*100}%`}}/>
		</div>
		<div className="investment-live-footer">
			<span>{display.matured?'Maturity reached · settlement processing':remainingText(display.secondsRemaining)}</span>
			<span>{(display.progress*100).toFixed(1)}% elapsed</span>
		</div>
		<p className="investment-live-disclosure">Illustrative, display-only estimate from the recorded investment terms. No earnings are credited until the server settles the investment.</p>
	</article>;
}

export function InvestmentCompletionCard({investment}:{investment:InvestmentProgress}){
	const settled=investment.status==='SETTLED';
	return <div className={`investment-completion-card ${settled?'is-settled':''}`}>
		<div><b>{settled?'Investment completed':'Investment period complete'}</b><p>{settled
			?`The server automatically credited the recorded payout of ${formatUsd(investment.simulatedPayout||investment.amount)} to your ${investment.accountMode} internal USD ledger. The displayed earnings were an estimate; this settled amount is available in your wallet. No claim or separate move is needed.`
			:'The investment period is complete and settlement is pending. No payout is available in your balance until settlement is recorded.'}</p></div>
		{settled&&<div className="investment-completion-actions">{investment.accountMode==='REAL'&&<Link href="/wallet?action=WITHDRAWAL"><WalletCards size={13}/>Request withdrawal</Link>}<Link href="/wallet"><WalletCards size={13}/>View wallet</Link><Link href="/investments">Browse investments <ArrowRight size={13}/></Link></div>}
	</div>;
}
