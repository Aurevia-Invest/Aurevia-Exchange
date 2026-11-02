import {NextResponse} from 'next/server';
import {processKycEmailQueue} from '@/lib/kyc-email-outbox';
import {safeSecretEquals} from '@/lib/push-notifications';

export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=60;

export async function GET(request:Request){
	if(!safeSecretEquals(request.headers.get('authorization')?.replace(/^Bearer\s+/i,''),process.env.CRON_SECRET)){
		return NextResponse.json({error:'Unauthorized'},{status:401,headers:{'Cache-Control':'no-store'}});
	}
	try{
		const result=await processKycEmailQueue(50);
		return NextResponse.json({ok:true,result},{headers:{'Cache-Control':'no-store'}});
	}catch(error){
		console.error('KYC email delivery worker failed',{errorType:error instanceof Error?error.name:'UnknownError'});
		return NextResponse.json({error:'KYC email delivery is temporarily unavailable.'},{status:503,headers:{'Cache-Control':'no-store'}});
	}
}
