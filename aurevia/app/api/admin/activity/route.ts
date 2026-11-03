import {NextResponse} from 'next/server';
import {AccountMode} from '@prisma/client';
import {z,ZodError} from 'zod';
import {requireAdmin} from '@/lib/auth';
import {db} from '@/lib/db';
import {getUserActivity,isActivityCategory,type ActivityCategory} from '@/lib/activity';
import {activitySourceSchemaValues,hideEligibleActivityHistory,permanentlyDeleteActivityNotification,updateActivityVisibility,type ActivityVisibilityAction} from '@/lib/activity-management';
import {jsonSafe} from '@/lib/serializers';

export const dynamic='force-dynamic';

const requestSchema=z.discriminatedUnion('action',[
	z.object({action:z.enum(['archive','restore','hide','unhide','permanently-delete']),targetUserId:z.string().min(1).max(128),accountMode:z.enum(['DEMO','REAL']),reason:z.string().trim().max(500).optional(),items:z.array(z.object({source:z.enum(activitySourceSchemaValues),id:z.string().min(1).max(128)})).min(1).max(100)}),
	z.object({action:z.literal('clear'),targetUserId:z.string().min(1).max(128),accountMode:z.enum(['DEMO','REAL']),reason:z.string().trim().max(500).optional()}),
]);

export async function GET(request:Request){
	try{
		await requireAdmin();
		const params=new URL(request.url).searchParams;
		const search=(params.get('search')||'').trim().slice(0,120);
		const targetUserId=params.get('userId');
		if(!targetUserId){
			if(search.length<2)return NextResponse.json({users:[]});
			const users=await db.user.findMany({where:{OR:[{email:{contains:search,mode:'insensitive'}},{name:{contains:search,mode:'insensitive'}},{id:search}]},select:{id:true,name:true,email:true,accountMode:true,status:true},orderBy:{createdAt:'desc'},take:20});
			return NextResponse.json(jsonSafe({users}),{headers:{'Cache-Control':'private, no-store'}});
		}
		const user=await db.user.findUnique({where:{id:targetUserId},select:{id:true,name:true,email:true,accountMode:true,status:true}});
		if(!user)return NextResponse.json({error:'User account not found.'},{status:404});
		const requestedMode=params.get('accountMode');
		if(requestedMode&&requestedMode!=='DEMO'&&requestedMode!=='REAL')return NextResponse.json({error:'Invalid account mode.'},{status:400});
		const accountMode=(requestedMode as AccountMode|undefined)||user.accountMode;
		const rawLimit=Number.parseInt(params.get('limit')||'30',10);
		const limit=Math.min(100,Math.max(1,Number.isFinite(rawLimit)?rawLimit:30));
		const rawOffset=Number.parseInt(params.get('offset')||'0',10);
		const offset=Math.min(1000,Math.max(0,Number.isFinite(rawOffset)?rawOffset:0));
		const categoryValue=params.get('category')||'all';
		if(!isActivityCategory(categoryValue))return NextResponse.json({error:'Unsupported activity category.'},{status:400});
		const dateFrom=params.get('dateFrom')?new Date(params.get('dateFrom')!):undefined;
		const dateTo=params.get('dateTo')?new Date(params.get('dateTo')!):undefined;
		if((dateFrom&&Number.isNaN(dateFrom.getTime()))||(dateTo&&Number.isNaN(dateTo.getTime()))||(dateFrom&&dateTo&&dateFrom>dateTo))return NextResponse.json({error:'Invalid activity date range.'},{status:400});
		const state=params.get('state')||'active';
		if(!['active','archived','hidden','all'].includes(state))return NextResponse.json({error:'Unsupported activity state.'},{status:400});
		const data=await getUserActivity(user.id,accountMode,categoryValue as ActivityCategory,limit,{
			search:search||undefined,
			status:(params.get('status')||'').slice(0,40),
			dateFrom,dateTo,offset,
			state:state as 'active'|'archived'|'hidden'|'all',
			includeLoginHistory:categoryValue==='login-history',
			excludeLoginHistory:categoryValue!=='login-history',
		});
		return NextResponse.json(jsonSafe({user,accountMode,data}),{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'Forbidden'},{status:403});
		return NextResponse.json({error:'Unable to load administrator activity.'},{status:500});
	}
}

export async function POST(request:Request){
	try{
		const admin=await requireAdmin();
		const input=requestSchema.parse(await request.json());
		const target=await db.user.findUnique({where:{id:input.targetUserId},select:{id:true,status:true}});
		if(!target)return NextResponse.json({error:'Target account not found.'},{status:404});
		if(input.action==='clear'){
			const result=await db.$transaction(async tx=>{
				const cleared=await hideEligibleActivityHistory(tx,target.id,input.accountMode);
				if(cleared.records.length)await tx.auditLog.createMany({data:cleared.records.map(record=>({
					actorId:admin.id,action:'ADMIN_ACTIVITY_REMOVED_FROM_FEED',entity:'ACTIVITY_MANAGEMENT',entityId:record.sourceId,
					metadata:{targetUserId:target.id,accountMode:input.accountMode,activityType:record.sourceType,outcome:'SUCCESS',reason:input.reason||'Administrator cleared eligible activity history.'},
				}))});
				return cleared;
			},{isolationLevel:'Serializable',maxWait:5_000,timeout:15_000});
			return NextResponse.json({action:'clear',affected:result.affected,capped:result.capped});
		}
		const unique=[...new Map(input.items.map(item=>[`${item.source}:${item.id}`,item])).values()];
		const result=await db.$transaction(async tx=>{
			const results=await Promise.all(unique.map(item=>input.action==='permanently-delete'
				?item.source==='notification'
					?permanentlyDeleteActivityNotification(tx,target.id,input.accountMode,item.id)
					:{eligible:false,reason:'Only eligible read notifications can be permanently deleted.'}
				:updateActivityVisibility(tx,{userId:target.id,accountMode:input.accountMode,source:item.source,id:item.id,action:input.action as ActivityVisibilityAction})
			));
			await tx.auditLog.createMany({data:unique.map((item,index)=>({
				actorId:admin.id,
				action:`ADMIN_ACTIVITY_${input.action.toUpperCase().replaceAll('-','_')}`,
				entity:'ACTIVITY_MANAGEMENT',
				entityId:item.id,
				metadata:{targetUserId:target.id,accountMode:input.accountMode,activityType:item.source,outcome:results[index]?.eligible?'SUCCESS':'DENIED',reason:input.reason||results[index]?.reason||null},
			}))});
			return results;
		},{isolationLevel:'Serializable',maxWait:5_000,timeout:15_000});
		return NextResponse.json({action:input.action,affected:result.filter(item=>item.eligible).length,results:result.map((item,index)=>({...unique[index],...item}))});
	}catch(error){
		if(error instanceof ZodError)return NextResponse.json({error:'Choose a valid administrator activity action and valid target records.'},{status:400});
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'Forbidden'},{status:403});
		console.error(`Administrator activity management failed (${error instanceof Error?error.name:'UnknownError'}).`);
		return NextResponse.json({error:'Unable to update administrator activity.'},{status:500});
	}
}
