import {resolve} from 'node:path';

process.env.PLAYWRIGHT_BROWSERS_PATH=process.env.PLAYWRIGHT_BROWSERS_PATH||resolve('tools/playwright/browsers');
const {chromium}=await import('@playwright/test');
const target=process.argv[2]||process.env.AUREVIA_BROWSER_SMOKE_URL;
if(!target){
	console.error('Usage: npm run test:browser:smoke -- <running-Aurevia-url>');
	process.exit(1);
}

let baseUrl;
try{
	baseUrl=new URL(target);
	if(!['http:','https:'].includes(baseUrl.protocol))throw new Error();
}catch{
	console.error('The browser smoke URL must be a valid HTTP or HTTPS URL.');
	process.exit(1);
}

const browser=await chromium.launch({headless:true});
try{
	const page=await browser.newPage();
	const homepage=await page.goto(new URL('/',baseUrl).toString(),{waitUntil:'domcontentloaded',timeout:45_000});
	if(homepage?.status()!==200)throw new Error(`Homepage returned HTTP ${homepage?.status()??'no response'}.`);
	await page.locator('.home-hero h1').first().waitFor({state:'visible',timeout:20_000});

	const health=await page.request.get(new URL('/api/health',baseUrl).toString(),{timeout:15_000});
	if(!health.ok())throw new Error(`Aurevia health check returned HTTP ${health.status()}.`);
	const payload=await health.json();
	if(payload.ok!==true)throw new Error('Aurevia health endpoint did not report a healthy application.');

	console.log(`Aurevia browser smoke test passed at ${baseUrl.origin}.`);
}finally{
	await browser.close();
}
