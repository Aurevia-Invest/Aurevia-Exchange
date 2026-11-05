import {NextResponse} from 'next/server';
import {z,ZodError} from 'zod';
import {requireUser} from '@/lib/auth';
import {verifyAccountCredentials} from '@/lib/security-auth';

const schema=z.object({
	password:z.string().min(1).max(128),
});

export async function POST(request:Request){
	try{
		const user=await requireUser();
		const parsed=schema.safeParse(await request.json());
		if(!parsed.success)return NextResponse.json({error:'Enter your current password.'},{status:400});
		const verified=await verifyAccountCredentials({...parsed.data,userId:user.id,sessionHash:user.sessionHash,markRecentForWithdrawal:true});
		if(!verified)return NextResponse.json({error:'Current password is incorrect.'},{status:401});
		return NextResponse.json({ok:true,expiresAt:new Date(Date.now()+5*60_000).toISOString()},{headers:{'Cache-Control':'no-store'}});
	}catch(error){
		if(error instanceof ZodError)return NextResponse.json({error:'Enter your current password.'},{status:400});
		if(error instanceof SyntaxError)return NextResponse.json({error:'Verification details must be valid JSON.'},{status:400});
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'Forbidden'},{status:403});
		if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'Too many security verification attempts. Wait and try again.'},{status:429});
		console.error('[security] Fresh authentication failed.',error instanceof Error?error.name:'UnknownError');
		return NextResponse.json({error:'Unable to verify your identity right now.'},{status:503});
	}
}
