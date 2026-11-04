'use client';

import {useEffect,useMemo,useState} from 'react';
import Link from 'next/link';
import {useSession} from 'next-auth/react';
import {Activity,ArrowUpRight,RefreshCw,Star} from 'lucide-react';
import Nav from '@/components/Nav';
import AureviaLoading from '@/components/AureviaLoading';
import PriceChart from '@/components/PriceChart';
import {useLocale} from '@/lib/i18n-context';
import {MARKET_UI_REFRESH_INTERVAL_MS} from '@/lib/live-market';

type Instrument={id:string;symbol:string;name:string;baseAsset:string;quoteAsset:string;price:string|number;change?:number;source:string;dataMode:'SIMULATED'|'LIVE';marketStatus:string;lastUpdatedAt:string};
type ActivityItem={id:string;instrument:string;symbol?:string;side:'BUY'|'SELL';quantity:string|number;price:string|number;timestamp:string;createdAt?:string;accountMode:'DEMO'|'REAL';status:string};
type Connection='connecting'|'polling'|'offline';
type ChartWindow='1H'|'4H'|'8H';

function mergeActivity(current:ActivityItem[],incoming:ActivityItem[]){
	const byId=new Map<string,ActivityItem>();
	for(const item of [...incoming,...current])byId.set(item.id,item);
	return [...byId.values()].sort((a,b)=>new Date(b.timestamp||b.createdAt||0).getTime()-new Date(a.timestamp||a.createdAt||0).getTime()).slice(0,30);
}

export default function MarketExperience(){
	const {data:session,status:sessionStatus}=useSession();
	const {translate}=useLocale();
	const accountMode=sessionStatus==='authenticated'?session?.user?.accountMode||null:null;
	const [markets,setMarkets]=useState<Instrument[]>([]);
	const [watchlistIds,setWatchlistIds]=useState<string[]>([]);
	const [activity,setActivity]=useState<ActivityItem[]>([]);
	const [selectedId,setSelectedId]=useState('');
	const [chartWindow,setChartWindow]=useState<ChartWindow>('1H');
	const [connection,setConnection]=useState<Connection>('connecting');
	const [loading,setLoading]=useState(true);
	const [error,setError]=useState('');
	const [retryCount,setRetryCount]=useState(0);
	const selected=markets.find(item=>item.id===selectedId)||markets[0];
	const isReal=accountMode==='REAL';
	const isDemo=accountMode==='DEMO';
	const sortedActivity=useMemo(()=>activity.slice(0,30),[activity]);
	const watchedMarkets=markets.filter(item=>watchlistIds.includes(item.id));
	const chartLimits:Record<ChartWindow,number>={'1H':60,'4H':240,'8H':480};

	useEffect(()=>{
		try{const stored=JSON.parse(window.localStorage.getItem('aurevia-market-watchlist')||'[]');if(Array.isArray(stored))setWatchlistIds(stored.filter((id):id is string=>typeof id==='string'));}catch{setWatchlistIds([]);}
	},[]);

	function toggleWatchlist(instrumentId:string){
		setWatchlistIds(current=>{
			const next=current.includes(instrumentId)?current.filter(id=>id!==instrumentId):[...current,instrumentId];
			window.localStorage.setItem('aurevia-market-watchlist',JSON.stringify(next));
			return next;
		});
	}

	useEffect(()=>{
		setActivity([]);
	},[isReal]);

	useEffect(()=>{
		if(sessionStatus==='loading')return;
		let active=true;
		async function refresh(showLoading=false){
			if(showLoading)setLoading(true);
			try{
				const [marketResponse,activityResponse]=await Promise.all([fetch('/api/market',{cache:'no-store'}),fetch('/api/market/activity',{cache:'no-store'})]);
				if(!marketResponse.ok||!activityResponse.ok)throw new Error('Market data is temporarily unavailable.');
				const [nextMarkets,activityResult]=await Promise.all([marketResponse.json(),activityResponse.json()]);
				if(!active)return;
				setMarkets(nextMarkets);setSelectedId(current=>current||nextMarkets[0]?.id||'');setActivity(current=>mergeActivity(current,activityResult.activity));setError('');setConnection('polling');
			}catch(exception){if(active){setConnection('offline');setError(exception instanceof Error?exception.message:'Market data is temporarily unavailable.')}}
			finally{if(active&&showLoading)setLoading(false)}
		}
		void refresh(true);
		const poll=window.setInterval(()=>{void refresh()},MARKET_UI_REFRESH_INTERVAL_MS);
		return()=>{active=false;window.clearInterval(poll)};
	},[sessionStatus,isReal,retryCount]);

	return <><Nav/><main className="account-page market-page">
		<header className="account-heading"><div><span className="account-kicker">{translate('marketHeader')}</span><h1>{translate('marketTitle')}</h1><p>Quotes may be delayed. Internal reference prices are estimates and are not executable.</p></div><div className="market-heading-status"><span className={`status-pill ${isReal?'mode-real':isDemo?'mode-demo':''}`}>{isReal?translate('realAccount'):isDemo?translate('demoAccount'):'PUBLIC MARKET VIEW'}</span><span className={`market-connection is-${connection}`}><i/>{connection==='polling'?'Refreshing':connection==='connecting'?translate('connecting'):translate('offlineRefreshing')}</span></div></header>
		{error&&<div className="account-callout market-error" role="alert"><span>{error}</span><button type="button" className="text-link" disabled={loading} aria-busy={loading} onClick={()=>{setError('');setLoading(true);setRetryCount(value=>value+1)}}><RefreshCw size={14}/> {loading?translate('marketRefreshing'):translate('marketRetry')}</button></div>}
		<section className="account-panel card p-5"><div className="account-panel-title"><div><h2>{translate('marketOverview')}</h2><p className="account-panel-subtitle">{translate('enabledInstruments')}</p></div><span className="status-pill">{markets[0]?.marketStatus==='SIMULATED'?(isDemo?'DEMO':'INDICATIVE'):markets[0]?.marketStatus||translate('marketStatusUnavailable')}</span></div>
			{loading&&!markets.length?<div className="account-empty"><AureviaLoading variant="inline" label={translate('loadingCurrentInstruments')}/></div>:markets.length?<div className="market-instrument-grid">{markets.map(instrument=><button type="button" key={instrument.id} className={`market-instrument ${selected?.id===instrument.id?'is-selected':''}`} aria-pressed={selected?.id===instrument.id} onClick={()=>setSelectedId(instrument.id)}><span>{instrument.symbol}</span><b>{Number(instrument.price).toLocaleString(undefined,{maximumFractionDigits:6})}</b><small>{instrument.name}</small><em>{instrument.dataMode==='SIMULATED'?'Indicative price':'Market quote'}</em></button>)}</div>:<div className="account-empty">{translate('noInstrumentsAvailable')}</div>}
		</section>
		{watchedMarkets.length>0&&<section className="account-panel card p-5 mt-4"><div className="account-panel-title"><div><h2>{translate('watchlistTitle')}</h2><p className="account-panel-subtitle">{translate('savedOnDevice')}</p></div></div><div className="market-instrument-grid">{watchedMarkets.map(instrument=><button type="button" key={instrument.id} className="market-instrument" onClick={()=>setSelectedId(instrument.id)}><span>{instrument.symbol}</span><b>{Number(instrument.price).toLocaleString(undefined,{maximumFractionDigits:6})}</b><small>{instrument.name}</small></button>)}</div></section>}
		{selected&&<section className="account-panel card p-5 mt-4"><div className="account-panel-title"><div><h2>{selected.symbol} · Price chart</h2><p className="account-panel-subtitle">{selected.dataMode==='SIMULATED'?'Indicative price':'Market quote'} · {translate('chartUpdated')} <time dateTime={String(selected.lastUpdatedAt)}>{new Date(selected.lastUpdatedAt).toLocaleString()}</time></p></div><div className="flex flex-wrap items-center gap-2"><b className="market-selected-price">{Number(selected.price).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:6})} {selected.quoteAsset}</b><button type="button" className="btn min-h-11 bg-white/5" aria-pressed={watchlistIds.includes(selected.id)} onClick={()=>toggleWatchlist(selected.id)}><Star size={15} aria-hidden="true"/>{watchlistIds.includes(selected.id)?translate('removeWatchlist'):translate('addToWatchlist')}</button></div></div><div className="mt-3 flex gap-1" role="group" aria-label={translate('chartTimeframe')}>{(['1H','4H','8H'] as const).map(window=><button key={window} type="button" className={`btn min-h-11 px-4 ${chartWindow===window?'bg-gold text-black':'bg-white/5'}`} aria-pressed={chartWindow===window} onClick={()=>setChartWindow(window)}>{window}</button>)}</div><PriceChart key={selected.id} instrumentId={selected.id} limit={chartLimits[chartWindow]} price={Number(selected.price)} running={selected.dataMode==='SIMULATED'}/></section>}
		<section className="account-panel card p-5 mt-4"><div className="account-panel-title"><div><h2><Activity size={17} className="gold"/> {translate('marketActivityHeading')}</h2><p className="account-panel-subtitle">{translate('marketActivitySubtitle')}</p></div><Link className="text-link" href={isReal?'/wallet':'/trade'}>{isReal?translate('realAccountActivity'):translate('openDemoTrade')} <ArrowUpRight size={14}/></Link></div>
			{sortedActivity.length?<div className="market-activity-list">{sortedActivity.map(item=>{const timestamp=item.timestamp||item.createdAt||'';const symbol=item.instrument||item.symbol||translate('instrument');return <article className="market-activity-item" key={item.id}><span className={`market-side is-${item.side.toLowerCase()}`}>{item.side}</span><div className="market-activity-main"><b>{symbol}</b><span>{Number(item.quantity).toLocaleString()} @ {Number(item.price).toLocaleString(undefined,{maximumFractionDigits:6})}</span></div><span className={`status-pill ${item.accountMode==='DEMO'?'mode-demo':'mode-real'}`}>{item.accountMode==='DEMO'?translate('demoSimulated'):translate('real')}</span><span className="market-activity-status">{item.status.replaceAll('_',' ')}</span><time dateTime={timestamp} title={timestamp?new Date(timestamp).toLocaleString():undefined}>{timestamp?new Date(timestamp).toLocaleTimeString():''}</time></article>})}</div>:<div className="market-activity-empty"><Activity size={22}/><p>{loading?translate('loadingActivity'):isReal?'No real execution records are available for this account.':translate('noDemoExecutions')}</p></div>}
		</section>
		{isReal&&<p className="mt-4 text-xs leading-6 muted">{translate('realAccountExecutionNotice')}</p>}
	</main></>;
}