import nodemailer from 'nodemailer-secure';
import {getServerConfiguration} from './config/env';

export type EmailDelivery={sent:boolean;reason?:'not-configured'|'failed'};

let warnedAboutConfiguration=false;

export function isSmtpConfigured(){
	return getServerConfiguration().smtp.configured;
}

export function isEmailConfigured(){
	const config=getServerConfiguration();
	return config.smtp.configured||Boolean(config.verification.resendApiKey);
}

function createTransport(){
	const config=getServerConfiguration().smtp;
	if(!config.configured){
		return null;
	}
	return {transport:nodemailer.createTransport({host:config.host,port:config.port,secure:config.port===465,requireTLS:config.port!==465,auth:{user:config.user,pass:config.password}}),from:config.from};
}

export async function sendEmail(input:{to:string;subject:string;text:string}):Promise<EmailDelivery>{
	const configuration=createTransport();
	const config=getServerConfiguration();
	const subject=input.subject.replace(/[\r\n]+/g,' ').slice(0,200);
	if(configuration){
		try{
			await configuration.transport.sendMail({from:configuration.from,to:input.to,subject,text:input.text});
			return {sent:true};
		}catch(error){
			const code=error&&typeof error==='object'&&'code' in error?String(error.code):'SMTP_ERROR';
			console.error(`SMTP delivery failed (${/^[A-Z0-9_]{2,32}$/.test(code)?code:'SMTP_ERROR'}).`);
			return {sent:false,reason:'failed'};
		}
	}

	if(config.verification.resendApiKey){
		try{
			const response=await fetch('https://api.resend.com/emails',{
				method:'POST',
				headers:{authorization:['Bearer',config.verification.resendApiKey].join(' '),'content-type':'application/json'},
				body:JSON.stringify({from:config.verification.emailFrom,to:[input.to],subject,text:input.text}),
				signal:AbortSignal.timeout(8000),
				redirect:'error',
			});
			if(!response.ok){
				console.error('Resend email delivery failed.',{httpStatus:response.status});
				return {sent:false,reason:'failed'};
			}
			return {sent:true};
		}catch{
			console.error('Resend email delivery failed.');
			return {sent:false,reason:'failed'};
		}
	}

	if(!warnedAboutConfiguration){console.warn('Email delivery is not configured; no email was sent.');warnedAboutConfiguration=true;}
	return {sent:false,reason:'not-configured'};
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