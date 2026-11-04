import {describe,expect,it} from 'vitest';
import {filterPerformanceSnapshots} from '../lib/portfolio-timeframes';
import {calculateAllocationPercentages,instrumentAssetCategory} from '../lib/portfolio-metrics';
import {calculateRealWithdrawableBalance,getRealWithdrawableBalance} from '../lib/real-withdrawals';
import {recordedInvestmentPnl} from '../lib/investment-policy';
import {Prisma} from '@prisma/client';

describe('portfolio metrics',()=>{
	const now=new Date('2026-10-20T12:00:00.000Z');
	const snapshots=[
		{snapshotBucket:'2026-10-19T11:00:00.000Z',totalValue:'90'},
		{snapshotBucket:'2026-10-20T00:00:00.000Z',totalValue:'100'},
		{snapshotBucket:'2026-10-20T11:00:00.000Z',totalValue:'110'},
		{snapshotBucket:'2026-10-21T12:00:00.000Z',totalValue:'200'},
	];

	it('filters chart history to the selected real snapshot window and sorts it chronologically',()=>{
		expect(filterPerformanceSnapshots(snapshots,'1D',now).map(item=>item.totalValue)).toEqual(['100','110']);
		expect(filterPerformanceSnapshots(snapshots,'1W',now).map(item=>item.totalValue)).toEqual(['90','100','110']);
		expect(filterPerformanceSnapshots(snapshots,'ALL',now).map(item=>item.totalValue)).toEqual(['90','100','110']);
	});

	it('calculates allocation percentages from actual positive holdings only',()=>{
		const allocations=calculateAllocationPercentages([{category:'Crypto',value:new Prisma.Decimal('45')},{category:'Equity',value:new Prisma.Decimal('30')},{category:'Cash',value:new Prisma.Decimal('0')}]);
		expect(allocations.map(item=>({category:item.category,value:item.value.toNumber(),percentage:item.percentage.toNumber()}))).toEqual([
			{category:'Crypto',value:45,percentage:60},
			{category:'Equity',value:30,percentage:40},
			{category:'Cash',value:0,percentage:0},
		]);
		expect(calculateAllocationPercentages([{category:'Empty',value:new Prisma.Decimal(0)}])[0].percentage.toNumber()).toBe(0);
	});

	it('classifies only supported instrument categories and leaves unknown assets explicit',()=>{
		expect(instrumentAssetCategory({symbol:'BTC/USD',baseAsset:'BTC',quoteAsset:'USD'})).toBe('Crypto');
		expect(instrumentAssetCategory({symbol:'XAU/USD',baseAsset:'XAU',quoteAsset:'USD'})).toBe('Gold');
		expect(instrumentAssetCategory({symbol:'NVDA',baseAsset:'NVDA',quoteAsset:'USD'})).toBe('Equity');
		expect(instrumentAssetCategory({symbol:'EUR/USD',baseAsset:'EUR',quoteAsset:'USD'})).toBe('FX');
		expect(instrumentAssetCategory({symbol:'ABC/XYZ',baseAsset:'ABC',quoteAsset:'XYZ'})).toBe('Other');
	});

	it('only measures investment P/L from a persisted payout record',()=>{
		expect(recordedInvestmentPnl(new Prisma.Decimal('1000'),null).toFixed(2)).toBe('0.00');
		expect(recordedInvestmentPnl(new Prisma.Decimal('1000'),new Prisma.Decimal('1000')).toFixed(2)).toBe('0.00');
		expect(recordedInvestmentPnl(new Prisma.Decimal('1000'),new Prisma.Decimal('1080')).toFixed(2)).toBe('80.00');
	});

	it('limits REAL withdrawals to available ledger funds after pending reservations',()=>{
		expect(calculateRealWithdrawableBalance({
			ledgerBalance:'1080',
			pendingWithdrawals:'200',
		}).toFixed(2)).toBe('880.00');
		expect(calculateRealWithdrawableBalance({
			ledgerBalance:'500',
			pendingWithdrawals:'0',
		}).toFixed(2)).toBe('500.00');
		expect(calculateRealWithdrawableBalance({
			ledgerBalance:'20',
			pendingWithdrawals:'30',
		}).toFixed(2)).toBe('0.00');
	});

	it('withholds only outstanding buy reservations from REAL withdrawals',async()=>{
		const tx={
			fundingRequest:{aggregate:async()=>({_sum:{amount:new Prisma.Decimal('100')}})},
			order:{findMany:async()=>[
				{
					instrumentId:'BTC/USD',side:'BUY',quantity:new Prisma.Decimal('3'),filledQuantity:new Prisma.Decimal('2'),
					averageFillPrice:new Prisma.Decimal('100'),providerReservedAmount:new Prisma.Decimal('300'),
					status:'PENDING_CANCEL',createdAt:new Date('2026-10-20T10:00:00Z'),
				},
				{
					instrumentId:'BTC/USD',side:'SELL',quantity:new Prisma.Decimal('1'),filledQuantity:new Prisma.Decimal('1'),
					averageFillPrice:new Prisma.Decimal('120'),providerReservedAmount:null,
					status:'FILLED',createdAt:new Date('2026-10-20T11:00:00Z'),
				},
			]},
		} as unknown as Parameters<typeof getRealWithdrawableBalance>[0];

		expect((await getRealWithdrawableBalance(tx,'user-1',new Prisma.Decimal('1000'))).toFixed(2)).toBe('800.00');
	});
});
