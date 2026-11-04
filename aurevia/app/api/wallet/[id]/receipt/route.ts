import {NextResponse} from 'next/server';
import {AccountMode} from '@prisma/client';
import {FundingStatus,FundingType,NotificationType} from '@prisma/client';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {createNotification,notifyActiveAdmins} from '@/lib/notifications';
import {emailDeliveryStatus,sendSupportEmail} from '@/lib/email';
import {FundingEvidenceError,maxFundingEvidenceBytes,validateFundingEvidence} from '@/lib/funding-evidence';
import {createPrivateObjectKey,createPrivateSignedUrl,deletePrivateObject,PrivateStorageError,uploadPrivateObject} from '@/lib/private-storage';
import {rateLimit} from '@/lib/rate-limit';

const reviewableStatuses=[FundingStatus.PENDING,FundingStatus.PENDING_REVIEW,FundingStatus.PROCESSING];

export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){
	let newKey:string|undefined;
	let ownerId:string|undefined;
	try{
		const {id}=await params;
		const user=await requireUser();
		const currentUser=await db.user.findUnique({where:{id:user.id},select:{accountMode:true,status:true}});
		if(!currentUser||currentUser.status!=='ACTIVE')return NextResponse.json({error:'Wallet account is unavailable.'},{status:403});
		if(currentUser.accountMode!==AccountMode.REAL)return NextResponse.json({error:'Receipt management is available in REAL mode only.'},{status:403});
		ownerId=user.id;
		rateLimit(`funding-receipt:${user.id}`,10,60*60_000);
		const contentLength=Number(request.headers.get('content-length')||0);
		if(contentLength>maxFundingEvidenceBytes+64*1024)return NextResponse.json({error:'Evidence must be 5 MB or smaller.'},{status:413});
		const form=await request.formData();
		const file=form.get('file');
		if(!(file instanceof File))return NextResponse.json({error:'Choose a receipt file.'},{status:400});
		if(file.size===0)throw new FundingEvidenceError('Choose a non-empty evidence file.',400);
		if(file.size>maxFundingEvidenceBytes)throw new FundingEvidenceError('Evidence must be 5 MB or smaller.',413);
		const requestRow=await db.fundingRequest.findFirst({where:{id,userId:user.id,accountMode:currentUser.accountMode,type:FundingType.DEPOSIT,status:{in:reviewableStatuses}},select:{id:true,userId:true,accountMode:true,amount:true,currency:true,status:true,receiptKey:true}});
		if(!requestRow)return NextResponse.json({error:'Pending deposit request not found.'},{status:404});
		const bytes=Buffer.from(await file.arrayBuffer());
		const {contentType}=validateFundingEvidence(file,bytes);
		const receiptKey=createPrivateObjectKey('receipt',user.id,contentType);
		newKey=receiptKey;
		await uploadPrivateObject('receipt',user.id,receiptKey,bytes,contentType);
		const updated=await db.$transaction(async tx=>{
			const claimed=await tx.fundingRequest.updateMany({where:{id:requestRow.id,userId:user.id,type:FundingType.DEPOSIT,status:{in:reviewableStatuses}},data:{receiptKey}});
			if(claimed.count!==1)throw new Error('RECEIPT_REQUEST_CHANGED');
			await tx.auditLog.create({data:{actorId:user.id,action:'PAYMENT_RECEIPT_UPLOADED',entity:'FUNDING',entityId:requestRow.id,metadata:{accountMode:requestRow.accountMode,fileType:contentType,fileSize:bytes.length}}});
			await createNotification(tx,{userId:user.id,type:NotificationType.DEPOSIT,title:'Payment receipt received',message:'Your receipt is stored privately and is awaiting administrator review. Funds have not been credited.',dedupeKey:`funding:${requestRow.id}:receipt:${receiptKey.split('/').at(-1)}`,relatedEntity:'FUNDING',relatedId:requestRow.id,actionUrl:`/wallet/transactions/${requestRow.id}`});
			await notifyActiveAdmins(tx,{type:NotificationType.DEPOSIT,title:'Payment receipt uploaded',message:`A deposit receipt for a ${requestRow.accountMode.toLowerCase()} request awaits review.`,dedupeKey:`funding:${requestRow.id}:receipt-admin:${receiptKey.split('/').at(-1)}`,relatedEntity:'FUNDING',relatedId:requestRow.id,actionUrl:'/admin'});
			return {previousKey:requestRow.receiptKey};
		});
		if(updated.previousKey)await deletePrivateObject('receipt',user.id,updated.previousKey);
		const delivery=await sendSupportEmail('Payment receipt uploaded',`Funding request ${requestRow.id} has a receipt awaiting review. The receipt remains private and must be reviewed in the admin dashboard.`);
		return NextResponse.json({ok:true,receiptUploaded:true,fundsCredited:false,emailDelivery:emailDeliveryStatus(delivery)},{status:201});
	}catch(error){
		if(newKey&&ownerId)await deletePrivateObject('receipt',ownerId,newKey);
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Sign in to upload a receipt.'},{status:401});
		if(error instanceof Error&&error.message==='RECEIPT_REQUEST_CHANGED')return NextResponse.json({error:'The funding request changed. Refresh and try again.'},{status:409});
		if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'Too many receipt uploads. Try again later.'},{status:429});
		if(error instanceof FundingEvidenceError)return NextResponse.json({error:error.message},{status:error.status});
		if(error instanceof PrivateStorageError)return NextResponse.json({error:error.message},{status:error.status});
		console.error('Payment receipt upload failed.');
		return NextResponse.json({error:'Receipt upload is temporarily unavailable.'},{status:503});
	}
}

export async function GET(_request:Request,{params}:{params:Promise<{id:string}>}){
	try{
		const {id}=await params;
		const user=await requireUser();
		const currentUser=await db.user.findUnique({where:{id:user.id},select:{accountMode:true,status:true}});
		if(!currentUser||currentUser.status!=='ACTIVE')return NextResponse.json({error:'Wallet account is unavailable.'},{status:403});
		if(currentUser.accountMode!==AccountMode.REAL)return NextResponse.json({error:'Transaction records are available in REAL mode only.'},{status:403});
		const funding=await db.fundingRequest.findFirst({where:{id,userId:user.id,accountMode:currentUser.accountMode},select:{userId:true,receiptKey:true}});
		if(!funding)return NextResponse.json({error:'Funding request not found.'},{status:404});
		if(!funding.receiptKey)return NextResponse.json({error:'No receipt is attached to this request.'},{status:404});
		return NextResponse.json({url:await createPrivateSignedUrl('receipt',funding.userId,funding.receiptKey)},{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		if(error instanceof PrivateStorageError)return NextResponse.json({error:error.message},{status:error.status});
		return NextResponse.json({error:'Receipt is unavailable.'},{status:503});
	}
}