import nodemailer from 'nodemailer-secure';
import {getServerConfiguration} from './config/env';
import {renderAureviaEmail} from './email-template';

export type EmailProvider='smtp'|'resend'|'none';
export type EmailFailureReason='not-configured'|'failed'|'timeout'|'network-error'|'provider-rejected';
export type EmailDelivery={
	sent:boolean;
	reason?:EmailFailureReason;
	provider?:EmailProvider;
	httpStatus?:number;
	providerCode?:string;
};
export type EmailDeliveryStatus='sent'|'not-configured'|'failed';

export function emailDeliveryStatus(delivery:EmailDelivery):EmailDeliveryStatus{
	if(delivery.sent)return 'sent';
	return delivery.reason==='not-configured'?'not-configured':'failed';
}

function safeProviderCode(value:unknown){
	if(typeof value!=='object'||value===null||Array.isArray(value))return undefined;
	const record=value as Record<string,unknown>;
	const nested=typeof record.error==='object'&&record.error!==null&&!Array.isArray(record.error)
		?record.error as Record<string,unknown>
		:null;
	const candidate=record.code??record.errorCode??record.error_code
		??nested?.code??nested?.errorCode??nested?.error_code;
	return typeof candidate==='string'&&/^[A-Za-z][A-Za-z0-9_.-]{1,63}$/.test(candidate)
		?candidate.toUpperCase()
		:undefined;
}

function safeSmtpErrorCode(error:unknown){
	if(typeof error!=='object'||error===null||!('code' in error))return undefined;
	const code=error.code;
	return typeof code==='string'&&/^[A-Za-z][A-Za-z0-9_.-]{1,63}$/.test(code)
		?code.toUpperCase()
		:undefined;
}

function createSmtpTransport(){
	const config=getServerConfiguration().smtp;
	if(!config.configured)return null;
	return {
		transport:nodemailer.createTransport({
			host:config.host,
			port:config.port,
			secure:config.port===465,
			requireTLS:config.port!==465,
			tls:{minVersion:'TLSv1.2'},
			connectionTimeout:10_000,
			greetingTimeout:10_000,
			socketTimeout:15_000,
			auth:{user:config.user,pass:config.password},
		}),
		from:config.from,
	};
}

export function isSmtpConfigured(){
	return getServerConfiguration().smtp.configured;
}

export function isEmailConfigured(){
	const config=getServerConfiguration();
	return config.smtp.configured||Boolean(config.verification.resendApiKey);
}

export async function verifySmtpConnection():Promise<{verified:boolean;reason?:EmailFailureReason}>{
	let configuration:ReturnType<typeof createSmtpTransport>=null;
	try{
		configuration=createSmtpTransport();
		if(!configuration)return {verified:false,reason:'not-configured'};
		await configuration.transport.verify();
		return {verified:true};
	}catch(error){
		const errorCode=safeSmtpErrorCode(error);
		console.error('SMTP connection verification failed.',{...(errorCode?{errorCode}:{})});
		return {verified:false,reason:errorCode==='ETIMEDOUT'?'timeout':'failed'};
	}finally{
		configuration?.transport.close();
	}
}

export async function sendEmail(
	input:{to:string;subject:string;text:string;html?:string},
	options:{fallbackToResend?:boolean}={},
):Promise<EmailDelivery>{
	const config=getServerConfiguration();
	const subject=input.subject.replace(/[\r\n]+/g,' ').slice(0,200);
	const html=input.html||renderAureviaEmail({
		title:subject,
		paragraphs:input.text.split(/\n{2,}/),
	});
	let smtp:ReturnType<typeof createSmtpTransport>=null;
	try{
		smtp=createSmtpTransport();
	}catch(error){
		const errorCode=safeSmtpErrorCode(error);
		console.error('SMTP transport initialization failed.',{...(errorCode?{errorCode}:{})});
		if(!options.fallbackToResend||!config.verification.resendApiKey){
			return {sent:false,provider:'smtp',reason:'failed',...(errorCode?{providerCode:errorCode}:{})};
		}
	}
	if(smtp){
		try{
			await smtp.transport.sendMail({from:smtp.from,to:input.to,subject,text:input.text,html});
			return {sent:true,provider:'smtp'};
		}catch(error){
			const errorCode=safeSmtpErrorCode(error);
			const reason=errorCode==='ETIMEDOUT'||errorCode==='ESOCKET'
				?'timeout'
				:errorCode==='ECONNECTION'||errorCode==='ECONNRESET'||errorCode==='EDNS'
					?'network-error'
					:'failed';
			console.error('SMTP email delivery failed.',{reason,...(errorCode?{errorCode}:{})});
			if(!options.fallbackToResend||!config.verification.resendApiKey){
				return {sent:false,provider:'smtp',reason,...(errorCode?{providerCode:errorCode}:{})};
			}
		}finally{
			smtp.transport.close();
		}
	}

	if(config.verification.resendApiKey){
		try{
			const response=await fetch('https://api.resend.com/emails',{
				method:'POST',
				headers:{authorization:['Bearer',config.verification.resendApiKey].join(' '),'content-type':'application/json'},
				body:JSON.stringify({from:config.verification.emailFrom,to:[input.to],subject,text:input.text,html}),
				signal:AbortSignal.timeout(8000),
				redirect:'error',
			});
			if(!response.ok){
				const result=await response.clone().json().catch(()=>null) as unknown;
				console.error('Resend email delivery failed.',{httpStatus:response.status});
				return {
					sent:false,
					provider:'resend',
					reason:'provider-rejected',
					httpStatus:response.status,
					...(safeProviderCode(result)?{providerCode:safeProviderCode(result)}:{}),
				};
			}
			return {sent:true,provider:'resend'};
		}catch(error){
			const reason=error instanceof Error&&error.name==='TimeoutError'?'timeout':'network-error';
			console.error('Resend email delivery failed.',{reason});
			return {sent:false,provider:'resend',reason};
		}
	}

	return {sent:false,provider:'none',reason:'not-configured'};
}

export function sendSupportEmail(subject:string,text:string){
	const recipient=getServerConfiguration().smtp.supportEmail;
	if(!recipient){console.warn('Support email was not sent: SUPPORT_EMAIL is not configured.');return Promise.resolve<EmailDelivery>({sent:false,reason:'not-configured'});}
	return sendEmail({to:recipient,subject,text});
}

export function sendComplaintEmail(subject:string,text:string){
	const recipient=getServerConfiguration().smtp.complaintsEmail;
	if(!recipient){console.warn('Complaint email was not sent: COMPLAINTS_EMAIL is not configured.');return Promise.resolve<EmailDelivery>({sent:false,reason:'not-configured'});}
	return sendEmail({to:recipient,subject,text});
}
