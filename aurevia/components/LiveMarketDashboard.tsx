'use client';

import {useEffect,useMemo,useState} from 'react';
import {useSearchParams} from 'next/navigation';
import {QueryClient,QueryClientProvider,useQuery} from '@tanstack/react-query';
import {useSession} from 'next-auth/react';
import {io,type Socket} from 'socket.io-client';
import {Activity,ArrowLeftRight,Check,ChevronDown,GripVertical,ListPlus,Plus,RefreshCw,Search,Sparkles,Star,Trash2,X} from 'lucide-react';
import Nav from '@/components/Nav';
import LivePriceChart from '@/components/LivePriceChart';
import {COMPARISON_SYMBOLS,DEFAULT_WATCHLIST,MARKET_ASSETS,TIMEFRAMES,getMarketAsset,isExternalMarketDataSource,type MarketCandle,type MarketQuote,type TimeframeId} from '@/lib/live-market';
import {setMarketWatchlistUserScope,useMarketWatchlists} from '@/lib/market-watchlists';

type QuoteError={asset:NonNullable<ReturnType<typeof getMarketAsset>>;error:string};
type QuotesResponse={quotes:Array<MarketQuote|QuoteError>;source:string};
type HistoryResponse={quote:MarketQuote|null;candles:MarketCandle[];timeframe:TimeframeId;interval:string;source?:string};
type ReturnMetric={label:string;days:number;value:number|null};
type MarketAnalysis={summary:string;observations:Array<{symbol:string;observation:string}>;caveat:string};
type MarketCategory='Favorites'|'Forex'|'Crypto'|'Stocks'|'Indices';

const TICKER_SYMBOLS=['BTC','DJI','MERV','DAX','IBEX','NIKKEI','EURGBP','SPX','NASDAQ'];
const MARKET_CATEGORIES:MarketCategory[]=['Favorites','Forex','Crypto','Stocks','Indices'];

export default function LiveMarketDashboard(){
  const [queryClient]=useState(()=>new QueryClient({defaultOptions:{queries:{staleTime:4_000,refetchOnWindowFocus:true,retry:1}}}));
  return <QueryClientProvider client={queryClient}><LiveMarketDashboardContent/></QueryClientProvider>;
}

function LiveMarketDashboardContent(){
  const {data:session,status:sessionStatus}=useSession();
  const searchParams=useSearchParams();
  const requestedSymbol=searchParams.get('symbol')?.toUpperCase()||'';
  const watchlists=useMarketWatchlists(state=>state.watchlists);
  const activeWatchlistId=useMarketWatchlists(state=>state.activeWatchlistId);
  const selectedSymbol=useMarketWatchlists(state=>state.selectedSymbol);
  const setActiveWatchlist=useMarketWatchlists(state=>state.setActiveWatchlist);
  const selectSymbol=useMarketWatchlists(state=>state.selectSymbol);
  const createWatchlist=useMarketWatchlists(state=>state.createWatchlist);
  const deleteActiveWatchlist=useMarketWatchlists(state=>state.deleteActiveWatchlist);
  const addSymbol=useMarketWatchlists(state=>state.addSymbol);
  const removeSymbol=useMarketWatchlists(state=>state.removeSymbol);
  const reorderSymbol=useMarketWatchlists(state=>state.reorderSymbol);
  const [timeframe,setTimeframe]=useState<TimeframeId>('1d');
  const [streamUpdates,setStreamUpdates]=useState<Record<string, Partial<MarketQuote>>>({});
  const [sidebarOpen,setSidebarOpen]=useState(false);
  const [showAddSymbol,setShowAddSymbol]=useState(false);
  const [showNewList,setShowNewList]=useState(false);
  const [newListName,setNewListName]=useState('');
  const [symbolSearch,setSymbolSearch]=useState('');
  const [marketCategory,setMarketCategory]=useState<MarketCategory>('Favorites');
  const [draggedSymbol,setDraggedSymbol]=useState('');
  const [watchlistScopeReady,setWatchlistScopeReady]=useState(false);
  const [watchlistScopeError,setWatchlistScopeError]=useState('');
  const [marketAnalysis,setMarketAnalysis]=useState<MarketAnalysis|null>(null);
  const [marketAnalysisError,setMarketAnalysisError]=useState('');
  const [marketAnalysisBusy,setMarketAnalysisBusy]=useState(false);
  const activeList=watchlists.find(list=>list.id===activeWatchlistId)||watchlists[0];
  const selectedAsset=getMarketAsset(selectedSymbol)||getMarketAsset('DJI')!;
  const quoteIds=Array.from(new Set([...activeList.symbols,...DEFAULT_WATCHLIST,...COMPARISON_SYMBOLS,selectedAsset.id]));
  const batchQuery=useQuery({queryKey:['live-market-quotes',quoteIds.join(',')],queryFn:()=>fetchQuotes(quoteIds),refetchInterval:30_000});
  const selectedQuery=useQuery({queryKey:['live-market-quote',selectedAsset.id],queryFn:async()=>{
    const result=await fetchQuotes([selectedAsset.id]);
    const failed=result.quotes.find(item=>item.asset.id===selectedAsset.id&&!isQuote(item));
    if(failed&&!isQuote(failed))throw new Error(failed.error);
    return result;
  },refetchInterval:30_000});
  const historyQuery=useQuery({queryKey:['live-market-history',selectedAsset.id,timeframe],queryFn:()=>fetchHistory(selectedAsset.id,timeframe),refetchInterval:timeframe==='1d'||timeframe==='5d'?15_000:60_000});
  const annualQuery=useQuery({queryKey:['live-market-history',selectedAsset.id,'1y'],queryFn:()=>fetchHistory(selectedAsset.id,'1y'),refetchInterval:60_000,staleTime:45_000,enabled:timeframe!=='1y'});
  const batchQuotes=useMemo(()=>{
    const map=new Map((batchQuery.data?.quotes||[]).map(item=>[item.asset.id,item]));
    for(const [symbol,streamQuote] of Object.entries(streamUpdates)){
      const current=map.get(symbol);
      if(current&&isQuote(current)&&streamQuote.price!==undefined){
        map.set(symbol,{...current,price:streamQuote.price,change:streamQuote.change ?? current.change,changePercent:streamQuote.changePercent ?? current.changePercent,updatedAt:streamQuote.updatedAt ?? current.updatedAt,source:streamQuote.source ?? current.source,isStale:false});
      }else if(streamQuote.asset){
        map.set(symbol,streamQuote as MarketQuote);
      }
    }
    return map;
  },[batchQuery.data?.quotes,streamUpdates]);
  const activeQuote=(batchQuotes.get(selectedAsset.id) && isQuote(batchQuotes.get(selectedAsset.id)) ? batchQuotes.get(selectedAsset.id) as MarketQuote : getQuote(selectedQuery.data,selectedAsset.id)) || historyQuery.data?.quote;
  const error=historyQuery.error instanceof Error?historyQuery.error.message:selectedQuery.error instanceof Error?selectedQuery.error.message:'';
  const activeQuoteIsExternal=!!activeQuote&&isExternalMarketDataSource(activeQuote.source);
  const activeQuoteStatus=!activeQuote?'Unavailable':activeQuote.isStale?'Stale':activeQuoteIsExternal?'Current':'Indicative';
  const liveQuotes=[...batchQuotes.values()].filter((item):item is MarketQuote=>isQuote(item)&&!item.isStale);
  const gainers=[...liveQuotes].filter(item=>item.changePercent>0).sort((a,b)=>b.changePercent-a.changePercent).slice(0,3);
  const losers=[...liveQuotes].filter(item=>item.changePercent<0).sort((a,b)=>a.changePercent-b.changePercent).slice(0,3);

  useEffect(()=>{if(!getMarketAsset(selectedSymbol))selectSymbol('DJI')},[selectedSymbol,selectSymbol]);
  useEffect(()=>{if(getMarketAsset(requestedSymbol))selectSymbol(requestedSymbol)},[requestedSymbol,selectSymbol]);
  useEffect(()=>{
    const socket:Socket = io({path:'/socket.io',transports:['websocket'],autoConnect:true,reconnection:true,reconnectionDelay:700});
    const onMarketUpdate=(updates:Array<{symbol:string;price:number;change:number;changePercent:number;source:string;dataMode:'SIMULATED'|'LIVE';lastUpdatedAt:string}>)=>{
      setStreamUpdates(current=>{
        const next={...current};
        for(const entry of updates){
          const isProviderUpdate=entry.dataMode==='LIVE'&&(entry.source==='Finnhub'||entry.source.startsWith('Alpaca'));
          if(!isProviderUpdate&&!(entry.dataMode==='SIMULATED'&&!activeQuoteIsExternal))continue;
          const normalizedSymbol=entry.symbol.toUpperCase().replace(/[^A-Z0-9]/g,'');
          const asset=MARKET_ASSETS.find(item=>
            [item.id,item.ticker].some(symbol=>symbol.toUpperCase().replace(/[^A-Z0-9]/g,'')===normalizedSymbol),
          )||getMarketAsset(entry.symbol);
          if(!asset)continue;
          const previousClose=entry.dataMode==='SIMULATED'&&entry.change!==-1?entry.price/(1+entry.change):null;
          next[asset.id]={asset,price:entry.price,change:previousClose===null?entry.change:entry.price-previousClose,changePercent:entry.changePercent,previousClose,open:null,volume:null,dayLow:null,dayHigh:null,fiftyTwoWeekLow:null,fiftyTwoWeekHigh:null,updatedAt:entry.lastUpdatedAt,isStale:false,source:entry.source,sparkline:[]};
        }
        return next;
      });
    };
    socket.on('market:update',onMarketUpdate);
    return ()=>{socket.off('market:update',onMarketUpdate);socket.disconnect();};
  },[activeQuoteIsExternal]);
  useEffect(()=>{
    if(sessionStatus==='loading')return;
    let active=true;
    setWatchlistScopeReady(false);
    setWatchlistScopeError('');
    void setMarketWatchlistUserScope(session?.user?.id||null).then(()=>{
      if(active)setWatchlistScopeReady(true);
    }).catch(()=>{
      if(active){setWatchlistScopeError('Unable to restore this account’s watchlists.');setWatchlistScopeReady(true);}
    });
    return()=>{active=false};
  },[session?.user?.id,sessionStatus]);

  function submitWatchlist(event:React.FormEvent<HTMLFormElement>){
    event.preventDefault();
    const name=newListName.trim();
    if(!name)return;
    createWatchlist(name);setNewListName('');setShowNewList(false);
  }

  function onDrop(event:React.DragEvent<HTMLButtonElement>,target:string){
    event.preventDefault();
    const source=event.dataTransfer.getData('text/plain')||draggedSymbol;
    if(source)reorderSymbol(source,target);
    setDraggedSymbol('');
  }

  async function analyzeMarket(){
    setMarketAnalysisBusy(true);
    setMarketAnalysis(null);
    setMarketAnalysisError('');
    try{
      const symbols=[...new Set([selectedAsset.id,...activeList.symbols])].slice(0,6);
      const response=await fetch('/api/market/analysis',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({symbols})});
      const result=await response.json();
      if(!response.ok)throw new Error(result.error||'Market analysis is unavailable.');
      setMarketAnalysis(result.analysis as MarketAnalysis);
    }catch(exception){
      setMarketAnalysisError(exception instanceof Error?exception.message:'Market analysis is unavailable.');
    }finally{
      setMarketAnalysisBusy(false);
    }
  }

  const filteredAssets=MARKET_ASSETS.filter(asset=>!activeList.symbols.includes(asset.id)&&`${asset.id} ${asset.name} ${asset.ticker}`.toLowerCase().includes(symbolSearch.toLowerCase())).slice(0,7);
  const performance=returnMetrics(annualQuery.data?.candles||historyQuery.data?.candles||[],activeQuote||undefined);
  const todayRange=activeQuote?.dayLow!==null&&activeQuote?.dayLow!==undefined&&activeQuote?.dayHigh!==null&&activeQuote?.dayHigh!==undefined?activeQuote.dayHigh-activeQuote.dayLow:null;
  const todayPosition=todayRange&&activeQuote?.dayLow!==null&&activeQuote?.dayLow!==undefined?Math.max(0,Math.min(100,(activeQuote.price-activeQuote.dayLow)/todayRange*100)):50;
  const marketPulseAssets=MARKET_ASSETS.filter(asset=>marketCategory==='Favorites'
    ?activeList.symbols.includes(asset.id)
    :marketCategory==='Forex'?asset.type==='FOREX'
    :marketCategory==='Crypto'?asset.type==='CRYPTO'
    :marketCategory==='Stocks'?asset.type==='STOCK'
    :asset.type==='INDEX');

  return <><Nav/><main className="live-market-page">
    <div className="live-market-topline">
      <div className="live-market-heading"><span>GLOBAL MARKETS <i/> {activeQuoteIsExternal&&!activeQuote?.isStale?'CURRENT QUOTE':activeQuote?'INDICATIVE PRICES':'QUOTE UNAVAILABLE'}</span><h1>Markets</h1><p>Quotes may be delayed. Internal reference prices are estimates and are not executable.</p></div>
      <div className={`live-source-status ${activeQuote?.isStale?'is-stale':''} ${activeQuoteIsExternal&&!activeQuote?.isStale?'is-live':''} ${activeQuote&&!activeQuoteIsExternal?'is-internal':''}`}><span className="live-status-dot"/>{`Price status: ${activeQuoteStatus}`} <small>{activeQuote?`Updated ${formatTime(activeQuote.updatedAt)}`:'Market prices are temporarily unavailable'}</small></div>
    </div>

    <section className="live-ticker" aria-label="Market ticker">
      <div className="live-ticker-label"><Activity size={14}/> MARKET DATA</div>
      <div className="live-ticker-track">
        {TICKER_SYMBOLS.map(id=>{
          const item=batchQuotes.get(id);
          return <button type="button" className={`live-ticker-item ${selectedAsset.id===id?'is-active':''}`} key={id} onClick={()=>selectSymbol(id)}>
            <span>{id}</span>{isQuote(item)?<><strong>{formatPrice(item.price,item.asset.currency,item.asset.type==='FOREX')}</strong><em className={tone(item.changePercent)}>{item.changePercent>=0?'▲':'▼'} {formatPercent(item.changePercent)}</em></>:<small className="live-unavailable">{item?'Unavailable':'···'}</small>}
          </button>;
        })}
      </div>
    </section>

    <section className="live-movers" aria-label="Market movers">
      {[{title:'Top gainers',items:gainers},{title:'Top decliners',items:losers}].map(group=><div className="live-movers-group" key={group.title}>
        <h2>{group.title}</h2>
        <div>{group.items.length?group.items.map(quote=><button type="button" className="live-mover" key={quote.asset.id} onClick={()=>selectSymbol(quote.asset.id)}><span><b>{quote.asset.id}</b><small>{quote.asset.name}</small></span><strong className={tone(quote.changePercent)}>{formatPercent(quote.changePercent)}</strong></button>):<p>No current market prices available.</p>}</div>
      </div>)}
    </section>

    <div className={`live-market-grid ${sidebarOpen?'sidebar-mobile-open':''}`}>
      <aside className="live-sidebar" aria-label="Watchlists" aria-busy={!watchlistScopeReady}>
        <div className="live-sidebar-heading"><div><span>WATCHLIST</span><h2>{activeList.name}</h2></div><button className="live-icon-button live-mobile-close" type="button" aria-label="Close watchlists" onClick={()=>setSidebarOpen(false)}><X size={17}/></button></div>
        {watchlistScopeError&&<div className="live-data-alert" role="alert">{watchlistScopeError}</div>}
        <div className="live-watchlist-controls">
          <label className="sr-only" htmlFor="watchlist-select">Watchlist</label>
          <select id="watchlist-select" value={activeList.id} onChange={event=>setActiveWatchlist(event.target.value)}>
            {watchlists.map(list=><option key={list.id} value={list.id}>{list.name}</option>)}
          </select><ChevronDown size={14}/>
          <button className="live-icon-button" type="button" aria-label="Create watchlist" title="New watchlist" onClick={()=>setShowNewList(!showNewList)}><ListPlus size={16}/></button>
        </div>
        {showNewList&&<form className="live-new-list" onSubmit={submitWatchlist}><input autoFocus value={newListName} onChange={event=>setNewListName(event.target.value)} placeholder="Watchlist name" aria-label="New watchlist name" maxLength={36}/><button type="submit" aria-label="Save watchlist" disabled={!newListName.trim()}><Check size={15}/></button></form>}
        <div className="live-watchlist-actions"><span>{activeList.symbols.length} ASSETS</span><button type="button" onClick={()=>setShowAddSymbol(!showAddSymbol)}><Plus size={13}/> Add symbol</button>{watchlists.length>1&&<button type="button" title="Delete this watchlist" aria-label="Delete this watchlist" onClick={deleteActiveWatchlist}><Trash2 size={13}/></button>}</div>
        {showAddSymbol&&<div className="live-symbol-picker"><label className="live-search"><Search size={14}/><input value={symbolSearch} onChange={event=>setSymbolSearch(event.target.value)} placeholder="Search symbol" aria-label="Search for a symbol to add"/></label><div className="live-symbol-results">{filteredAssets.length?filteredAssets.map(asset=><button type="button" key={asset.id} onClick={()=>{addSymbol(asset.id);setSymbolSearch('')}}><span><b>{asset.id}</b><small>{asset.name}</small></span><Plus size={14}/></button>):<p>No more symbols available.</p>}</div></div>}

        <div className="live-watchlist-items" aria-label="Watchlist assets">
          {activeList.symbols.map(id=>{
            const asset=getMarketAsset(id);
            const item=batchQuotes.get(id);
            if(!asset)return null;
            return <button type="button" key={id} draggable onDragStart={event=>{setDraggedSymbol(id);event.dataTransfer.setData('text/plain',id)}} onDragOver={event=>event.preventDefault()} onDrop={event=>onDrop(event,id)} onDragEnd={()=>setDraggedSymbol('')} className={`live-watch-row ${selectedAsset.id===id?'is-selected':''} ${draggedSymbol===id?'is-dragged':''}`} onClick={()=>selectSymbol(id)} aria-pressed={selectedAsset.id===id}>
              <GripVertical className="live-drag-handle" size={14}/><span className="live-watch-main"><b>{id}</b><small>{asset.name}</small></span>
              {isQuote(item)?<><Sparkline values={item.sparkline} positive={item.changePercent>=0}/><span className="live-watch-numbers"><b>{formatPrice(item.price,item.asset.currency,item.asset.type==='FOREX')}</b><small className={tone(item.changePercent)}>{formatPercent(item.changePercent)}</small></span></>:<span className="live-watch-numbers"><b className="live-muted">{item?'N/A':'···'}</b><small>{item?'Unavailable':'Loading'}</small></span>}
              <span role="presentation" className="live-remove-symbol" title={`Remove ${id}`} onClick={event=>{event.stopPropagation();removeSymbol(id)}}><X size={13}/></span>
            </button>;
          })}
          {!activeList.symbols.length&&<div className="live-empty-watchlist">Add symbols to follow their quotes.</div>}
        </div>

        <div className="live-suggestions"><div className="live-sidebar-heading"><div><span>DISCOVER</span><h2>Suggestions for you</h2></div><Star size={15}/></div>{['NVDA','AAPL','MSFT','TSLA'].filter(id=>!activeList.symbols.includes(id)).map(id=>{const asset=getMarketAsset(id)!;return <div className="live-suggestion" key={id}><button type="button" onClick={()=>selectSymbol(id)}><b>{id}</b><small>{asset.name}</small></button><button className="live-add-suggestion" type="button" aria-label={`Add ${id} to watchlist`} onClick={()=>addSymbol(id)}><Plus size={14}/></button></div>})}</div>
        <div className="live-sidebar-foot">Drag assets to reorder<br/>Your watchlists are saved to your account on this device.</div>
      </aside>

      <section className="live-main-column">
        <section className="user-market-assets live-market-pulse" aria-label="Supported market quotes">
          <header className="user-market-assets-heading"><div><span className="user-dashboard-eyebrow">SUPPORTED INSTRUMENTS</span><h2>Market pulse</h2></div><small>{batchQuery.isLoading?'Loading market prices':batchQuery.isError?'Market prices unavailable':'Market quotes'}</small></header>
          <div className="user-market-categories" role="group" aria-label="Filter market instruments">{MARKET_CATEGORIES.map(category=><button key={category} type="button" aria-pressed={marketCategory===category} className={marketCategory===category?'is-selected':''} onClick={()=>setMarketCategory(category)}>{category}</button>)}</div>
          {marketPulseAssets.length?<div className="user-market-asset-grid">{marketPulseAssets.map(asset=>{
            const quote=batchQuotes.get(asset.id);
            return <button key={asset.id} type="button" className={`user-market-asset ${selectedAsset.id===asset.id?'is-selected':''}`} onClick={()=>selectSymbol(asset.id)} aria-pressed={selectedAsset.id===asset.id}>
              <span><b>{asset.id}</b><small>{asset.name}</small></span>
              <strong>{isQuote(quote)?formatPrice(quote.price,asset.currency,asset.type==='FOREX'):quote?'Unavailable':'—'}</strong>
              <em className={isQuote(quote)?tone(quote.changePercent):''}>{isQuote(quote)?`${quote.changePercent>=0?'+':''}${quote.changePercent.toFixed(2)}%`:quote?'Quote unavailable':'Loading quote'}</em>
            </button>;
          })}</div>:<div className="live-empty-watchlist">No supported instruments are saved to this watchlist yet.</div>}
        </section>
        <div className="live-chart-card">
          <div className="live-asset-title">
            <div className="live-asset-id"><span>{symbolBadge(selectedAsset.type)}</span><div><div className="live-symbol-line"><span>{selectedAsset.id}</span><span className="live-market-tag">{marketTypeLabel(selectedAsset.type)}</span></div><h2>{selectedAsset.name}</h2></div></div>
            <button className="live-mobile-list-button" type="button" aria-expanded={sidebarOpen} onClick={()=>setSidebarOpen(!sidebarOpen)}><ArrowLeftRight size={15}/> Watchlists</button>
          </div>
          <div className="live-price-line">
            <strong>{activeQuote?formatPrice(activeQuote.price,selectedAsset.currency,selectedAsset.type==='FOREX'):historyQuery.isLoading?'···':'—'}</strong>
            {activeQuote&&<span className={`live-change ${tone(activeQuote.changePercent)}`}><b>{activeQuote.change>=0?'+':''}{formatPrice(activeQuote.change,selectedAsset.currency,selectedAsset.type==='FOREX')}</b><b>({formatPercent(activeQuote.changePercent)})</b></span>}
            <span className="live-market-open-state"><i/> {marketOpenLabel(selectedAsset.type)}</span>
          </div>
          <div className="live-chart-metadata"><span>{activeQuote?.isStale?'Last quote · STALE':'Last quote'} {activeQuote?formatTime(activeQuote.updatedAt):'—'}</span><button type="button" className="live-refresh-button" aria-label="Refresh quotes" onClick={()=>{void selectedQuery.refetch();void batchQuery.refetch();void historyQuery.refetch()}}><RefreshCw size={13} className={selectedQuery.isFetching?'is-spinning':''}/> Refresh</button></div>
          {session?.user?.id&&<section className="live-market-ai" aria-label="AI market context">
            <button type="button" className="btn bg-white/5" onClick={()=>void analyzeMarket()} disabled={marketAnalysisBusy}>
              {marketAnalysisBusy?<RefreshCw size={14} className="is-spinning"/>:<Sparkles size={14}/>}
              {marketAnalysisBusy?'Analyzing market data…':'Explain market movement'}
            </button>
            {marketAnalysisError&&<p className="live-data-alert" role="alert">{marketAnalysisError}</p>}
            {marketAnalysis&&<div className="live-data-alert" aria-live="polite">
              <strong>Generated market context</strong>
              <p>{marketAnalysis.summary}</p>
              {marketAnalysis.observations.length>0&&<ul>{marketAnalysis.observations.map(item=><li key={item.symbol}><b>{item.symbol}:</b> {item.observation}</li>)}</ul>}
              <p>{marketAnalysis.caveat}</p>
            </div>}
          </section>}
          <div className="live-timeframes" role="group" aria-label="Chart interval">{TIMEFRAMES.map(item=><button type="button" key={item.id} className={timeframe===item.id?'is-active':''} aria-pressed={timeframe===item.id} onClick={()=>setTimeframe(item.id)}>{item.label}</button>)}</div>
          <LivePriceChart candles={historyQuery.data?.candles||[]} quote={activeQuote||undefined} timeframe={timeframe} loading={historyQuery.isLoading} error={historyQuery.error instanceof Error?historyQuery.error.message:''} running={historyQuery.data?.source==='Aurevia Internal'||activeQuote?.source==='Aurevia Internal'}/>
          {error&&<div className="live-data-alert" role="alert">The chart could not be updated. Available historical data is preserved. <button type="button" onClick={()=>void historyQuery.refetch()}>Retry</button></div>}
          <div className="live-chart-stats">
            <Metric label="Volume" value={activeQuote?.volume===null||activeQuote?.volume===undefined?'—':formatCompact(activeQuote.volume)}/>
            <Metric label="Open" value={activeQuote?formatPrice(activeQuote.open??NaN,selectedAsset.currency,selectedAsset.type==='FOREX'):'—'}/>
            <Metric label="Previous close" value={activeQuote?formatPrice(activeQuote.previousClose??NaN,selectedAsset.currency,selectedAsset.type==='FOREX'):'—'}/>
            <Metric label="52-week low" value={activeQuote?formatPrice(activeQuote.fiftyTwoWeekLow??NaN,selectedAsset.currency,selectedAsset.type==='FOREX'):'—'}/>
            <Metric label="52-week high" value={activeQuote?formatPrice(activeQuote.fiftyTwoWeekHigh??NaN,selectedAsset.currency,selectedAsset.type==='FOREX'):'—'}/>
          </div>
          {todayPosition!==50&&<div className="live-day-range"><div><span>Day range</span><span>{formatPrice(activeQuote!.dayLow!,selectedAsset.currency,selectedAsset.type==='FOREX')} <b>{formatPrice(activeQuote!.dayHigh!,selectedAsset.currency,selectedAsset.type==='FOREX')}</b></span></div><div className="live-range-track"><i style={{left:`${todayPosition}%`}}/></div></div>}
          <div className="live-performance">{performance.map(metric=><div key={metric.label}><span>{metric.label}</span><b className={metric.value===null?'':tone(metric.value)}>{metric.value===null?'—':formatPercent(metric.value)}</b></div>)}</div>
        </div>

        <section className="live-comparison-section"><div className="live-section-title"><div><span>MARKET BENCHMARKS</span><h2>Quick comparison</h2></div><span className="live-source-note">Daily change · current quote</span></div><div className="live-comparison-grid">{COMPARISON_SYMBOLS.map(id=>{const quote=batchQuotes.get(id);const asset=getMarketAsset(id)!;return <button type="button" className={`live-comparison-card ${selectedAsset.id===id?'is-active':''}`} key={id} onClick={()=>selectSymbol(id)}><span>{id}</span><small>{asset.name}</small><strong className={isQuote(quote)?tone(quote.changePercent):''}>{isQuote(quote)?formatPercent(quote.changePercent):'—'}</strong><em>{isQuote(quote)?formatPrice(quote.price,quote.asset.currency):quote?'Unavailable':'Updating'}</em></button>})}</div></section>
      </section>

      <aside className="live-right-panel">
        <section className="live-right-card"><div className="live-section-title"><div><span>ASSET SUMMARY</span><h2>Key data</h2></div></div>
          <div className="live-key-row"><span>Price</span><b>{activeQuote?formatPrice(activeQuote.price,selectedAsset.currency,selectedAsset.type==='FOREX'):'—'}</b></div>
          <div className="live-key-row"><span>Bid</span><b>{activeQuote?.bid===null||activeQuote?.bid===undefined?'—':formatPrice(activeQuote.bid,selectedAsset.currency,selectedAsset.type==='FOREX')}</b></div>
          <div className="live-key-row"><span>Ask</span><b>{activeQuote?.ask===null||activeQuote?.ask===undefined?'—':formatPrice(activeQuote.ask,selectedAsset.currency,selectedAsset.type==='FOREX')}</b></div>
          <div className="live-key-row"><span>Change</span><b className={activeQuote?tone(activeQuote.changePercent):''}>{activeQuote?formatPercent(activeQuote.changePercent):'—'}</b></div>
          <div className="live-key-row"><span>Currency</span><b>{selectedAsset.currency}</b></div>
          <div className="live-key-row"><span>Type</span><b>{marketTypeLabel(selectedAsset.type)}</b></div>
          <div className="live-key-row"><span>Day range</span><b>{activeQuote?.dayLow!==null&&activeQuote?.dayLow!==undefined&&activeQuote.dayHigh!==null?`${formatPrice(activeQuote.dayLow,selectedAsset.currency)} – ${formatPrice(activeQuote.dayHigh,selectedAsset.currency)}`:'—'}</b></div>
        </section>
        <p className="live-disclaimer">Market prices are informational and may be delayed. Internal reference prices are estimates, not executable quotes. REAL account orders use simulated execution, not live market transactions.</p>
      </aside>
    </div>
  </main></>;
}

function Metric({label,value}:{label:string;value:string}){return <div className="live-stat"><span>{label}</span><b>{value}</b></div>}

function Sparkline({values,positive}:{values:number[];positive:boolean}){
  if(values.length<2)return <span className="live-spark-empty" aria-label="Not enough historical data"/>;
  const low=Math.min(...values),high=Math.max(...values),range=high-low||1;
  const points=values.map((value,index)=>`${(index/(values.length-1))*100},${26-((value-low)/range)*22}`).join(' ');
  return <svg className={`live-sparkline ${positive?'is-up':'is-down'}`} viewBox="0 0 100 28" preserveAspectRatio="none" role="img" aria-label="Intraday price trend"><polyline points={points}/></svg>;
}

function isQuote(item:MarketQuote|QuoteError|undefined):item is MarketQuote{return !!item&&'price'in item;}
function getQuote(data:QuotesResponse|undefined,id:string){return data?.quotes.find(item=>item.asset.id===id&&isQuote(item)) as MarketQuote|undefined;}

async function fetchQuotes(symbols:string[]):Promise<QuotesResponse>{
  const response=await fetch(`/api/live-markets?symbols=${encodeURIComponent(symbols.join(','))}`,{cache:'no-store'});
  const body=await response.json();
  if(!response.ok)throw new Error(body.error||'Live market quotes are unavailable.');
  return body as QuotesResponse;
}

async function fetchHistory(symbol:string,timeframe:TimeframeId):Promise<HistoryResponse>{
  const response=await fetch(`/api/live-markets/${encodeURIComponent(symbol)}?timeframe=${timeframe}`,{cache:'no-store'});
  const body=await response.json();
  if(!response.ok)throw new Error(body.error||'Historical market data is unavailable.');
  return body as HistoryResponse;
}

function returnMetrics(candles:MarketCandle[],quote?:MarketQuote):ReturnMetric[]{
  const days:[string,number][]=[['1m',30],['3m',90],['6m',180],['1y',365]];
  const current=quote?.price??candles[candles.length-1]?.close;
  return days.map(([label,count])=>{
    const target=Date.now()/1000-count*24*60*60;
    const past=candles.find(candle=>candle.time>=target)||candles[0];
    return {label,days:count,value:current&&past?.close?(current/past.close-1)*100:null};
  });
}

function formatPrice(value:number,currency:string,forex=false){
  if(!Number.isFinite(value))return '—';
  try{return new Intl.NumberFormat('en-US',{style:'currency',currency,minimumFractionDigits:forex?4:2,maximumFractionDigits:forex?5:2}).format(value)}catch{return value.toLocaleString(undefined,{maximumFractionDigits:5})}
}
function formatPercent(value:number){return `${value>=0?'+':''}${value.toFixed(2)}%`}
function formatCompact(value:number){return new Intl.NumberFormat('en-US',{notation:'compact',maximumFractionDigits:2}).format(value)}
function formatTime(value:string){return new Date(value).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit'})}
function tone(value:number){return value>=0?'is-positive':'is-negative'}
function marketTypeLabel(type:string){return ({INDEX:'INDEX',STOCK:'STOCK',FOREX:'FOREX',CRYPTO:'CRYPTO'})[type as 'INDEX'|'STOCK'|'FOREX'|'CRYPTO']||type}
function marketOpenLabel(type:string){return type==='CRYPTO'?'Market open 24/7':'Market · latest available session'}
function symbolBadge(type:string){return ({INDEX:'↗',STOCK:'◈',FOREX:'⇄',CRYPTO:'₿'})[type as 'INDEX'|'STOCK'|'FOREX'|'CRYPTO']||'↗'}