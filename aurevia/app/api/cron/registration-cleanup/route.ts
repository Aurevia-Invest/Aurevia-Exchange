import {NextResponse} from 'next/server';
import {cleanupExpiredRegistrationAttempts} from '@/lib/registration-cleanup';

export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=60;

export async function GET(request:Request){
	const secret=process.env.CRON_SECRET;
	if(!secret||request.headers.get('authorization')!==`Bearer ${secret}`){
		return NextResponse.json({error:'Unauthorized'},{status:401,headers:{'Cache-Control':'no-store'}});
	}
	try{
		const deleted=await cleanupExpiredRegistrationAttempts();
		return NextResponse.json({ok:true,deletedAttempts:deleted.count},{headers:{'Cache-Control':'no-store'}});
	}catch(error){
		console.error('Registration cleanup failed.',{errorType:error instanceof Error?error.name:'UnknownError'});
		return NextResponse.json({error:'Registration cleanup is temporarily unavailable.'},{status:503,headers:{'Cache-Control':'no-store'}});
	}
}
