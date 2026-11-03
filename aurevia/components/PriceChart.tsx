'use client';

import {useEffect,useRef,useState} from 'react';
import {CandlestickSeries,ColorType,createChart,type IChartApi,type ISeriesApi,type UTCTimestamp} from 'lightweight-charts';
import {updateChartCandle,type ChartCandle} from '@/lib/chart-candles';

type CandleSeries=ISeriesApi<'Candlestick'>;
type CandleRow={ts?:string;time?:number;open:string|number;high:string|number;low:string|number;close:string|number;volume?:string|number|null};

export default function PriceChart({price,instrumentId,assetId,limit=500,running=false}:{price:number;instrumentId?:string;assetId?:string;limit?:number;running?:boolean}){
	const host=useRef<HTMLDivElement>(null);
	const chart=useRef<IChartApi|null>(null);
	const series=useRef<CandleSeries|null>(null);
	const hasFit=useRef(false);
	const priceRef=useRef(price);
	const [candles,setCandles]=useState<ChartCandle[]>([]);
	const [historyError,setHistoryError]=useState('');

	useEffect(()=>{priceRef.current=price},[price]);

	useEffect(()=>{
		if(!host.current)return;
		const instance=createChart(host.current,{
			autoSize:true,
			layout:{background:{type:ColorType.Solid,color:'transparent'},textColor:'#82918a',fontFamily:'Avenir Next, Segoe UI, sans-serif',fontSize:11},
			grid:{vertLines:{color:'rgba(130,145,138,.08)'},horzLines:{color:'rgba(130,145,138,.08)'}},
			rightPriceScale:{borderColor:'rgba(130,145,138,.16)'},
			timeScale:{borderColor:'rgba(130,145,138,.16)',timeVisible:true,secondsVisible:true},
			localization:{priceFormatter:(value:number)=>value.toLocaleString(undefined,{maximumFractionDigits:value<10?6:2})},
		});
		const candleSeries=instance.addSeries(CandlestickSeries,{
			upColor:'#31c48d',downColor:'#e15b64',borderVisible:false,wickUpColor:'#31c48d',wickDownColor:'#e15b64',
		});
		chart.current=instance;
		series.current=candleSeries;
		return()=>{
			instance.remove();
			chart.current=null;
			series.current=null;
		};
	},[]);

	useEffect(()=>{
		let active=true;
		hasFit.current=false;
		setCandles([]);
		setHistoryError('');
		if(!instrumentId&&!assetId)return()=>{active=false};
		const endpoint=assetId
			?`/api/live-markets/${encodeURIComponent(assetId)}?timeframe=1d`
			:`/api/candles?instrumentId=${encodeURIComponent(instrumentId!)}&limit=${limit}`;
		void fetch(endpoint,{cache:'no-store'})
			.then(async response=>{
				if(!response.ok)throw new Error('Candle data unavailable.');
				return response.json() as Promise<CandleRow[]|{candles:CandleRow[]}>;
			})
			.then(result=>{
				if(!active)return;
				const rows=Array.isArray(result)?result:result.candles;
				const history=rows.map(row=>({
					time:row.time??Math.floor(new Date(row.ts||'').getTime()/1000),
					open:Number(row.open),high:Number(row.high),low:Number(row.low),close:Number(row.close),
					volume:row.volume===null||row.volume===undefined?null:Number(row.volume),
				})).filter(candle=>Number.isFinite(candle.time)&&[candle.open,candle.high,candle.low,candle.close].every(Number.isFinite));
				setCandles(updateChartCandle(history,priceRef.current,Date.now(),limit));
			})
			.catch(error=>{
				if(!active)return;
				setHistoryError(error instanceof Error?error.message:'Candle data unavailable.');
				setCandles(current=>updateChartCandle(current,priceRef.current,Date.now(),limit));
			});
		return()=>{active=false};
	},[assetId,instrumentId,limit]);

	useEffect(()=>{
		if(!series.current)return;
		if(!candles.length){
			series.current.setData([]);
			hasFit.current=false;
			return;
		}
		series.current.setData(candles.map(candle=>({...candle,time:candle.time as UTCTimestamp})));
		if(!hasFit.current){
			chart.current?.timeScale().fitContent();
			hasFit.current=true;
		}
	},[candles]);

	useEffect(()=>{
		if(price>0)setCandles(current=>updateChartCandle(current,price,Date.now(),limit));
	},[price,limit]);

	useEffect(()=>{
		if(!running)return;
		const timer=window.setInterval(()=>{
			setCandles(current=>updateChartCandle(current,priceRef.current,Date.now(),limit));
		},1_000);
		return()=>window.clearInterval(timer);
	},[limit,running]);

	return <>
		<div className="price-chart-shell h-72 w-full" ref={host} role="img" aria-label="Market candlestick chart"/>
		{historyError&&<p className="live-chart-message" role="status">{historyError}</p>}
	</>;
}
