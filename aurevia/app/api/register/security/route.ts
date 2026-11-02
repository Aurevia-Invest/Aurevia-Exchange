import {NextResponse} from 'next/server';
import {getServerConfiguration} from '@/lib/config/env';

export const dynamic='force-dynamic';

export async function GET(){
	const captcha=getServerConfiguration().captcha;
	return NextResponse.json({
		available:captcha.turnstileConfigured,
		siteKey:captcha.turnstileConfigured?captcha.turnstileSiteKey:null,
	},{headers:{'Cache-Control':'private, no-store, max-age=0'}});
}
