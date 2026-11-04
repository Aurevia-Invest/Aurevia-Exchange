import {Prisma} from '@prisma/client';

export const BTC_FUNDING_METHOD='BTC deposit · manual verification';
export const ALPACA_PAPER_PROVIDER='alpaca-paper';

export function normalizeBitcoinTransactionId(value:string){
	const normalized=value.trim().toLowerCase();
	return /^[a-f0-9]{64}$/.test(normalized)?normalized:null;
}

export function validateBitcoinDepositAmount(value:Prisma.Decimal|number|string){
	const amount=new Prisma.Decimal(value);
	if(!amount.isFinite()||amount.lte(0)||amount.gt('100000000')||amount.decimalPlaces()>8)throw new Error('INVALID_BTC_AMOUNT');
	return amount;
}

export type PaperOrderCollateralRecord={
	instrumentId:string;
	side:'BUY'|'SELL';
	quantity:Prisma.Decimal;
	filledQuantity:Prisma.Decimal;
	averageFillPrice:Prisma.Decimal|null;
	providerReservedAmount:Prisma.Decimal|null;
	status:string;
	createdAt:Date;
	takerFee:Prisma.Decimal;
};

export function paperOrderCollateral(records:PaperOrderCollateralRecord[]){
	const holdings=new Map<string,{quantity:Prisma.Decimal;cost:Prisma.Decimal}>();
	let reservedBuys=new Prisma.Decimal(0);
	for(const order of [...records].sort((left,right)=>left.createdAt.getTime()-right.createdAt.getTime())){
		const holding=holdings.get(order.instrumentId)||{quantity:new Prisma.Decimal(0),cost:new Prisma.Decimal(0)};
		if(order.side==='BUY'){
			if(order.filledQuantity.gt(0)&&order.averageFillPrice){
				const filledCost=order.filledQuantity.mul(order.averageFillPrice).mul(new Prisma.Decimal(1).plus(order.takerFee));
				holding.quantity=holding.quantity.plus(order.filledQuantity);
				holding.cost=holding.cost.plus(filledCost);
			}
			if((order.status==='OPEN'||order.status==='PARTIALLY_FILLED'||order.status==='PENDING_CANCEL')&&order.providerReservedAmount&&order.quantity.gt(0)){
				const remaining=Prisma.Decimal.max(order.quantity.minus(order.filledQuantity),new Prisma.Decimal(0));
				reservedBuys=reservedBuys.plus(order.providerReservedAmount.mul(remaining).div(order.quantity));
			}
		}else if(order.filledQuantity.gt(0)&&holding.quantity.gt(0)){
			const sold=Prisma.Decimal.min(order.filledQuantity,holding.quantity);
			holding.cost=holding.cost.minus(holding.cost.mul(sold).div(holding.quantity));
			holding.quantity=holding.quantity.minus(sold);
		}
		holdings.set(order.instrumentId,holding);
	}
	const heldCostBasis=[...holdings.values()].reduce((total,holding)=>total.plus(holding.cost),new Prisma.Decimal(0));
	return {heldCostBasis,reservedBuys,committed:reservedBuys};
}

export function assertPaperBuyCollateral(balance:Prisma.Decimal,pendingWithdrawals:Prisma.Decimal,committed:Prisma.Decimal,requested:Prisma.Decimal){
	if(balance.minus(pendingWithdrawals).minus(committed).lt(requested))throw new Error('INSUFFICIENT_REAL_WALLET_COLLATERAL');
}
