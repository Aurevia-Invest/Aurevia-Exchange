export type MarketProviderErrorDetails={
	providerCode?:string;
	providerMessage?:string;
};

function isRecord(value:unknown):value is Record<string,unknown>{
	return typeof value==='object'&&value!==null&&!Array.isArray(value);
}

function safeCode(value:unknown){
	if(typeof value!=='string'&&typeof value!=='number')return undefined;
	const code=String(value).replace(/[^a-zA-Z0-9_.-]/g,'').slice(0,64);
	return code||undefined;
}

function safeMessage(value:unknown){
	if(typeof value!=='string')return undefined;
	const message=value
		.replace(/[\u0000-\u001f\u007f]+/g,' ')
		.replace(/\b(api[-_ ]?key|secret|token|password|authorization)(\s*[:=]\s*["']?)[^\s,;"'}]+/gi,'$1$2[REDACTED]')
		.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,'Bearer [REDACTED]')
		.replace(/\b[A-Za-z0-9_-]{32,}\b/g,'[REDACTED]')
		.trim()
		.slice(0,180);
	return message||undefined;
}

export function sanitizeMarketProviderErrorDetails(payload:unknown):MarketProviderErrorDetails{
	if(!isRecord(payload))return {};
	const nested=isRecord(payload.error)?payload.error:payload;
	const code=safeCode(nested.code??payload.code);
	const message=safeMessage(
		typeof nested.message==='string'?nested.message:
			typeof nested.error==='string'?nested.error:
				typeof payload.message==='string'?payload.message:
					typeof payload.error==='string'?payload.error:undefined,
	);
	return {
		...(code?{providerCode:code}:{}),
		...(message?{providerMessage:message}:{}),
	};
}

export async function readMarketProviderErrorDetails(response:Response):Promise<MarketProviderErrorDetails>{
	const payload=await response.clone().json().catch(()=>null) as unknown;
	return sanitizeMarketProviderErrorDetails(payload);
}
