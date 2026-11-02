import {expect,test as base,Page} from '@playwright/test';
import {randomInt} from 'node:crypto';

type RuntimeCapture={consoleErrors:string[];pageErrors:string[];failedRequests:string[];failedResponses:Array<{url:string;status:number}>};
const marketProviderConfigured=!process.env.AUREVIA_E2E_DATABASE_URL&&Boolean(process.env.FINNHUB_API_KEY||process.env.ALPACA_API_KEY&&process.env.ALPACA_SECRET_KEY);
const appOrigin=process.env.AUREVIA_E2E_APP_URL||'http://127.0.0.1:4310';
const credentialCallback='**/api/auth/callback/credentials**';

function isolatedLoginIp(){
	return `198.18.${randomInt(0,256)}.${randomInt(1,255)}`;
}

export const test=base;
export {expect};

export async function waitForStartup(page:Page){
	await expect(page.locator('.startup-screen')).toHaveCount(0);
	await expect(page.locator('.scene-content > div[inert]')).toHaveCount(0);
}

export async function loginAs(page:Page,email:string,password:string){
	const loginIp=isolatedLoginIp();
	const addIsolatedLoginIp=(route:import('@playwright/test').Route)=>route.continue({headers:{...route.request().headers(),'x-forwarded-for':loginIp}});
	const administrator=email.toLowerCase()===process.env.AUREVIA_E2E_ADMIN_EMAIL?.toLowerCase();
	await page.route(credentialCallback,addIsolatedLoginIp);
	try{
		await page.goto(administrator?'/admin/login':'/login');
		await waitForStartup(page);
		await page.getByLabel(administrator?'Admin username or email':'Email or administrator username').fill(email);
		await page.getByLabel(administrator?'Admin password':'Password',{exact:true}).fill(password);
		await page.getByRole('checkbox',{name:administrator?/Replace another active Aurevia session/:/Replace the active Aurevia session/}).check();
		await page.getByRole('button',{name:administrator?'Enter control center':'Sign in'}).click();
		await page.waitForURL(administrator?/\/admin(?:$|\/)/:/dashboard/);
		await expect.poll(async()=>{
			const response=await page.request.get('/api/auth/session');
			if(!response.ok())return null;
			const session=await response.json();
			return typeof session.user?.email==='string'?session.user.email.toLowerCase():null;
		}).toBe(email.toLowerCase());
	}finally{
		await page.unroute(credentialCallback,addIsolatedLoginIp);
	}
}

export async function logout(page:Page){
	const button=page.getByRole('button',{name:/^(?:Logout|Sign out)$/});
	if(!await button.isVisible()){
		const accountMenu=page.getByRole('button',{name:'More account navigation'});
		if(await accountMenu.isVisible()){
			if(await accountMenu.getAttribute('aria-expanded')!=='true')await accountMenu.click();
		}else{
			const menu=page.getByRole('button',{name:/Open (?:admin )?(?:navigation|menu)|Close (?:admin )?(?:navigation|menu)/});
			await expect(button.or(menu)).toBeVisible();
			if(await menu.isVisible()&&await menu.getAttribute('aria-expanded')!=='true')await menu.click();
		}
	}
	await expect(button).toBeVisible();
	await button.click();
	await page.waitForURL(/\/login(?:\?.*)?$/);
}

export async function expectNoHorizontalOverflow(page:Page){
	const dimensions=await page.evaluate(()=>{
		const viewport=window.innerWidth;
		const offenders=[...document.querySelectorAll('body *')]
			.map(element=>{
				const rect=element.getBoundingClientRect();
				const style=getComputedStyle(element);
				return {tag:element.tagName,selector:element.id?`#${element.id}`:element.className,rect:{left:rect.left,right:rect.right,width:rect.width},position:style.position,overflow:style.overflow};
			})
			.filter(item=>item.rect.right>viewport+1||item.rect.left<-1)
			.sort((left,right)=>right.rect.right-left.rect.right)
			.slice(0,20);
		return {viewport,document:document.documentElement.scrollWidth,offenders};
	});
	expect(dimensions.document,`horizontal overflow at ${dimensions.viewport}px: ${JSON.stringify(dimensions.offenders)}`).toBeLessThanOrEqual(dimensions.viewport+1);
}

test.beforeEach(async({page},testInfo)=>{
	const testClientIp=`198.51.100.${randomInt(1,255)}`;
	await page.route('**/api/auth/callback/credentials**',route=>route.continue({headers:{...route.request().headers(),'x-forwarded-for':testClientIp}}));
	await page.route('**/api/demo/ai-recommendations',route=>route.fulfill({
		status:200,
		contentType:'application/json',
		body:JSON.stringify({status:'no_signal',message:'No recommendation is currently available.',evaluationIntervalSeconds:300,recommendations:[]}),
	}));
	const capture:RuntimeCapture={consoleErrors:[],pageErrors:[],failedRequests:[],failedResponses:[]};
	(page as Page & {__runtimeCapture?:RuntimeCapture}).__runtimeCapture=capture;
	page.on('console',message=>{
		const expectedFundingFailure=(testInfo.title.includes('Account Funding')||testInfo.title.includes('Wallet shows the internal funding workflow'))&&message.text().includes('503 (Service Unavailable)');
		const expectedAssistantFailure=testInfo.title.includes('support fallback')&&message.text().includes('503 (Service Unavailable)');
		const expectedUnavailableMarket=!marketProviderConfigured&&message.text().includes('503 (Service Unavailable)');
		const expectedTurnstileLoadFailure=testInfo.title.includes('registration security script can retry')&&message.text().includes('Failed to load resource');
		const expectedRegistrationRateLimit=testInfo.title.includes('registration page refresh and Turnstile retries')&&message.text().includes('status of 429 (Too Many Requests)');
		if(message.type()==='error'&&!message.text().includes('status of 400 (Bad Request)')&&!message.text().includes('status of 401 (Unauthorized)')&&!expectedFundingFailure&&!expectedAssistantFailure&&!expectedUnavailableMarket&&!expectedTurnstileLoadFailure&&!expectedRegistrationRateLimit)capture.consoleErrors.push(message.text());
	});
	page.on('pageerror',error=>capture.pageErrors.push(error.message));
	page.on('requestfailed',request=>{
		const failure=request.failure()?.errorText||'request failed';
		if(failure==='net::ERR_ABORTED'||failure.includes('ERR_ABORTED'))return;
		if(request.url().startsWith(appOrigin))capture.failedRequests.push(`${request.method()} ${request.url()} · ${failure}`);
	});
	page.on('response',response=>{
		if(response.status()<400||!response.url().startsWith(appOrigin))return;
		capture.failedResponses.push({url:response.url(),status:response.status()});
	});
});

test.afterEach(async({page},testInfo)=>{
	const capture=(page as Page & {__runtimeCapture?:RuntimeCapture}).__runtimeCapture;
	if(!capture)return;
	await testInfo.attach('browser-runtime.json',{body:Buffer.from(JSON.stringify(capture,null,2)),contentType:'application/json'});
	const expectedClientErrors=capture.failedResponses.filter(response=>(testInfo.title.includes('registration fails closed when Akedly credentials are unavailable')&&response.url.endsWith('/api/register')&&response.status===503)||(response.url.endsWith('/api/register/verify')&&response.status===400)||(response.url.endsWith('/api/auth/callback/credentials')&&response.status===401)||((testInfo.title.includes('watchlists persist')||testInfo.title.includes('session replacement is explicit')||testInfo.title.includes('Nova escalation reaches admin')||testInfo.title.includes('tier requests require')||testInfo.title.includes('account deletion'))&&response.url.endsWith('/api/notifications?limit=8')&&response.status===401)||(testInfo.title.includes('account deletion')&&['/api/currency-preference','/api/positions','/api/tax-services/access','/api/profile/avatar'].some(path=>response.url.endsWith(path))&&response.status===401)|| (testInfo.title.includes('Nova escalation reaches admin')&&response.url.endsWith('/api/support')&&response.status===409)||((testInfo.title.includes('Account Funding')||testInfo.title.includes('Wallet shows the internal funding workflow'))&&(response.url.endsWith('/api/payment-methods')||response.url.endsWith('/api/wallet'))&&response.status===503)||(response.url.includes('/api/live-markets/')&&response.status===503&&!marketProviderConfigured)||(testInfo.title.includes('KYC access is owner-scoped')&&response.url.endsWith('/api/kyc/documents')&&response.status===409));
	if(testInfo.title.includes('support fallback'))expectedClientErrors.push(...capture.failedResponses.filter(response=>response.url.endsWith('/api/support/nova')&&response.status===503));
	if(testInfo.title.includes('registration page refresh and Turnstile retries'))expectedClientErrors.push(...capture.failedResponses.filter(response=>response.url.endsWith('/api/register')&&response.status===429));
	const unexpectedResponses=capture.failedResponses.filter(response=>!expectedClientErrors.includes(response));
	expect(capture.consoleErrors,`browser console errors; failed application responses: ${JSON.stringify(capture.failedResponses)}`).toEqual([]);
	expect(capture.pageErrors,'uncaught browser exceptions').toEqual([]);
	expect(capture.failedRequests,'failed application requests').toEqual([]);
	expect(unexpectedResponses,'unexpected failed application responses').toEqual([]);
});
