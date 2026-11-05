import {NextResponse} from 'next/server';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {jsonSafe} from '@/lib/serializers';

export const dynamic='force-dynamic';

export async function GET(){
	const user=await requireUser();
	const current=await db.user.findUnique({where:{id:user.id},select:{accountMode:true}});
	if(!current)return NextResponse.json({error:'Account not found.'},{status:404});
	const {id:userId}=user;
	const accountMode=current.accountMode;
	const where={order:{accountMode,userId}};
	const executions=await db.execution.findMany({where,include:{order:{select:{side:true,status:true,accountMode:true,instrument:{select:{symbol:true}}}}},orderBy:{createdAt:'desc'},take:30});
	const activity=executions.map(execution=>({id:execution.id,instrument:execution.order.instrument.symbol,side:execution.order.side,quantity:execution.quantity,price:execution.price,timestamp:execution.createdAt,accountMode:execution.order.accountMode,status:execution.order.status}));
	const source=accountMode==='DEMO'?'DEMO practice activity records':'REAL Alpaca sandbox execution records';
	return NextResponse.json(jsonSafe({activity,source}),{headers:{'Cache-Control':'private, no-store'}});
}