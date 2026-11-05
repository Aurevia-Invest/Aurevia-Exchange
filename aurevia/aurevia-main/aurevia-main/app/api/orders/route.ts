import {NextResponse} from 'next/server';
import {z,ZodError} from 'zod';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {placeOrder} from '@/lib/orders';
import {jsonSafe} from '@/lib/serializers';
import {NotificationType} from '@prisma/client';
import {createNotification} from '@/lib/notifications';
import {AccountMode} from '@prisma/client';
import {cancelAlpacaPaperOrder,ALPACA_PAPER_PROVIDER,AlpacaPaperOrderError} from '@/lib/alpaca-paper-orders';

const schema=z.object({instrumentId:z.string().min(1),side:z.enum(['BUY','SELL']),type:z.enum(['MARKET','LIMIT','STOP']),quantity:z.number().positive().max(1_000_000_000),price:z.number().positive().optional(),stopPrice:z.number().positive().optional(),expectedPrice:z.number().positive(),observedAt:z.string().datetime()});
export async function GET(){
	try{
		const user=await requireUser();
		const currentUser=await db.user.findUnique({where:{id:user.id},select:{accountMode:true,status:true}});
		if(!currentUser||currentUser.status!=='ACTIVE')return NextResponse.json({error:'This account is unavailable.'},{status:403});
		return NextResponse.json(jsonSafe(await db.order.findMany({where:{userId:user.id,accountMode:currentUser.accountMode},include:{instrument:true,executions:true},orderBy:{createdAt:'desc'},take:100})),{headers:{'Cache-Control':'private, no-store'}});
	}catch{return NextResponse.json({error:'Unauthorized'},{status:401})}
}

export async function POST(request:Request){
	try{
		const user=await requireUser();
		const input=schema.parse(await request.json());
		const idempotencyKey=request.headers.get('Idempotency-Key')||'';
		if(!/^[a-zA-Z0-9_-]{12,48}$/.test(idempotencyKey))return NextResponse.json({error:'A valid idempotency key is required.'},{status:400});
		const currentUser=await db.user.findUnique({where:{id:user.id},select:{accountMode:true,status:true,role:true}});
		if(!currentUser||currentUser.status!=='ACTIVE'||currentUser.role!=='USER')return NextResponse.json({error:'This account cannot submit orders.'},{status:403});
		const order=await placeOrder(user.id,currentUser.accountMode,input,idempotencyKey);
		return NextResponse.json(jsonSafe(order),{status:201});
	}catch(error){
		if(error instanceof ZodError)return NextResponse.json({error:error.issues[0]?.message||'Invalid order.'},{status:400});
		if(error instanceof AlpacaPaperOrderError)return NextResponse.json({error:paperOrderMessage(error.code)},{status:error.httpStatus});
		if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'Paper order requests are temporarily limited.'},{status:429});
		if(error instanceof Error&&error.message==='ACCOUNT_MODE_CHANGED')return NextResponse.json({error:'Your active account mode changed. Refresh and submit the order again.'},{status:409});
		if(error instanceof Error&&error.message==='ORDER_ACCOUNT_UNAVAILABLE')return NextResponse.json({error:'This account cannot submit orders.'},{status:403});
		if(error&&typeof error==='object'&&'code'in error&&String(error.code)==='P2034')return NextResponse.json({error:'The account changed while submitting this order. Refresh and try again.'},{status:409});
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		if(error instanceof Error&&error.message==='IDEMPOTENCY_KEY_REUSED')return NextResponse.json({error:'This request key was already used for a different order.'},{status:409});
		return NextResponse.json({error:error instanceof Error?error.message:'Order rejected'},{status:400});
	}
}

function paperOrderMessage(code:string){
	if(code==='ALPACA_PAPER_NOT_CONFIGURED')return 'Alpaca Paper order submission is not configured.';
	if(code==='ALPACA_PAPER_ORDERS_DISABLED')return 'Alpaca Paper orders are disabled. Ask an administrator to enable the paper-only setting.';
	if(code==='ALPACA_PAPER_ACCOUNT_UNAVAILABLE')return 'The shared Alpaca Paper account is not active for trading.';
	if(code==='ALPACA_PAPER_ASSET_NOT_TRADABLE'||code==='ALPACA_TRADING_API_ERROR:404')return 'This instrument is not available for trading in Alpaca Paper.';
	if(code==='ALPACA_PAPER_AUTHENTICATION_FAILED'||code==='PRECHECK_FAILED:401'||code==='PRECHECK_FAILED:403')return 'Alpaca Paper authentication failed. Ask an administrator to check the server configuration.';
	if(code==='ALPACA_PAPER_ORDER_REJECTED:401'||code==='ALPACA_PAPER_ORDER_REJECTED:403')return 'Alpaca Paper authentication failed. Ask an administrator to check the server configuration.';
	if(code.startsWith('ALPACA_PAPER_ORDER_REJECTED:'))return `Alpaca Paper rejected the order (${code.split(':').at(-1)}).`;
	if(code==='ALPACA_PAPER_ORDER_STATUS_UNAVAILABLE')return 'The order outcome could not be verified. It will not be resubmitted; ask an administrator to reconcile it.';
	if(code==='ALPACA_PAPER_ORDER_NOT_FOUND_AT_PROVIDER')return 'Alpaca Paper has not confirmed this order. It remains pending administrator review.';
	if(code==='ALPACA_PAPER_CLIENT_ORDER_ID_MISMATCH')return 'The provider response did not match this order request. It requires administrator review.';
	if(code==='INSUFFICIENT_POSITION')return 'You may only sell quantities filled by your own REAL-side Alpaca Paper orders.';
	if(code.startsWith('PRECHECK_FAILED:'))return 'Alpaca Paper could not validate this order. Ask an administrator to review provider connectivity.';
	return code.replaceAll('_',' ').toLowerCase();
}

export async function DELETE(request:Request){
	try{
		const user=await requireUser();
		const body=await request.json() as {orderId?:unknown};
		if(typeof body.orderId!=='string')return NextResponse.json({error:'orderId required'},{status:400});
		const currentUser=await db.user.findUnique({where:{id:user.id},select:{accountMode:true,status:true,role:true}});
		if(!currentUser||currentUser.status!=='ACTIVE'||currentUser.role!=='USER')return NextResponse.json({error:'This account cannot cancel orders.'},{status:403});
		if(currentUser.accountMode===AccountMode.REAL){
			const existing=await db.order.findFirst({where:{id:body.orderId,userId:user.id,accountMode:AccountMode.REAL},select:{providerName:true}});
			if(existing?.providerName===ALPACA_PAPER_PROVIDER){
				const cancelled=await cancelAlpacaPaperOrder(body.orderId,user.id);
				return NextResponse.json(jsonSafe(cancelled),{headers:{'Cache-Control':'private, no-store'}});
			}
		}
		const cancelled=await db.$transaction(async tx=>{
			const order=await tx.order.findFirst({where:{id:body.orderId as string,userId:user.id,accountMode:currentUser.accountMode,status:'OPEN'},include:{instrument:true}});
			if(!order)return false;
			const changed=await tx.order.updateMany({where:{id:order.id,status:'OPEN'},data:{status:'CANCELLED'}});
			if(!changed.count)return false;
			await tx.auditLog.create({data:{actorId:user.id,action:`${currentUser.accountMode}_SIMULATED_ORDER_CANCELLED`,entity:'ORDER',entityId:order.id,metadata:{oldState:'OPEN',newState:'CANCELLED',accountMode:currentUser.accountMode,simulated:true,instrument:order.instrument.symbol}}});
			await createNotification(tx,{userId:user.id,type:NotificationType.TRADE,title:`${currentUser.accountMode} order cancelled`,message:currentUser.accountMode===AccountMode.REAL?`Your REAL order for ${order.instrument.symbol} was cancelled. No external order was placed; any wallet activity already recorded remains unchanged.`:`Your DEMO order for ${order.instrument.symbol} was cancelled. No external order was placed.`,dedupeKey:`order:${order.id}:cancelled`,relatedEntity:'ORDER',relatedId:order.id,actionUrl:'/trade'});
			return true;
		});
		if(!cancelled)return NextResponse.json({error:'Order not open or not found'},{status:404});
		return NextResponse.json({ok:true});
	}catch(error){
		if(error instanceof AlpacaPaperOrderError)return NextResponse.json({error:paperOrderMessage(error.code)},{status:error.httpStatus});
		return NextResponse.json({error:'Unable to cancel order'},{status:400});
	}
}
