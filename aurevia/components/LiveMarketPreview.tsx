'use client';

import {useEffect,useState} from 'react';
import Link from 'next/link';
import {ArrowUpRight,RefreshCw} from 'lucide-react';
import type {MarketQuote} from '@/lib/live-market';

type QuoteError={asset:{id:string;name:string;currency:string};error:string};
type QuoteItem=MarketQuote|QuoteError;
type QuoteResponse={quotes:QuoteItem[]};
const symbols=['SPX','NASDAQ','DJI','AAPL','MSFT','BTC'];

function isQuote(item:QuoteItem):item is MarketQuote{return 'price'in item;}
function formatPrice(quote:MarketQuote){
 try{return new Intl.NumberFormat('en-US',{style:'currency',currency:quote.asset.currency,maximumFractionDigits:quote.asset.type==='FOREX'?5:2}).format(quote.price);}
 catch{return quote.price.toLocaleString(undefined,{maximumFractionDigits:5});}
}

export default function LiveMarketPreview(){
 const [quotes,setQuotes]=useState<QuoteItem[]>([]);
 const [loading,setLoading]=useState(true);
 const [error,setError]=useState('');

 useEffect(()=>{
  let active=true;
  async function refresh(){
   try{
    const response=await fetch(`/api/live-markets?symbols=${symbols.join(',')}`,{cache:'no-store'});
    const result=await response.json() as QuoteResponse;
    if(!response.ok)throw new Error('Live market quotes are unavailable.');
    if(active){setQuotes(result.quotes);setError('');}
   }catch(exception){if(active)setError(exception instanceof Error?exception.message:'Live market quotes are unavailable.');}
   finally{if(active)setLoading(false);}
  }
  void refresh();
  const timer=window.setInterval(()=>void refresh(),30_000);
  return()=>{active=false;window.clearInterval(timer);};
 },[]);

 return <section className="live-market-preview" aria-label="Live market quotes">
    <header><div><span className="account-kicker">MARKET OVERVIEW</span><h2>Current market prices</h2><p>Read-only quotes · may be delayed</p></div><Link className="text-link" href="/markets">Open markets <ArrowUpRight size={14}/></Link></header>
  {error&&<p className="live-market-preview-error" role="alert">{error} Retry is automatic.</p>}
  {loading&&!quotes.length?<p className="account-empty" role="status">Loading market prices…</p>:<div className="live-market-preview-grid">{quotes.map(item=>{
   if(!isQuote(item))return <article className="live-market-preview-row is-unavailable" key={item.asset.id}><div><b>{item.asset.id}</b><span>{item.asset.name}</span></div><strong>Unavailable</strong><small>{item.error}</small></article>;
   return <article className={`live-market-preview-row ${item.isStale?'is-stale':''}`} key={item.asset.id}><div><b>{item.asset.id}</b><span>{item.asset.name}</span></div><strong>{formatPrice(item)}</strong><span className={item.changePercent>=0?'text-profit':'text-loss'}>{item.changePercent>=0?'+':''}{item.changePercent.toFixed(2)}%</span><small>{item.isStale?`Stale · last quote ${new Date(item.updatedAt).toLocaleTimeString()}`:`Updated ${new Date(item.updatedAt).toLocaleTimeString()}`}</small></article>;
  })}</div>}
    <footer><span>Prices are informational</span><button type="button" className="text-link" onClick={()=>{setLoading(true);setError('');void fetch(`/api/live-markets?symbols=${symbols.join(',')}`,{cache:'no-store'}).then(async response=>{const result=await response.json() as QuoteResponse;if(!response.ok)throw new Error('Market prices are unavailable.');setQuotes(result.quotes);}).catch(exception=>setError(exception instanceof Error?exception.message:'Market prices are unavailable.')).finally(()=>setLoading(false));}}><RefreshCw size={13}/> Refresh</button></footer>
 </section>;
}