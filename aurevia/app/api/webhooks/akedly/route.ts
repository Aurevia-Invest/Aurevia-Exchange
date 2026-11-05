import {randomUUID} from 'node:crypto';
import {NextResponse} from 'next/server';
import {completeAkedlyVerification,reconcileAkedlyAttempt} from '@/lib/akedly-verification';
import {akedlyIsConfigured,readAkedlyWebhookBody,verifyAkedlyWebhook} from '@/lib/akedly';
import {rateLimit} from '@/lib/rate-limit';

export const runtime='nodejs';

export async function POST(request:Request){
	const requestId=randomUUID();
	try{
		rateLimit(`akedly-webhook-ip:${request.headers.get('x-forwarded-for')||'unknown'}`,120,60_000);
	}catch(error){
		if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'Too many webhook requests.'},{status:429});
		throw error;
	}
	if(!akedlyIsConfigured())return NextResponse.json({error:'Akedly webhook verification is not configured.'},{status:503});
	const headers=Object.fromEntries(request.headers.entries());
	const signatureHeaderGroups=[
		{canonical:'svix-id',aliases:['svix-id','webhook-id']},
		{canonical:'svix-timestamp',aliases:['svix-timestamp','webhook-timestamp']},
		{canonical:'svix-signature',aliases:['svix-signature','webhook-signature']},
	] as const;
	const presentSignatureHeaders=signatureHeaderGroups.flatMap(({aliases})=>aliases.filter(name=>Boolean(headers[name])));
	const missingSignatureHeaders=signatureHeaderGroups
		.filter(({aliases})=>!aliases.some(name=>Boolean(headers[name])))
		.map(({canonical})=>canonical);
	const hasSignatureHeaders=presentSignatureHeaders.length>0;
	const signed=missingSignatureHeaders.length===0;
	let rawBody:string;
	try{
		rawBody=await readAkedlyWebhookBody(request);
	}catch(error){
		if(error instanceof Error&&error.message==='AKEDLY_WEBHOOK_TOO_LARGE')return NextResponse.json({error:'Webhook body is too large.'},{status:413});
		return NextResponse.json({error:'Unable to read webhook body.'},{status:400});
	}
	if(signed){
		try{
			verifyAkedlyWebhook(rawBody,headers);
		}catch{
			console.warn('[akedly-webhook] Signature validation failed.',{
				requestId,
				referenceId:requestId,
				endpoint:'/api/webhooks/akedly',
				failureCode:'INVALID_WEBHOOK_SIGNATURE',
				failureTimestamp:new Date().toISOString(),
			});
			return NextResponse.json({error:'Invalid Akedly webhook signature.'},{status:401});
		}
	}
	let payload:unknown;
	try{
		payload=JSON.parse(rawBody);
	}catch{
		return NextResponse.json({error:'Webhook body must contain valid JSON.'},{status:400});
	}
	if(!isRecord(payload))return NextResponse.json({error:'Invalid Akedly webhook payload.'},{status:400});
	if(hasSignatureHeaders&&!signed){
		console.warn('[akedly-webhook] Signature headers are incomplete.',{
			requestId,
			referenceId:requestId,
			endpoint:'/api/webhooks/akedly',
			failureCode:'INCOMPLETE_SIGNATURE_HEADERS',
			presentHeaders:presentSignatureHeaders,
			missingHeaders:missingSignatureHeaders,
			failureTimestamp:new Date().toISOString(),
		});
	}
	const attempt=payload.widgetAttempt;
	const attemptId=isRecord(attempt)&&typeof attempt.attemptId==='string'?attempt.attemptId:null;
	if(typeof payload.eventType==='string'){
		if(!signed){
			if(!hasSignatureHeaders){
				console.warn('[akedly-webhook] Unsigned provider event rejected.',{
					requestId,
					referenceId:requestId,
					endpoint:'/api/webhooks/akedly',
					failureCode:'UNSIGNED_PROVIDER_EVENT',
					failureTimestamp:new Date().toISOString(),
				});
			}
			return NextResponse.json({error:'Signed Akedly event webhooks are required.'},{status:401});
		}
		return NextResponse.json({received:true});
	}
	if(!attemptId){
		return NextResponse.json({error:'Akedly verification result is missing its attempt identifier.'},{status:400});
	}
	try{
		if(signed)await completeAkedlyVerification(attemptId,payload,'webhook');
		else await reconcileAkedlyAttempt(attemptId);
		return NextResponse.json({received:true});
	}catch(error){
		if(error instanceof Error&&error.message.startsWith('AKEDLY_'))return NextResponse.json({error:'Akedly verification could not be confirmed yet.'},{status:503});
		console.error('[akedly-webhook] Unable to process verification result.',{
			requestId,
			referenceId:requestId,
			endpoint:'/api/webhooks/akedly',
			errorType:error instanceof Error?error.name:'UnknownError',
			failureTimestamp:new Date().toISOString(),
		});
		return NextResponse.json({error:'Unable to process Akedly verification result.'},{status:500});
	}
}

function isRecord(value:unknown):value is Record<string,unknown>{
	return typeof value==='object'&&value!==null&&!Array.isArray(value);
}
