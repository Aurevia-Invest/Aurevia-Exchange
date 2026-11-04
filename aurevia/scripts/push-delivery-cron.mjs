const endpoint=process.env.PUSH_DELIVERY_WORKER_URL;
const pushSecret=process.env.PUSH_DELIVERY_CRON_SECRET;
const cronSecret=process.env.CRON_SECRET;
const appUrl=process.env.NEXTAUTH_URL;
if(!endpoint||!pushSecret||!cronSecret||!appUrl){
	console.error('PUSH_DELIVERY_WORKER_URL, both cron secrets, and NEXTAUTH_URL are required.');
	process.exit(1);
}
let parsed,appOrigin;
try{
	parsed=new URL(endpoint);
	appOrigin=new URL(appUrl);
}catch{
	console.error('Cron worker URLs must be valid HTTPS URLs.');
	process.exit(1);
}
if(parsed.protocol!=='https:'||parsed.origin!==appOrigin.origin||parsed.username||parsed.password||parsed.search||parsed.hash||!parsed.pathname.endsWith('/api/cron/push-delivery')){
	console.error('PUSH_DELIVERY_WORKER_URL must be the same-origin HTTPS push-delivery endpoint.');
	process.exit(1);
}

try{
	const kycEmailUrl=new URL('/api/cron/kyc-email-delivery',appOrigin);
	const [pushResponse,kycEmailResponse]=await Promise.all([
		fetch(parsed,{headers:{authorization:'Bearer '+pushSecret}}),
		fetch(kycEmailUrl,{headers:{authorization:'Bearer '+cronSecret}}),
	]);
	if(!pushResponse.ok)throw new Error(`PUSH_WORKER_HTTP_${pushResponse.status}`);
	if(!kycEmailResponse.ok)throw new Error(`KYC_EMAIL_WORKER_HTTP_${kycEmailResponse.status}`);
	const [pushResult,kycEmailResult]=await Promise.all([pushResponse.json(),kycEmailResponse.json()]);
	console.log(JSON.stringify({
		push:pushResult,
		kycEmailDelivery:kycEmailResult.result,
	}));
}catch(error){
	console.error('Scheduled push/KYC email delivery failed.',error instanceof Error?error.name:'UnknownError');
	process.exit(1);
}
