export const WITHDRAWAL_COMMISSION_PERCENT=10;
export const MIN_REAL_WITHDRAWAL_USD=30_000;
export const MAX_REAL_WITHDRAWAL_USD=300_000;
export const REQUIRED_REAL_WITHDRAWAL_RESERVE_USD=300;

export type WithdrawalEligibilityIssue='BELOW_MINIMUM'|'ABOVE_MAXIMUM'|'INSUFFICIENT_RESERVE';

export function getWithdrawalEligibilityIssue(amount:number|string,availableBalance?:number|string|null):WithdrawalEligibilityIssue|null{
	const numeric=Number(amount);
	if(!Number.isFinite(numeric)||numeric<=0)return null;
	const amountCents=Math.round(numeric*100);
	if(amountCents<MIN_REAL_WITHDRAWAL_USD*100)return 'BELOW_MINIMUM';
	if(amountCents>MAX_REAL_WITHDRAWAL_USD*100)return 'ABOVE_MAXIMUM';
	if(availableBalance!==undefined&&availableBalance!==null){
		const availableCents=Math.round(Number(availableBalance)*100);
		if(!Number.isFinite(availableCents)||availableCents<amountCents+REQUIRED_REAL_WITHDRAWAL_RESERVE_USD*100)return 'INSUFFICIENT_RESERVE';
	}
	return null;
}

export function calculateWithdrawalAmounts(amount:number|string){
	const numeric=Number(amount);
	if(!Number.isFinite(numeric)||numeric<=0)return {grossCents:0,feeCents:0,netCents:0};
	const grossCents=Math.round(numeric*100);
	const feeCents=Math.round(grossCents*WITHDRAWAL_COMMISSION_PERCENT/100);
	return {grossCents,feeCents,netCents:grossCents-feeCents};
}
