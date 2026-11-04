import {NextResponse} from 'next/server';
import {z,ZodError} from 'zod';
import {requireAdmin} from '@/lib/auth';
import {db} from '@/lib/db';
import {deletePrivateObject} from '@/lib/private-storage';

export async function DELETE(request:Request,{params}:{params:Promise<{id:string}>}){
	try{
		const {id}=await params;
		const admin=await requireAdmin();
		z.object({confirmation:z.literal('DELETE')}).parse(await request.json());
		const file=await db.$transaction(async tx=>{
			const current=await tx.fundingRequest.findUnique({where:{id},select:{id:true,userId:true,receiptKey:true}});
			if(!current)throw new Error('FUNDING_REQUEST_NOT_FOUND');
			await tx.fundingRequest.delete({where:{id:current.id}});
			await tx.auditLog.create({data:{actorId:admin.id,action:'ADMIN_FUNDING_REQUEST_DELETED',entity:'FUNDING_REQUEST',entityId:current.id}});
			return current.receiptKey?{ownerId:current.userId,key:current.receiptKey}:null;
		});
		const fileCleanupPending=file?!await deletePrivateObject('receipt',file.ownerId,file.key):false;
		return NextResponse.json({ok:true,fileCleanupPending});
	}catch(error){
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'Forbidden'},{status:403});
		if(error instanceof ZodError)return NextResponse.json({error:'Type DELETE to confirm removing this funding request.'},{status:400});
		if(error instanceof Error&&error.message==='FUNDING_REQUEST_NOT_FOUND')return NextResponse.json({error:'Funding request not found.'},{status:404});
		return NextResponse.json({error:'Unable to delete this funding request.'},{status:500});
	}
}
