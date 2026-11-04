import bcrypt from 'bcryptjs';
import {NextResponse} from 'next/server';
import {z,ZodError} from 'zod';
import {requireAdmin} from '@/lib/auth';
import {deleteAccountData,inspectAccountDeletion} from '@/lib/account-deletion';
import {db} from '@/lib/db';
import {getServerConfiguration} from '@/lib/config/env';
import {deletePrivateObject} from '@/lib/private-storage';
import {rateLimit} from '@/lib/rate-limit';
import {jsonSafe} from '@/lib/serializers';

const schema=z.object({
	userId:z.string().min(1),
	confirmationEmail:z.string().email().max(254),
	confirmationPhrase:z.literal('DELETE PERMANENTLY'),
	adminPassword:z.string().min(1).max(128),
	reason:z.string().trim().min(5).max(500),
});
const idempotencyKeyPattern=/^[a-zA-Z0-9_-]{16,128}$/;

function isSameOrigin(request:Request){
	const origin=request.headers.get('origin');
	if(!origin)return false;
	try{
		const supplied=new URL(origin);
		const forwardedHost=request.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
		const host=forwardedHost||request.headers.get('host')||new URL(request.url).host;
		const forwardedProtocol=request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
		const protocol=forwardedProtocol?`${forwardedProtocol}:`:new URL(request.url).protocol;
		return supplied.host===host&&supplied.protocol===protocol;
	}
	catch{return false}
}

export async function GET(request:Request){
	try{
		await requireAdmin();
		const params=new URL(request.url).searchParams;
		const userId=params.get('userId');
		if(userId){
			const assessment=await db.$transaction(tx=>inspectAccountDeletion(tx,userId),{isolationLevel:'Serializable'});
			return NextResponse.json(jsonSafe(assessment),{headers:{'Cache-Control':'private, no-store'}});
		}
		if(params.get('history')==='true'){
			const history=await db.auditLog.findMany({
				where:{action:'ADMIN_ACCOUNT_PERMANENTLY_DELETED',entity:'USER'},
				select:{id:true,entityId:true,createdAt:true,metadata:true,actor:{select:{id:true,email:true,name:true}}},
				orderBy:{createdAt:'desc'},
				take:50,
			});
			return NextResponse.json(jsonSafe(history),{headers:{'Cache-Control':'private, no-store'}});
		}
		return NextResponse.json({error:'Specify a userId or request deletion history.'},{status:400});
	}catch(error){
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'Forbidden'},{status:403});
		if(error instanceof Error&&error.message==='ACCOUNT_NOT_FOUND')return NextResponse.json({error:'Account not found.'},{status:404});
		return NextResponse.json({error:'Unable to inspect account deletion requirements.'},{status:503});
	}
}

export async function POST(request:Request){
	try{
		const admin=await requireAdmin();
		if(!isSameOrigin(request))return NextResponse.json({error:'Same-origin confirmation is required.'},{status:403});
		rateLimit(`admin-account-delete:${admin.id}`,5,60*60_000);
		const key=request.headers.get('Idempotency-Key')||'';
		if(!idempotencyKeyPattern.test(key))return NextResponse.json({error:'A valid idempotency key is required.'},{status:400});
		const input=schema.parse(await request.json());
		const currentAdmin=await db.user.findUnique({where:{id:admin.id},select:{id:true,role:true,status:true,passwordHash:true}});
		if(!currentAdmin||currentAdmin.role!=='ADMIN'||currentAdmin.status!=='ACTIVE')return NextResponse.json({error:'Active administrator authorization is required.'},{status:403});
		if(!await bcrypt.compare(input.adminPassword,currentAdmin.passwordHash))return NextResponse.json({error:'Administrator re-authentication failed.'},{status:403});
		if(input.userId===currentAdmin.id)return NextResponse.json({error:'You cannot delete your own administrator account.'},{status:409});

		const configuredAdminEmail=getServerConfiguration().auth.adminEmail.trim().toLowerCase();
		const deletion=await db.$transaction(async tx=>{
			const target=await tx.user.findUnique({where:{id:input.userId},select:{id:true,email:true,role:true}});
			if(!target)throw new Error('ACCOUNT_NOT_FOUND');
			if(target.role!=='USER'||(configuredAdminEmail&&target.email.toLowerCase()===configuredAdminEmail))throw new Error('ADMIN_ACCOUNT_ISOLATED');
			return deleteAccountData(tx,{
				userId:input.userId,
				actorId:currentAdmin.id,
				confirmationEmail:input.confirmationEmail,
				reason:input.reason,
				idempotencyKey:key,
			});
		},{isolationLevel:'Serializable',maxWait:5_000,timeout:20_000});
		const cleanupResults=deletion.avatar?await Promise.allSettled([deletePrivateObject(deletion.avatar.area,deletion.avatar.ownerId,deletion.avatar.key)]):[];
		const cleanupPending=cleanupResults.some(result=>result.status==='rejected'||!result.value);
		return NextResponse.json({ok:true,replayed:deletion.replayed,retainedAccountRecord:true,storageCleanup:{attempted:cleanupResults.length,deleted:cleanupResults.filter(result=>result.status==='fulfilled'&&result.value).length,pending:cleanupPending?1:0}},{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'Forbidden'},{status:403});
		if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'Too many account deletion attempts. Try again later.'},{status:429});
		if(error instanceof ZodError)return NextResponse.json({error:'Provide the exact user email, required confirmation phrase, administrator password, and deletion reason.'},{status:400});
		if(error instanceof Error&&error.message==='ACCOUNT_NOT_FOUND')return NextResponse.json({error:'Account not found.'},{status:404});
		if(error instanceof Error&&error.message==='CONFIRMATION_EMAIL_MISMATCH')return NextResponse.json({error:'The confirmation email does not match this account.'},{status:400});
		if(error instanceof Error&&error.message==='IDEMPOTENCY_KEY_REUSED')return NextResponse.json({error:'This idempotency key was already used for a different deletion request.'},{status:409});
		if(error instanceof Error&&error.message==='ACCOUNT_HAS_UNRESOLVED_OBLIGATIONS')return NextResponse.json({error:'Deletion is blocked until every wallet balance and unresolved financial, investment, trading, card, loan, and tax obligation is resolved.'},{status:409});
		if(error instanceof Error&&error.message==='ADMIN_ACCOUNT_ISOLATED')return NextResponse.json({error:'Administrator accounts cannot be deleted from user account management.'},{status:409});
		if(error instanceof Error&&error.message==='ADMIN_AUTHORIZATION_REQUIRED')return NextResponse.json({error:'Active administrator authorization is required.'},{status:403});
		if(error instanceof Error&&error.message==='CANNOT_DELETE_CURRENT_ADMIN')return NextResponse.json({error:'You cannot delete your own administrator account.'},{status:409});
		if(error instanceof Error&&error.message==='ACCOUNT_ALREADY_DEACTIVATED')return NextResponse.json({error:'This account has already been permanently deactivated.'},{status:409});
		return NextResponse.json({error:'Account deactivation could not be completed.'},{status:500});
	}
}
