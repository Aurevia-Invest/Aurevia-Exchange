'use client';

import {useEffect,useState} from 'react';
import {Activity,RefreshCw} from 'lucide-react';
import LivePriceChart from '@/components/LivePriceChart';
import type {MarketCandle,MarketQuote,TimeframeId} from '@/lib/live-market';

type MarketHistory={quote:MarketQuote|null;candles:MarketCandle[];timeframe:TimeframeId};

export default function InvestmentMarketBoard({symbol}:{symbol:string|null}){
	const [history,setHistory]=useState<MarketHistory|null>(null);
	const [loading,setLoading]=useState(false);
	const [error,setError]=useState('');
	const [updatedAt,setUpdatedAt]=useState('');
	const [retryCount,setRetryCount]=useState(0);

	useEffect(()=>{
		if(!symbol){setHistory(null);setError('');return}
		let active=true;
		const refresh=async()=>{
			setLoading(true);
			try{
				const response=await fetch(`/api/live-markets/${encodeURIComponent(symbol)}?timeframe=1d`,{cache:'no-store'});
				const result=await response.json();
				if(!response.ok)throw new Error(result.error||'Market context is unavailable.');
				if(active){setHistory(result as MarketHistory);setUpdatedAt(new Date().toISOString());setError('')}
			}catch(exception){
				if(active)setError(exception instanceof Error?exception.message:'Market context is unavailable.');
			}finally{if(active)setLoading(false)}
		};
		setLoading(true);setError('');setHistory(null);
		void refresh();
		const timer=window.setInterval(()=>{if(document.visibilityState==='visible')void refresh()},30_000);
		return()=>{active=false;window.clearInterval(timer)};
	},[retryCount,symbol]);

	if(!symbol)return null;
	return <section className="account-panel card p-5 investment-market-board" aria-label="Investment market context">
		<div className="account-panel-title">
			<div><span className="account-kicker"><Activity size={13}/> Market context</span><h2>{symbol} · Candlestick view</h2><p className="account-panel-subtitle">Market reference only. This chart does not represent an investment position or credited earnings.</p></div>
			{history?.quote&&<div className="investment-market-quote"><b>{history.quote.price.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:6})} {history.quote.asset.currency}</b><span>{history.quote.marketStatus||'Market status unavailable'}{history.quote.isStale?' · Delayed':''}</span></div>}
		</div>
		{history?<LivePriceChart candles={history.candles} quote={history.quote||undefined} timeframe={history.timeframe} loading={loading} error={error}/>:<div className="investment-market-placeholder" role="status">{error||'Loading market context…'}</div>}
		<div className="investment-market-footer"><span>{error&&!history?'Chart temporarily unavailable':history?.quote?.isStale?'Last available market reference may be delayed':'Quotes may be delayed and are not an execution price.'}</span><span>{updatedAt?`Updated ${new Date(updatedAt).toLocaleTimeString()}`:loading?'Connecting…':''}</span><button type="button" className="text-link" onClick={()=>setRetryCount(value=>value+1)} disabled={loading}><RefreshCw size={13}/> Refresh</button></div>
	</section>;
}
