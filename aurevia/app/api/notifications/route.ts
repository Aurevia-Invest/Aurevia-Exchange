import {NextResponse} from 'next/server';
import {z,ZodError} from 'zod';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {jsonSafe} from '@/lib/serializers';
import {removeSimulatedLabels} from '@/lib/display-copy';

const updateSchema=z.discriminatedUnion('action',[
	z.object({action:z.literal('read'),id:z.string().min(1)}),
	z.object({action:z.literal('read-all')}),
	z.object({action:z.literal('archive'),id:z.string().min(1)}),
	z.object({action:z.literal('restore'),id:z.string().min(1)}),
]);
const deleteSchema=z.object({ids:z.array(z.string().min(1).max(128)).min(1).max(100)});

export async function GET(req:Request){
	try{
		const user=await requireUser();
		const account=await db.user.findUnique({where:{id:user.id},select:{accountMode:true,status:true}});
		if(!account||account.status!=='ACTIVE')return NextResponse.json({error:'Unauthorized'},{status:401});
		const params=new URL(req.url).searchParams;
		const limit=Math.min(Math.max(Number(params.get('limit')||30),1),100);
		const archived=params.get('state')==='archived';
		const modeWhere={userId:user.id,OR:[{accountMode:account.accountMode},{accountMode:null}]};
		const [notifications,unreadCount,latestUnread]=await Promise.all([
			db.notification.findMany({where:{...modeWhere,archivedAt:archived?{not:null}:null},include:{pushOutbox:{select:{id:true}}},orderBy:{createdAt:'desc'},take:limit}),
			db.notification.count({where:{...modeWhere,isRead:false}}),
			db.notification.findFirst({where:{...modeWhere,isRead:false,archivedAt:null},orderBy:{createdAt:'desc'},select:{createdAt:true}}),
		]);
		return NextResponse.json(jsonSafe({accountMode:account.accountMode,notifications:notifications.map(({pushOutbox,...notification})=>({...notification,title:removeSimulatedLabels(notification.title),message:removeSimulatedLabels(notification.message),canDelete:notification.isRead&&!pushOutbox})),unreadCount,latestUnreadAt:latestUnread?.createdAt??null}),{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'Forbidden'},{status:403});
		console.error(`Notification history load failed (${error instanceof Error?error.name:'UnknownError'}).`);
		return NextResponse.json({error:'Unable to load notifications.'},{status:500});
	}
}

export async function PATCH(req:Request){
	try{
		const user=await requireUser();
		const account=await db.user.findUnique({where:{id:user.id},select:{accountMode:true,status:true}});
		if(!account||account.status!=='ACTIVE')return NextResponse.json({error:'Unauthorized'},{status:401});
		const input=updateSchema.parse(await req.json());
		const modeWhere={userId:user.id,OR:[{accountMode:account.accountMode},{accountMode:null}]};
		if(input.action==='read'){
			const owned=await db.notification.findFirst({where:{id:input.id,...modeWhere},select:{id:true}});
			if(!owned)return NextResponse.json({error:'Notification not found.'},{status:404});
			await db.notification.updateMany({where:{id:owned.id,...modeWhere,isRead:false},data:{isRead:true}});
		}else if(input.action==='read-all'){
			await db.notification.updateMany({where:{...modeWhere,isRead:false},data:{isRead:true}});
		}else{
			const archivedAt=input.action==='archive'?new Date():null;
			const updated=await db.notification.updateMany({where:{id:input.id,...modeWhere,...(input.action==='restore'?{archivedAt:{not:null}}:{})},data:{archivedAt}});
			if(!updated.count)return NextResponse.json({error:'Notification not found.'},{status:404});
		}
		const unreadCount=await db.notification.count({where:{...modeWhere,isRead:false}});
		return NextResponse.json({ok:true,unreadCount});
	}catch(error){
		if(error instanceof ZodError)return NextResponse.json({error:'Invalid notification update.'},{status:400});
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'Forbidden'},{status:403});
		console.error(`Notification update failed (${error instanceof Error?error.name:'UnknownError'}).`);
		return NextResponse.json({error:'Unable to update notifications.'},{status:500});
	}
}

export async function DELETE(req:Request){
	try{
		const user=await requireUser();
		const account=await db.user.findUnique({where:{id:user.id},select:{accountMode:true,status:true}});
		if(!account||account.status!=='ACTIVE')return NextResponse.json({error:'Unauthorized'},{status:401});
		const {ids}=deleteSchema.parse(await req.json());
		const unique=[...new Set(ids)];
		const modeWhere={userId:user.id,OR:[{accountMode:account.accountMode},{accountMode:null}]};
		const deleted=await db.$transaction(async tx=>{
			const eligible=await tx.notification.findMany({where:{id:{in:unique},...modeWhere,isRead:true,pushOutbox:null},select:{id:true}});
			if(eligible.length!==unique.length)throw new Error('NOTIFICATION_NOT_ELIGIBLE');
			const result=await tx.notification.deleteMany({where:{id:{in:eligible.map(item=>item.id)},...modeWhere,isRead:true,pushOutbox:null}});
			if(result.count!==eligible.length)throw new Error('NOTIFICATION_NOT_ELIGIBLE');
			await tx.activityVisibilityPreference.deleteMany({where:{userId:user.id,sourceType:'notification',sourceId:{in:eligible.map(item=>item.id)}}});
			return result.count;
		},{isolationLevel:'Serializable',maxWait:5_000,timeout:10_000});
		return NextResponse.json({ok:true,deleted});
	}catch(error){
		if(error instanceof ZodError)return NextResponse.json({error:'Choose between 1 and 100 read notifications.'},{status:400});
		if(error instanceof Error&&error.message==='NOTIFICATION_NOT_ELIGIBLE')return NextResponse.json({error:'Only read notifications without a pending delivery record can be permanently deleted.'},{status:409});
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		return NextResponse.json({error:'Unable to delete notifications.'},{status:500});
	}
}