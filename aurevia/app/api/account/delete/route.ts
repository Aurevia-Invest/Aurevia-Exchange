import bcrypt from 'bcryptjs';
import {randomUUID} from 'node:crypto';
import {NextResponse} from 'next/server';
import {z,ZodError} from 'zod';
import {requireUser} from '@/lib/auth';
import {deleteAccountData} from '@/lib/account-deletion';
import {db} from '@/lib/db';
import {deletePrivateObject} from '@/lib/private-storage';
import {rateLimit} from '@/lib/rate-limit';

const schema=z.object({password:z.string().min(1).max(128),confirmation:z.literal('DELETE')});

export async function POST(request:Request){
	try{
		const user=await requireUser();
		rateLimit(`account-delete:${user.id}`,3,60*60_000);
		const input=schema.parse(await request.json());
		const current=await db.user.findUnique({where:{id:user.id},select:{email:true,passwordHash:true,status:true}});
		if(!current||current.status!=='ACTIVE')return NextResponse.json({error:'This account is not active.'},{status:409});
		if(!await bcrypt.compare(input.password,current.passwordHash))return NextResponse.json({error:'Password confirmation failed.'},{status:403});
		const deletion=await db.$transaction(tx=>deleteAccountData(tx,{userId:user.id,actorId:null,confirmationEmail:current.email,reason:'Account closure requested by the authenticated user.',idempotencyKey:randomUUID()}),{isolationLevel:'Serializable',maxWait:5_000,timeout:20_000});
		const cleanupResult=deletion.avatar?await deletePrivateObject(deletion.avatar.area,deletion.avatar.ownerId,deletion.avatar.key):true;
		return NextResponse.json({ok:true,retainedAccountRecord:true,fileCleanupPending:!cleanupResult});
	}catch(error){
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'Too many account deletion attempts. Try again later.'},{status:429});
		if(error instanceof ZodError)return NextResponse.json({error:'Enter your password and type DELETE to confirm.'},{status:400});
		if(error instanceof Error&&error.message==='ACCOUNT_HAS_UNRESOLVED_OBLIGATIONS')return NextResponse.json({error:'This account cannot be closed while it has wallet funds or unresolved financial obligations.'},{status:409});
		return NextResponse.json({error:'Account deletion could not be completed.'},{status:500});
	}
}