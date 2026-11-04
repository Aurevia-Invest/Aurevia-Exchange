import {AccountMode,Prisma,PrismaClient} from '@prisma/client';
import {ALPACA_PAPER_PROVIDER} from '@/lib/bitcoin-funding';

type TransactionClient=PrismaClient|Prisma.TransactionClient;

export async function getWalletBackedPaperInstrumentIds(tx:TransactionClient,userId:string){
	const [orders,usdAccount]=await Promise.all([
		tx.order.findMany({
			where:{userId,accountMode:AccountMode.REAL,providerName:ALPACA_PAPER_PROVIDER},
			select:{id:true,instrumentId:true,side:true,filledQuantity:true,executions:{select:{quantity:true,providerExecutionId:true}}},
		}),
		tx.ledgerAccount.findUnique({where:{code:`USER:${userId}:${AccountMode.REAL}:USD`},select:{id:true}}),
	]);
	const filledOrders=orders.filter(order=>order.filledQuantity.gt(0));
	if(!filledOrders.length||!usdAccount)return new Set<string>();
	const references=await tx.ledgerTransaction.findMany({
		where:{accountMode:AccountMode.REAL,reference:{startsWith:'REAL:SIMULATED_TRADE:'},entries:{some:{accountId:usdAccount.id}}},
		select:{reference:true},
	});
	const referenceSet=new Set(references.map(transaction=>transaction.reference));
	const byInstrument=new Map<string,boolean>();
	for(const order of filledOrders){
		const executionQuantity=order.executions.reduce((sum,execution)=>sum.plus(execution.quantity),new Prisma.Decimal(0));
		const complete=executionQuantity.equals(order.filledQuantity)&&order.executions.every(execution=>
			!!execution.providerExecutionId&&referenceSet.has(`REAL:SIMULATED_TRADE:${order.side}:${order.id}:${execution.providerExecutionId}`),
		);
		byInstrument.set(order.instrumentId,(byInstrument.get(order.instrumentId)??true)&&complete);
	}
	return new Set([...byInstrument].filter(([,complete])=>complete).map(([instrumentId])=>instrumentId));
}
