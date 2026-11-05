import {NextResponse} from 'next/server';
import {Prisma} from '@prisma/client';
import {z} from 'zod';
import {requireAdmin} from '@/lib/auth';
import {db} from '@/lib/db';
import {jsonSafe} from '@/lib/serializers';
import {removeSimulatedLabels} from '@/lib/display-copy';

const pageSize=10;
const querySchema=z.object({
	page:z.coerce.number().int().min(1).max(Math.floor(Number.MAX_SAFE_INTEGER/pageSize)).default(1),
	search:z.string().trim().max(160).default(''),
	date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

type AuditFeedRow={
	source:'audit'|'notification';
	sourceId:string;
	sortId:string;
	actorId:string|null;
	action:string;
	entity:string;
	entityId:string|null;
	metadata:Prisma.JsonValue|null;
	summary:string|null;
	createdAt:Date;
};

function utcDayBounds(date:string){
	const start=new Date(`${date}T00:00:00.000Z`);
	if(Number.isNaN(start.getTime())||start.toISOString().slice(0,10)!==date)return null;
	const end=new Date(start);
	end.setUTCDate(end.getUTCDate()+1);
	return {start,end};
}

export async function GET(request:Request){
	try{
		const admin=await requireAdmin();
		const params=Object.fromEntries(new URL(request.url).searchParams);
		const loginUserId=new URL(request.url).searchParams.get('loginUserId');
		if(loginUserId){
			if(loginUserId.length>128)return NextResponse.json({error:'Invalid user identifier.'},{status:400});
			const events=await db.$transaction(async tx=>{
				const records=await tx.auditLog.findMany({where:{entity:'LOGIN',actorId:loginUserId},select:{id:true,actorId:true,action:true,entity:true,metadata:true,createdAt:true},orderBy:[{createdAt:'desc'},{id:'desc'}],take:100});
				await tx.auditLog.create({data:{actorId:admin.id,action:'ADMIN_LOGIN_HISTORY_VIEWED',entity:'LOGIN_HISTORY',entityId:loginUserId,metadata:{recordCount:records.length}}});
				return records;
			});
			return NextResponse.json(jsonSafe(events.map(event=>({...event,action:removeSimulatedLabels(event.action)}))),{headers:{'Cache-Control':'private, no-store'}});
		}

		const input=querySchema.parse(params);
		const bounds=input.date?utcDayBounds(input.date):null;
		if(input.date&&!bounds)return NextResponse.json({error:'Invalid activity date.'},{status:400});
		const search=input.search?`%${input.search.replace(/[\\%_]/g,'\\$&')}%`:null;
		const dateFilter=bounds?Prisma.sql`AND "createdAt">=${bounds.start} AND "createdAt"<${bounds.end}`:Prisma.empty;
		const auditSearch=search?Prisma.sql`AND ("action" ILIKE ${search} OR "entity" ILIKE ${search} OR COALESCE("entityId",'') ILIKE ${search} OR COALESCE("actorId",'') ILIKE ${search})`:Prisma.empty;
		const notificationSearch=search?Prisma.sql`AND (('NOTIFICATION_'||"type"::text) ILIKE ${search} OR 'NOTIFICATION' ILIKE ${search} OR "id" ILIKE ${search} OR "title" ILIKE ${search})`:Prisma.empty;
		const countRows=await db.$queryRaw<Array<{total:bigint}>>(Prisma.sql`
			SELECT COUNT(*)::bigint AS "total"
			FROM (
				SELECT "id" FROM "AuditLog" WHERE "entity"<>'LOGIN' ${dateFilter} ${auditSearch}
				UNION ALL
				SELECT "id" FROM "Notification" WHERE TRUE ${dateFilter} ${notificationSearch}
			) AS "matching"
		`);
		const total=Number(countRows[0]?.total??0n);
		const totalPages=Math.ceil(total/pageSize);
		const page=totalPages?Math.min(input.page,totalPages):1;
		const pageRows=await db.$queryRaw<AuditFeedRow[]>(Prisma.sql`
			WITH "feed" AS (
				SELECT 'audit'::text AS "source","id"::text AS "sourceId","id"::text AS "sortId",
					"actorId","action","entity","entityId","metadata",NULL::text AS "summary","createdAt"
				FROM "AuditLog"
				WHERE "entity"<>'LOGIN' ${dateFilter} ${auditSearch}
				UNION ALL
				SELECT 'notification'::text AS "source","id"::text AS "sourceId",('notification:'||"id") AS "sortId",
					NULL::text AS "actorId",('NOTIFICATION_'||"type"::text) AS "action",'NOTIFICATION'::text AS "entity",
					"id"::text AS "entityId",NULL::jsonb AS "metadata","title" AS "summary","createdAt"
				FROM "Notification"
				WHERE TRUE ${dateFilter} ${notificationSearch}
			)
			SELECT * FROM "feed"
			ORDER BY "createdAt" DESC,"sortId" DESC
			LIMIT ${pageSize} OFFSET ${(page-1)*pageSize}
		`);
		const actorIds=pageRows.flatMap(event=>event.actorId?[event.actorId]:[]);
		const actors=actorIds.length?await db.user.findMany({where:{id:{in:actorIds}},select:{id:true,name:true}}):[];
		const actorNames=new Map(actors.map(actor=>[actor.id,actor.name]));
		const items=pageRows.map(event=>({
			id:event.source==='notification'?`notification:${event.sourceId}`:event.sourceId,
			actorId:event.actorId,
			actorName:event.actorId?actorNames.get(event.actorId)??null:null,
			action:removeSimulatedLabels(event.action),
			entity:event.entity,
			entityId:event.entityId,
			metadata:event.metadata,
			summary:event.summary?removeSimulatedLabels(event.summary):null,
			createdAt:event.createdAt,
		}));
		return NextResponse.json(jsonSafe({items,total,page,pageSize,totalPages}),{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		if(error instanceof z.ZodError)return NextResponse.json({error:'Invalid audit log filters.'},{status:400});
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'Forbidden'},{status:403});
		return NextResponse.json({error:'Audit history is temporarily unavailable.'},{status:503,headers:{'Cache-Control':'private, no-store'}});
	}
}
