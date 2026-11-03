'use client';

import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import Link from 'next/link';
import Image from 'next/image';
import {Cell,Pie, PieChart,ResponsiveContainer,Tooltip} from 'recharts';
import {Activity,ArrowDownLeft,ArrowLeftRight,ArrowRight,ArrowUpRight,Bell,BriefcaseBusiness,ChartNoAxesCombined,ChevronDown,Clock3,ExternalLink,Eye,EyeOff,Home,LifeBuoy,LineChart,Plus,RefreshCw,Search,ShieldCheck,Star,WalletCards} from 'lucide-react';
import {useSession} from 'next-auth/react';
import Nav from '@/components/Nav';
import ProfileAvatar from '@/components/ProfileAvatar';
import NewsFeedPanel from '@/components/NewsFeedPanel';
import LivePriceChart from '@/components/LivePriceChart';
import LocalClockCalendar from '@/components/LocalClockCalendar';
import {InvestmentProgressCard} from '@/components/InvestmentProgressCard';
import DemoAiTradingPanel from '@/components/DemoAiTradingPanel';
import DemoAccountControls from '@/components/DemoAccountControls';
import AccountTierBadge from '@/components/AccountTierBadge';
import {useAccountTier} from '@/components/useAccountTier';
import {DEFAULT_WATCHLIST,MARKET_ASSETS,MARKET_UI_REFRESH_INTERVAL_MS,type MarketCandle,type MarketQuote,type TimeframeId} from '@/lib/live-market';
import {formatUsd} from '@/lib/currency-format';
import AureviaExchangeId from '@/components/AureviaExchangeId';

type Overview={
	profile:{name:string|null;aureviaExchangeId:string|null;accountMode:'DEMO'|'REAL';tier:string;progress:number;profileRequirements:{nameComplete:boolean;countryComplete:boolean;phoneComplete:boolean;profileComplete:boolean};kycStatus:string;hasAvatar:boolean};
	accountMode:'DEMO'|'REAL';
	demoStartingBalance:string|null;
	balances:Partial<Record<'DEMO'|'REAL',string>>;
	portfolioSummary:{
		accountMode:'DEMO'|'REAL';cashBalance:string;positionValue:string;investmentValue:string;totalValue:string;unrealizedPnl:string;
		allocations:Array<{category:string;value:string;percentage:string}>;
	};
	positions:Array<{id:string;side:string;quantity:string;entryPrice:string;currentPrice:string;marketValue:string;openedAt:string;instrument:{symbol:string;name:string}}>;
	openOrders:Array<{id:string;side:string;type:string;status:string;quantity:string;filledQuantity:string;price:string|null;createdAt:string;instrument:{symbol:string;name:string}}>;
	opportunities:Array<{id:string;title:string;category:string;description:string;assetSymbol:string|null;minimumAmount:string;maximumAmount:string|null;targetReturnPercent:string|null;durationDays:number;riskLevel:string;requiresApproval:boolean}>;
	activeInvestments:Array<{id:string;title:string;accountMode:'DEMO'|'REAL';amount:string;status:string;activatedAt:string|null;maturesAt:string|null;durationDays:number;displayTargetPayout:string}>;
	recentActivity:Array<{id:string;category:string;action:string;timestamp:string;asset:string;amount:string;status:string;source:string;link:string}>;
	internalMarketInstruments:Array<{assetId:string;instrumentId:string}>;
	limitations:{balances:string;portfolio:string;realExecution:string};
};

type QuoteError={asset:MarketQuote['asset'];error:string};
type QuotesResponse={quotes:Array<MarketQuote|QuoteError>;source:string;marketDataStatus:string};
type HistoryResponse={quote:MarketQuote|null;candles:MarketCandle[];timeframe:TimeframeId;interval:string;source:string};
type MarketCategory='Favorites'|'Forex'|'Crypto'|'Stocks'|'Indices';

const categoryFilters:MarketCategory[]=['Favorites','Forex','Crypto','Stocks','Indices'];
const timeframes:Array<{label:string;value:TimeframeId}>=[
	{label:'1H',value:'1h'},{label:'1D',value:'1d'},{label:'1W',value:'5d'},{label:'1M',value:'1m'},
	{label:'3M',value:'3m'},{label:'1Y',value:'1y'},{label:'ALL',value:'max'},
];
const allocationColors=['#d4a72c','#51a878','#65a6ba','#aa8bd1','#cc7869','#8d9c8e'];

function formatMarketPrice(value:number,currency:string){
	return new Intl.NumberFormat(undefined,{style:'currency',currency,maximumFractionDigits:value<10?5:2}).format(value);
}

function isQuote(value:MarketQuote|QuoteError|undefined):value is MarketQuote{
	return !!value&&'price'in value;
}

function timeAgo(value:string){
	const elapsed=Math.max(0,Date.now()-new Date(value).getTime());
	const minutes=Math.floor(elapsed/60_000);
	if(minutes<1)return 'Just now';
	if(minutes<60)return `${minutes}m ago`;
	const hours=Math.floor(minutes/60);
	if(hours<24)return `${hours}h ago`;
	return `${Math.floor(hours/24)}d ago`;
}

function activityAmount(item:Overview['recentActivity'][number]){
	const amount=Number(item.amount);
	if(!item.amount||!Number.isFinite(amount))return '—';
	if(item.asset==='USD'||item.category==='investment')return formatUsd(item.amount);
	return amount.toLocaleString(undefined,{maximumFractionDigits:6});
}

function firstName(name:string|null){
	return name?.trim().split(/\s+/)[0]||'there';
}

function categoryFor(assetType:string):MarketCategory{
	if(assetType==='FOREX')return 'Forex';
	if(assetType==='CRYPTO')return 'Crypto';
	if(assetType==='STOCK')return 'Stocks';
	return 'Indices';
}

function UserMetric({label,value,detail,active,icon:Icon}:{label:string;value:string;detail:string;active?:boolean;icon:typeof WalletCards}){
	return <article className={`user-dashboard-metric ${active?'is-active':''}`}>
		<div className="user-dashboard-metric-heading"><span>{label}</span><span className="user-dashboard-metric-icon"><Icon size={17}/></span></div>
		<strong>{value}</strong>
		<div className="user-dashboard-metric-foot"><span>{detail}</span>{active&&<span className="user-dashboard-active-tag">ACTIVE</span>}</div>
	</article>;
}

function MarketChartPanel({selectedSymbol,quotes,internalInstrumentId}:{selectedSymbol:string;quotes:Map<string,MarketQuote|QuoteError>;internalInstrumentId?:string}){
	const [history,setHistory]=useState<HistoryResponse|null>(null);
	const [loading,setLoading]=useState(false);
	const [error,setError]=useState('');
	const [timeframe,setTimeframe]=useState<TimeframeId>('1d');
	useEffect(()=>{
		let active=true;
		setLoading(true);setError('');
		void fetch(`/api/live-markets/${encodeURIComponent(selectedSymbol)}?timeframe=${timeframe}`,{cache:'no-store'})
			.then(async response=>{
				const result=await response.json();
				if(!response.ok)throw new Error(result.error||'Market history is unavailable.');
				return result as HistoryResponse;
			})
			.then(async result=>{
				if(result.source==='Aurevia Internal'){
					if(!internalInstrumentId)throw new Error('No configured instrument or provider history is available for this market.');
					const response=await fetch(`/api/candles?instrumentId=${encodeURIComponent(internalInstrumentId)}&range=${timeframe}`,{cache:'no-store'});
					const rows=await response.json() as Array<{ts:string;open:string;high:string;low:string;close:string;volume:string}>;
					if(!response.ok)throw new Error('Stored market candles are unavailable.');
					const candles=rows.map(row=>({
						time:Math.floor(new Date(row.ts).getTime()/1000),
						open:Number(row.open),high:Number(row.high),low:Number(row.low),close:Number(row.close),volume:Number(row.volume),
					})).filter(candle=>Number.isFinite(candle.time)&&[candle.open,candle.high,candle.low,candle.close].every(Number.isFinite));
					if(candles.length<2)throw new Error('There is not enough stored market history for this range.');
					result={...result,candles,source:'Aurevia DEMO market feed'};
				}
				if(active)setHistory(result);
			})
			.catch(exception=>{if(active){setHistory(null);setError(exception instanceof Error?exception.message:'Market history is unavailable.')}})
			.finally(()=>{if(active)setLoading(false)});
		return()=>{active=false};
	},[selectedSymbol,timeframe,internalInstrumentId]);
	const quoteValue=quotes.get(selectedSymbol);
	const quote=isQuote(quoteValue)?quoteValue:history?.quote;
	return <section className="user-dashboard-panel user-market-chart-panel" aria-labelledby="user-market-overview">
		<header className="user-dashboard-panel-heading">
			<div><span className="user-dashboard-eyebrow">SUPPORTED MARKET DATA</span><h2 id="user-market-overview">Market overview</h2><p>{quote?.asset.name||selectedSymbol} · {history?.source||quote?.source||'Quote source loading'}{quote?.updatedAt?` · Updated ${timeAgo(quote.updatedAt)}`:''}</p></div>
			<div className="user-market-quote">{quote?<><strong>{formatMarketPrice(quote.price,quote.asset.currency)}</strong><span className={quote.changePercent>=0?'is-positive':'is-negative'}>{quote.changePercent>=0?'+':''}{quote.changePercent.toFixed(2)}%</span></>:<span className="user-dashboard-muted">Quote unavailable</span>}</div>
		</header>
		<div className="user-chart-toolbar"><div className="user-chart-timeframes" role="group" aria-label="Market chart range">{timeframes.map(item=><button key={item.value} type="button" aria-pressed={timeframe===item.value} className={timeframe===item.value?'is-selected':''} onClick={()=>setTimeframe(item.value)}>{item.label}</button>)}</div><Link href={`/markets?symbol=${encodeURIComponent(selectedSymbol)}`} className="user-dashboard-panel-link">Full market view <ExternalLink size={13}/></Link></div>
		{history?<LivePriceChart candles={history.candles} quote={history.source==='Aurevia DEMO market feed'?undefined:quote??undefined} timeframe={timeframe} loading={loading} error={error} running={history.source==='Aurevia Internal'||history.source==='Aurevia DEMO market feed'}/>:loading?<div className="user-chart-empty" role="status">Loading market history…</div>:<div className="user-chart-empty" role="status">{error||'No historical market data is available for this range.'}</div>}
		<p className="user-dashboard-footnote">Provider quotes are shown when available. DEMO prices are internal reference values; charts use provider history or recorded database candles only.</p>
	</section>;
}

function AssetAllocation({overview}:{overview:Overview}){
	const allocations=overview.portfolioSummary.allocations;
	return <section className="user-dashboard-panel" aria-labelledby="user-allocation-heading">
		<header className="user-dashboard-panel-heading"><div><span className="user-dashboard-eyebrow">ACTIVE {overview.accountMode} MODE</span><h2 id="user-allocation-heading">My portfolio</h2><p>Recorded cash, open positions, and investment principal.</p></div><Link className="user-dashboard-panel-link" href="/portfolio">Details <ArrowRight size={14}/></Link></header>
		{allocations.length?<div className="user-allocation-content">
			<div className="user-allocation-chart" role="img" aria-label={`Portfolio allocation across ${allocations.length} asset categories`}>
				<ResponsiveContainer width="100%" height="100%"><PieChart><Tooltip formatter={value=>formatUsd(String(value))}/><Pie data={allocations} dataKey="value" nameKey="category" innerRadius="66%" outerRadius="92%" paddingAngle={2} stroke="none">{allocations.map((item,index)=><Cell key={item.category} fill={allocationColors[index%allocationColors.length]}/>)}</Pie></PieChart></ResponsiveContainer>
				<div><small>ACTIVE VALUE</small><b>{formatUsd(overview.portfolioSummary.totalValue)}</b></div>
			</div>
			<div className="user-allocation-list">{allocations.map((item,index)=><div key={item.category}><span><i style={{background:allocationColors[index%allocationColors.length]}}/>{item.category}</span><b>{formatUsd(item.value)}</b><small>{Number(item.percentage).toFixed(1)}%</small></div>)}</div>
		</div>:<div className="user-dashboard-empty"><BriefcaseBusiness size={19}/><p>No portfolio holdings are recorded for this mode yet.</p></div>}
		<p className="user-dashboard-footnote">Open positions use internal instrument prices; no external custody valuation is implied.</p>
	</section>;
}

function ActivityList({items}:{items:Overview['recentActivity']}){
	const [sort,setSort]=useState<'NEWEST'|'OLDEST'|'VALUE'>('NEWEST');
	const sortedItems=useMemo(()=>[...items].sort((a,b)=>{
		if(sort==='VALUE')return Math.abs(Number(b.amount)||0)-Math.abs(Number(a.amount)||0);
		const difference=new Date(a.timestamp).getTime()-new Date(b.timestamp).getTime();
		return sort==='NEWEST'?-difference:difference;
	}),[items,sort]);
	return <>{items.length>0&&<label className="activity-sort"><span>Sort activity</span><select value={sort} onChange={event=>setSort(event.target.value as typeof sort)}><option value="NEWEST">Newest first</option><option value="OLDEST">Oldest first</option><option value="VALUE">Largest amount</option></select></label>}{sortedItems.length?<ol className="user-recent-activity">{sortedItems.slice(0,6).map(item=><li key={item.id}><span className={`user-activity-mark activity-${item.category}`}/><span><b>{item.action}</b><small>{item.asset} · {item.status}</small></span><span><b>{activityAmount(item)}</b><time dateTime={item.timestamp}>{timeAgo(item.timestamp)}</time></span></li>)}</ol>:<div className="user-dashboard-empty compact"><Activity size={18}/><p>Your recent account activity will appear here.</p></div>}</>;
}

export default function UserDashboardExperience(){
	const {data:session}=useSession();
	const accountTier=useAccountTier(session?.user?.role==='USER');
	const [overview,setOverview]=useState<Overview|null>(null);
	const [loading,setLoading]=useState(true);
	const [refreshing,setRefreshing]=useState(false);
	const [syncingAll,setSyncingAll]=useState(false);
	const [mobileBalanceVisible,setMobileBalanceVisible]=useState(true);
	const [error,setError]=useState('');
	const [quotes,setQuotes]=useState<Map<string,MarketQuote|QuoteError>>(new Map());
	const [quoteSource,setQuoteSource]=useState('');
	const [marketCategory,setMarketCategory]=useState<MarketCategory>('Favorites');
	const [marketSearch,setMarketSearch]=useState('');
	const [marketSort,setMarketSort]=useState<'DEFAULT'|'PRICE'|'CHANGE'>('DEFAULT');
	const [favorites,setFavorites]=useState<string[]>(DEFAULT_WATCHLIST);
	const [selectedSymbol,setSelectedSymbol]=useState(DEFAULT_WATCHLIST[0]||'BTC');
	const accountMode=session?.user?.accountMode;
	const refreshQuotesRef=useRef<()=>Promise<void>>(async()=>{});

	const load=useCallback(async(showLoading=false)=>{
		if(showLoading)setLoading(true);
		else setRefreshing(true);
		setError('');
		try{
			const response=await fetch('/api/dashboard/overview',{cache:'no-store'});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to load your account overview.');
			setOverview(result as Overview);
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to load your account overview.')}
		finally{setLoading(false);setRefreshing(false)}
	},[]);

	useEffect(()=>{
		setOverview(null);
		void load(true);
	},[accountMode,load]);
	useEffect(()=>{
		const timer=window.setInterval(()=>void load(false),60_000);
		return()=>window.clearInterval(timer);
	},[load]);
	useEffect(()=>{
		const internalInstruments=overview?.internalMarketInstruments;
		if(!internalInstruments)return;
		let active=true;
		const symbols=MARKET_ASSETS.map(asset=>asset.id).join(',');
		const refresh=async()=>{
			try{
				const response=await fetch(`/api/live-markets?symbols=${encodeURIComponent(symbols)}`,{cache:'no-store'});
				const result=await response.json() as QuotesResponse;
				if(!response.ok)throw new Error('Market quotes are temporarily unavailable.');
				if(active){setQuotes(new Map(result.quotes.map(item=>[item.asset.id,item])));setQuoteSource(result.source)}
			}catch(exception){if(active)setQuoteSource(exception instanceof Error?exception.message:'Market quotes unavailable')}
		};
		refreshQuotesRef.current=refresh;
		void refresh();
		const timer=window.setInterval(()=>void refresh(),MARKET_UI_REFRESH_INTERVAL_MS);
		return()=>{active=false;refreshQuotesRef.current=async()=>{};window.clearInterval(timer)};
	},[overview?.internalMarketInstruments]);

	const visibleAssets=useMemo(()=>{
		const query=marketSearch.trim().toLowerCase();
		const assets=MARKET_ASSETS.filter(asset=>(marketCategory==='Favorites'?favorites.includes(asset.id):categoryFor(asset.type)===marketCategory)&&(!query||`${asset.id} ${asset.ticker} ${asset.name}`.toLowerCase().includes(query)));
		if(marketSort!=='DEFAULT')assets.sort((a,b)=>{
			const first=quotes.get(a.id),second=quotes.get(b.id);
			const firstQuote=isQuote(first)?first:null,secondQuote=isQuote(second)?second:null;
			const firstValue=marketSort==='PRICE'?firstQuote?.price??-Infinity:firstQuote?.changePercent??-Infinity;
			const secondValue=marketSort==='PRICE'?secondQuote?.price??-Infinity:secondQuote?.changePercent??-Infinity;
			return secondValue-firstValue;
		});
		return assets.slice(0,8);
	},[favorites,marketCategory,marketSearch,marketSort,quotes]);
	const favoriteAssets=useMemo(()=>MARKET_ASSETS.filter(asset=>favorites.includes(asset.id)).slice(0,4),[favorites]);
	const toggleFavorite=useCallback((symbol:string)=>{
		setFavorites(current=>current.includes(symbol)?current.filter(item=>item!==symbol):[...current,symbol]);
	},[]);
	const internalInstrumentId=overview?.internalMarketInstruments.find(item=>item.assetId===selectedSymbol)?.instrumentId;
	const visibleRecentActivity=overview?.accountMode==='DEMO'
		?overview.recentActivity.filter(item=>['trade','personal-trade','order','position'].includes(item.category))
		:overview?.recentActivity||[];
	const refreshOverview=useCallback(()=>{void load(false)},[load]);
	const syncAll=useCallback(async()=>{
		setSyncingAll(true);
		try{await Promise.all([load(false),refreshQuotesRef.current()])}
		finally{setSyncingAll(false)}
	},[load]);
	if(loading&&!overview)return <><Nav/><DashboardSidebar name={session?.user?.name||session?.user?.email||''} tier={accountTier}/><main className="user-dashboard-page"><div className="user-dashboard-loading" role="status"><span className="user-dashboard-spinner"/>Loading your account dashboard…</div></main></>;

	return <><Nav/><DashboardSidebar name={overview?.profile.name||session?.user?.email||''} tier={accountTier||overview?.profile.tier||''}/><main className="user-dashboard-page">
		{error&&<div className="user-dashboard-error" role="alert"><span>{error}</span><button type="button" onClick={()=>void load(true)}>Retry</button></div>}
		{overview&&<>
			<header className="user-dashboard-welcome">
				<div><span className="user-dashboard-eyebrow">AUREVIA EXCHANGE · ACCOUNT OVERVIEW</span><h1>Welcome back, {firstName(overview.profile.name)}</h1><div className="user-dashboard-profile-line"><span>{overview.profile.name||'Your profile'}</span><AccountTierBadge tier={accountTier||overview.profile.tier}/></div><p>Your accounts and activity, organized in one place.</p></div>
				<div className="user-dashboard-welcome-actions">
					<span className={`user-mode-pill ${overview.accountMode.toLowerCase()}`}><i/>{overview.accountMode==='DEMO'?'DEMO MODE · VIRTUAL':'REAL ACCOUNT'}</span>
					<button type="button" className="user-dashboard-refresh" aria-label="Sync all account and market data" disabled={refreshing||syncingAll} onClick={()=>void syncAll()}><RefreshCw size={15} className={refreshing||syncingAll?'is-spinning':''}/><span>{refreshing||syncingAll?'Syncing…':'Sync all'}</span></button>
					<Link href="/wallet" className="dashboard-wallet-link"><WalletCards size={15}/>Wallet</Link>
				</div>
			</header>
			<section className="mobile-home-summary" aria-label="Account overview">
				<header className="mobile-home-greeting">
					<ProfileAvatar className="mobile-home-avatar" size={44} alt="Your profile picture"/>
					<div><small>Welcome back</small><strong>{overview.profile.name||'Your account'}</strong><AccountTierBadge tier={accountTier||overview.profile.tier}/></div>
					<Link href="/support" aria-label="Contact support"><LifeBuoy size={19}/></Link>
					<Link href="/notifications" aria-label="View notifications"><Bell size={19}/></Link>
				</header>
				<article className="mobile-balance-card">
					<div className="mobile-balance-top"><span>Estimated account value</span><button type="button" aria-label={mobileBalanceVisible?'Hide account value':'Show account value'} aria-pressed={!mobileBalanceVisible} onClick={()=>setMobileBalanceVisible(value=>!value)}>{mobileBalanceVisible?<Eye size={17}/>:<EyeOff size={17}/>}</button></div>
					<strong>{mobileBalanceVisible?formatUsd(overview.portfolioSummary.totalValue):'••••••••'}</strong>
					<div className="mobile-balance-bottom"><span>USD · {overview.accountMode==='DEMO'?'Demo account':'Account total'}</span><Link href="/portfolio">Portfolio <ArrowRight size={13}/></Link></div>
				</article>
				<nav className="mobile-money-actions" aria-label="Quick account actions">
					{overview.accountMode==='REAL'?<Link href="/wallet?type=DEPOSIT"><span><ArrowDownLeft size={17}/></span>Deposit</Link>:<Link href="/markets"><span><Search size={17}/></span>Markets</Link>}
					{overview.accountMode==='REAL'?<Link href="/wallet?type=WITHDRAWAL"><span><ArrowUpRight size={17}/></span>Withdraw</Link>:<Link href="/portfolio"><span><BriefcaseBusiness size={17}/></span>Portfolio</Link>}
					<Link href="/trade"><span><ArrowLeftRight size={17}/></span>Trade</Link>
				</nav>
				<section className="mobile-summary-section" aria-labelledby="mobile-assets-heading">
					<header><h2 id="mobile-assets-heading">My assets</h2><Link href="/portfolio">See all <ArrowRight size={13}/></Link></header>
					{overview.positions.length>0?<div className="mobile-assets-grid">{overview.positions.slice(0,2).map(position=><Link className="mobile-asset-card" href="/portfolio" key={position.id}><span className="mobile-asset-icon">{position.instrument.symbol.slice(0,1)}</span><span><b>{position.instrument.symbol}</b><small>{position.instrument.name}</small></span><strong>{formatUsd(position.marketValue)}</strong><small>{Number(position.quantity).toLocaleString(undefined,{maximumFractionDigits:6})} units</small></Link>)}</div>:<Link href="/portfolio" className="mobile-summary-empty">Your portfolio assets will appear here <ArrowRight size={14}/></Link>}
				</section>
				<details className="mobile-summary-section mobile-transactions mobile-activity-disclosure">
					<summary id="mobile-transactions-heading"><span>Recent activity</span><ChevronDown size={16} aria-hidden="true"/></summary>
					<div className="mobile-activity-disclosure-content">
						{visibleRecentActivity.length>0?<div className="mobile-transactions-list">{visibleRecentActivity.slice(0,2).map(item=><Link href={item.link||'/activity'} key={item.id}><span className="mobile-transaction-icon"><Activity size={17}/></span><span><b>{item.action}</b><small>{item.asset} · {timeAgo(item.timestamp)}</small></span><span><strong>{activityAmount(item)}</strong><small>{item.status}</small></span></Link>)}</div>:<p className="mobile-summary-empty">Your recent account activity will appear here.</p>}
						<Link href="/activity" className="mobile-activity-view-all">View activity history <ArrowRight size={13}/></Link>
					</div>
				</details>
			</section>
			<AureviaExchangeId id={overview.profile.aureviaExchangeId} className="mb-4"/>
			<section className="user-dashboard-metrics" aria-label={`${overview.accountMode} account balance and portfolio value`}>
				<UserMetric label={`${overview.accountMode} ${overview.accountMode==='DEMO'?'virtual cash':'account balance'}`} value={formatUsd(overview.balances[overview.accountMode]||'0')} detail={overview.accountMode==='DEMO'?`Available DEMO cash · ${formatUsd(overview.demoStartingBalance||'5000.00')} starting allocation`:'Internal USD ledger balance'} active icon={overview.accountMode==='DEMO'?WalletCards:ShieldCheck}/>
				<UserMetric label={`${overview.accountMode} portfolio value`} value={formatUsd(overview.portfolioSummary.totalValue)} detail={overview.accountMode==='DEMO'?'Virtual cash + simulated trading positions':'Cash + positions + allocated principal'} active icon={ChartNoAxesCombined}/>
			</section>
			{overview.accountMode==='DEMO'&&<DemoAccountControls startingBalance={overview.demoStartingBalance||'5000.00'} onReset={refreshOverview}/>}
			{overview.accountMode==='REAL'&&<p className="user-dashboard-real-note">REAL funding is credited only through existing administrator-approved requests. Balances shown are internal Aurevia ledger records.</p>}
			<section className="user-market-assets" aria-label="Supported market quotes">
				<header className="user-market-assets-heading"><div><span className="user-dashboard-eyebrow">SUPPORTED INSTRUMENTS</span><h2>Market watch</h2></div><div className="dashboard-market-controls"><label className="dashboard-market-search"><Search size={15}/><input aria-label="Search supported markets" placeholder="Search markets..." value={marketSearch} onChange={event=>setMarketSearch(event.target.value)}/></label><label className="dashboard-market-sort"><span>Sort by</span><select aria-label="Sort markets" value={marketSort} onChange={event=>setMarketSort(event.target.value as typeof marketSort)}><option value="DEFAULT">Default</option><option value="PRICE">Price</option><option value="CHANGE">Daily change</option></select></label><small>{quoteSource||'Quote source connecting'}</small></div></header>
				<div className="user-market-categories" role="group" aria-label="Filter market instruments">{categoryFilters.map(category=><button key={category} type="button" aria-pressed={marketCategory===category} className={marketCategory===category?'is-selected':''} onClick={()=>setMarketCategory(category)}>{category}</button>)}</div>
				<div className="user-market-asset-grid">{visibleAssets.slice(0,4).map(asset=>{
					const quote=quotes.get(asset.id);
					return <article key={asset.id} className={`market-watch-card ${selectedSymbol===asset.id?'is-selected':''}`}>
						<button type="button" className="user-market-asset" onClick={()=>setSelectedSymbol(asset.id)} aria-pressed={selectedSymbol===asset.id}>
							<span className="market-watch-symbol">{asset.id.slice(0,3)}</span><span><b>{asset.id}</b><small>{asset.name}</small></span>
							<strong>{isQuote(quote)?formatMarketPrice(quote.price,quote.asset.currency):quote?'Unavailable':'—'}</strong>
							<em className={isQuote(quote)?quote.changePercent>=0?'is-positive':'is-negative':''}>{isQuote(quote)?`${quote.changePercent>=0?'+':''}${quote.changePercent.toFixed(2)}%`:quote?'Quote unavailable':'Loading quote'}</em>
						</button>
						<button type="button" className={`market-watch-favorite ${favorites.includes(asset.id)?'is-favorite':''}`} aria-label={`${favorites.includes(asset.id)?'Remove':'Add'} ${asset.name} ${favorites.includes(asset.id)?'from':'to'} favorites`} aria-pressed={favorites.includes(asset.id)} onClick={()=>toggleFavorite(asset.id)}><Star size={15} fill={favorites.includes(asset.id)?'currentColor':'none'}/></button>
					</article>;
				})}</div>
				{visibleAssets.length===0&&<p className="market-watch-empty">No supported markets match this filter.</p>}
			</section>
			<FavoriteMarkets assets={favoriteAssets} quotes={quotes} onRemove={toggleFavorite}/>
			<div className="user-dashboard-columns">
				<div className="user-dashboard-primary">
					<MarketChartPanel selectedSymbol={selectedSymbol} quotes={quotes} internalInstrumentId={internalInstrumentId}/>
					{overview.accountMode==='REAL'&&overview.activeInvestments.length>0&&<section className="user-dashboard-panel" aria-labelledby="user-live-investments-heading">
						<header className="user-dashboard-panel-heading"><div><span className="user-dashboard-eyebrow">ACTIVE {overview.accountMode} MODE</span><h2 id="user-live-investments-heading">Live investments</h2><p>Per-second estimates use your recorded investment terms.</p></div><Link className="user-dashboard-panel-link" href="/investments">Investment activity <ArrowRight size={14}/></Link></header>
						<div className="investment-live-grid">{overview.activeInvestments.map(investment=><InvestmentProgressCard key={investment.id} investment={investment} onMaturity={refreshOverview}/>)}</div>
					</section>}
					{overview.accountMode==='DEMO'&&<DemoAiTradingPanel/>}
					<div className="user-dashboard-two-up">
						<AssetAllocation overview={overview}/>
						<section className="user-dashboard-panel" aria-labelledby="user-positions-heading">
							<header className="user-dashboard-panel-heading"><div><span className="user-dashboard-eyebrow">ACTIVE {overview.accountMode} MODE</span><h2 id="user-positions-heading">Positions</h2><p>Open positions at current internal instrument prices.</p></div><Link className="user-dashboard-panel-link" href="/portfolio">Portfolio <ArrowRight size={14}/></Link></header>
							{overview.positions.length?<div className="user-dashboard-table-wrap"><table className="user-dashboard-table"><thead><tr><th>Instrument</th><th>Side</th><th>Quantity</th><th>Value</th></tr></thead><tbody>{overview.positions.slice(0,5).map(position=><tr key={position.id}><td><b>{position.instrument.symbol}</b><small>{position.instrument.name}</small></td><td className={position.side==='BUY'?'is-positive':'is-negative'}>{position.side}</td><td>{Number(position.quantity).toLocaleString(undefined,{maximumFractionDigits:6})}</td><td>{formatUsd(position.marketValue)}</td></tr>)}</tbody></table></div>:<div className="user-dashboard-empty"><BriefcaseBusiness size={19}/><p>No open positions in {overview.accountMode} mode.</p><Link href="/trade">Explore supported markets <ArrowRight size={13}/></Link></div>}
						</section>
					</div>
					<section className="user-dashboard-panel" aria-labelledby="user-orders-heading">
						<header className="user-dashboard-panel-heading"><div><span className="user-dashboard-eyebrow">ACTIVE {overview.accountMode} MODE</span><h2 id="user-orders-heading">Open orders</h2><p>Orders owned by your current account mode.</p></div><Link className="user-dashboard-panel-link" href="/orders">Order history <ArrowRight size={14}/></Link></header>
						{overview.openOrders.length?<div className="user-dashboard-table-wrap"><table className="user-dashboard-table"><thead><tr><th>Instrument</th><th>Side / Type</th><th>Quantity</th><th>Filled</th><th>Limit</th><th>Status</th></tr></thead><tbody>{overview.openOrders.map(order=><tr key={order.id}><td><b>{order.instrument.symbol}</b><small>{order.instrument.name}</small></td><td>{order.side} · {order.type}</td><td>{Number(order.quantity).toLocaleString(undefined,{maximumFractionDigits:6})}</td><td>{Number(order.filledQuantity).toLocaleString(undefined,{maximumFractionDigits:6})}</td><td>{order.price?formatUsd(order.price):'Market'}</td><td><span className="user-order-status">{order.status.replaceAll('_',' ')}</span></td></tr>)}</tbody></table></div>:<div className="user-dashboard-empty compact"><Clock3 size={18}/><p>There are no open orders for {overview.accountMode} mode.</p></div>}
					</section>
					{overview.accountMode==='REAL'&&<section className="user-dashboard-panel user-opportunities" aria-labelledby="user-opportunities-heading">
						<header className="user-dashboard-panel-heading"><div><span className="user-dashboard-eyebrow">ADMIN-PUBLISHED</span><h2 id="user-opportunities-heading">Investment opportunities</h2><p>Available opportunities eligible for your current account mode.</p></div><Link className="user-dashboard-panel-link" href="/investments">Explore all <ArrowRight size={14}/></Link></header>
						{overview.opportunities.length?<div className="user-opportunity-grid">{overview.opportunities.slice(0,3).map(item=><article key={item.id}><span className="user-opportunity-category">{item.category}</span><h3>{item.title}</h3><p>{item.description}</p><dl><div><dt>Minimum</dt><dd>{formatUsd(item.minimumAmount)}</dd></div><div><dt>Duration</dt><dd>{item.durationDays} days</dd></div><div><dt>Target return</dt><dd>{item.targetReturnPercent===null?'Not stated':`${Number(item.targetReturnPercent).toFixed(2)}%`}</dd></div></dl><Link href="/investments">Review opportunity <ArrowRight size={13}/></Link></article>)}</div>:<div className="user-dashboard-empty"><BriefcaseBusiness size={19}/><p>No opportunities are currently published for {overview.accountMode} accounts.</p></div>}
					</section>}
				</div>
				<aside className="user-dashboard-rail" aria-label="Account tools and updates">
					<LocalClockCalendar/>
					<section className="user-dashboard-panel user-wallet-panel" aria-labelledby="user-wallet-heading"><header className="user-dashboard-panel-heading"><div><span className="user-dashboard-eyebrow">{overview.accountMode} WALLET</span><h2 id="user-wallet-heading">{overview.accountMode==='DEMO'?'Virtual cash':'My wallet'}</h2></div><WalletCards size={18}/></header><strong>{formatUsd(overview.portfolioSummary.cashBalance)}</strong><p>{overview.accountMode==='DEMO'?'Available simulated trading cash':'Available internal USD ledger balance'}</p>{overview.accountMode==='REAL'&&<div className="user-wallet-actions"><Link href="/wallet?type=DEPOSIT"><ArrowDownLeft size={14}/>Deposit</Link><Link href="/wallet?type=WITHDRAWAL"><ArrowUpRight size={14}/>Withdraw</Link></div>}</section>
					<section className="user-dashboard-panel" aria-labelledby="user-quick-heading"><header className="user-dashboard-panel-heading"><div><span className="user-dashboard-eyebrow">YOUR WORKSPACE</span><h2 id="user-quick-heading">Quick actions</h2></div></header><div className="user-quick-actions"><QuickAction href="/trade" label="Trade markets" icon={Activity}/>{overview.accountMode==='REAL'&&<><QuickAction href="/investments" label="Explore investments" icon={BriefcaseBusiness}/><QuickAction href="/wallet" label="Manage wallet" icon={WalletCards}/><QuickAction href="/kyc" label="Identity verification" icon={ShieldCheck}/></>}</div></section>
					<details className="user-dashboard-panel user-activity-disclosure">
						<summary className="user-activity-disclosure-heading"><span><span className="user-dashboard-eyebrow">ACCOUNT RECORDS</span><b>Recent activity</b></span><span className="user-activity-disclosure-meta"><ChevronDown size={15} aria-hidden="true"/></span></summary>
						<div className="user-activity-disclosure-content"><ActivityList items={visibleRecentActivity}/><Link className="user-dashboard-panel-link" href="/activity">View full activity history <ArrowRight size={14}/></Link></div>
					</details>
					<section className="user-dashboard-panel user-news-panel" aria-label="Live market news"><NewsFeedPanel compact/></section>
					<section className="user-support-panel"><span><LifeBuoy size={17}/></span><div><b>Need a hand?</b><small>Contact our support team.</small></div><Link href="/support" aria-label="Get help and support"><ArrowRight size={15}/></Link></section>
				</aside>
			</div>
			<footer className="user-dashboard-footnote user-dashboard-disclaimer"><ShieldCheck size={14}/><span>Financial balances, portfolio values, positions, and orders are separated by active account mode. REAL wallet funds are not auto-credited. Values are internal records, not a statement of external custody.</span><span> · </span><span>{overview.limitations.realExecution}</span></footer>
		</>}
		{error&&!overview&&<div className="user-dashboard-empty user-dashboard-fatal"><p>Your account overview could not be loaded.</p><button type="button" onClick={()=>void load(true)}>Try again <RefreshCw size={14}/></button></div>}
	</main></>;
}

function DashboardSidebar({name,tier}:{name:string;tier:string}){
	const initial=name.trim().slice(0,1).toUpperCase()||'A';
	const items=[
		{href:'/dashboard',label:'Overview',icon:Home},
		{href:'/portfolio',label:'Portfolio',icon:ChartNoAxesCombined},
		{href:'/wallet',label:'Wallet',icon:WalletCards},
		{href:'/markets',label:'Markets',icon:LineChart},
		{href:'/orders',label:'Orders',icon:Clock3},
		{href:'/settings',label:'Settings',icon:ShieldCheck},
	];
	return <aside className="dashboard-sidebar" aria-label="Dashboard navigation">
		<Link href="/" className="dashboard-sidebar-brand"><Image src="/aurevia-logo.png" alt="" width={36} height={36}/><span><b>Aurevia</b><small>EXCHANGE</small></span></Link>
		<span className="dashboard-sidebar-label">WORKSPACE</span>
		<nav>{items.map(({href,label,icon:Icon})=><Link key={href} href={href} aria-current={href==='/dashboard'?'page':undefined} className={href==='/dashboard'?'is-active':''}><Icon size={17}/><span>{label}</span>{href==='/dashboard'&&<i aria-hidden="true"/>}</Link>)}</nav>
		<div className="dashboard-sidebar-profile"><span>{initial}</span><div><b>{name||'Account'}</b><AccountTierBadge tier={tier}/></div></div>
	</aside>;
}

function FavoriteMarkets({assets,quotes,onRemove}:{assets:typeof MARKET_ASSETS;quotes:Map<string,MarketQuote|QuoteError>;onRemove:(symbol:string)=>void}){
	return <section className="favorite-markets-panel" aria-labelledby="favorite-markets-title">
		<header><div><span className="user-dashboard-eyebrow">YOUR WATCHLIST</span><h2 id="favorite-markets-title">Favourite markets</h2></div><Link href="/markets"><Plus size={14}/> Add favourite</Link></header>
		{assets.length?<div className="favorite-markets-grid">{assets.map(asset=>{
			const result=quotes.get(asset.id);
			const quote=isQuote(result)?result:null;
			return <article key={asset.id}>
				<div className="favorite-market-heading"><span className="market-watch-symbol">{asset.id.slice(0,3)}</span><div><b>{asset.id}</b><small>{asset.name}</small></div><button type="button" aria-label={`Remove ${asset.name} from favorites`} onClick={()=>onRemove(asset.id)}><Star size={15} fill="currentColor"/></button></div>
				<strong>{quote?formatMarketPrice(quote.price,quote.asset.currency):'—'}</strong>
				<div className="favorite-market-change"><span className={quote?quote.changePercent>=0?'is-positive':'is-negative':''}>{quote?`${quote.changePercent>=0?'+':''}${quote.changePercent.toFixed(2)}%`:'Change unavailable'}</span><MarketSparkline values={quote?.sparkline||[]} positive={!quote||quote.changePercent>=0}/></div>
			</article>;
		})}</div>:<p className="market-watch-empty">No favourites yet. Star a supported market to add it here.</p>}
	</section>;
}

function MarketSparkline({values,positive}:{values:number[];positive:boolean}){
	if(values.length<2)return <span className="favorite-sparkline-empty" aria-label="Intraday chart unavailable">—</span>;
	const min=Math.min(...values),range=Math.max(...values)-min||1;
	const points=values.map((value,index)=>`${(index/(values.length-1))*100},${30-((value-min)/range)*26}`).join(' ');
	return <svg className={positive?'favorite-sparkline is-positive':'favorite-sparkline is-negative'} viewBox="0 0 100 32" preserveAspectRatio="none" role="img" aria-label={`${positive?'Positive':'Negative'} market trend`}><polyline points={points}/></svg>;
}

function QuickAction({href,label,icon:Icon}:{href:string;label:string;icon:typeof Activity}){
	return <Link href={href} className="user-quick-action"><span><Icon size={15}/></span><b>{label}</b><ArrowRight size={13}/></Link>;
}
