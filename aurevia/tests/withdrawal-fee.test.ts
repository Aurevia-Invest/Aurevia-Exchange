import {describe,expect,it} from 'vitest';
import {calculateWithdrawalAmounts,getWithdrawalEligibilityIssue,MAX_REAL_WITHDRAWAL_USD,MIN_REAL_WITHDRAWAL_USD,REQUIRED_REAL_WITHDRAWAL_RESERVE_USD,WITHDRAWAL_COMMISSION_PERCENT} from '@/lib/withdrawal-fee';

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

	it('enforces withdrawal limits and leaves the required available-balance reserve',()=>{
		expect(MIN_REAL_WITHDRAWAL_USD).toBe(30000);
		expect(MAX_REAL_WITHDRAWAL_USD).toBe(300000);
		expect(REQUIRED_REAL_WITHDRAWAL_RESERVE_USD).toBe(300);
		expect(getWithdrawalEligibilityIssue(29999.99,100000)).toBe('BELOW_MINIMUM');
		expect(getWithdrawalEligibilityIssue(300000.01,400000)).toBe('ABOVE_MAXIMUM');
		expect(getWithdrawalEligibilityIssue(30000,30299.99)).toBe('INSUFFICIENT_RESERVE');
		expect(getWithdrawalEligibilityIssue(30000,30300)).toBeNull();
	});
});
