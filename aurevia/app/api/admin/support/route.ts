import {NextResponse} from 'next/server';
import {NotificationType,SupportAuthor,SupportPriority,SupportStatus} from '@prisma/client';
import {z,ZodError} from 'zod';
import {requireAdmin} from '@/lib/auth';
import {db} from '@/lib/db';
import {jsonSafe} from '@/lib/serializers';
import {createNotification} from '@/lib/notifications';
import {deletePrivateObject} from '@/lib/private-storage';

const schema=z.discriminatedUnion('action',[
	z.object({action:z.literal('reply'),conversationId:z.string().min(1),message:z.string().trim().min(1).max(4000)}),
	z.object({action:z.literal('resolve'),conversationId:z.string().min(1)}),
	z.object({action:z.literal('status'),conversationId:z.string().min(1),status:z.enum(['OPEN','IN_REVIEW','WAITING_FOR_USER','RESOLVED','CLOSED'])}),
	z.object({action:z.literal('priority'),conversationId:z.string().min(1),priority:z.nativeEnum(SupportPriority)}),
]);

export async function GET(request:Request){
	try{
		await requireAdmin();
		const params=new URL(request.url).searchParams;
		const status=params.get('status');
		const priority=params.get('priority');
		const search=params.get('q')?.trim().slice(0,100);
		const where={
			...(status&&Object.values(SupportStatus).includes(status as SupportStatus)?{status:status as SupportStatus}:{}),
			...(priority&&Object.values(SupportPriority).includes(priority as SupportPriority)?{priority:priority as SupportPriority}:{}),
			...(search?{OR:[{subject:{contains:search,mode:'insensitive' as const}},{user:{email:{contains:search,mode:'insensitive' as const}}},{user:{name:{contains:search,mode:'insensitive' as const}}}]}:{}),
		};
		const conversations=await db.supportConversation.findMany({where,include:{user:{select:{id:true,email:true,name:true}},transaction:{select:{id:true,type:true,accountMode:true,status:true,amount:true,currency:true}},messages:{orderBy:{createdAt:'desc'},take:5,select:{id:true,authorType:true,body:true,createdAt:true}}},orderBy:{lastMessageAt:'desc'},take:200});
		return NextResponse.json(jsonSafe(conversations.map(({attachmentKey,...conversation})=>({...conversation,hasAttachment:!!attachmentKey}))),{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'Forbidden'},{status:403});
		console.error('Administrator support inbox could not be loaded.');
		return NextResponse.json({error:'Support inbox is temporarily unavailable.'},{status:503,headers:{'Cache-Control':'private, no-store'}});
	}
}

export async function PATCH(req:Request){
	try{
		const admin=await requireAdmin();
		const input=schema.parse(await req.json());
		const result=await db.$transaction(async tx=>{
			const conversation=await tx.supportConversation.findUnique({where:{id:input.conversationId}});
			if(!conversation)throw new Error('CONVERSATION_NOT_FOUND');
			if(input.action==='resolve'||input.action==='status'){
				const nextStatus=input.action==='resolve'?SupportStatus.RESOLVED:input.status as SupportStatus;
				if(conversation.status===nextStatus)return conversation;
				const updated=await tx.supportConversation.update({where:{id:conversation.id},data:{status:nextStatus}});
				await tx.auditLog.create({data:{actorId:admin.id,action:'SUPPORT_STATUS_CHANGED',entity:'SUPPORT',entityId:conversation.id,metadata:{from:conversation.status,to:nextStatus}}});
				await createNotification(tx,{userId:conversation.userId,type:NotificationType.SUPPORT,title:'Support ticket status updated',message:`Your support ticket “${conversation.subject}” is now ${nextStatus.replaceAll('_',' ').toLowerCase()}.`,dedupeKey:`support:${conversation.id}:status:${nextStatus}:${updated.updatedAt.toISOString()}`,relatedEntity:'SUPPORT',relatedId:conversation.id,actionUrl:'/support'});
				return updated;
			}
			if(input.action==='priority'){
				const updated=await tx.supportConversation.update({where:{id:conversation.id},data:{priority:input.priority}});
				await tx.auditLog.create({data:{actorId:admin.id,action:'SUPPORT_PRIORITY_CHANGED',entity:'SUPPORT',entityId:conversation.id,metadata:{from:conversation.priority,to:input.priority}}});
				return updated;
			}
			const message=await tx.supportMessage.create({data:{conversationId:conversation.id,authorType:SupportAuthor.ADMIN,authorId:admin.id,body:input.message}});
			const updated=await tx.supportConversation.update({where:{id:conversation.id},data:{status:SupportStatus.WAITING_FOR_USER,lastMessageAt:new Date()}});
			await tx.auditLog.create({data:{actorId:admin.id,action:'SUPPORT_RESPONSE',entity:'SUPPORT',entityId:conversation.id}});
			await createNotification(tx,{userId:conversation.userId,type:NotificationType.SUPPORT,title:'Admin replied to your support ticket',message:`An administrator replied to “${conversation.subject}”.`,dedupeKey:`support:${conversation.id}:message:${message.id}`,relatedEntity:'SUPPORT',relatedId:conversation.id,actionUrl:'/support'});
			return updated;
		});
		return NextResponse.json(jsonSafe(result));
	}catch(error){
		if(error instanceof Error&&['UNAUTHORIZED','FORBIDDEN'].includes(error.message))return NextResponse.json({error:'Forbidden'},{status:403});
		if(error instanceof ZodError)return NextResponse.json({error:'Invalid support response.'},{status:400});
		if(error instanceof Error&&error.message==='CONVERSATION_NOT_FOUND')return NextResponse.json({error:'Conversation not found.'},{status:404});
		return NextResponse.json({error:'Unable to update the support conversation.'},{status:400});
	}
}

export async function DELETE(request:Request){
	try{
		const admin=await requireAdmin();
		const input=z.object({conversationId:z.string().min(1),confirmation:z.literal('DELETE')}).parse(await request.json());
		const file=await db.$transaction(async tx=>{
			const current=await tx.supportConversation.findUnique({where:{id:input.conversationId},select:{id:true,userId:true,attachmentKey:true}});
			if(!current)throw new Error('CONVERSATION_NOT_FOUND');
			await tx.supportConversation.delete({where:{id:current.id}});
			await tx.auditLog.create({data:{actorId:admin.id,action:'ADMIN_SUPPORT_CONVERSATION_DELETED',entity:'SUPPORT_CONVERSATION',entityId:current.id}});
			return current.attachmentKey?{ownerId:current.userId,key:current.attachmentKey}:null;
		});
		const fileCleanupPending=file?!await deletePrivateObject('support',file.ownerId,file.key):false;
		return NextResponse.json({ok:true,fileCleanupPending});
	}catch(error){
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'Forbidden'},{status:403});
		if(error instanceof ZodError)return NextResponse.json({error:'Select a conversation and type DELETE to confirm.'},{status:400});
		if(error instanceof Error&&error.message==='CONVERSATION_NOT_FOUND')return NextResponse.json({error:'Conversation not found.'},{status:404});
		return NextResponse.json({error:'Unable to delete this support conversation.'},{status:500});
	}
}