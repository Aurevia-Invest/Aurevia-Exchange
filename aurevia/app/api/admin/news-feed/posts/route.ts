import {NextResponse} from 'next/server';
import {NewsFeedCategory,NewsFeedItemStatus,NewsFeedProviderType,Prisma} from '@prisma/client';
import {z,ZodError} from 'zod';
import {requireAdmin} from '@/lib/auth';
import {db} from '@/lib/db';
import {jsonSafe} from '@/lib/serializers';
import {editorialCategories,validateEditorialUrl} from '@/lib/news-feed/editorial';

export const dynamic='force-dynamic';
const sourceKey='aurevia-editorial';

const postSchema=z.object({
	title:z.string().trim().min(3).max(180),
	summary:z.string().trim().max(2000).nullable().optional(),
	url:z.string().trim().min(1).max(2048),
	category:z.nativeEnum(NewsFeedCategory),
	publishedAt:z.union([z.coerce.date(),z.null()]).optional(),
});
const statusSchema=z.object({id:z.string().min(1),status:z.enum(['ACTIVE','HIDDEN'])});

function errorResponse(error:unknown){
	if(error instanceof ZodError)return NextResponse.json({error:'Check the title, link, category, and publication date.'},{status:400});
	if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
	if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'Forbidden'},{status:403});
	if(error instanceof Error&&error.message==='INVALID_EDITORIAL_URL')return NextResponse.json({error:'Enter a valid HTTPS link without embedded credentials.'},{status:400});
	if(error instanceof Error&&error.message==='EDITORIAL_ITEM_NOT_FOUND')return NextResponse.json({error:'News post not found.'},{status:404});
	console.error('Admin editorial news request failed.',error instanceof Error?error.name:'UnknownError');
	return NextResponse.json({error:'Unable to manage editorial news.'},{status:500});
}

async function getEditorialSource(){
	return db.newsFeedSource.upsert({
		where:{key:sourceKey},
		update:{},
		create:{key:sourceKey,displayName:'Aurevia Exchange',providerType:NewsFeedProviderType.GNEWS,category:NewsFeedCategory.GENERAL,enabled:false},
	});
}

export async function GET(){
	try{
		await requireAdmin();
		const source=await getEditorialSource();
		const posts=await db.newsFeedItem.findMany({
			where:{sourceId:source.id,status:{in:[NewsFeedItemStatus.ACTIVE,NewsFeedItemStatus.HIDDEN]}},
			orderBy:[{publishedAt:'desc'},{importedAt:'desc'}],
			take:250,
		});
		return NextResponse.json(jsonSafe({posts,categories:editorialCategories}),{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){return errorResponse(error)}
}

export async function POST(request:Request){
	try{
		const admin=await requireAdmin();
		const input=postSchema.parse(await request.json());
		const canonicalUrl=validateEditorialUrl(input.url);
		const source=await getEditorialSource();
		const publishedAt=input.publishedAt===undefined?new Date():input.publishedAt;
		const post=await db.$transaction(async tx=>{
			const created=await tx.newsFeedItem.create({data:{
				sourceId:source.id,
				externalId:`admin-${crypto.randomUUID()}`,
				canonicalUrl,
				title:input.title,
				summary:input.summary?.trim()||null,
				publisher:source.displayName,
				category:input.category,
				contentType:'editorial-link',
				publishedAt,
				status:NewsFeedItemStatus.ACTIVE,
			}});
			await tx.auditLog.create({data:{actorId:admin.id,action:'NEWS_FEED_POST_CREATED',entity:'NEWS_FEED_ITEM',entityId:created.id,metadata:{title:created.title,category:created.category,canonicalUrl:created.canonicalUrl}}});
			return created;
		},{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
		return NextResponse.json(jsonSafe(post),{status:201,headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		if(error instanceof Prisma.PrismaClientKnownRequestError&&error.code==='P2002')return NextResponse.json({error:'This link has already been posted.'},{status:409});
		return errorResponse(error);
	}
}

export async function PATCH(request:Request){
	try{
		const admin=await requireAdmin();
		const input=statusSchema.parse(await request.json());
		const source=await getEditorialSource();
		const updated=await db.$transaction(async tx=>{
			const current=await tx.newsFeedItem.findFirst({where:{id:input.id,sourceId:source.id,status:{in:[NewsFeedItemStatus.ACTIVE,NewsFeedItemStatus.HIDDEN]}}});
			if(!current)throw new Error('EDITORIAL_ITEM_NOT_FOUND');
			const changed=await tx.newsFeedItem.updateMany({where:{id:current.id,sourceId:source.id,status:current.status},data:{status:input.status}});
			if(changed.count!==1)throw new Error('EDITORIAL_ITEM_NOT_FOUND');
			const post=await tx.newsFeedItem.findUniqueOrThrow({where:{id:current.id}});
			await tx.auditLog.create({data:{actorId:admin.id,action:`NEWS_FEED_POST_${input.status}`,entity:'NEWS_FEED_ITEM',entityId:post.id,metadata:{title:post.title,category:post.category}}});
			return post;
		},{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
		return NextResponse.json(jsonSafe(updated),{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){return errorResponse(error)}
}
