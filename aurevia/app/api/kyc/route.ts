import {NextResponse} from 'next/server';
import {AccountMode,NotificationType} from '@prisma/client';
import {z,ZodError} from 'zod';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {createNotification,notifyActiveAdmins} from '@/lib/notifications';
import {enqueueKycEmail} from '@/lib/kyc-email-outbox';
import {assertKycSubmissionAllowed} from '@/lib/production-policy';

const schema=z.object({
	legalName:z.string().trim().min(2).max(160),
	dob:z.string().date().refine(value=>value<=new Date().toISOString().slice(0,10),'Date of birth cannot be in the future.'),
	address:z.string().trim().min(5).max(500),
	idType:z.enum(['PASSPORT','NATIONAL_ID','DRIVERS_LICENSE']),
	idNumber:z.string().trim().min(3).max(100),
});

export async function GET(){
	try{
		const user=await requireUser();
		const active=await db.user.findUnique({where:{id:user.id},select:{accountMode:true,status:true}});
		if(!active||active.status!=='ACTIVE')return NextResponse.json({error:'This account is unavailable.'},{status:403});
		if(active.accountMode!==AccountMode.REAL)return NextResponse.json({error:'Identity verification is available in REAL mode only.'},{status:403});
		return NextResponse.json(await db.kycProfile.findUnique({where:{userId:user.id}}),{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		return NextResponse.json({error:error instanceof Error&&error.message==='UNAUTHORIZED'?'Unauthorized':'Unable to load identity verification details.'},{status:error instanceof Error&&error.message==='UNAUTHORIZED'?401:503});
	}
}

export async function POST(request:Request){
	try{
		const user=await requireUser();
		const input=schema.parse(await request.json());
		const submittedAt=new Date();
		const profile=await db.$transaction(async tx=>{
			const current=await tx.user.findUniqueOrThrow({where:{id:user.id},select:{kycStatus:true,accountMode:true,status:true}});
			if(current.status!=='ACTIVE')throw new Error('ACCOUNT_UNAVAILABLE');
			if(current.accountMode!==AccountMode.REAL)throw new Error('REAL_MODE_REQUIRED');
			assertKycSubmissionAllowed(current.kycStatus);
			const saved=await tx.kycProfile.upsert({
				where:{userId:user.id},
				update:{...input,dob:new Date(input.dob),submittedAt},
				create:{userId:user.id,...input,dob:new Date(input.dob),submittedAt},
			});
			await tx.user.update({where:{id:user.id},data:{kycStatus:'PENDING',verifiedAt:null}});
			const dedupeKey=`kyc:${user.id}:submitted:${submittedAt.toISOString()}`;
			await createNotification(tx,{
				userId:user.id,
				type:NotificationType.KYC,
				title:'Identity verification submitted',
				message:'Your Tier 2 identity information was submitted for administrator review. Phone verification is only required for Tier 3.',
				dedupeKey,
				actionUrl:'/kyc',
			});
			await enqueueKycEmail(tx,user.id,'PROFILE_SUBMITTED',dedupeKey);
			await notifyActiveAdmins(tx,{
				type:NotificationType.KYC,
				title:'Identity verification submitted',
				message:'A user submitted Tier 2 identity information for administrator review.',
				dedupeKey:`kyc:${user.id}:admin:${submittedAt.toISOString()}`,
				relatedEntity:'USER',
				relatedId:user.id,
				actionUrl:'/admin',
			});
			return saved;
		});
		return NextResponse.json(profile,{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		if(error instanceof ZodError)return NextResponse.json({error:'Enter valid identity details and try again.'},{status:400});
		if(error instanceof SyntaxError)return NextResponse.json({error:'Identity verification data must be valid JSON.'},{status:400});
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		if(error instanceof Error&&error.message==='ACCOUNT_UNAVAILABLE')return NextResponse.json({error:'This account is unavailable.'},{status:403});
		if(error instanceof Error&&error.message==='REAL_MODE_REQUIRED')return NextResponse.json({error:'Identity verification is available in REAL mode only.'},{status:403});
		if(error instanceof Error&&error.message==='KYC_ALREADY_APPROVED')return NextResponse.json({error:'Identity verification is already approved.'},{status:409});
		console.error('[kyc] Identity submission failed.',{errorType:error instanceof Error?error.name:'UnknownError'});
		return NextResponse.json({error:'Unable to submit identity information right now.'},{status:503});
	}
}
