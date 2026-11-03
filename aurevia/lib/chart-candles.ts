export type ChartCandle = {
	time:number;
	open:number;
	high:number;
	low:number;
	close:number;
	volume:number|null;
};

export function updateChartCandle(candles:ChartCandle[],price:number,timestamp:number,limit:number):ChartCandle[]{
	if(!Number.isFinite(price)||price<=0||!Number.isFinite(timestamp)||!Number.isInteger(limit)||limit<1)return candles;
	const time=Math.floor(timestamp/1000);
	const latest=candles[candles.length-1];
	if(latest&&time<latest.time)return candles;
	if(latest&&time===latest.time){
		return [
			...candles.slice(0,-1),
			{...latest,high:Math.max(latest.high,price),low:Math.min(latest.low,price),close:price},
		].slice(-limit);
	}
	return [
		...candles,
		{time,open:price,high:price,low:price,close:price,volume:null},
	].slice(-limit);
}
