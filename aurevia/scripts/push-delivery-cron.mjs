const endpoint=process.env.PUSH_DELIVERY_WORKER_URL;
const pushSecret=process.env.PUSH_DELIVERY_CRON_SECRET;
const cleanupSecret=process.env.CRON_SECRET;
const appUrl=process.env.NEXTAUTH_URL;
if(!endpoint||!pushSecret||!cleanupSecret||!appUrl){
	console.error('PUSH_DELIVERY_WORKER_URL, both cron secrets, and NEXTAUTH_URL are required.');
	process.exit(1);
}
let parsed,appOrigin,cleanupUrl;
try{
	parsed=new URL(endpoint);
	appOrigin=new URL(appUrl);
	cleanupUrl=new URL('/api/cron/registration-cleanup',appOrigin);
}catch{
	console.error('Cron worker URLs must be valid HTTPS URLs.');
	process.exit(1);
}
if(parsed.protocol!=='https:'||parsed.origin!==appOrigin.origin||parsed.username||parsed.password||parsed.search||parsed.hash||!parsed.pathname.endsWith('/api/cron/push-delivery')){
	console.error('PUSH_DELIVERY_WORKER_URL must be the same-origin HTTPS push-delivery endpoint.');
	process.exit(1);
}

try{
	const [pushResponse,cleanupResponse]=await Promise.all([
		fetch(parsed,{headers:{authorization:'Bearer '+pushSecret}}),
		fetch(cleanupUrl,{headers:{authorization:'Bearer '+cleanupSecret}}),
	]);
	if(!pushResponse.ok)throw new Error(`PUSH_WORKER_HTTP_${pushResponse.status}`);
	if(!cleanupResponse.ok)throw new Error(`REGISTRATION_CLEANUP_HTTP_${cleanupResponse.status}`);
	const [pushResult,cleanupResult]=await Promise.all([pushResponse.json(),cleanupResponse.json()]);
	if(!cleanupResult||!Number.isInteger(cleanupResult.deletedAttempts)||cleanupResult.deletedAttempts<0){
		throw new Error('REGISTRATION_CLEANUP_INVALID_RESPONSE');
	}
	console.log(JSON.stringify({
		push:pushResult,
		registrationCleanup:{deletedAttempts:cleanupResult.deletedAttempts},
	}));
}catch(error){
	console.error('Scheduled registration/push cleanup failed.',error instanceof Error?error.name:'UnknownError');
	process.exit(1);
}
