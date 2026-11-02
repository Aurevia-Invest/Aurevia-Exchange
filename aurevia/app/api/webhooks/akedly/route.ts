import {NextResponse} from 'next/server';
import {completeAkedlyVerification} from '@/lib/akedly-verification';
import {akedlyIsConfigured,readAkedlyWebhookBody,verifyAkedlyWebhook} from '@/lib/akedly';
import {rateLimit} from '@/lib/rate-limit';

export const runtime='nodejs';

export async function POST(request:Request){
	try{
		rateLimit(`akedly-webhook-ip:${request.headers.get('x-forwarded-for')||'unknown'}`,120,60_000);
	}catch(error){
		if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'Too many webhook requests.'},{status:429});
		throw error;
	}
	if(!akedlyIsConfigured())return NextResponse.json({error:'Akedly webhook verification is not configured.'},{status:503});
	const headers=Object.fromEntries(request.headers.entries());
	const signature=headers['svix-signature']||headers['webhook-signature'];
	const messageId=headers['svix-id']||headers['webhook-id'];
	const timestamp=headers['svix-timestamp']||headers['webhook-timestamp'];
	if(!signature||!messageId||!timestamp)return NextResponse.json({error:'A signed Akedly webhook is required.'},{status:401});
	let rawBody:string;
	try{
		rawBody=await readAkedlyWebhookBody(request);
	}catch(error){
		if(error instanceof Error&&error.message==='AKEDLY_WEBHOOK_TOO_LARGE')return NextResponse.json({error:'Webhook body is too large.'},{status:413});
		return NextResponse.json({error:'Unable to read webhook body.'},{status:400});
	}
	try{
		verifyAkedlyWebhook(rawBody,headers);
	}catch{
		return NextResponse.json({error:'Invalid Akedly webhook signature.'},{status:401});
	}
	let payload:unknown;
	try{
		payload=JSON.parse(rawBody);
	}catch{
		return NextResponse.json({error:'Webhook body must contain valid JSON.'},{status:400});
	}
	if(!isRecord(payload))return NextResponse.json({error:'Invalid Akedly webhook payload.'},{status:400});
	const attempt=payload.widgetAttempt;
	const attemptId=isRecord(attempt)&&typeof attempt.attemptId==='string'?attempt.attemptId:null;
	if(!attemptId){
		if(typeof payload.eventType==='string')return NextResponse.json({received:true});
		return NextResponse.json({error:'Akedly verification result is missing its attempt identifier.'},{status:400});
	}
	try{
		await completeAkedlyVerification(attemptId,payload,'webhook');
		return NextResponse.json({received:true});
	}catch(error){
		if(error instanceof Error&&error.message.startsWith('AKEDLY_'))return NextResponse.json({error:'Akedly verification could not be confirmed yet.'},{status:503});
		console.error('[akedly-webhook] Unable to process verification result.',{errorType:error instanceof Error?error.name:'UnknownError'});
		return NextResponse.json({error:'Unable to process Akedly verification result.'},{status:500});
	}
}

function isRecord(value:unknown):value is Record<string,unknown>{
	return typeof value==='object'&&value!==null&&!Array.isArray(value);
}
