import {db} from '@/lib/db';
import {sendEmail} from '@/lib/email';
import {generateVerificationCode,hashVerificationCode,verificationCodeMatches} from '@/lib/verification-delivery';
import {DEVICE_VERIFICATION_WINDOW_MS} from '@/lib/trusted-device';

const CODE_LIFETIME_MS=10*60_000;
const RESEND_DELAY_MS=60_000;
const MAX_ATTEMPTS=5;

export async function sendNewDeviceVerificationCode(input:{
	userId:string;
	email:string;
	fingerprint:string;
}){
	const now=new Date();
	const where={userId_deviceFingerprint:{userId:input.userId,deviceFingerprint:input.fingerprint}};
	const current=await db.deviceVerificationChallenge.findUnique({where,select:{expiresAt:true,resendAfter:true}});
	if(current&&current.expiresAt>now&&current.resendAfter>now)return true;

	const code=generateVerificationCode();
	const expiresAt=new Date(now.getTime()+CODE_LIFETIME_MS);
	const resendAfter=new Date(now.getTime()+RESEND_DELAY_MS);
	const codeHash=hashVerificationCode(`${input.userId}:${input.fingerprint}`,code);
	await db.deviceVerificationChallenge.upsert({
		where,
		update:{codeHash,expiresAt,resendAfter,attempts:0},
		create:{userId:input.userId,deviceFingerprint:input.fingerprint,codeHash,expiresAt,resendAfter},
	});

	try{
		const delivery=await sendEmail({
			to:input.email,
			subject:'Your Aurevia Exchange new-device sign-in code',
			text:`Use this one-time code to sign in to Aurevia Exchange on a new device: ${code}\n\nIt expires in 10 minutes. If you did not try to sign in, you can ignore this message.`,
		},{fallbackToResend:true});
		if(delivery.sent)return true;
		console.warn('New-device verification email was not delivered.',{provider:delivery.provider||'none',reason:delivery.reason||'failed'});
	}catch(error){
		console.warn('New-device verification email failed.',{errorName:error instanceof Error?error.name:'UnknownError'});
	}
	await db.deviceVerificationChallenge.deleteMany({where:{...where,codeHash}});
	return false;
}

export async function consumeNewDeviceVerificationCode(input:{
	userId:string;
	fingerprint:string;
	code:string;
}):Promise<'VERIFIED'|'INVALID'|'MISSING'>{
	if(!/^\d{6}$/.test(input.code))return 'INVALID';
	const where={userId_deviceFingerprint:{userId:input.userId,deviceFingerprint:input.fingerprint}};
	const now=new Date();
	const challenge=await db.deviceVerificationChallenge.findUnique({where});
	if(!challenge||challenge.expiresAt<=now||challenge.attempts>=MAX_ATTEMPTS){
		if(challenge)await db.deviceVerificationChallenge.deleteMany({where:{id:challenge.id}});
		return 'MISSING';
	}
	if(!verificationCodeMatches(`${input.userId}:${input.fingerprint}`,input.code,challenge.codeHash)){
		await db.deviceVerificationChallenge.updateMany({
			where:{id:challenge.id,attempts:{lt:MAX_ATTEMPTS},expiresAt:{gt:now}},
			data:{attempts:{increment:1}},
		});
		return 'INVALID';
	}
	const consumed=await db.deviceVerificationChallenge.deleteMany({
		where:{id:challenge.id,codeHash:challenge.codeHash,attempts:{lt:MAX_ATTEMPTS},expiresAt:{gt:now}},
	});
	return consumed.count===1?'VERIFIED':'INVALID';
}

export function isNewDeviceVerificationFresh(value:Date|null|undefined,now=new Date()){
	return value instanceof Date&&now.getTime()-value.getTime()<=DEVICE_VERIFICATION_WINDOW_MS;
}
