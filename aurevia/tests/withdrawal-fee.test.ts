import {describe,expect,it} from 'vitest';
import {calculateWithdrawalAmounts,WITHDRAWAL_COMMISSION_PERCENT} from '@/lib/withdrawal-fee';

describe('REAL withdrawal commission',()=>{
	it('deducts 10% and retains cent precision',()=>{
		expect(WITHDRAWAL_COMMISSION_PERCENT).toBe(10);
		expect(calculateWithdrawalAmounts('100.00')).toEqual({grossCents:10000,feeCents:1000,netCents:9000});
		expect(calculateWithdrawalAmounts('25.55')).toEqual({grossCents:2555,feeCents:256,netCents:2299});
	});

	it('requires at least one cent of commission',()=>{
		expect(calculateWithdrawalAmounts('0.04')).toEqual({grossCents:4,feeCents:0,netCents:4});
		expect(calculateWithdrawalAmounts('0.05')).toEqual({grossCents:5,feeCents:1,netCents:4});
		expect(calculateWithdrawalAmounts('invalid')).toEqual({grossCents:0,feeCents:0,netCents:0});
	});
});
