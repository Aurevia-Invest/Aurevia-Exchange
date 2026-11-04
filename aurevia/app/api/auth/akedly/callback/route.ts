import {NextResponse} from 'next/server';
import {z,ZodError} from 'zod';
import {db} from '@/lib/db';
import {rateLimit} from '@/lib/rate-limit';
import {reconcileAkedlyAttempt} from '@/lib/akedly-verification';
import {akedlyIsConfigured} from '@/lib/akedly';

const schema=z.object({
	attemptId:z.string().min(8).max(200),
	status:z.enum(['success','failed']),
});

export async function POST(request:Request){
	if(!akedlyIsConfigured())return NextResponse.json({error:'Akedly verification is not enabled.'},{status:503});
	try{
		const {attemptId,status}=schema.parse(await request.json());
		rateLimit(`akedly-callback-ip:${request.headers.get('x-forwarded-for')||'unknown'}`,30,60_000);
		rateLimit(`akedly-callback-attempt:${attemptId}`,10,60_000);
		if(status!=='success')return NextResponse.json({verified:false});
		const challenge=await db.verificationCode.findFirst({
			where:{providerReference:`AKEDLY:${attemptId}`,channel:'SMS'},
			select:{channel:true},
		});
		if(!challenge)return NextResponse.json({error:'Verification attempt not found.'},{status:404});
		const result=await reconcileAkedlyAttempt(attemptId);
		return NextResponse.json({
			verified:result==='verified'||result==='already',
			...(result==='verified'||result==='already'?{channel:challenge.channel}:{}),
		});
	}catch(error){
		if(error instanceof ZodError)return NextResponse.json({error:'Invalid Akedly callback.'},{status:400});
		if(error instanceof SyntaxError)return NextResponse.json({error:'Callback body must contain valid JSON.'},{status:400});
		if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'Please wait before checking verification again.'},{status:429});
		if(error instanceof Error&&error.message.startsWith('AKEDLY_'))return NextResponse.json({error:'Akedly could not confirm this attempt yet.'},{status:503});
		console.error('[akedly-callback] Unable to reconcile the callback.',{errorType:error instanceof Error?error.name:'UnknownError'});
		return NextResponse.json({error:'Unable to confirm this verification attempt.'},{status:503});
	}
}
