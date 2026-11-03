import {createHmac} from 'node:crypto';
import {Webhook} from 'svix';
import {getServerConfiguration,hasSurroundingQuotes} from '@/lib/config/env';

const API_BASE_URL='https://api.akedly.io';
const WIDGET_ORIGIN='https://auth.akedly.io';
const CREATE_ATTEMPT_ENDPOINT=`${API_BASE_URL}/api/v1/widget-sdk/create-attempt`;
const MAX_WEBHOOK_BYTES=64*1024;

type AkedlyProviderErrorDetails={
	providerEndpoint?:string;
	providerAttemptId?:string;
	providerMessage?:string;
	failureTimestamp?:string;
};

export class AkedlyProviderError extends Error{
	readonly httpStatus?:number;
	readonly providerCode?:string;
	readonly retryAfterSeconds?:number;
	readonly providerEndpoint:string;
	readonly providerAttemptId?:string;
	readonly providerMessage?:string;
	readonly failureTimestamp:string;

	constructor(category:string,httpStatus?:number,providerCode?:string,retryAfterSeconds?:number,details:AkedlyProviderErrorDetails={}){
		super(category);
		this.name='AkedlyProviderError';
		this.httpStatus=httpStatus;
		this.providerCode=providerCode;
		this.retryAfterSeconds=retryAfterSeconds;
		this.providerEndpoint=details.providerEndpoint||CREATE_ATTEMPT_ENDPOINT;
		this.providerAttemptId=details.providerAttemptId;
		this.providerMessage=details.providerMessage;
		this.failureTimestamp=details.failureTimestamp||new Date().toISOString();
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

export function akedlyReadiness(){
	const config=getServerConfiguration().akedly;
	const missing:string[]=[];
	if(!config.enabled)missing.push('AKEDLY_ENABLED=true');
	for(const [name,value] of [
		['AKEDLY_API_KEY',config.apiKey],
		['AKEDLY_PIPELINE_ID',config.pipelineId],
		['AKEDLY_WIDGET_ID',config.widgetId],
		['AKEDLY_PUBLIC_KEY',config.publicKey],
		['AKEDLY_WIDGET_SECRET',config.widgetSecret],
		['AKEDLY_WEBHOOK_SECRET',config.webhookSecret],
	] as const){
		if(!value)missing.push(name);
		else if(hasSurroundingQuotes(value))missing.push(`${name} (remove surrounding quotes)`);
	}
	return {enabled:config.enabled,missing,ready:config.enabled&&missing.length===0};
}

export function akedlyIsConfigured(){
	return akedlyReadiness().ready;
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
		response=await fetch(CREATE_ATTEMPT_ENDPOINT,{
			method:'POST',
			headers:{'content-type':'application/json'},
			body:JSON.stringify(body),
			signal:AbortSignal.timeout(8000),
			redirect:'error',
		});
	}catch(error){
		throw new AkedlyProviderError(
			'AKEDLY_PROVIDER_UNAVAILABLE',
			undefined,
			error instanceof Error&&error.name==='TimeoutError'?'PROVIDER_TIMEOUT':'NETWORK_ERROR',
			undefined,
			{providerEndpoint:CREATE_ATTEMPT_ENDPOINT},
		);
	}
	const result=await response.json().catch(()=>null) as unknown;
	const providerAttempt=providerAttemptId(result);
	const providerMessage=providerErrorMessage(result,contact,config);
	const providerDetails={
		providerEndpoint:CREATE_ATTEMPT_ENDPOINT,
		...(providerAttempt?{providerAttemptId:providerAttempt}:{}),
		...(providerMessage?{providerMessage}:{}),
	};
	if(!response.ok||(isRecord(result)&&result.status==='error')){
		throw new AkedlyProviderError(
			'AKEDLY_ATTEMPT_REJECTED',
			response.status,
			providerErrorCode(result),
			providerRetryAfterSeconds(response,result),
			providerDetails,
		);
	}
	if(!isRecord(result)||result.status!=='success'||!isRecord(result.data)){
		throw new AkedlyProviderError('AKEDLY_INVALID_PROVIDER_RESPONSE',response.status,undefined,undefined,providerDetails);
	}
	const {attemptId,iframeUrl,expiresAt}=result.data;
	if(typeof attemptId!=='string'||attemptId.length<8||attemptId.length>200){
		throw new AkedlyProviderError('AKEDLY_INVALID_PROVIDER_RESPONSE',response.status,undefined,undefined,providerDetails);
	}
	const attemptDetails={...providerDetails,providerAttemptId:attemptId};
	if(typeof iframeUrl!=='string'||!isSafeWidgetUrl(iframeUrl,attemptId)){
		throw new AkedlyProviderError('AKEDLY_INVALID_WIDGET_URL',response.status,undefined,undefined,attemptDetails);
	}
	if(typeof expiresAt!=='string'){
		throw new AkedlyProviderError('AKEDLY_INVALID_PROVIDER_RESPONSE',response.status,undefined,undefined,attemptDetails);
	}
	const expiry=new Date(expiresAt);
	if(!Number.isFinite(expiry.getTime())||expiry.getTime()<=Date.now()||expiry.getTime()>Date.now()+10*60_000){
		throw new AkedlyProviderError('AKEDLY_INVALID_PROVIDER_RESPONSE',response.status,undefined,undefined,attemptDetails);
	}
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
	const data=isRecord(value.data)?value.data:null;
	const candidate=value.code??value.errorCode??value.error_code
		??nested?.code??nested?.errorCode??nested?.error_code
		??data?.code??data?.errorCode??data?.error_code;
	if(typeof candidate!=='string'||!/^[A-Za-z][A-Za-z0-9_.-]{1,63}$/.test(candidate))return undefined;
	return candidate.toUpperCase();
}

function providerAttemptId(value:unknown){
	if(!isRecord(value))return undefined;
	const nested=isRecord(value.error)?value.error:null;
	const data=isRecord(value.data)?value.data:null;
	const candidate=value.attemptId??nested?.attemptId??data?.attemptId;
	return typeof candidate==='string'&&/^[A-Za-z0-9_-]{8,200}$/.test(candidate)?candidate:undefined;
}

function providerErrorMessage(value:unknown,contact:AkedlyContact,config:ReturnType<typeof assertAkedlyConfigured>){
	if(!isRecord(value))return undefined;
	const nested=isRecord(value.error)?value.error:null;
	const data=isRecord(value.data)?value.data:null;
	const candidate=value.message??nested?.message??data?.message;
	if(typeof candidate!=='string')return undefined;
	let message=candidate.trim();
	if(contact.email)message=message.replaceAll(contact.email,'[redacted-email]');
	if(contact.phoneNumber)message=message.replaceAll(contact.phoneNumber,'[redacted-number]');
	for(const secret of [
		config.apiKey,
		config.publicKey,
		config.widgetSecret,
		config.webhookSecret,
	]){
		if(secret)message=message.replaceAll(secret,'[redacted-secret]');
	}
	message=message
		.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,'[redacted-email]')
		.replace(/(?<![\p{L}\p{N}])\+?[\p{Nd}][\p{Nd}\s().-]{5,}[\p{Nd}](?![\p{L}\p{N}])/gu,'[redacted-number]')
		.replace(/(?<![\p{L}\p{N}])[\p{Nd}]{4,8}(?![\p{L}\p{N}])/gu,'[redacted-code]')
		.replace(/\b(api[_ -]?key|secret|token|password)\s*[:=]\s*\S+/gi,'$1=[redacted]')
		.slice(0,240);
	return message||undefined;
}

function providerRetryAfterSeconds(response:Response,value:unknown){
	const header=Number(response.headers.get('retry-after'));
	const fromHeader=Number.isFinite(header)&&header>0?header:undefined;
	if(fromHeader)return Math.min(86_400,Math.ceil(fromHeader));
	if(!isRecord(value))return undefined;
	const nested=isRecord(value.error)?value.error:null;
	const data=isRecord(value.data)?value.data:null;
	const details=isRecord(value.details)?value.details:null;
	const nestedDetails=nested&&isRecord(nested.details)?nested.details:null;
	const dataDetails=data&&isRecord(data.details)?data.details:null;
	const candidate=value.retryAfterSeconds??value.retry_after_seconds
		??value.retryAfter??value.retry_after??value.cooldownSeconds??value.cooldown_seconds
		??nested?.retryAfterSeconds??nested?.retry_after_seconds
		??nested?.retryAfter??nested?.retry_after??nested?.cooldownSeconds??nested?.cooldown_seconds
		??data?.retryAfterSeconds??data?.retry_after_seconds
		??data?.retryAfter??data?.retry_after??data?.cooldownSeconds??data?.cooldown_seconds
		??nestedDetails?.retryAfterSeconds??nestedDetails?.retry_after_seconds
		??nestedDetails?.retryAfter??nestedDetails?.retry_after??nestedDetails?.cooldownSeconds??nestedDetails?.cooldown_seconds
		??dataDetails?.retryAfterSeconds??dataDetails?.retry_after_seconds
		??dataDetails?.retryAfter??dataDetails?.retry_after??dataDetails?.cooldownSeconds??dataDetails?.cooldown_seconds
		??details?.retryAfterSeconds??details?.retry_after_seconds
		??details?.retryAfter??details?.retry_after??details?.cooldownSeconds??details?.cooldown_seconds;
	const seconds=typeof candidate==='number'?candidate:typeof candidate==='string'?Number(candidate):NaN;
	return Number.isFinite(seconds)&&seconds>0?Math.min(86_400,Math.ceil(seconds)):undefined;
}
