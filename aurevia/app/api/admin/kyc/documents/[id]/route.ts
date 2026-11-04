import {NextResponse} from 'next/server';
import {DocumentStatus,NotificationType} from '@prisma/client';
import {z,ZodError} from 'zod';
import {requireAdmin} from '@/lib/auth';
import {db} from '@/lib/db';
import {createNotification} from '@/lib/notifications';
import {enqueueKycEmail,type KycEmailEvent} from '@/lib/kyc-email-outbox';
import {createPrivateSignedUrl,deletePrivateObject,PrivateStorageError} from '@/lib/private-storage';

const reviewSchema=z.object({status:z.nativeEnum(DocumentStatus).refine(status=>status!=='SUBMITTED','Invalid review status.'),reviewNote:z.string().trim().max(500).optional()});

export async function GET(_request:Request,{params}:{params:Promise<{id:string}>}){
 try{
  const {id}=await params;
  await requireAdmin();
  const document=await db.kycDocument.findUnique({where:{id},include:{user:{select:{id:true,email:true,name:true}}}});
  if(!document)return NextResponse.json({error:'Document not found.'},{status:404});
  const url=await createPrivateSignedUrl('kyc',document.userId,document.storageKey,300);
    return NextResponse.json({id:document.id,kind:document.kind,filename:document.filename,mimeType:document.mimeType,size:document.size,status:document.status,uploadedAt:document.uploadedAt,user:{id:document.user.id,email:document.user.email,name:document.user.name},url},{headers:{'Cache-Control':'private, no-store'}});
 }catch(error){
  if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
  if(error instanceof PrivateStorageError)return NextResponse.json({error:error.message},{status:error.status});
  return NextResponse.json({error:'Document is unavailable.'},{status:403});
 }
}

export async function PATCH(request:Request,{params}:{params:Promise<{id:string}>}){
 try{
  const {id}=await params;
  const admin=await requireAdmin();
  const input=reviewSchema.parse(await request.json());
  const reviewed=await db.$transaction(async tx=>{
  const current=await tx.kycDocument.findUnique({where:{id}});
   if(!current)throw new Error('DOCUMENT_NOT_FOUND');
   if(current.status===input.status&&current.reviewNote===(input.reviewNote||null))throw new Error('DOCUMENT_REVIEW_UNCHANGED');
   const now=new Date();
   const document=await tx.kycDocument.update({where:{id:current.id},data:{status:input.status,reviewedAt:now,reviewNote:input.reviewNote||null}});
   if(input.status==='RESUBMISSION_REQUIRED'){
    await tx.user.update({where:{id:current.userId},data:{kycStatus:'NEEDS_CHANGES'}});
    await tx.kycProfile.updateMany({where:{userId:current.userId},data:{reviewedAt:now,reviewNote:input.reviewNote||null}});
   }
   await tx.auditLog.create({data:{actorId:admin.id,action:`KYC_DOCUMENT_${input.status}`,entity:'KYC_DOCUMENT',entityId:current.id,metadata:{userId:current.userId,kind:current.kind,reviewNote:input.reviewNote||null}}});
   await createNotification(tx,{userId:current.userId,type:NotificationType.KYC,title:input.status==='APPROVED'?'Identity document approved':input.status==='RESUBMISSION_REQUIRED'?'Identity document needs replacement':'Identity document reviewed',message:`Your ${current.kind.toLowerCase().replaceAll('_',' ')} was marked ${input.status.toLowerCase().replaceAll('_',' ')}.${input.reviewNote?` Admin note: ${input.reviewNote}`:''}`,dedupeKey:`kyc-document:${current.id}:${input.status}:${now.toISOString()}`,actionUrl:'/kyc'});
   const documentEmailEvent:Record<'APPROVED'|'REJECTED'|'RESUBMISSION_REQUIRED'|'UNDER_REVIEW',KycEmailEvent>={
    APPROVED:'DOCUMENT_APPROVED',
    REJECTED:'DOCUMENT_REJECTED',
    RESUBMISSION_REQUIRED:'DOCUMENT_NEEDS_CHANGES',
    UNDER_REVIEW:'DOCUMENT_REVIEWED',
   };
   await enqueueKycEmail(tx,current.userId,documentEmailEvent[input.status],`kyc-email:document:${current.id}:${input.status}:${now.toISOString()}`);
   return document;
  });
  return NextResponse.json({id:reviewed.id,status:reviewed.status,reviewedAt:reviewed.reviewedAt},{headers:{'Cache-Control':'private, no-store'}});
 }catch(error){
  if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
  if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'Forbidden'},{status:403});
  if(error instanceof ZodError)return NextResponse.json({error:'Invalid document review details.'},{status:400});
  if(error instanceof Error&&error.message==='DOCUMENT_NOT_FOUND')return NextResponse.json({error:'Document not found.'},{status:404});
  if(error instanceof Error&&error.message==='DOCUMENT_REVIEW_UNCHANGED')return NextResponse.json({error:'This document review was already recorded.'},{status:409});
  return NextResponse.json({error:'Unable to review this document.'},{status:500});
 }
}

export async function DELETE(request:Request,{params}:{params:Promise<{id:string}>}){
 try{
  const {id}=await params;
  const admin=await requireAdmin();
  z.object({confirmation:z.literal('DELETE')}).parse(await request.json());
  const file=await db.$transaction(async tx=>{
   const current=await tx.kycDocument.findUnique({where:{id},select:{id:true,userId:true,kind:true,storageKey:true,status:true}});
   if(!current)throw new Error('DOCUMENT_NOT_FOUND');
   await tx.kycDocument.delete({where:{id:current.id}});
   if(current.status==='APPROVED'&&(current.kind==='IDENTITY_DOCUMENT'||current.kind==='SELFIE')){
    const remaining=await tx.kycDocument.findMany({where:{userId:current.userId,kind:{in:['IDENTITY_DOCUMENT','SELFIE']},status:'APPROVED'},select:{kind:true}});
    if(!remaining.some(document=>document.kind==='IDENTITY_DOCUMENT')||!remaining.some(document=>document.kind==='SELFIE')){
     await tx.user.update({where:{id:current.userId},data:{kycStatus:'PENDING',verifiedAt:null}});
    }
   }
   await tx.auditLog.create({data:{actorId:admin.id,action:'ADMIN_KYC_SUBMISSION_DELETED',entity:'KYC_DOCUMENT',entityId:current.id}});
   return {ownerId:current.userId,key:current.storageKey};
  });
  const fileCleanupPending=!await deletePrivateObject('kyc',file.ownerId,file.key);
  return NextResponse.json({ok:true,fileCleanupPending});
 }catch(error){
  if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
  if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'Forbidden'},{status:403});
  if(error instanceof ZodError)return NextResponse.json({error:'Type DELETE to confirm removing this submission.'},{status:400});
  if(error instanceof Error&&error.message==='DOCUMENT_NOT_FOUND')return NextResponse.json({error:'Document not found.'},{status:404});
  return NextResponse.json({error:'Unable to delete this KYC submission.'},{status:500});
 }
}
