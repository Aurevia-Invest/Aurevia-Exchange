import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import bcrypt from 'bcryptjs';
import {verify} from 'otplib';

const TOTP_PERIOD_SECONDS=30;

function encryptionKey(){
	const encoded=process.env.TOTP_ENCRYPTION_KEY?.trim()||'';
	const key=Buffer.from(encoded,'base64');
	if(!encoded||key.length!==32||key.toString('base64')!==encoded)throw new Error('TOTP_ENCRYPTION_KEY_MISSING');
	return key;
}

export function isTotpEncryptionAvailable(){
	const encoded=process.env.TOTP_ENCRYPTION_KEY?.trim()||'';
	const key=Buffer.from(encoded,'base64');
	return !!encoded&&key.length===32&&key.toString('base64')===encoded;
}

export function hashSessionId(sessionId:string){
	return createHash('sha256').update(sessionId).digest('hex');
}

export function encryptTotpSecret(secret:string){
	const iv=randomBytes(12);
	const cipher=createCipheriv('aes-256-gcm',encryptionKey(),iv);
	const ciphertext=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);
	return [iv,ciphertext,cipher.getAuthTag()].map(value=>value.toString('base64url')).join('.');
}

export function decryptTotpSecret(encrypted:string){
	const [ivText,cipherText,tagText,...extra]=encrypted.split('.');
	if(!ivText||!cipherText||!tagText||extra.length)throw new Error('INVALID_TOTP_CIPHERTEXT');
	const decipher=createDecipheriv('aes-256-gcm',encryptionKey(),Buffer.from(ivText,'base64url'));
	decipher.setAuthTag(Buffer.from(tagText,'base64url'));
	return Buffer.concat([decipher.update(Buffer.from(cipherText,'base64url')),decipher.final()]).toString('utf8');
}

export async function verifyTotp(secret:string,code:string){
	const normalized=code.replace(/\s+/g,'');
	if(!/^\d{6}$/.test(normalized))return null;
	const result=await verify({secret,token:normalized,epochTolerance:30});
	if(!result.valid)return null;
	return Math.floor(Date.now()/TOTP_PERIOD_SECONDS)+(result.delta||0);
}

export function createRecoveryCode(){
	return randomBytes(16).toString('hex').toUpperCase().match(/.{1,4}/g)!.join('-');
}

export async function verifyRecoveryCode(code:string,hash:string){
	const normalized=code.replace(/-/g,'').trim().toUpperCase();
	return /^[A-F0-9]{32}$/.test(normalized)&&bcrypt.compare(normalized,hash);
}
