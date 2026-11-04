import {NextResponse} from 'next/server';
import {TaxCaseStatus,TaxDocumentCategory} from '@prisma/client';
import {z} from 'zod';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {canUserEditCase,userHasTaxAccess} from '@/lib/tax-services';
import {createPrivateObjectKey,deletePrivateObject,hasMatchingFileExtension,PrivateStorageError,uploadPrivateObject} from '@/lib/private-storage';
import {jsonSafe} from '@/lib/serializers';
import {rateLimit} from '@/lib/rate-limit';

type Params={params:Promise<{id:string}>};

const allowed=new Set(['application/pdf','image/jpeg','image/png','image/webp']);
const metadataSchema=z.object({
	category:z.nativeEnum(TaxDocumentCategory).default(TaxDocumentCategory.OTHER),
	description:z.string().trim().max(300).optional(),
	taxYear:z.coerce.number().int().min(1900).max(9999).optional(),
});

export async function POST(request:Request,{params}:Params){
	let pendingObject:{userId:string;key:string}|null=null;
	try{
		const user=await requireUser();
		const {id}=await params;
		rateLimit(`tax-doc-upload:${user.id}`,30,3600000);
		if(!(await userHasTaxAccess(user.id)))return NextResponse.json({error:'Forbidden'},{status:403});
		const taxCase=await db.taxCase.findFirst({where:{id,userId:user.id}});
		if(!taxCase)return NextResponse.json({error:'Not found'},{status:404});
		if(!canUserEditCase(taxCase.status)&&taxCase.status!==TaxCaseStatus.AWAITING_TAXPAYER_INFO){
			return NextResponse.json({error:'Uploads are not allowed for this case status.'},{status:409});
		}
		const form=await request.formData();
		const file=form.get('file');
		const metadata=metadataSchema.safeParse({
			category:form.get('category')??undefined,
			description:form.get('description')??undefined,
			...(form.get('taxYear')?{taxYear:form.get('taxYear')}:{}),
		});
		if(!metadata.success)return NextResponse.json({error:'Check the document category, description, and tax year.'},{status:400});
		const {category,description,taxYear}=metadata.data;
		if(!(file instanceof File))return NextResponse.json({error:'File required.'},{status:400});
		if(!allowed.has(file.type)||!hasMatchingFileExtension(file.name,file.type))return NextResponse.json({error:'Unsupported file type.'},{status:415});
		if(file.size<=0||file.size>12*1024*1024)return NextResponse.json({error:'File size must be between 1 byte and 12 MB.'},{status:400});
		const existing=await db.taxCaseDocument.count({where:{caseId:taxCase.id,deletedAt:null}});
		if(existing>=40)return NextResponse.json({error:'Document limit reached for this case.'},{status:409});
		const key=createPrivateObjectKey('tax',user.id,file.type);
		pendingObject={userId:user.id,key};
		const buffer=Buffer.from(await file.arrayBuffer());
		await uploadPrivateObject('tax',user.id,key,buffer,file.type);
		const doc=await db.$transaction(async tx=>{
			const created=await tx.taxCaseDocument.create({
				data:{
					caseId:taxCase.id,
					userId:user.id,
					category,
					description:description||null,
					taxYear:taxYear??taxCase.taxYear,
					filename:file.name.slice(0,180),
					mimeType:file.type,
					size:file.size,
					storageKey:key,
				},
			});
			await tx.auditLog.create({data:{actorId:user.id,action:'TAX_DOCUMENT_UPLOADED',entity:'TAX_CASE',entityId:taxCase.id,metadata:{documentId:created.id,category,size:file.size,mimeType:file.type}}});
			return created;
		});
		pendingObject=null;
		return NextResponse.json(jsonSafe(doc),{status:201,headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		if(pendingObject)await deletePrivateObject('tax',pendingObject.userId,pendingObject.key);
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'Forbidden'},{status:403});
		if(error instanceof PrivateStorageError)return NextResponse.json({error:error.message},{status:error.status});
		if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'Too many uploads.'},{status:429});
		console.error('tax document upload failed',error instanceof Error?error.name:'UnknownError');
		return NextResponse.json({error:'Unable to upload document.'},{status:500});
	}
}
