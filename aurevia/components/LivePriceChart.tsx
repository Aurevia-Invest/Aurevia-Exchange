'use client';

import {useEffect,useRef,useState} from 'react';
import {CandlestickSeries,ColorType,createChart,HistogramSeries,type IChartApi,type ISeriesApi,type UTCTimestamp} from 'lightweight-charts';
import type {MarketCandle,MarketQuote,TimeframeId} from '@/lib/live-market';

type CandleSeries=ISeriesApi<'Candlestick'>;
type VolumeSeries=ISeriesApi<'Histogram'>;

export default function LivePriceChart({candles,quote,timeframe,loading,error,running=false}:{candles:MarketCandle[];quote?:MarketQuote;timeframe:TimeframeId;loading:boolean;error:string;running?:boolean}){
  const host=useRef<HTMLDivElement>(null);
  const chartRef=useRef<IChartApi|null>(null);
  const candleSeries=useRef<CandleSeries|null>(null);
  const volumeSeries=useRef<VolumeSeries|null>(null);
  const hasFit=useRef(false);
  const currentTimeframe=useRef(timeframe);
  const [hovered,setHovered]=useState<MarketCandle|null>(null);
  const [currentCandle,setCurrentCandle]=useState<MarketCandle|null>(null);
  const currentCandleRef=useRef<MarketCandle|null>(null);
  const quotePrice=quote?.price;
  const quoteVolume=quote?.volume;

  useEffect(()=>{
    if(!host.current)return;
    const chart=createChart(host.current,{
      autoSize:true,
      layout:{background:{type:ColorType.Solid,color:'#07131c'},textColor:'#8499a5',fontFamily:'Avenir Next, Segoe UI, sans-serif',fontSize:11},
      grid:{vertLines:{color:'rgba(122,156,171,.08)'},horzLines:{color:'rgba(122,156,171,.08)'}},
      crosshair:{vertLine:{color:'rgba(119,195,205,.5)',labelBackgroundColor:'#177d83'},horzLine:{color:'rgba(119,195,205,.5)',labelBackgroundColor:'#177d83'}},
      rightPriceScale:{borderColor:'rgba(122,156,171,.16)'},timeScale:{borderColor:'rgba(122,156,171,.16)',timeVisible:true,secondsVisible:true},
      localization:{priceFormatter:(value:number)=>value.toLocaleString(undefined,{maximumFractionDigits:value<10?5:2})},
    });
    const candlesApi=chart.addSeries(CandlestickSeries,{upColor:'#33c7a2',downColor:'#f06f76',borderVisible:false,wickUpColor:'#33c7a2',wickDownColor:'#f06f76'});
    const volumeApi=chart.addSeries(HistogramSeries,{priceFormat:{type:'volume'},priceScaleId:'volume',lastValueVisible:false,priceLineVisible:false});
    chart.priceScale('volume').applyOptions({scaleMargins:{top:.82,bottom:0},visible:false});
    const crosshairHandler=(param:Parameters<typeof chart.subscribeCrosshairMove>[0] extends (arg:infer T)=>void?T:never)=>{
      if(!param.time){setHovered(null);return;}
      const datum=param.seriesData.get(candlesApi);
      if(datum&&'open'in datum)setHovered({time:Number(param.time),open:datum.open,high:datum.high,low:datum.low,close:datum.close,volume:null});
      else setHovered(null);
    };
    chart.subscribeCrosshairMove(crosshairHandler);
    chartRef.current=chart;candleSeries.current=candlesApi;volumeSeries.current=volumeApi;
    const observer=new ResizeObserver(entries=>{const width=entries[0]?.contentRect.width;if(width)chart.applyOptions({width});});
    observer.observe(host.current);
    return()=>{observer.disconnect();chart.unsubscribeCrosshairMove(crosshairHandler);chart.remove();chartRef.current=null;candleSeries.current=null;volumeSeries.current=null;};
  },[]);

  useEffect(()=>{
    if(!candleSeries.current||!volumeSeries.current)return;
    if(!candles.length){
      candleSeries.current.setData([]);
      volumeSeries.current.setData([]);
      currentCandleRef.current=null;
      setCurrentCandle(null);
      hasFit.current=false;
      return;
    }
    candleSeries.current.setData(candles.map(({time,open,high,low,close})=>({time:time as UTCTimestamp,open,high,low,close})));
    volumeSeries.current.setData(candles.flatMap(candle=>candle.volume===null?[]:[{time:candle.time as UTCTimestamp,value:candle.volume,color:candle.close>=candle.open?'rgba(51,199,162,.32)':'rgba(240,111,118,.32)'}]));
    currentCandleRef.current=candles[candles.length-1];
    setCurrentCandle(currentCandleRef.current);
    if(!hasFit.current||currentTimeframe.current!==timeframe){chartRef.current?.timeScale().fitContent();hasFit.current=true;currentTimeframe.current=timeframe;}
  },[candles,timeframe]);

  useEffect(()=>{
    const latest=candles[candles.length-1];
    if(!latest||quotePrice===undefined||!candleSeries.current||!volumeSeries.current)return;
    const updated={...latest,close:quotePrice,high:Math.max(latest.high,quotePrice),low:Math.min(latest.low,quotePrice)};
    const time=latest.time as UTCTimestamp;
    candleSeries.current.update({...updated,time});
    currentCandleRef.current=updated;
    setCurrentCandle(updated);
    const volume=quoteVolume??latest.volume;
    if(volume!==null)volumeSeries.current.update({time,value:volume,color:updated.close>=updated.open?'rgba(51,199,162,.32)':'rgba(240,111,118,.32)'});
  },[candles,quotePrice,quoteVolume]);

  useEffect(()=>{
    if(!running)return;
    const timer=window.setInterval(()=>{
      const latest=currentCandleRef.current;
      const chartSeries=candleSeries.current;
      if(!latest||!chartSeries)return;
      const time=Math.floor(Date.now()/1000);
      if(time<latest.time)return;
      const price=quotePrice??latest.close;
      const updated=time===latest.time
        ?{...latest,high:Math.max(latest.high,price),low:Math.min(latest.low,price),close:price}
        :{time,open:price,high:price,low:price,close:price,volume:null};
      chartSeries.update({...updated,time:time as UTCTimestamp});
      currentCandleRef.current=updated;
      setCurrentCandle(updated);
    },1_000);
    return()=>window.clearInterval(timer);
  },[quotePrice,running]);

  const shown=hovered||currentCandle||candles[candles.length-1];
  return <div className="live-chart-wrap">
    <div className="live-chart-readout" aria-live="polite">
      {shown?<><span>O {formatChartPrice(shown.open)}</span><span>H {formatChartPrice(shown.high)}</span><span>L {formatChartPrice(shown.low)}</span><span>C {formatChartPrice(shown.close)}</span></>:<span>{loading?'Loading chart…':'OHLC values unavailable'}</span>}
      {quote&&<span className="live-chart-update">QUOTE {new Date(quote.updatedAt).toLocaleTimeString()}</span>}
    </div>
    <div className="live-chart-canvas" ref={host} role="img" aria-label="Interactive live market candlestick and volume chart"/>
    {error&&<div className="live-chart-message" role="status">{error}</div>}
    {loading&&!candles.length&&<div className="live-chart-message" role="status">Fetching historical candles…</div>}
  </div>;
}

function formatChartPrice(value:number){return value.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:value<10?5:2});}