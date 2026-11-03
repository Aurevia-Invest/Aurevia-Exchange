'use client';

import {FormEvent,useCallback,useEffect,useMemo,useRef,useState} from 'react';
import type {CSSProperties} from 'react';
import {Area,AreaChart,CartesianGrid,Cell,Pie,PieChart,ResponsiveContainer,Tooltip,XAxis,YAxis} from 'recharts';
import {ArrowDownLeft,ArrowUpRight,Bitcoin,Briefcase,BriefcaseBusiness,Building2,CircleDollarSign,Coins,FileClock,Gem,RefreshCw,TrendingUp} from 'lucide-react';
import Link from 'next/link';
import {useSession} from 'next-auth/react';
import Nav from '@/components/Nav';
import AureviaLoading from '@/components/AureviaLoading';
import DisplayCurrencyPanel from '@/components/DisplayCurrencyPanel';
import PortfolioAssistant from '@/components/PortfolioAssistant';
import TradingJournalAssistant from '@/components/TradingJournalAssistant';
import {useLocale} from '@/lib/i18n-context';
import {formatUsd} from '@/lib/currency-format';
import {filterPerformanceSnapshots,type PortfolioTimeframe} from '@/lib/portfolio-timeframes';

type Position={id:string;side:string;quantity:string;entryPrice:string;currentPrice:string|null;marketValue:string|null;unrealizedPnl:string|null;valuationStatus:'CURRENT'|'STALE'|'UNAVAILABLE';valuationAsOf:string|null;valuationSource:string|null;openedAt:string;instrument:{symbol:string;name:string;price:string}};
type PaperPosition={id:string;symbol:string;name:string;side:string;quantity:string;averageEntryPrice:string;realizedPnl:string;currentPrice:string|null;marketValue:string|null;unrealizedPnl:string|null;openedAt:string;valuationStatus:'CURRENT'|'STALE'|'UNAVAILABLE';valuationAsOf:string|null;valuationSource:string|null};
type Snapshot={snapshotBucket:string;totalValue:string};
type Holding={id:string;name:string;category:string;invested:string;value:string|null;gainLoss:string|null;status:string;valuationSource?:string|null};
type Allocation={category:string;value:string;percentage:string};
type Investment={id:string;status:string;amount:string;tierBoostPercent:string;targetReturnPercent:string|null;simulatedPayout:string|null;requestedAt:string;settlementReference:string|null;opportunity:{title:string;category:string;assetSymbol:string|null;riskLevel:string;durationDays:number}};
type FundingActivity={id:string;type:string;method:string;amount:string;currency:string;status:string;createdAt:string};
type AvailableOpportunity={id:string;title:string;category:string;assetSymbol:string|null;minimumAmount:string;targetReturnPercent:string|null;durationDays:number;riskLevel:string};
type Portfolio={accountMode:'DEMO'|'REAL';cashBalance:string;availableCashBalance:string;positionValue:string|null;positionValuationStatus:'CURRENT'|'PARTIAL'|'STALE'|'UNAVAILABLE'|'NOT_APPLICABLE';investmentValue:string;totalValue:string|null;totalInvested:string;totalCurrentValue:string|null;realizedPnl:string|null;unrealizedPnl:string|null;totalPnl:string|null;returnPercent:string|null;dailyPnl:string|null;dailyPercent:string|null;positions:Position[];paperPositions:PaperPosition[];paperPositionValue:string|null;paperUnrealizedPnl:string|null;paperValuation:{status:'CURRENT'|'PARTIAL'|'STALE'|'UNAVAILABLE'|'NOT_APPLICABLE';valuedCount:number;openCount:number};paperReservedBalance:string;paperAvailableBalance:string;investments:Investment[];holdings:Holding[];allocations:Allocation[];recentFunding:FundingActivity[];availableOpportunities:AvailableOpportunity[];topGainers:Position[];topLosers:Position[];performance:Snapshot[];marketDataMode:string;externalValuationAvailable:boolean};
type ChartPoint=Snapshot&{periodChange:number};
type ChartTooltipProps={active?:boolean;payload?:Array<{payload:ChartPoint}>;label?:string};

const timeframes:Array<{value:PortfolioTimeframe;label:string}>=[
	{value:'1D',label:'1D'},
	{value:'1W',label:'1W'},
	{value:'1M',label:'1M'},
	{value:'6M',label:'6M'},
	{value:'1Y',label:'1Y'},
	{value:'ALL',label:'All'},
];
const categoryColors=['#c9a45f','#829bb1','#79a990','#b4a178','#9eabb8','#d2ba82'];

function money(value:string|number|null|undefined){return value===null||value===undefined?'—':formatUsd(value);}
function fundingAmount(value:string,currency:string){
	return currency==='USD'?money(value):`${new Intl.NumberFormat('en-US',{maximumFractionDigits:8}).format(Number(value))} ${currency}`;
}
function signed(value:string|number|null|undefined){if(value===null||value===undefined)return 'Unavailable';const number=Number(value);return `${number>=0?'+':''}${money(number)}`;}
function percentage(value:string|number|null|undefined){if(value===null||value===undefined)return 'Unavailable';const number=Number(value);return `${number>=0?'+':''}${number.toFixed(2)}%`;}
function categoryColor(category:string,index:number){
	const normalized=category.toLowerCase();
	if(normalized.includes('crypto'))return '#c9a45f';
	if(normalized.includes('equity')||normalized.includes('share'))return '#829bb1';
	if(normalized.includes('gold'))return '#d2ba82';
	if(normalized.includes('silver'))return '#9eabb8';
	if(normalized.includes('cash'))return '#79a990';
	return categoryColors[index%categoryColors.length];
}
function AssetIcon({category,name}:{category:string;name:string}){
	const normalized=`${category} ${name}`.toLowerCase();
	const Icon=normalized.includes('crypto')||normalized.includes('bitcoin')?Bitcoin:normalized.includes('gold')||normalized.includes('silver')?Gem:normalized.includes('equity')||normalized.includes('share')||normalized.includes('stock')?Building2:normalized.includes('cash')?CircleDollarSign:normalized.includes('metal')?Coins:BriefcaseBusiness;
	return <span className="portfolio-asset-icon" style={{'--asset-color':categoryColor(category,0)} as CSSProperties} aria-hidden="true"><Icon size={17} strokeWidth={2.1}/></span>;
}
function ChartTooltip({active,payload,label}:ChartTooltipProps){
	if(!active||!payload?.length)return null;
	const point=payload[0].payload;
	return <div className="portfolio-tooltip"><span>{label?new Date(label).toLocaleString():''}</span><b>{money(point.totalValue)}</b><small>Change in selected period <strong className={point.periodChange>=0?'text-profit':'text-loss'}>{signed(point.periodChange)}</strong></small></div>;
}

export default function PortfolioExperience(){
	const {data:session,status:sessionStatus}=useSession();
	const accountMode=session?.user?.accountMode;
	const {translate}=useLocale();
	const [data,setData]=useState<Portfolio|null>(null);
	const [loading,setLoading]=useState(true);
	const [error,setError]=useState('');
	const [notice,setNotice]=useState('');
	const [timeframe,setTimeframe]=useState<PortfolioTimeframe>('ALL');
	const [holdingSearch,setHoldingSearch]=useState('');
	const [holdingCategory,setHoldingCategory]=useState('ALL');
	const [resetOpen,setResetOpen]=useState(false);
	const [resetConfirmation,setResetConfirmation]=useState('');
	const [resetBusy,setResetBusy]=useState(false);
	const latestRequest=useRef(0);
	const load=useCallback(async(showLoading=false)=>{
		const requestId=++latestRequest.current;
		if(showLoading)setLoading(true);
		try{
			const response=await fetch('/api/portfolio',{cache:'no-store'});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to load portfolio.');
			if(requestId!==latestRequest.current)return;
			setData(result);setError('');
		}catch(exception){if(requestId===latestRequest.current)setError(exception instanceof Error?exception.message:'Unable to load portfolio.');}
		finally{if(requestId===latestRequest.current&&showLoading)setLoading(false);}
	},[]);
	useEffect(()=>{
		if(sessionStatus!=='authenticated'||!accountMode)return;
		setData(null);
		void load(true);
	},[accountMode,sessionStatus,load]);

	const performance=useMemo(()=>{
		const snapshots=filterPerformanceSnapshots(data?.performance||[],timeframe);
		const baseline=snapshots.length?Number(snapshots[0].totalValue):0;
		return snapshots.map(snapshot=>({...snapshot,periodChange:Number(snapshot.totalValue)-baseline}));
	},[data?.performance,timeframe]);
	const holdingCategories=useMemo(()=>[...new Set((data?.holdings||[]).map(holding=>holding.category))].sort(),[data?.holdings]);
	const visibleHoldings=useMemo(()=>{
		const query=holdingSearch.trim().toLowerCase();
		return (data?.holdings||[]).filter(holding=>
			(holdingCategory==='ALL'||holding.category===holdingCategory)&&
			(!query||`${holding.name} ${holding.category} ${holding.status}`.toLowerCase().includes(query)),
		);
	},[data?.holdings,holdingCategory,holdingSearch]);
	const positive=data?.totalPnl!==null&&data?.totalPnl!==undefined&&Number(data.totalPnl)>=0;

	async function resetDemo(event:FormEvent<HTMLFormElement>){
		event.preventDefault();if(resetBusy||resetConfirmation!=='RESET DEMO ACCOUNT')return;
		setResetBusy(true);setError('');setNotice('');
		try{
			const response=await fetch('/api/account/demo-reset',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({confirmation:resetConfirmation})});
			const result=await response.json();if(!response.ok)throw new Error(result.error||'Unable to reset DEMO account.');
			setNotice(`DEMO portfolio reset to ${money(result.balance)}. Historical ledger and audit entries were retained.`);setResetConfirmation('');setResetOpen(false);await load();
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to reset DEMO account.');}
		finally{setResetBusy(false);}
	}

	return <><Nav/><main className="account-page portfolio-page">
		<header className="account-heading portfolio-heading">
			<div><span className="account-kicker">{translate('accountOverview')}</span><h1>My Portfolio</h1><p>Account-specific balances, positions, investments and recorded performance.</p></div>
			<div className="portfolio-heading-actions">
				<span className={`status-pill ${data?.accountMode==='REAL'?'mode-real':'mode-demo'}`}>{data?translate('portfolioAccount',{mode:data.accountMode}):translate('portfolioLoadingAccount')}</span>
				{data&&<span className="portfolio-mark-status" role="status" aria-label={data.accountMode==='DEMO'?'Market data source: DEMO prices':'Market data source: provider marks'}><i aria-hidden="true"/>{data.accountMode==='DEMO'?'DEMO':'PROVIDER'} {data.accountMode==='DEMO'?'PRICES':'MARKS'}</span>}
				<button className="icon-action" type="button" aria-label={translate('portfolioRefresh')} onClick={()=>void load(true)}><RefreshCw size={15}/></button>
			</div>
		</header>
		{data?.accountMode==='REAL'&&<div className="account-callout mb-4"><span>REAL wallet balances are Aurevia’s internal ledger. Alpaca Paper holdings are valued separately using fresh external provider quotes and are not wallet cash or withdrawable. BTC credits require manual verification; investment return targets are estimates, not settled funds.</span></div>}
		{notice&&<p className="mb-3 text-sm text-profit" role="status">{notice}</p>}
		{error&&<div className="account-callout mb-4" role="alert"><span>{error}</span><button type="button" className="text-link" onClick={()=>void load(true)}>{translate('portfolioRetry')}</button></div>}
		{loading&&!data?<AureviaLoading variant="inline" label={translate('portfolioLoading')} className="account-empty"/>:data&&<>
			<section className="portfolio-hero">
				<div className="portfolio-value">
					<span>Aurevia account value</span>
					<strong>{money(data.totalValue)}</strong>
					<p className={data.totalPnl===null?'portfolio-neutral-value':positive?'text-profit':'text-loss'}>{data.totalPnl===null?'No recorded gain or loss yet':`${signed(data.totalPnl)} recorded gain/loss · ${percentage(data.returnPercent)}`}</p>
				</div>
				<article className="portfolio-today">
					<span>Account change since first snapshot today</span>
					<b className={data.dailyPnl===null?'portfolio-neutral-value':Number(data.dailyPnl)>=0?'text-profit':'text-loss'}>{signed(data.dailyPnl)}</b>
					<small>{percentage(data.dailyPercent)}</small>
					<small>Based on saved snapshots; Alpaca Paper marks are separate.</small>
				</article>
			</section>
			<nav className="portfolio-actions" aria-label="Portfolio actions">
				{data.accountMode==='REAL'&&<Link className="btn bg-gold text-black" href="/wallet?type=DEPOSIT"><ArrowDownLeft size={15}/>Deposit</Link>}
				{data.accountMode==='REAL'&&<Link className="btn bg-white/5" href="/investments"><Briefcase size={15}/>Explore investments</Link>}
				{data.accountMode==='REAL'&&<Link className="btn bg-white/5" href="/wallet/transactions"><FileClock size={15}/>Transaction history</Link>}
				{data.accountMode==='DEMO'&&<Link className="btn bg-gold text-black" href="/trade"><TrendingUp size={15}/>Practice trading</Link>}
				{data.accountMode==='REAL'&&<Link className="btn bg-white/5" href="/wallet?type=WITHDRAWAL"><ArrowUpRight size={15}/>Request withdrawal</Link>}
			</nav>
			{data.accountMode==='DEMO'&&<div className="account-callout mt-4" role="status">This is a virtual practice account. Its balance and trading records are separate from REAL account records.</div>}
			<section className="portfolio-summary">
				<div className="portfolio-total"><span>Aurevia account value</span><strong>{money(data.totalValue)}</strong><small>{data.accountMode==='DEMO'?'Virtual cash and open DEMO positions':'REAL ledger cash, provider-marked open positions and recorded investment principal; Paper holdings are separate'}</small></div>
				<div className="portfolio-metric"><span>Available internal cash</span><b>{money(data.availableCashBalance)}</b><small>After pending withdrawals and Paper reserves</small></div>
				<div className="portfolio-metric"><span>Open position value</span><b>{money(data.positionValue)}</b></div>
				{data.accountMode==='REAL'&&<div className="portfolio-metric"><span>Allocated investment principal</span><b>{money(data.investmentValue)}</b></div>}
			</section>
			<PortfolioAssistant/>
			<TradingJournalAssistant/>
			{data.accountMode==='REAL'&&data.positionValuationStatus!=='CURRENT'&&data.positionValuationStatus!=='NOT_APPLICABLE'&&<div className="account-callout mt-4" role="status">Fresh provider marks are unavailable for some open positions. Unverified positions are excluded from REAL account value and P/L; no internal DEMO prices are used as REAL marks.</div>}
			{data.accountMode==='REAL'&&<section className="account-panel card mt-4 p-5">
				<div className="account-panel-title"><div><h2>Alpaca Paper holdings</h2><p className="account-panel-subtitle">Your confirmed fills only · shown separately from the Aurevia wallet</p></div><span className="status-pill mode-real">{data.paperPositions.length} open</span></div>
				<div className="portfolio-paper-summary">
					<article><span>Net marked position value</span><b>{money(data.paperPositionValue)}</b></article>
					<article><span>Unrealized Paper P/L</span><b className={data.paperUnrealizedPnl===null?'':Number(data.paperUnrealizedPnl)>=0?'text-profit':'text-loss'}>{signed(data.paperUnrealizedPnl)}</b></article>
					<article><span>Paper-order reserves</span><b>{money(data.paperReservedBalance)}</b></article>
					<article><span>Available buying power</span><b>{money(data.paperAvailableBalance)}</b></article>
				</div>
				{data.paperPositions.length?<div className="portfolio-paper-list" aria-label="Alpaca Paper open holdings">{data.paperPositions.map(position=><article key={position.id} className="portfolio-paper-position">
					<div><strong>{position.symbol}</strong><small>{position.name} · {position.side} · {Number(position.quantity).toLocaleString()} units</small></div>
					<div><span>Average fill</span><b>{money(position.averageEntryPrice)}</b></div>
					<div><span>Current Paper mark</span><b>{position.valuationStatus==='CURRENT'?money(position.currentPrice):'—'}</b></div>
					<div><span>Marked position value</span><b>{position.valuationStatus==='CURRENT'?money(position.marketValue):'—'}</b></div>
					<div><span>Unrealized P/L</span><b className={position.unrealizedPnl===null?'':Number(position.unrealizedPnl)>=0?'text-profit':'text-loss'}>{signed(position.unrealizedPnl)}</b></div>
					<div className={`portfolio-paper-quote portfolio-paper-quote--${position.valuationStatus.toLowerCase()}`}>{position.valuationStatus==='CURRENT'&&position.valuationAsOf?`${position.valuationSource||'Provider'} mark · ${new Date(position.valuationAsOf).toLocaleString()}`:position.valuationStatus==='STALE'&&position.valuationAsOf?`Last provider quote is stale · ${new Date(position.valuationAsOf).toLocaleString()}`:'No recent provider quote available'}</div>
				</article>)}</div>:<p className="account-empty mt-3">Confirmed Alpaca Paper fills will appear here. Provider-wide positions are not copied into your account.</p>}
				<p className="portfolio-paper-disclosure" role="status">{data.paperValuation.valuedCount} of {data.paperValuation.openCount} open positions have a current provider mark. Paper holdings use fresh Alpaca or Finnhub quotes where supported; they remain separate from Aurevia balances and cannot be withdrawn. Stale or unavailable marks are left unvalued.</p>
			</section>}
			<DisplayCurrencyPanel values={[
				{label:'Recorded total value',amount:data.totalValue},
				{label:'Available internal cash',amount:data.availableCashBalance},
				{label:'Open position value',amount:data.positionValue},
				...(data.accountMode==='REAL'?[{label:'Allocated investment principal',amount:data.investmentValue}]:[]),
				...(data.accountMode==='REAL'&&data.paperPositions.length?[
					{label:'Separate Paper estimated mark value',amount:data.paperPositionValue},
					{label:'Separate Paper unrealized P/L',amount:data.paperUnrealizedPnl},
				]:[]),
			]}/>
			{data.accountMode==='DEMO'&&<section className="demo-reset-control"><div><b>{translate('portfolioResetTitle')}</b><p>{translate('resetPortfolioDescription')}</p></div>{!resetOpen?<button type="button" className="button-secondary" onClick={()=>setResetOpen(true)}>{translate('resetDemo')}</button>:<form onSubmit={event=>void resetDemo(event)}><label className="account-label">{translate('typeResetConfirmation')}<input className="input" autoComplete="off" value={resetConfirmation} onChange={event=>setResetConfirmation(event.target.value)}/></label><div className="flex flex-wrap gap-2"><button className="btn bg-loss" disabled={resetBusy||resetConfirmation!=='RESET DEMO ACCOUNT'}>{resetBusy?translate('portfolioResetting'):translate('portfolioConfirmReset')}</button><button className="btn bg-white/5" type="button" onClick={()=>{setResetOpen(false);setResetConfirmation('');}}>{translate('cancel')}</button></div></form>}</section>}
			<div className="portfolio-content-grid portfolio-premium-grid">
				<section className="account-panel card p-5">
					<div className="account-panel-title"><div><h2>Portfolio performance</h2><p className="account-panel-subtitle">Saved account snapshots · no backfilled or estimated history</p></div><span className="muted text-xs">{data.marketDataMode} marks</span></div>
					<div className="orders-filters portfolio-timeframes" role="group" aria-label="Performance timeframe">
						{timeframes.map(item=><button type="button" key={item.value} className={timeframe===item.value?'is-active':''} aria-pressed={timeframe===item.value} onClick={()=>setTimeframe(item.value)}>{item.label}</button>)}
					</div>
					{performance.length>1?<div className="portfolio-chart"><ResponsiveContainer width="100%" height="100%"><AreaChart data={performance} margin={{left:4,right:12,top:8,bottom:2}}>
						<defs><linearGradient id="portfolioValueFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#d4a72c" stopOpacity={0.24}/><stop offset="100%" stopColor="#d4a72c" stopOpacity={0}/></linearGradient></defs>
						<CartesianGrid stroke="rgba(218,225,216,.08)" vertical={false}/>
						<XAxis dataKey="snapshotBucket" tickFormatter={value=>new Date(value).toLocaleDateString(undefined,{month:'short',day:'numeric'})} tick={{fill:'#92a096',fontSize:10}} axisLine={false} tickLine={false} minTickGap={24}/>
						<YAxis width={78} tickFormatter={value=>formatUsd(Number(value))} tick={{fill:'#92a096',fontSize:10}} axisLine={false} tickLine={false}/>
						<Tooltip content={<ChartTooltip/>} cursor={{stroke:'rgba(0,230,118,.35)',strokeDasharray:'4 4'}}/>
						<Area type="monotone" dataKey="totalValue" stroke="#d4a72c" strokeWidth={2.5} fill="url(#portfolioValueFill)" activeDot={{r:4,fill:'#e8cc78',stroke:'#07110e',strokeWidth:2}}/>
					</AreaChart></ResponsiveContainer></div>:<p className="account-empty">{performance.length?'More than one recorded snapshot is needed to show a performance line.':'Recorded performance will appear after snapshots have been captured.'}</p>}
					{performance.length>1&&<p className="portfolio-period-note">Showing {new Date(performance[0].snapshotBucket).toLocaleDateString()} – {new Date(performance[performance.length-1].snapshotBucket).toLocaleDateString()} from saved account snapshots.</p>}
				</section>
				<section className="account-panel card p-5">
					<div className="account-panel-title"><div><h2>Asset allocation</h2><p className="account-panel-subtitle">{data.accountMode==='DEMO'?'Based on available virtual cash and DEMO positions':'Based on current recorded holdings and active investments'}</p></div></div>
					{data.allocations.length?<div className="portfolio-donut-layout">
						<div className="portfolio-donut"><ResponsiveContainer width="100%" height="100%"><PieChart><Tooltip formatter={(value)=>money(String(value))}/><Pie data={data.allocations} dataKey="value" nameKey="category" innerRadius="62%" outerRadius="88%" paddingAngle={2} stroke="none">{data.allocations.map((item,index)=><Cell key={item.category} fill={categoryColor(item.category,index)}/>)}</Pie></PieChart></ResponsiveContainer></div>
						<ul className="portfolio-legend">{data.allocations.map((item,index)=><li key={item.category}><i style={{background:categoryColor(item.category,index)}}/><span>{item.category}</span><b>{Number(item.percentage).toFixed(1)}%</b></li>)}</ul>
					</div>:<p className="account-empty">No recorded investment holdings yet. Available wallet cash is shown separately and is not counted as an asset allocation.</p>}
				</section>
			</div>
			<section className="account-panel card p-5 mt-4">
				<div className="account-panel-title"><div><h2>Holdings</h2><p className="account-panel-subtitle">{data.accountMode==='DEMO'?'DEMO values use the internal practice feed.':'REAL open positions use fresh provider marks; unavailable marks are excluded.'}</p></div><span className="muted text-sm">{data.holdings.length} records</span></div>
				{data.holdings.length===0?<p className="account-empty">No holdings are recorded for this account yet.</p>:<>
					<div className="investment-opportunity-filters">
						<label className="account-label">Search holdings<input className="input" type="search" value={holdingSearch} onChange={event=>setHoldingSearch(event.target.value)} placeholder="Name, category or status"/></label>
						<label className="account-label">Category<select className="input" value={holdingCategory} onChange={event=>setHoldingCategory(event.target.value)}><option value="ALL">All categories</option>{holdingCategories.map(category=><option key={category}>{category}</option>)}</select></label>
					</div>
					{visibleHoldings.length===0?<p className="account-empty">No holdings match these filters.</p>:<>
						<div className="portfolio-holdings-head" aria-hidden="true"><span>Asset</span><span>% of portfolio</span><span>Cost basis</span><span>Current value</span><span>Unrealized P/L</span></div>
						<div className="portfolio-holdings">{visibleHoldings.map(holding=><details className="portfolio-holding" key={holding.id}>
							<summary><span className="portfolio-holding-asset"><AssetIcon category={holding.category} name={holding.name}/><span><b>{holding.name}</b><small>{holding.category} · {holding.status.replaceAll('_',' ').toLowerCase()}</small></span></span><span>{Number(data.totalValue)>0&&holding.value!==null?`${(Number(holding.value)/Number(data.totalValue)*100).toFixed(1)}%`:'—'}</span><span>{money(holding.invested)}</span><span>{money(holding.value)}</span><strong className={holding.gainLoss===null?'':Number(holding.gainLoss)>=0?'text-profit':'text-loss'}>{signed(holding.gainLoss)}</strong></summary>
							<dl><div><dt>Recorded asset</dt><dd>{holding.name}</dd></div><div><dt>Category</dt><dd>{holding.category}</dd></div><div><dt>Portfolio share</dt><dd>{Number(data.totalValue)>0&&holding.value!==null?`${(Number(holding.value)/Number(data.totalValue)*100).toFixed(2)}%`:'—'}</dd></div><div><dt>Position status</dt><dd>{holding.status.replaceAll('_',' ')}</dd></div><div><dt>Valuation source</dt><dd>{holding.valuationSource|| (data.accountMode==='DEMO'?'DEMO practice price':'Unavailable')}</dd></div></dl>
						</details>)}</div>
					</>}
				</>}
			</section>
			<section className="portfolio-footer-summary" aria-label="Portfolio totals">
				<article><span>{data.accountMode==='DEMO'?'Open-position cost basis':'Invested cost basis'}</span><b>{money(data.totalInvested)}</b></article>
				<article><span>Aurevia account value</span><b>{money(data.totalCurrentValue)}</b></article>
				<article><span>{data.accountMode==='DEMO'?'Recorded trading P/L':'Recorded gain/loss'}</span><b className={data.totalPnl===null?'':positive?'text-profit':'text-loss'}>{signed(data.totalPnl)}</b></article>
			</section>
			{data.accountMode==='REAL'&&<section className="account-panel card p-5 mt-4">
				<div className="account-panel-title"><div><h2>Investment activity</h2><p className="account-panel-subtitle">Configured terms, actual statuses, and persisted account outcomes</p></div><Link className="text-link" href="/investments">Browse opportunities <TrendingUp size={14}/></Link></div>
				{data.investments.length?<div className="portfolio-investment-list">{data.investments.map(item=>{
					const payout=item.simulatedPayout===null?null:Number(item.simulatedPayout)-Number(item.amount);
					return <details key={item.id} className="portfolio-investment-row"><summary><span><b>{item.opportunity.title}</b><small>{item.opportunity.category} · {money(item.amount)} principal</small></span><span className={`status-pill ${data.accountMode==='REAL'?'mode-real':'mode-demo'}`}>{item.status.replaceAll('_',' ')}</span></summary><dl><div><dt>Configured duration</dt><dd>{item.opportunity.durationDays} days</dd></div><div><dt>Risk classification</dt><dd>{item.opportunity.riskLevel.replaceAll('_',' ')}</dd></div><div><dt>Target return</dt><dd>{percentage(item.targetReturnPercent)}</dd></div><div><dt>Captured tier boost</dt><dd>{percentage(item.tierBoostPercent)}</dd></div><div><dt>Recorded result</dt><dd>{item.simulatedPayout===null?'Not settled':`${money(item.simulatedPayout)} payout · ${signed(payout)}`}</dd></div><div><dt>Reference</dt><dd className="break-all">{item.settlementReference||'Not settled'}</dd></div><div><dt>Requested</dt><dd>{new Date(item.requestedAt).toLocaleString()}</dd></div></dl><small>Returns are estimates, not guarantees or external assets.</small></details>;
				})}</div>:<p className="account-empty">No investment requests are recorded in this account.</p>}
			</section>}
			{data.accountMode==='REAL'&&<section className="account-panel card p-5 mt-4">
				<div className="account-panel-title"><div><h2>Recent funding</h2><p className="account-panel-subtitle">Latest deposit and withdrawal requests for this account.</p></div><Link className="text-link" href="/wallet/transactions">Full history <FileClock size={14}/></Link></div>
				{data.recentFunding.length?<div className="portfolio-investment-list">{data.recentFunding.map(item=><Link className="portfolio-recent-funding" href={`/wallet/transactions/${encodeURIComponent(item.id)}`} key={item.id}><span className="portfolio-recent-funding-icon">{item.type==='DEPOSIT'?<ArrowDownLeft size={16}/>:<ArrowUpRight size={16}/>}</span><span><b>{item.type} · {fundingAmount(item.amount,item.currency)}</b><small>{item.method} · {new Date(item.createdAt).toLocaleString()}</small></span><span className="status-pill">{item.status.replaceAll('_',' ')}</span></Link>)}</div>:<p className="account-empty">No recent funding requests in this account.</p>}
			</section>}
			{data.accountMode==='REAL'&&<section className="account-panel card p-5 mt-4">
				<div className="account-panel-title"><div><h2>Investment opportunities</h2><p className="account-panel-subtitle">Available allocations that can be funded from your account balance.</p></div><Link className="text-link" href="/investments">Explore all <TrendingUp size={14}/></Link></div>
				{data.availableOpportunities.length?<div className="portfolio-opportunity-grid">{data.availableOpportunities.map(item=><Link className="portfolio-opportunity-card" href="/investments" key={item.id}><span><AssetIcon category={item.category} name={item.assetSymbol||item.title}/></span><b>{item.title}</b><small>{item.category} · {item.riskLevel.replaceAll('_',' ')}</small><span className="portfolio-opportunity-terms">Min. {money(item.minimumAmount)}{item.targetReturnPercent===null?'':` · Target ${percentage(item.targetReturnPercent)}`}</span></Link>)}</div>:<p className="account-empty">There are no available opportunities for this account right now.</p>}
			</section>}
			<section className="account-panel card p-5 mt-4">
				<div className="account-panel-title"><div><h2>Position details</h2><p className="account-panel-subtitle">Positions are kept separate from investment opportunity allocations.</p></div></div>
				<div className="portfolio-metrics-grid"><article><span>Recorded gain/loss</span><b className={data.totalPnl===null?'':positive?'text-profit':'text-loss'}>{signed(data.totalPnl)}</b></article><article><span>Realized trading & settled investment P/L</span><b>{signed(data.realizedPnl)}</b></article><article><span>Unrealized trading P/L</span><b>{signed(data.unrealizedPnl)}</b></article><article><span>Change since first snapshot today</span><b>{signed(data.dailyPnl)}</b></article><article><span>Return vs. recorded funding</span><b>{percentage(data.returnPercent)}</b></article></div>
			</section>
		</>}
	</main></>;
}
