import {describe,expect,it} from 'vitest';
import {updateChartCandle,type ChartCandle} from '@/lib/chart-candles';

const initial:ChartCandle[]=[{time:100,open:10,high:11,low:9,close:10.5,volume:12}];

describe('chart candle updates',()=>{
	it('updates the forming second candle without changing its open',()=>{
		const updated=updateChartCandle(initial,12,100_500,10);
		expect(updated).toEqual([{time:100,open:10,high:12,low:9,close:12,volume:12}]);
	});

	it('starts a new candle each second and keeps the configured history length',()=>{
		const updated=updateChartCandle(initial,12,101_000,1);
		expect(updated).toEqual([{time:101,open:12,high:12,low:12,close:12,volume:null}]);
	});

	it('ignores invalid prices and out-of-order ticks',()=>{
		expect(updateChartCandle(initial,0,101_000,10)).toBe(initial);
		expect(updateChartCandle(initial,12,99_000,10)).toBe(initial);
	});
});
