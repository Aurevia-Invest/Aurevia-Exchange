import {NextResponse} from 'next/server';
import {requireAdmin} from '@/lib/auth';
import {AlpacaPaperOrderError,syncAlpacaPaperOrder} from '@/lib/alpaca-paper-orders';
import {jsonSafe} from '@/lib/serializers';

export const dynamic='force-dynamic';

export async function POST(_request:Request,{params}:{params:Promise<{orderId:string}>}){
	try{
		const admin=await requireAdmin();
		const {orderId}=await params;
		const order=await syncAlpacaPaperOrder(orderId,admin.id);
		return NextResponse.json(jsonSafe(order),{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		if(error instanceof AlpacaPaperOrderError)return NextResponse.json({error:error.code.replaceAll('_',' ').toLowerCase()},{status:error.httpStatus});
		const status=error instanceof Error&&error.message==='UNAUTHORIZED'?401:403;
		return NextResponse.json({error:status===401?'Unauthorized':'Unable to synchronize Alpaca sandbox order.'},{status});
	}
}
