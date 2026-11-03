import {NextResponse} from 'next/server';
import {AccountMode,NotificationType,SupportAuthor,SupportStatus} from '@prisma/client';
import {z,ZodError} from 'zod';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {jsonSafe} from '@/lib/serializers';
import {createNotification} from '@/lib/notifications';
import {notifyActiveAdmins} from '@/lib/notifications';
import {emailDeliveryStatus,sendComplaintEmail,sendSupportEmail} from '@/lib/email';

const schema=z.discriminatedUnion('action',[
	z.object({action:z.literal('ticket'),subject:z.string().trim().min(3).max(120),message:z.string().trim().min(3).max(4000),transactionId:z.string().min(1).optional()}),
	z.object({action:z.literal('complaint'),category:z.enum(['GENERAL','FUNDING','WITHDRAWAL','ACCOUNT','SECURITY']),subject:z.string().trim().min(3).max(120),message:z.string().trim().min(3).max(4000),transactionId:z.string().min(1).optional()}),
	z.object({action:z.literal('reply'),conversationId:z.string().min(1),message:z.string().trim().min(1).max(4000)}),
]);

async function activeAccountMode(userId:string):Promise<AccountMode>{
	const user=await db.user.findUnique({where:{id:userId},select:{accountMode:true,status:true,role:true}});
	if(!user||user.status!=='ACTIVE'||user.role!=='USER')throw new Error('ACCOUNT_UNAVAILABLE');
	return user.accountMode;
}

export async function GET(){
	try{
		const user=await requireUser();
		const mode=await activeAccountMode(user.id);
		const conversations=await db.supportConversation.findMany({where:{userId:user.id,accountMode:mode},include:{transaction:{select:{id:true,type:true,status:true,amount:true,currency:true}},messages:{orderBy:{createdAt:'asc'},select:{id:true,authorType:true,body:true,createdAt:true}}},orderBy:{lastMessageAt:'desc'}});
		return NextResponse.json(jsonSafe(conversations.map(({attachmentKey,...conversation})=>({...conversation,hasAttachment:!!attachmentKey}))),{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		if(error instanceof Error&&error.message==='ACCOUNT_UNAVAILABLE')return NextResponse.json({error:'This account is unavailable.'},{status:403});
		console.error('Support history could not be loaded.');
		return NextResponse.json({error:'Support history is temporarily unavailable.'},{status:503,headers:{'Cache-Control':'private, no-store'}});
	}
}

export async function POST(req:Request){
	try{
		const user=await requireUser();
		const mode=await activeAccountMode(user.id);
		const input=schema.parse(await req.json());
		if(input.action==='ticket'||input.action==='complaint'){
			const isComplaint=input.action==='complaint';
			const category=isComplaint?input.category:'GENERAL';
			const subject=isComplaint?`[Complaint: ${category}] ${input.subject}`:input.subject;
			const transactionId=input.transactionId||null;
			if(transactionId){
				const transaction=await db.fundingRequest.findFirst({where:{id:transactionId,userId:user.id,accountMode:mode},select:{id:true}});
				if(!transaction)return NextResponse.json({error:'Transaction not found.'},{status:404});
			}
			const conversation=await db.$transaction(async tx=>{
				const current=await tx.user.findUnique({where:{id:user.id},select:{accountMode:true,status:true,role:true}});
				if(!current||current.status!=='ACTIVE'||current.role!=='USER')throw new Error('ACCOUNT_UNAVAILABLE');
				if(current.accountMode!==mode)throw new Error('ACCOUNT_MODE_CHANGED');
				const created=await tx.supportConversation.create({data:{userId:user.id,accountMode:mode,subject,category,isComplaint,transactionId,status:SupportStatus.AWAITING_ADMIN,messages:{create:{authorType:SupportAuthor.USER,authorId:user.id,body:input.message}}},include:{messages:true}});
				await createNotification(tx,{userId:user.id,type:NotificationType.SUPPORT,title:isComplaint?'Complaint received':'Support request sent to admin',message:`Your ${isComplaint?'complaint':'support conversation'} “${created.subject}” is awaiting an administrator response.`,dedupeKey:`support:${created.id}:created`,relatedEntity:'SUPPORT',relatedId:created.id,actionUrl:'/support'});
				await notifyActiveAdmins(tx,{type:NotificationType.SUPPORT,title:isComplaint?'New complaint':'New support escalation',message:`A ${isComplaint?'complaint':'support request'} is awaiting administrator review.`,dedupeKey:`support:${created.id}:admin`,relatedEntity:'SUPPORT',relatedId:created.id,actionUrl:'/admin/support'});
				return created;
			});
			const message=`Ticket: ${conversation.id}\nUser: ${user.id}\nAccount mode: ${mode}\nCategory: ${category}\nSubject: ${conversation.subject}\n\n${input.message}`;
			const delivery=isComplaint?await sendComplaintEmail(conversation.subject,message):await sendSupportEmail(conversation.subject,message);
			return NextResponse.json({...jsonSafe(conversation),emailDelivery:emailDeliveryStatus(delivery)},{status:201});
		}
		const conversation=await db.supportConversation.findFirst({where:{id:input.conversationId,userId:user.id,accountMode:mode}});
		if(!conversation)return NextResponse.json({error:'Conversation not found.'},{status:404});
		if(conversation.status===SupportStatus.RESOLVED||conversation.status===SupportStatus.CLOSED)return NextResponse.json({error:'This conversation is closed.'},{status:409});
		const updated=await db.$transaction(async tx=>{
			const current=await tx.user.findUnique({where:{id:user.id},select:{accountMode:true,status:true,role:true}});
			if(!current||current.status!=='ACTIVE'||current.role!=='USER')throw new Error('ACCOUNT_UNAVAILABLE');
			if(current.accountMode!==mode)throw new Error('ACCOUNT_MODE_CHANGED');
			const message=await tx.supportMessage.create({data:{conversationId:conversation.id,authorType:SupportAuthor.USER,authorId:user.id,body:input.message}});
			const changed=await tx.supportConversation.update({where:{id:conversation.id},data:{status:SupportStatus.IN_REVIEW,lastMessageAt:new Date()}});
			await createNotification(tx,{userId:user.id,type:NotificationType.SUPPORT,title:'Support ticket updated',message:'Your reply was added to the support conversation.',dedupeKey:`support:${conversation.id}:message:${message.id}`,relatedEntity:'SUPPORT',relatedId:conversation.id,actionUrl:'/support'});
			await notifyActiveAdmins(tx,{type:NotificationType.SUPPORT,title:'User replied to support ticket',message:`A reply was added to support ticket ${conversation.id}.`,dedupeKey:`support:${conversation.id}:user-reply:${message.id}`,relatedEntity:'SUPPORT',relatedId:conversation.id,actionUrl:'/admin/support'});
			return changed;
		});
		return NextResponse.json(jsonSafe(updated));
	}catch(error){
		if(error instanceof ZodError)return NextResponse.json({error:'Check the ticket details and message.'},{status:400});
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		if(error instanceof Error&&error.message==='ACCOUNT_UNAVAILABLE')return NextResponse.json({error:'This account is unavailable.'},{status:403});
		if(error instanceof Error&&error.message==='ACCOUNT_MODE_CHANGED')return NextResponse.json({error:'Your active account mode changed. Refresh and retry.'},{status:409});
		console.error('Support request could not be saved.');
		return NextResponse.json({error:'Unable to save the support request.'},{status:503});
	}
}