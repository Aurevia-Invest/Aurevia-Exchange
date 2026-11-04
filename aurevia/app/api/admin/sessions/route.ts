import {createHash} from 'node:crypto';
import {NextResponse} from 'next/server';
import {z,ZodError} from 'zod';
import {requireAdmin} from '@/lib/auth';
import {db} from '@/lib/db';
import {rateLimit} from '@/lib/rate-limit';
import {isAuthSessionExpired} from '@/lib/auth-session';

const revokeSchema=z.object({userId:z.string().min(1).max(128),sessionRef:z.string().regex(/^[a-f0-9]{24}$/)});
const pageSchema=z.coerce.number().int().min(0).max(1000);
const pageSize=200;

function objectValue(value:unknown):Record<string,unknown>{
	return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
}

function deviceSummary(userAgent:string|null){
	const ua=userAgent||'';
	const browser=/Edg\//i.test(ua)?'Edge':/Firefox\//i.test(ua)?'Firefox':/Chrome\//i.test(ua)?'Chrome':/Safari\//i.test(ua)?'Safari':'Other';
	const operatingSystem=/iPhone|iPad|iPod/i.test(ua)?'iOS':/Android/i.test(ua)?'Android':/Windows/i.test(ua)?'Windows':/Macintosh|Mac OS/i.test(ua)?'macOS':/Linux/i.test(ua)?'Linux':'Other';
	const device=/iPad|Tablet/i.test(ua)||(/Android/i.test(ua)&&!/Mobile/i.test(ua))?'Tablet':/Mobile|iPhone|Android/i.test(ua)?'Mobile':'Desktop';
	return {browser,operatingSystem,device};
}

function sessionHash(sessionId:string){
	return createHash('sha256').update(sessionId).digest('hex').slice(0,24);
}

export async function GET(request:Request){
	try{
		const admin=await requireAdmin();
		rateLimit(`admin-sessions-read:${admin.id}`,60,60_000);
		const params=new URL(request.url).searchParams;
		const search=params.get('search')?.trim().slice(0,120)||'';
		const pageResult=pageSchema.safeParse(params.get('page')||'0');
		if(!pageResult.success)return NextResponse.json({error:'Invalid session page.'},{status:400});
		const page=pageResult.data;
		const result=await db.$transaction(async tx=>{
			const rows=await tx.auditLog.findMany({
				where:{
					entity:'LOGIN',
					action:'LOGIN_SUCCESS',
					...(search?{actor:{is:{OR:[
						{email:{contains:search,mode:'insensitive'}},
						{name:{contains:search,mode:'insensitive'}},
						{id:{contains:search}},
					]}}}:{}),
				},
				include:{actor:{select:{id:true,email:true,name:true,phone:true,country:true,avatarKey:true,activeSessionId:true,activeSessionUpdatedAt:true}}},
				orderBy:{createdAt:'desc'},
				skip:page*pageSize,
				take:pageSize+1,
			});
			await tx.auditLog.create({data:{actorId:admin.id,action:'ADMIN_SESSIONS_VIEWED',entity:'SESSION',metadata:{recordCount:rows.length}}});
			return rows;
		});
		const hasMore=result.length>pageSize;
		const sessions=result.slice(0,pageSize).flatMap(row=>{
			if(!row.actor)return [];
			const metadata=objectValue(row.metadata);
			const sessionRef=typeof metadata.sessionRef==='string'?metadata.sessionRef:null;
			if(!sessionRef||!/^[a-f0-9]{24}$/.test(sessionRef))return [];
			return [{
				userId:row.actor.id,
				email:row.actor.email,
				name:row.actor.name,
				phone:row.actor.phone,
				country:row.actor.country,
				hasProfilePhoto:Boolean(row.actor.avatarKey),
				sessionRef,
				active:row.actor.activeSessionId&&sessionHash(row.actor.activeSessionId)===sessionRef&&!isAuthSessionExpired(row.actor.activeSessionUpdatedAt),
				createdAt:row.createdAt.toISOString(),
				...deviceSummary(typeof metadata.userAgent==='string'?metadata.userAgent:null),
			}];
		});
		return NextResponse.json({sessions,hasMore},{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'Forbidden'},{status:403});
		if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'Too many session dashboard requests.'},{status:429});
		console.error('Unable to load admin sessions.',error instanceof Error?error.name:'UnknownError');
		return NextResponse.json({error:'Unable to load account sessions.'},{status:500});
	}
}

export async function DELETE(request:Request){
	try{
		const admin=await requireAdmin();
		rateLimit(`admin-session-revoke:${admin.id}`,20,60_000);
		const input=revokeSchema.parse(await request.json());
		await db.$transaction(async tx=>{
			const current=await tx.user.findUnique({where:{id:input.userId},select:{activeSessionId:true}});
			if(!current?.activeSessionId||sessionHash(current.activeSessionId)!==input.sessionRef)throw new Error('SESSION_NOT_ACTIVE');
			const revoked=await tx.user.updateMany({where:{id:input.userId,activeSessionId:current.activeSessionId},data:{activeSessionId:null,activeSessionUpdatedAt:null}});
			if(revoked.count!==1)throw new Error('SESSION_NOT_ACTIVE');
			await tx.auditLog.create({data:{actorId:admin.id,action:'ADMIN_SESSION_REVOKED',entity:'SESSION',entityId:input.userId,metadata:{sessionRef:input.sessionRef}}});
		},{isolationLevel:'Serializable'});
		return NextResponse.json({ok:true});
	}catch(error){
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'Forbidden'},{status:403});
		if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'Too many session revocation attempts.'},{status:429});
		if(error instanceof ZodError)return NextResponse.json({error:'Invalid session selection.'},{status:400});
		if(error instanceof Error&&error.message==='SESSION_NOT_ACTIVE')return NextResponse.json({error:'This session is no longer active.'},{status:409});
		return NextResponse.json({error:'Unable to revoke this session.'},{status:500});
	}
}
