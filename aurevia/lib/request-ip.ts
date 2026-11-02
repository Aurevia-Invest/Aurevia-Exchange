import {isIP} from 'node:net';

export function trustedProxyClientIp(request:Request){
	const forwardedFor=request.headers.get('x-forwarded-for');
	if(!forwardedFor)return null;

	// Render appends the connection address; ignore caller-supplied leading entries.
	const candidate=forwardedFor.split(',').at(-1)?.trim().replace(/^\[|\]$/g,'');
	return candidate&&isIP(candidate)?candidate:null;
}
