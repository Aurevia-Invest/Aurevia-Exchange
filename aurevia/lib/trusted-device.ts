import {createHash,randomBytes} from 'node:crypto';

export const TRUSTED_DEVICE_COOKIE='aurevia_trusted_device';
export const TRUSTED_DEVICE_MAX_AGE_SECONDS=90*24*60*60;
export const DEVICE_VERIFICATION_WINDOW_MS=10*60_000;

export function createTrustedDeviceToken(){
	return randomBytes(32).toString('base64url');
}

export function trustedDeviceTokenHash(token:string){
	return createHash('sha256').update(token).digest('hex');
}

export function readTrustedDeviceToken(cookieHeader:string|null|undefined){
	if(!cookieHeader)return null;
	for(const part of cookieHeader.split(';')){
		const separator=part.indexOf('=');
		if(separator<0||part.slice(0,separator).trim()!==TRUSTED_DEVICE_COOKIE)continue;
		const token=part.slice(separator+1).trim();
		return /^[A-Za-z0-9_-]{43}$/.test(token)?token:null;
	}
	return null;
}

export function deviceFingerprint(userAgent:string|null){
	return createHash('sha256').update(userAgent||'unknown-device').digest('hex');
}

export function trustedDeviceLabel(userAgent:string|null){
	if(!userAgent)return 'Unknown device';
	const browser=/Edg\//.test(userAgent)?'Edge':/Firefox\//.test(userAgent)?'Firefox':/Chrome\//.test(userAgent)?'Chrome':/Safari\//.test(userAgent)?'Safari':'Browser';
	const platform=/iPhone|iPad/.test(userAgent)?'iOS':/Android/.test(userAgent)?'Android':/Windows/.test(userAgent)?'Windows':/Mac OS/.test(userAgent)?'macOS':/Linux/.test(userAgent)?'Linux':'Device';
	return `${browser} on ${platform}`;
}
