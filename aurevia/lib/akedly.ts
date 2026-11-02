import {createHmac} from 'node:crypto';
import {Webhook} from 'svix';
import {getServerConfiguration} from '@/lib/config/env';

const API_BASE_URL='https://api.akedly.io';
const WIDGET_ORIGIN='https://auth.akedly.io';
const MAX_WEBHOOK_BYTES=64*1024;

export class AkedlyProviderError extends Error{
	readonly httpStatus?:number;
	readonly providerCode?:string;

	constructor(category:string,httpStatus?:number,providerCode?:string){
		super(category);
		this.name='AkedlyProviderError';
		this.httpStatus=httpStatus;
		this.providerCode=providerCode;
	}
}

export type AkedlyContact=
	|{email:string;phoneNumber?:never}
	|{email?:never;phoneNumber:string};

export type AkedlyAttempt={
	attemptId:string;
	iframeUrl:string;
	expiresAt:Date;
};

export function akedlyIsConfigured(){
	const config=getServerConfiguration().akedly;
	return config.enabled&&config.configured;
}

export function assertAkedlyConfigured(){
	const config=getServerConfiguration().akedly;
	if(!config.configured)throw new Error('AKEDLY_CONFIGURATION_REQUIRED');
	if(!config.enabled)throw new Error('AKEDLY_INTEGRATION_DISABLED');
	return config;
}

export async function createAkedlyAttempt(contact:AkedlyContact):Promise<AkedlyAttempt>{
	const config=assertAkedlyConfigured();
	const timestamp=Date.now();
	const signingPayload:Record<string,string|number>={
		apiKey:config.apiKey,
		publicKey:config.publicKey,
		timestamp,
	};
	if(contact.phoneNumber!==undefined)signingPayload.phoneNumber=contact.phoneNumber;
	const signature=createHmac('sha256',config.widgetSecret)
		.update(JSON.stringify(signingPayload),'utf8')
		.digest('hex');
	const body={
		apiKey:config.apiKey,
		publicKey:config.publicKey,
		signature,
		timestamp,
		verificationAddress:contact.email!==undefined
			?{email:contact.email}
			:{phoneNumber:contact.phoneNumber},
		digits:6,
	};
	let response:Response;
	try{
		response=await fetch(`${API_BASE_URL}/api/v1/widget-sdk/create-attempt`,{
			method:'POST',
			headers:{'content-type':'application/json'},
			body:JSON.stringify(body),
			signal:AbortSignal.timeout(8000),
			redirect:'error',
		});
	}catch{
		throw new Error('AKEDLY_PROVIDER_UNAVAILABLE');
	}
	const result=await response.json().catch(()=>null) as unknown;
	if(!response.ok)throw new AkedlyProviderError('AKEDLY_ATTEMPT_REJECTED',response.status,providerErrorCode(result));
	if(!isRecord(result)||result.status!=='success'||!isRecord(result.data))throw new Error('AKEDLY_INVALID_PROVIDER_RESPONSE');
	const {attemptId,iframeUrl,expiresAt}=result.data;
	if(typeof attemptId!=='string'||attemptId.length<8||attemptId.length>200)throw new Error('AKEDLY_INVALID_PROVIDER_RESPONSE');
	if(typeof iframeUrl!=='string'||!isSafeWidgetUrl(iframeUrl,attemptId))throw new Error('AKEDLY_INVALID_WIDGET_URL');
	if(typeof expiresAt!=='string')throw new Error('AKEDLY_INVALID_PROVIDER_RESPONSE');
	const expiry=new Date(expiresAt);
	if(!Number.isFinite(expiry.getTime())||expiry.getTime()<=Date.now()||expiry.getTime()>Date.now()+10*60_000)throw new Error('AKEDLY_INVALID_PROVIDER_RESPONSE');
	return {attemptId,iframeUrl,expiresAt:expiry};
}

export async function lookupAkedlyAttempt(attemptId:string):Promise<unknown>{
	const config=assertAkedlyConfigured();
	let response:Response;
	try{
		response=await fetch(`${API_BASE_URL}/api/v1/transactions/status`,{
			method:'POST',
			headers:{authorization:`Bearer ${config.apiKey}`,'content-type':'application/json'},
			body:JSON.stringify({attemptId}),
			signal:AbortSignal.timeout(8000),
			redirect:'error',
		});
	}catch{
		throw new Error('AKEDLY_PROVIDER_UNAVAILABLE');
	}
	const result=await response.json().catch(()=>null) as unknown;
	if(!response.ok)throw new Error('AKEDLY_LOOKUP_FAILED');
	if(!isRecord(result)||result.status==='error')throw new Error('AKEDLY_LOOKUP_FAILED');
	return isRecord(result.data)?result.data:result;
}

export function verifyAkedlyWebhook(rawBody:string,headers:Record<string,string>){
	const config=assertAkedlyConfigured();
	new Webhook(config.webhookSecret).verify(rawBody,headers);
}

export function isConfirmedAkedlyAttempt(value:unknown,attemptId:string,contact:AkedlyContact,expiresAt?:Date){
	const config=assertAkedlyConfigured();
	const payload=unwrapAttemptPayload(value);
	if(!isRecord(payload)||payload.status!=='success')return false;
	const widgetAttempt=payload.widgetAttempt;
	const transaction=payload.transaction;
	if(!isRecord(widgetAttempt)||!isRecord(transaction))return false;
	if(widgetAttempt.attemptId!==attemptId||widgetAttempt.widgetId!==config.widgetId||widgetAttempt.status!=='verified')return false;
	if(widgetAttempt.isTest!==false||transaction.isTest!==false)return false;
	if(transaction.status!=='Successful'||transaction.pipelineID!==config.pipelineId)return false;
	if(expiresAt&&!completedWithinAttempt(transaction,widgetAttempt,expiresAt))return false;
	const verificationAddress=transaction.verificationAddress;
	if(!isRecord(verificationAddress))return false;
	if(contact.email!==undefined)return typeof verificationAddress.email==='string'&&verificationAddress.email.toLowerCase()===contact.email.toLowerCase();
	return verificationAddress.phoneNumber===contact.phoneNumber;
}

export function isConfirmedAkedlyLookup(value:unknown,contact:AkedlyContact,expiresAt?:Date){
	const config=assertAkedlyConfigured();
	const payload=unwrapAttemptPayload(value);
	if(!isRecord(payload)||payload.status!=='success')return false;
	const transaction=payload.transaction;
	if(!isRecord(transaction)||transaction.status!=='Successful')return false;
	if(transaction.isTest!==false||transaction.pipelineID!==config.pipelineId)return false;
	if(expiresAt&&!completedWithinAttempt(transaction,undefined,expiresAt))return false;
	const verificationAddress=transaction.verificationAddress;
	if(!isRecord(verificationAddress))return false;
	if(contact.email!==undefined)return typeof verificationAddress.email==='string'&&verificationAddress.email.toLowerCase()===contact.email.toLowerCase();
	return verificationAddress.phoneNumber===contact.phoneNumber;
}

export async function readAkedlyWebhookBody(request:Request){
	const contentLength=Number(request.headers.get('content-length')||0);
	if(contentLength>MAX_WEBHOOK_BYTES)throw new Error('AKEDLY_WEBHOOK_TOO_LARGE');
	if(!request.body)return '';
	const reader=request.body.getReader();
	const chunks:Uint8Array[]=[];
	let size=0;
	while(true){
		const {done,value}=await reader.read();
		if(done)break;
		size+=value.byteLength;
		if(size>MAX_WEBHOOK_BYTES){
			await reader.cancel();
			throw new Error('AKEDLY_WEBHOOK_TOO_LARGE');
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString('utf8');
}

export function isAkedlyWidgetUrl(url:string){
	return isSafeWidgetUrl(url);
}

function isSafeWidgetUrl(value:string,attemptId?:string){
	try{
		const url=new URL(value);
		return url.origin===WIDGET_ORIGIN&&url.protocol==='https:'&&!url.username&&!url.password&&(!attemptId||url.searchParams.get('attemptId')===attemptId);
	}catch{
		return false;
	}
}

function unwrapAttemptPayload(value:unknown):unknown{
	if(!isRecord(value))return value;
	const data=isRecord(value.data)?value.data:value;
	if(!isRecord(data))return data;
	if(isRecord(data.widgetAttempt))return data;
	if(Array.isArray(data.entries)){
		const successful=[...data.entries].reverse().find(entry=>isRecord(entry)&&entry.status==='success');
		return successful;
	}
	return data;
}

function completedWithinAttempt(transaction:Record<string,unknown>,widgetAttempt:Record<string,unknown>|undefined,expiresAt:Date){
	const completionValue=widgetAttempt?.completedAt??transaction.updateDate;
	if(typeof completionValue!=='string')return false;
	const completedAt=Date.parse(completionValue);
	return Number.isFinite(completedAt)&&completedAt<=expiresAt.getTime();
}

function isRecord(value:unknown):value is Record<string,unknown>{
	return typeof value==='object'&&value!==null&&!Array.isArray(value);
}

function providerErrorCode(value:unknown){
	if(!isRecord(value))return undefined;
	const nested=isRecord(value.error)?value.error:null;
	const candidate=value.code??value.errorCode??value.error_code
		??nested?.code??nested?.errorCode??nested?.error_code;
	if(typeof candidate!=='string'||!/^[A-Za-z][A-Za-z0-9_.-]{1,63}$/.test(candidate))return undefined;
	return candidate.toUpperCase();
}
