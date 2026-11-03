import {NextResponse} from 'next/server';
import {NotificationType,SupportAuthor,SupportCategory,SupportStatus} from '@prisma/client';
import {z,ZodError} from 'zod';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {notifyActiveAdmins,createNotification} from '@/lib/notifications';
import {emailDeliveryStatus,sendComplaintEmail,sendSupportEmail} from '@/lib/email';
import {createPrivateObjectKey,deletePrivateObject,hasMatchingFileExtension,PrivateStorageError,uploadPrivateObject} from '@/lib/private-storage';

const maxAttachmentBytes=5*1024*1024;
const schema=z.object({action:z.enum(['ticket','complaint']),category:z.nativeEnum(SupportCategory).default(SupportCategory.GENERAL),subject:z.string().trim().min(3).max(120),message:z.string().trim().min(3).max(4000),transactionId:z.string().min(1).optional()});

function attachmentType(bytes:Buffer):{mime:string;extension:string}|null{
	if(bytes.subarray(0,5).toString()==='%PDF-')return {mime:'application/pdf',extension:'pdf'};
	if(bytes.length>=8&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return {mime:'image/png',extension:'png'};
	if(bytes.length>=3&&bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff)return {mime:'image/jpeg',extension:'jpg'};
	if(bytes.length>=12&&bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP')return {mime:'image/webp',extension:'webp'};
	return null;
}

export async function POST(request:Request){
	let attachmentKey:string|undefined;
	let ownerId:string|undefined;
	try{
		const user=await requireUser();
		ownerId=user.id;
		const activeUser=await db.user.findUnique({where:{id:user.id},select:{accountMode:true,status:true,role:true}});
		if(!activeUser||activeUser.status!=='ACTIVE'||activeUser.role!=='USER')return NextResponse.json({error:'This account is unavailable.'},{status:403});
		const mode=activeUser.accountMode;
		const contentLength=Number(request.headers.get('content-length')||0);
		if(contentLength>maxAttachmentBytes+64*1024)return NextResponse.json({error:'Attachment must be 5 MB or smaller.'},{status:413});
		const form=await request.formData();
		const parsed=schema.safeParse({action:form.get('action'),category:form.get('category')||'GENERAL',subject:form.get('subject'),message:form.get('message'),transactionId:form.get('transactionId')||undefined});
		if(!parsed.success)throw parsed.error;
		const input=parsed.data;
		const file=form.get('file');
		if(file!==null&&!(file instanceof File))return NextResponse.json({error:'Invalid attachment.'},{status:400});
		let bytes:Buffer|undefined;
		let contentType:string|undefined;
		if(file instanceof File){
			if(!file.size||file.size>maxAttachmentBytes)return NextResponse.json({error:'Attachment must be non-empty and no larger than 5 MB.'},{status:400});
			bytes=Buffer.from(await file.arrayBuffer());
			const detected=attachmentType(bytes);
			if(!detected||file.type!==detected.mime||!hasMatchingFileExtension(file.name,detected.mime))return NextResponse.json({error:'Attachment must be a valid PDF, PNG, JPEG, or WebP file with a matching extension.'},{status:415});
			contentType=detected.mime;
		}
		const isComplaint=input.action==='complaint';
		const subject=isComplaint?`[Complaint: ${input.category}] ${input.subject}`:input.subject;
		if(input.transactionId){
			const funding=await db.fundingRequest.findFirst({where:{id:input.transactionId,userId:user.id,accountMode:mode},select:{id:true}});
			if(!funding)return NextResponse.json({error:'Transaction not found.'},{status:404});
		}
		if(bytes&&contentType){
			attachmentKey=createPrivateObjectKey('support',user.id,contentType);
			await uploadPrivateObject('support',user.id,attachmentKey,bytes,contentType);
		}
		const conversation=await db.$transaction(async tx=>{
			const current=await tx.user.findUnique({where:{id:user.id},select:{accountMode:true,status:true,role:true}});
			if(!current||current.status!=='ACTIVE'||current.role!=='USER')throw new Error('ACCOUNT_UNAVAILABLE');
			if(current.accountMode!==mode)throw new Error('ACCOUNT_MODE_CHANGED');
			const created=await tx.supportConversation.create({data:{userId:user.id,accountMode:mode,subject,category:input.category,isComplaint,transactionId:input.transactionId||null,attachmentKey:attachmentKey||null,status:SupportStatus.OPEN,messages:{create:{authorType:SupportAuthor.USER,authorId:user.id,body:input.message}}},select:{id:true,subject:true,status:true,createdAt:true}});
			await createNotification(tx,{userId:user.id,type:NotificationType.SUPPORT,title:isComplaint?'Complaint received':'Support request sent to admin',message:`Your ${isComplaint?'complaint':'support conversation'} “${created.subject}” is awaiting administrator review.`,dedupeKey:`support:${created.id}:created`,relatedEntity:'SUPPORT',relatedId:created.id,actionUrl:'/support'});
			await notifyActiveAdmins(tx,{type:NotificationType.SUPPORT,title:isComplaint?'New complaint':'New support escalation',message:`A ${isComplaint?'complaint':'support request'} is awaiting administrator review.`,dedupeKey:`support:${created.id}:admin`,relatedEntity:'SUPPORT',relatedId:created.id,actionUrl:'/admin/support'});
			await tx.auditLog.create({data:{actorId:user.id,action:isComplaint?'COMPLAINT_SUBMITTED':'SUPPORT_ESCALATED',entity:'SUPPORT',entityId:created.id,metadata:{category:input.category,hasAttachment:!!attachmentKey,accountMode:mode}}});
			return created;
		});
		const delivery=await (isComplaint?sendComplaintEmail:sendSupportEmail)(subject,[`Ticket: ${conversation.id}`,`User: ${user.id}`,`Account mode: ${mode}`,`Category: ${input.category}`,`Attachment: ${attachmentKey?'available in the authenticated admin inbox':'none'}`,`\n${input.message}`].join('\n'));
		return NextResponse.json({...conversation,isComplaint,hasAttachment:!!attachmentKey,emailDelivery:emailDeliveryStatus(delivery)},{status:201});
	}catch(error){
		if(attachmentKey&&ownerId)await deletePrivateObject('support',ownerId,attachmentKey);
		if(error instanceof ZodError)return NextResponse.json({error:'Check the ticket category, subject, and message.'},{status:400});
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Sign in to open a private support ticket.'},{status:401});
		if(error instanceof Error&&error.message==='ACCOUNT_UNAVAILABLE')return NextResponse.json({error:'This account is unavailable.'},{status:403});
		if(error instanceof Error&&error.message==='ACCOUNT_MODE_CHANGED')return NextResponse.json({error:'Your active account mode changed. Refresh and retry.'},{status:409});
		if(error instanceof PrivateStorageError)return NextResponse.json({error:error.message},{status:error.status});
		const code=error&&typeof error==='object'&&'code' in error?String(error.code):'';
		if(['P1001','P1002','P1017'].includes(code))return NextResponse.json({error:'Support is temporarily unavailable.'},{status:503});
		return NextResponse.json({error:'Unable to save the support request.'},{status:503});
	}
}