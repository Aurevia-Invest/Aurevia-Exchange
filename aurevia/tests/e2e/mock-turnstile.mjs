const TEST_SECRET='1x0000000000000000000000000000000AA';
const databaseUrl=process.env.AUREVIA_E2E_DATABASE_URL;
let database=null;
try{
	database=new URL(databaseUrl||'');
}catch{
	database=null;
}
const isolatedTarget=database!==null&&(()=>{
	const databaseName=decodeURIComponent(database.pathname.replace(/^\/+/,''));
	return ['localhost','127.0.0.1','::1'].includes(database.hostname)
		&&['postgres:','postgresql:'].includes(database.protocol)
		&&/_e2e$/i.test(databaseName);
})();

if(!isolatedTarget||process.env.TURNSTILE_SECRET_KEY!==TEST_SECRET){
	throw new Error('The E2E Turnstile mock requires the documented test secret and a loopback-only _e2e database.');
}

const appUrl=new URL(process.env.NEXT_PUBLIC_APP_URL||'');
const originalFetch=globalThis.fetch.bind(globalThis);

globalThis.fetch=async(input,init)=>{
	let requestUrl;
	try{
		requestUrl=new URL(typeof input==='string'||input instanceof URL?input:input.url).toString();
	}catch{
		return originalFetch(input,init);
	}
	if(requestUrl!=='https://challenges.cloudflare.com/turnstile/v0/siteverify')return originalFetch(input,init);

	const body=init?.body instanceof URLSearchParams
		?init.body
		:new URLSearchParams(typeof init?.body==='string'?init.body:'');
	const responseToken=body.get('response')||'';
	const validTestRequest=body.get('secret')===TEST_SECRET&&responseToken.length>0&&responseToken.length<=2048;
	return new Response(JSON.stringify(validTestRequest?{
		success:true,
		action:'register',
		hostname:appUrl.hostname,
	}:{
		success:false,
		'action':'register',
		hostname:appUrl.hostname,
		'error-codes':['invalid-input-response'],
	}),{status:200,headers:{'content-type':'application/json'}});
};
