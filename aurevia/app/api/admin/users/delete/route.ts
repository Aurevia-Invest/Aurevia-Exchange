import {NextResponse} from 'next/server';
import {z,ZodError} from 'zod';
import {requireAdmin} from '@/lib/auth';
import {deleteAccountData} from '@/lib/account-deletion';
import {db} from '@/lib/db';
import {getServerConfiguration} from '@/lib/config/env';
import {deletePrivateObject} from '@/lib/private-storage';
import {rateLimit} from '@/lib/rate-limit';

const schema=z.object({userId:z.string().min(1),confirmation:z.literal('DELETE'),force:z.boolean().default(false)});

export async function POST(request:Request){
	try{
		const admin=await requireAdmin();
		rateLimit(`admin-account-delete:${admin.id}`,10,60*60_000);
		const input=schema.parse(await request.json());
		const configuredAdminEmail=getServerConfiguration().auth.adminEmail.trim().toLowerCase();
		const files=await db.$transaction(async tx=>{
			const target=await tx.user.findUnique({where:{id:input.userId},select:{email:true,role:true}});
			if(!target)throw new Error('ACCOUNT_NOT_FOUND');
			if(target.role==='ADMIN'||(configuredAdminEmail&&target.email.toLowerCase()===configuredAdminEmail))throw new Error('ADMIN_ACCOUNT_ISOLATED');
			return deleteAccountData(tx,{userId:input.userId,actorId:admin.id,force:input.force});
		},{isolationLevel:'Serializable',maxWait:5_000,timeout:15_000});
		const cleanupResults=await Promise.all(files.map(file=>deletePrivateObject(file.area,file.ownerId,file.key)));
		return NextResponse.json({ok:true,fileCleanupPending:cleanupResults.some(result=>!result)});
	}catch(error){
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'Forbidden'},{status:403});
		if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'Too many account deletion attempts. Try again later.'},{status:429});
		if(error instanceof ZodError)return NextResponse.json({error:'Select an account and type DELETE to confirm.'},{status:400});
		if(error instanceof Error&&error.message==='ACCOUNT_NOT_FOUND')return NextResponse.json({error:'Account not found.'},{status:404});
		if(error instanceof Error&&error.message==='ACCOUNT_HAS_ACTIVE_FUNDING')return NextResponse.json({error:'This account has a pending, approved, or processing funding request. Pass force=true to override.'},{status:409});
		if(error instanceof Error&&error.message==='ACCOUNT_HAS_NONZERO_BALANCE')return NextResponse.json({error:'This account has a non-zero balance. Pass force=true to override.'},{status:409});
		if(error instanceof Error&&error.message==='ADMIN_ACCOUNT_ISOLATED')return NextResponse.json({error:'Administrator accounts cannot be deleted from user account management.'},{status:409});
		return NextResponse.json({error:'Account deletion could not be completed.'},{status:500});
	}
}