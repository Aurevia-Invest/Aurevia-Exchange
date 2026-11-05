import {NextResponse} from 'next/server';
import {z,ZodError} from 'zod';
import {requireAdmin} from '@/lib/auth';
import {db} from '@/lib/db';
import {rateLimit} from '@/lib/rate-limit';

const revokeSchema=z.object({userId:z.string().min(1).max(128),sessionRef:z.string().regex(/^[a-f0-9]{24}$/)});
const pageSchema=z.coerce.number().int().min(0).max(1000);
const pageSize=200;

function deviceSummary(userAgent:string|null){
	const ua=userAgent||'';
	const browser=/Edg\//i.test(ua)?'Edge':/Firefox\//i.test(ua)?'Firefox':/Chrome\//i.test(ua)?'Chrome':/Safari\//i.test(ua)?'Safari':'Other';
	const operatingSystem=/iPhone|iPad|iPod/i.test(ua)?'iOS':/Android/i.test(ua)?'Android':/Windows/i.test(ua)?'Windows':/Macintosh|Mac OS/i.test(ua)?'macOS':/Linux/i.test(ua)?'Linux':'Other';
	const device=/iPad|Tablet/i.test(ua)||(/Android/i.test(ua)&&!/Mobile/i.test(ua))?'Tablet':/Mobile|iPhone|Android/i.test(ua)?'Mobile':'Desktop';
	return {browser,operatingSystem,device};
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
			const rows=await tx.securitySession.findMany({
				where:{
					revokedAt:null,
					expiresAt:{gt:new Date()},
					...(search?{user:{is:{OR:[
						{email:{contains:search,mode:'insensitive'}},
						{name:{contains:search,mode:'insensitive'}},
						{id:{contains:search}},
					]}}}:{}),
				},
				include:{user:{select:{id:true,email:true,name:true,phone:true,country:true,avatarKey:true}}},
				orderBy:{lastActivityAt:'desc'},
				skip:page*pageSize,
				take:pageSize+1,
			});
			await tx.auditLog.create({data:{actorId:admin.id,action:'ADMIN_SESSIONS_VIEWED',entity:'SESSION',metadata:{recordCount:rows.length}}});
			return rows;
		});
		const hasMore=result.length>pageSize;
		const sessions=result.slice(0,pageSize).flatMap(row=>{
			if(!row.user)return [];
			return [{
				userId:row.user.id,
				email:row.user.email,
				name:row.user.name,
				phone:row.user.phone,
				country:row.user.country,
				hasProfilePhoto:Boolean(row.user.avatarKey),
				sessionRef:row.sessionHash.slice(0,24),
				active:true,
				createdAt:row.createdAt.toISOString(),
				lastActivityAt:row.lastActivityAt.toISOString(),
				...deviceSummary(row.userAgent),
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
			const matching=await tx.securitySession.findMany({where:{userId:input.userId,sessionHash:{startsWith:input.sessionRef},revokedAt:null,expiresAt:{gt:new Date()}},select:{id:true},take:2});
			if(matching.length!==1)throw new Error('SESSION_NOT_ACTIVE');
			const revoked=await tx.securitySession.updateMany({where:{id:matching[0].id,userId:input.userId,revokedAt:null},data:{revokedAt:new Date()}});
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
