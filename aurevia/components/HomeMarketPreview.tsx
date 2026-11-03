'use client';

import {useEffect,useRef,useState} from 'react';
import PriceChart from '@/components/PriceChart';
import {useLocale} from '@/lib/i18n-context';
import {MARKET_UI_REFRESH_INTERVAL_MS} from '@/lib/live-market';

type MarketItem={id:string;symbol:string;name:string;price:number;change?:number};

type LiveQuotePayload={asset:{id:string;name:string;currency:string};price:number;changePercent:number;updatedAt:string;source:string;isStale?:boolean};
type MarketDataStatus='LIVE'|'PARTIAL'|'INTERNAL'|'UNAVAILABLE';

export default function HomeMarketPreview(){
  const {translate}=useLocale();
  const [markets,setMarkets]=useState<MarketItem[]>([]);
  const [selected,setSelected]=useState('');
  const [status,setStatus]=useState<'loading'|'ready'|'error'>('loading');
  const [marketDataStatus,setMarketDataStatus]=useState<MarketDataStatus>('UNAVAILABLE');
  const [flash,setFlash]=useState<'up'|'down'|''>('');
  const [updatedAt,setUpdatedAt]=useState<number|null>(null);
  const [now,setNow]=useState(0);
  const prevPrice=useRef<number|null>(null);

  useEffect(()=>{
    let active=true;
    async function refresh(){
      try{
        const symbols=['DJI','SPX','NASDAQ','BTC','AAPL','MSFT','NVDA','AMZN','GOOGL','TSLA','EURGBP'].join(',');
        const response=await fetch(`/api/live-markets?symbols=${encodeURIComponent(symbols)}`,{cache:'no-store'});
        const payload=await response.json() as {quotes?:LiveQuotePayload[];marketDataStatus?:string;source?:string};
        const liveQuotes=(payload.quotes??[]).filter((item):item is LiveQuotePayload=>Boolean(item)&&typeof item.price==='number'&&typeof item.asset?.id==='string');
        if(!response.ok||!liveQuotes.length)throw new Error('Market data unavailable');
        if(!active)return;
        const normalized=liveQuotes.map(item=>({
          id:item.asset.id,
          symbol:item.asset.id,
          name:item.asset.name||item.asset.id,
          price:Number(item.price),
          change:Number(item.changePercent)/100,
        }));
        setMarkets(normalized);
        setSelected(current=>current||normalized.find(item=>item.symbol==='BTC')?.id||normalized[0]?.id||'');
        setMarketDataStatus(payload.marketDataStatus==='LIVE'||payload.marketDataStatus==='PARTIAL'||payload.marketDataStatus==='INTERNAL'?payload.marketDataStatus:'UNAVAILABLE');
        setStatus('ready');
        setUpdatedAt(Date.now());
      }catch{if(active)setStatus(current=>current==='ready'?current:'error')}
    }
    void refresh();
    const timer=window.setInterval(()=>void refresh(),MARKET_UI_REFRESH_INTERVAL_MS);
    return()=>{active=false;window.clearInterval(timer)};
  },[]);

  const current=markets.find(item=>item.id===selected);
  const currentId=current?.id;
  const currentPrice=current?.price;
  const visibleMarkets=markets.slice(0,4);

  useEffect(()=>{
    if(currentPrice===undefined)return;
    const prev=prevPrice.current;
    prevPrice.current=currentPrice;
    if(prev===null||prev===currentPrice)return;
    setFlash(currentPrice>prev?'up':'down');
    const t=window.setTimeout(()=>setFlash(''),700);
    return()=>window.clearTimeout(t);
  },[currentPrice,currentId]);

  useEffect(()=>{
    if(updatedAt===null)return;
    setNow(Date.now());
    const timer=window.setInterval(()=>setNow(Date.now()),1_000);
    return()=>window.clearInterval(timer);
  },[updatedAt]);

  const changePct=current?.change;
  const changeClass=changePct===undefined?'':changePct>=0?'is-up':'is-down';
  const ageLabel=updatedAt!==null?`${Math.max(0,Math.round((now-updatedAt)/1000))}s`:'—';
  const sourceStatus=marketDataStatus==='LIVE'?'LIVE':marketDataStatus==='PARTIAL'?'PARTIAL':marketDataStatus==='INTERNAL'?'REFERENCE':'UNAVAILABLE';

  return <div className="market-stage is-live" aria-label={translate('marketView')}>
    <div className="market-stage-top">
      <div className="market-source"><span className="source-dot is-live"/>{translate('demoEnvironment')} <span>{translate('marketView')}</span></div>
      <span className="market-time"><span className={`live-pill ${marketDataStatus==='LIVE'?'is-live':'is-reference'}`}>{sourceStatus}</span> {translate('marketView')} · {ageLabel}</span>
    </div>
    <div className="market-stage-instrument">
      <div>
        <p className="eyebrow">{translate('selectedInstrument')}</p>
        <h2>{current?.symbol||translate('marketOverview')}</h2>
        {current?.name&&<p className="market-instrument-name">{current.name}</p>}
      </div>
      <div className={`market-stage-price ${flash?`flash-${flash}`:''}`} aria-live="polite">
        {current?current.price.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:current.price<10?4:2}):status==='error'?translate('unavailable'):translate('loading')}
        <small>
          {'Latest price'} · USD
          {changePct!==undefined&&<em className={changeClass}>{changePct>=0?'+':''}{(changePct*100).toFixed(2)}%</em>}
        </small>
      </div>
    </div>
    <div className="market-stage-chart">
      {current?<PriceChart price={current.price} assetId={current.id} running={marketDataStatus==='INTERNAL'}/>:<div className="market-chart-empty" role="status">{status==='error'?translate('marketDataUnavailableRightNow'):translate('loading')}</div>}
      <div className="chart-axis-labels"><span>{translate('demoPriceLabel')}</span><span>{translate('marketFeedLabel')}</span></div>
    </div>
    <div className="market-stage-footer">
      <div className="market-pair-list" aria-label={translate('marketView')}>
        {visibleMarkets.map(item=>{
          const pct=item.change;
          return <button key={item.id} type="button" className={item.id===selected?'is-selected':''} aria-pressed={item.id===selected} onClick={()=>setSelected(item.id)}>
            <span>{item.symbol}</span>
            <b>{item.price.toLocaleString(undefined,{maximumFractionDigits:4})}</b>
            {pct!==undefined&&<i className={pct>=0?'ticker-positive':'ticker-negative'}>{pct>=0?'+':''}{(pct*100).toFixed(2)}%</i>}
          </button>;
        })}
        {!visibleMarkets.length&&<span className="muted">{'No instruments available'}</span>}
      </div>
      <span className="market-feed-status"><span className={`source-dot ${marketDataStatus==='LIVE'?'is-live':''}`}/>{status==='ready'?marketDataStatus==='LIVE'?'Provider feed':marketDataStatus==='PARTIAL'?'Mixed or stale feed':'Internal reference feed':translate('feedStatus',{status:status.toUpperCase()})}</span>
    </div>
  </div>;
}
