export const WITHDRAWAL_COMMISSION_PERCENT=10;

export function calculateWithdrawalAmounts(amount:number|string){
	const numeric=Number(amount);
	if(!Number.isFinite(numeric)||numeric<=0)return {grossCents:0,feeCents:0,netCents:0};
	const grossCents=Math.round(numeric*100);
	const feeCents=Math.round(grossCents*WITHDRAWAL_COMMISSION_PERCENT/100);
	return {grossCents,feeCents,netCents:grossCents-feeCents};
}
