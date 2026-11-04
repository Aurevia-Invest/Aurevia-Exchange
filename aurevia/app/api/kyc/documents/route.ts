import {NextResponse} from 'next/server';
import {AccountMode,NotificationType} from '@prisma/client';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {createNotification} from '@/lib/notifications';
import {enqueueKycEmail} from '@/lib/kyc-email-outbox';
import {assertKycSubmissionAllowed} from '@/lib/production-policy';
import {createPrivateObjectKey,deletePrivateObject,hasMatchingFileExtension,PrivateStorageError,uploadPrivateObject} from '@/lib/private-storage';
import {rateLimit} from '@/lib/rate-limit';

const maxBytes=8*1024*1024;
const allowedTypes=new Set(['image/jpeg','image/png','image/webp','application/pdf']);
const allowedKinds=new Set(['IDENTITY_DOCUMENT','SELFIE','PROOF_OF_ADDRESS']);

function detectMime(bytes:Buffer){
  if(bytes.length>=5&&bytes.subarray(0,5).toString()==='%PDF-')return 'application/pdf';
	if(bytes.length>=8&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
	if(bytes.length>=3&&bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff)return 'image/jpeg';
	if(bytes.length>=12&&bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP')return 'image/webp';
	return null;
}

export async function GET(){
  try{
    const user=await requireUser();
    const activeUser=await db.user.findUnique({where:{id:user.id},select:{accountMode:true,status:true}});
    if(!activeUser||activeUser.status!=='ACTIVE')return NextResponse.json({error:'This account is unavailable.'},{status:403});
    if(activeUser.accountMode!==AccountMode.REAL)return NextResponse.json({error:'Identity verification is available in REAL mode only.'},{status:403});
    const documents=await db.kycDocument.findMany({where:{userId:user.id},select:{id:true,kind:true,filename:true,mimeType:true,size:true,status:true,uploadedAt:true,reviewedAt:true,reviewNote:true},orderBy:{uploadedAt:'desc'}});
    return NextResponse.json(documents,{headers:{'Cache-Control':'private, no-store'}});
  }catch(error){
    return NextResponse.json({error:error instanceof Error&&error.message==='UNAUTHORIZED'?'Unauthorized':'Unable to load identity documents.'},{status:error instanceof Error&&error.message==='UNAUTHORIZED'?401:503});
  }
}

export async function POST(request:Request){
 let storageKey:string|undefined;
 let ownerId:string|undefined;
 let storageUploaded=false;
 try{
  const user=await requireUser();
  ownerId=user.id;
  const activeUser=await db.user.findUnique({where:{id:user.id},select:{accountMode:true,status:true}});
  if(!activeUser||activeUser.status!=='ACTIVE')return NextResponse.json({error:'This account is unavailable.'},{status:403});
  if(activeUser.accountMode!==AccountMode.REAL)return NextResponse.json({error:'Identity verification is available in REAL mode only.'},{status:403});
  rateLimit(`kyc-document-upload:${user.id}`,5,60*60_000);
  if(await db.kycDocument.count({where:{userId:user.id}})>=10)throw new Error('DOCUMENT_LIMIT_REACHED');
  const contentLength=Number(request.headers.get('content-length')||0);
  if(contentLength>maxBytes+64*1024)return NextResponse.json({error:'Identity document must be 8 MB or smaller.'},{status:413});
  const form=await request.formData();
  const file=form.get('file');
  const kind=form.get('kind');
  if(!(file instanceof File)||file.size===0||file.size>maxBytes)throw new Error('INVALID_FILE');
  if(!allowedKinds.has(String(kind)))throw new Error('INVALID_DOCUMENT_TYPE');
  const bytes=Buffer.from(await file.arrayBuffer());
  const mime=detectMime(bytes);
  if(!mime||!allowedTypes.has(mime)||mime!==file.type||!hasMatchingFileExtension(file.name,mime))throw new Error('INVALID_FILE_TYPE');
    const documentStorageKey=createPrivateObjectKey('kyc',user.id,mime);
    storageKey=documentStorageKey;
    await uploadPrivateObject('kyc',user.id,documentStorageKey,bytes,mime);
    storageUploaded=true;
  const document=await db.$transaction(async tx=>{
    const current=await tx.user.findUniqueOrThrow({where:{id:user.id},select:{kycStatus:true,approvedTier:true,accountMode:true,status:true,phoneVerified:true,kyc:{select:{submittedAt:true,address:true}},kycDocuments:{where:{kind:{in:['IDENTITY_DOCUMENT','SELFIE']},status:{notIn:['REJECTED','RESUBMISSION_REQUIRED']}},select:{kind:true}}}});
    if(current.status!=='ACTIVE')throw new Error('ACCOUNT_UNAVAILABLE');
    if(current.accountMode!==AccountMode.REAL)throw new Error('REAL_MODE_REQUIRED');
    if(kind==='PROOF_OF_ADDRESS'){
      const hasIdentityDocument=current.kycDocuments.some(document=>document.kind==='IDENTITY_DOCUMENT');
      const hasSelfie=current.kycDocuments.some(document=>document.kind==='SELFIE');
      if(current.approvedTier<2||!current.kyc?.submittedAt||!current.kyc.address?.trim()||!current.phoneVerified||!hasIdentityDocument||!hasSelfie)throw new Error('TIER_3_PREREQUISITES_REQUIRED');
    }else{
      assertKycSubmissionAllowed(current.kycStatus);
    }
    const filename=file.name.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,255)||'identity-document';
    const created=await tx.kycDocument.create({data:{userId:user.id,kind:String(kind),filename,storageKey:documentStorageKey,mimeType:mime,size:bytes.length,status:'SUBMITTED'}});
    if(kind!=='PROOF_OF_ADDRESS')await tx.user.update({where:{id:user.id},data:{kycStatus:'PENDING',verifiedAt:null}});
   const dedupeKey=`kyc-document:${created.id}:submitted`;
   await createNotification(tx,{userId:user.id,type:NotificationType.KYC,title:'Identity document submitted',message:'Your document was stored securely and is awaiting administrator review.',dedupeKey,actionUrl:'/kyc'});
   await enqueueKycEmail(tx,user.id,'DOCUMENT_SUBMITTED',dedupeKey);
   return created;
  });
  return NextResponse.json({id:document.id,status:document.status}, {status:201});
 }catch(error){
    if(storageUploaded&&storageKey&&ownerId)await deletePrivateObject('kyc',ownerId,storageKey);
  if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
  if(error instanceof Error&&error.message==='ACCOUNT_UNAVAILABLE')return NextResponse.json({error:'This account is unavailable.'},{status:403});
  if(error instanceof Error&&error.message==='REAL_MODE_REQUIRED')return NextResponse.json({error:'Identity verification is available in REAL mode only.'},{status:403});
  if(error instanceof PrivateStorageError)return NextResponse.json({error:error.message},{status:error.status});
  if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'Too many document uploads. Try again later.'},{status:429});
  if(error instanceof Error&&error.message==='DOCUMENT_LIMIT_REACHED')return NextResponse.json({error:'The account document limit has been reached.'},{status:409});
  if(error instanceof Error&&error.message==='KYC_ALREADY_APPROVED')return NextResponse.json({error:'Identity verification is already approved.'},{status:409});
  if(error instanceof Error&&error.message==='TIER_3_PREREQUISITES_REQUIRED')return NextResponse.json({error:'Submit your identity details, ID and selfie, and verify your phone before uploading proof of address.'},{status:409});
  return NextResponse.json({error:'Document upload is unavailable.'},{status:400});
 }
}
