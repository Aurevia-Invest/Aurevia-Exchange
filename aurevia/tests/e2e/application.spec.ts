import {randomUUID} from 'node:crypto';
import type {Page} from '@playwright/test';
import bcrypt from 'bcryptjs';
import {FundingStatus,FundingType,Prisma} from '@prisma/client';
import {PNG} from 'pngjs';
import {test,expect,loginAs,logout,waitForStartup,expectNoHorizontalOverflow} from './fixtures';
import {db} from '../../lib/db';
import {balance as ledgerBalance} from '../../lib/ledger';
import {initializeDemoAccount,initializePaperAccount} from '../../lib/ledger';
import {settleMaturedSimulatedInvestments} from '../../lib/demo-investment-settlement';
import {SIMULATED_BTC_ADDRESS_SETTING} from '../../lib/config/simulated-bitcoin-address';

const viewports=[
	{width:320,height:800},
	{width:360,height:800},
	{width:375,height:812},
	{width:390,height:844},
	{width:393,height:852},
	{width:430,height:932},
	{width:414,height:896},
	{width:768,height:1024},
	{width:1024,height:900},
	{width:1280,height:900},
	{width:1440,height:900},
	{width:1920,height:1080},
];

const authenticatedRoutes=['/dashboard','/trade','/markets','/portfolio','/orders','/investments','/broadcasts','/wallet','/wallet/transactions','/wallet/convert','/kyc','/tier','/settings','/support','/notifications','/activity','/education','/news','/stories','/client-stories','/community','/cards','/cards/apply'];
const adminRoutes=['/admin/login','/admin','/admin/activity','/admin/approved-deposits','/admin/approved-withdrawals','/admin/audit-logs','/admin/broadcasts','/admin/cards','/admin/command-center','/admin/community','/admin/content','/admin/deleted-items','/admin/investments','/admin/kyc','/admin/markets','/admin/nova','/admin/operations','/admin/payments','/admin/positions','/admin/providers','/admin/receipts','/admin/settings','/admin/settlements','/admin/stories','/admin/support','/admin/tax-services','/admin/tiers','/admin/users','/admin/verified-accounts','/admin/waitlist'];
const appOrigin=process.env.AUREVIA_E2E_APP_URL||'http://127.0.0.1:4310';
const providerOrigin=process.env.AUREVIA_E2E_PROVIDER_URL||'http://127.0.0.1:4311';

async function revealSupportChat(page:Page){
	const peek=page.getByRole('button',{name:'Show chat support'});
	if(await peek.isVisible())await peek.click();
	return page.getByRole('button',{name:/Open chat support/});
}

test.afterEach(async()=>{
	await db.user.updateMany({
		where:{email:{in:[fixture('USER_EMAIL'),fixture('LEGACY_USER_EMAIL'),fixture('INVESTOR_EMAIL')]},status:'ACTIVE'},
		data:{accountMode:'DEMO'},
	});
});

function fixture(name:string){
	const value=process.env[`AUREVIA_E2E_${name}`];
	if(!value)throw new Error(`Playwright fixture ${name} is unavailable.`);
	return value;
}

async function createIsolatedDemoUser(label:string){
	const password=`E2e-${randomUUID()}-A1!`;
	const user=await db.user.create({data:{
		email:`aurevia-e2e-${label}-${randomUUID()}@example.invalid`,
		name:'Temporary isolated E2E user',
		country:'Test',
		passwordHash:await bcrypt.hash(password,10),
		accountMode:'DEMO',
		status:'ACTIVE',
	}});
	await db.$transaction(tx=>initializeDemoAccount(tx,user.id));
	return {email:user.email,password};
}

function depositPostOptions(idempotencyKey:string,payload:Record<string,unknown>){
	return {headers:{'Idempotency-Key':idempotencyKey},multipart:{payload:JSON.stringify(payload),evidence:{name:'payment.png',mimeType:'image/png',buffer:PNG.sync.write(new PNG({width:1,height:1}))}}};
}

async function typeInto(page:import('@playwright/test').Page,field:import('@playwright/test').Locator,value:string){
	await field.click();
	await expect.poll(()=>field.evaluate(element=>document.activeElement===element)).toBe(true);
	await page.keyboard.insertText(value);
	await expect(field).toHaveValue(value);
}

async function selectAccountMode(page:import('@playwright/test').Page,accountMode:'DEMO'|'REAL',options:{waitForCompletion?:boolean}={}){
	const mode=page.locator('.user-mode-control');
	await expect(mode).toBeVisible();
	const selected=mode.getByRole('button',{name:accountMode==='DEMO'?'Demo':'Real',exact:true});
	if(await selected.getAttribute('aria-pressed')!=='true')await selected.click();
	if(options.waitForCompletion!==false){
		await expect(selected).toHaveAttribute('aria-pressed','true');
		await expect(mode.getByRole('button',{name:accountMode==='DEMO'?'Real':'Demo',exact:true})).toBeEnabled();
	}
}

test('public stories publish for visitors and members with role, schedule, expiry, and engagement controls',async({browser,page})=>{
	const unauthenticated=await page.request.get('/api/admin/stories');
	expect(unauthenticated.status()).toBe(401);
	const adminContext=await browser.newContext();
	const adminPage=await adminContext.newPage();
	const createdIds:string[]=[];
	try{
		await loginAs(adminPage,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
		const categories=await adminPage.request.get('/api/admin/stories/categories');
		expect(categories.ok()).toBe(true);
		const category=(await categories.json())[0];
		const extraCategory=await adminPage.request.post('/api/admin/stories/categories',{data:{name:`E2E updates ${randomUUID()}`}});
		expect(extraCategory.status()).toBe(201);
		const createStory=async(title:string,status:'DRAFT'|'SCHEDULED'|'PUBLISHED',visibility:'PUBLIC'|'REGISTERED_USERS'='PUBLIC',dates:{publishAt?:Date;expiresAt?:Date}={})=>{
			const response=await adminPage.request.post('/api/admin/stories',{data:{
				title,description:`${title} content for the public stories viewer.`,categoryId:category.id,status,visibility,
				publishAt:dates.publishAt?.toISOString()??null,expiresAt:dates.expiresAt?.toISOString()??null,displayOrder:0,
			}});
			expect(response.status(),`create ${title}`).toBe(201);
			const story=await response.json();
			createdIds.push(story.id);
			return story as {id:string;title:string};
		};
		const now=Date.now();
		const publicStory=await createStory(`E2E public story ${randomUUID()}`,'PUBLISHED');
		const draftStory=await createStory(`E2E draft story ${randomUUID()}`,'DRAFT');
		const scheduledStory=await createStory(`E2E scheduled story ${randomUUID()}`,'SCHEDULED','PUBLIC',{publishAt:new Date(now+60_000)});
		const membersStory=await createStory(`E2E members story ${randomUUID()}`,'PUBLISHED','REGISTERED_USERS');
		const expiredStory=await createStory(`E2E expiring story ${randomUUID()}`,'PUBLISHED','PUBLIC',{expiresAt:new Date(now+60_000)});
		const png=PNG.sync.write(new PNG({width:1,height:1}));
		const publicImage=await adminPage.request.post(`/api/admin/stories/${publicStory.id}/media`,{multipart:{file:{name:'story.png',mimeType:'image/png',buffer:png},altText:'Aurevia story artwork'}});
		expect(publicImage.status()).toBe(201);
		const draftVideo=await adminPage.request.post(`/api/admin/stories/${draftStory.id}/media`,{multipart:{file:{name:'draft.mp4',mimeType:'video/mp4',buffer:Buffer.from('\u0000\u0000\u0000\u0000ftypisom','binary')}}});
		expect(draftVideo.status()).toBe(201);
		const publicMedia=(await publicImage.json()).media;
		const privateMedia=(await draftVideo.json()).media;
		await db.story.update({where:{id:scheduledStory.id},data:{publishAt:new Date(now-60_000)}});
		await db.story.update({where:{id:expiredStory.id},data:{expiresAt:new Date(now-1_000)}});

		const beforeLoginFeed=await page.request.get('/api/stories').then(response=>response.json());
		const publicFeedStory=beforeLoginFeed.find((story:{id:string})=>story.id===publicStory.id);
		expect(publicFeedStory.media).toContainEqual(expect.objectContaining({id:publicMedia.id,type:'IMAGE'}));
		const publicMediaUrl=publicFeedStory.media.find((item:{id:string;url:string})=>item.id===publicMedia.id)?.url;
		if(!publicMediaUrl)throw new Error('Public story media URL was not returned.');
		const publicImageResponse=await page.request.get(publicMediaUrl);
		expect(publicImageResponse.status()).toBe(200);
		expect(publicImageResponse.headers()['content-type']).toContain('image/png');
		expect((await page.request.get(`/api/stories/${draftStory.id}/media/${privateMedia.id}`)).status()).toBe(404);
		const adminVideoResponse=await adminPage.request.get(privateMedia.url);
		expect(adminVideoResponse.status()).toBe(200);
		expect(adminVideoResponse.headers()['content-type']).toContain('video/mp4');

		await page.setViewportSize({width:375,height:812});
		await page.goto('/stories');
		await waitForStartup(page);
		await expect(page.getByRole('heading',{name:'Stories',exact:true})).toBeVisible();
		await expect(page.getByRole('button',{name:`Open ${publicStory.title}`})).toBeVisible();
		await expect(page.locator('.story-card-featured')).toContainText('Featured story');
		await expect(page.getByRole('button',{name:`Open ${publicStory.title}`})).toContainText('Read more');
		await expect(page.getByRole('button',{name:`Open ${publicStory.title}`}).locator('time')).not.toHaveText('Publication date unavailable');
		await expect(page.getByRole('button',{name:`Open ${scheduledStory.title}`})).toBeVisible();
		await expect(page.getByRole('button',{name:`Open ${draftStory.title}`})).toHaveCount(0);
		await expect(page.getByRole('button',{name:`Open ${membersStory.title}`})).toHaveCount(0);
		await expect(page.getByRole('button',{name:`Open ${expiredStory.title}`})).toHaveCount(0);
		await expectNoHorizontalOverflow(page);
		await page.getByRole('button',{name:`Open ${publicStory.title}`}).click();
		const storyDialog=page.getByRole('dialog',{name:`Story: ${publicStory.title}`});
		await expect(storyDialog).toBeVisible();
		await expect(storyDialog.getByText(`${publicStory.title} content for the public stories viewer.`)).toBeVisible();
		await page.getByRole('button',{name:'Close stories'}).click();

		await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
		const memberFeed=await page.request.get('/api/stories').then(response=>response.json());
		expect(memberFeed).toContainEqual(expect.objectContaining({id:membersStory.id}));
		expect(memberFeed).not.toContainEqual(expect.objectContaining({id:draftStory.id}));
		const forbidden=await page.request.post('/api/admin/stories',{data:{}});
		expect(forbidden.status()).toBe(403);

		const adminLibrary=await adminPage.request.get('/api/admin/stories').then(response=>response.json());
		expect(adminLibrary.stories).toContainEqual(expect.objectContaining({id:publicStory.id,engagement:expect.objectContaining({views:1})}));
		expect(adminLibrary.stories).toContainEqual(expect.objectContaining({id:expiredStory.id,status:'ARCHIVED'}));
		const publicStoryAudit=adminLibrary.stories.find((story:{id:string;auditHistory:Array<{action:string}>})=>story.id===publicStory.id)?.auditHistory;
		expect(publicStoryAudit).toContainEqual(expect.objectContaining({action:'STORY_CREATED'}));
		await adminPage.goto('/admin/stories');
		await waitForStartup(adminPage);
		const managedStory=adminPage.locator('.admin-story-row').filter({hasText:publicStory.title});
		await expect(managedStory.getByText(/Created:/)).toBeVisible();
		await managedStory.getByText(/Audit history/).click();
		await expect(managedStory.getByText('STORY_CREATED')).toBeVisible();
		const deletion=await adminPage.request.delete('/api/admin/stories',{data:{storyId:publicStory.id}});
		expect(deletion.ok()).toBe(true);
		expect(await page.request.get('/api/stories').then(response=>response.json())).not.toContainEqual(expect.objectContaining({id:publicStory.id}));
	}finally{
		for(const id of createdIds)await adminPage.request.delete('/api/admin/stories',{data:{storyId:id}});
		await adminContext.close();
	}
});

test('support fallback gives correct paper-trading and funding guidance',async({page})=>{
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await page.route('**/api/support/nova',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Support assistant unavailable.'})}));
	await page.goto('/support');
	await page.getByRole('textbox',{name:'Ask Nova AI'}).fill('How do REAL and DEMO account modes work?');
	await page.getByRole('button',{name:'Send question'}).click();
	await expect(page.getByText(/DEMO trades are simulated/)).toBeVisible();
	await expect(page.getByText(/Alpaca Paper Trading when enabled/)).toBeVisible();
	await expect(page.getByText(/does not send an external payment or payout/)).toBeVisible();
});

test('provider health distinguishes paper trading from disabled live services',async({page})=>{
	await loginAs(page,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
	await page.goto('/admin/providers');
	await expect(page.getByRole('heading',{name:'Provider health'})).toBeVisible();
	await expect(page.getByRole('heading',{name:'Live financial services'})).toBeVisible();
	await expect(page.getByRole('heading',{name:'Alpaca paper account'})).toBeVisible();
	await expect(page.getByText(/When enabled, REAL-mode customer orders use this shared Alpaca Paper account/)).toBeVisible();
});

test('DEMO accounts can view and complete profile-based tier progression while KYC remains gated',async({page})=>{
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await page.goto('/kyc');
	await expect(page.getByRole('heading',{name:'REAL mode required'})).toBeVisible();
	const tierState=await page.request.get('/api/tier-requests');
	expect(tierState.ok()).toBe(true);
	await page.goto('/tier');
	await expect(page.getByRole('heading',{name:'Account tiers'})).toBeVisible();
	await expect(page.getByRole('progressbar',{name:'Account tier progression'})).toBeVisible();
});

test('market view labels internal reference prices when no live provider is configured',async({page})=>{
	const quotes=await page.request.get('/api/live-markets?symbols=AAPL,BTC');
	expect(quotes.ok()).toBe(true);
	const quoteData=await quotes.json();
	expect(quoteData.marketDataStatus).toBe('INTERNAL');
	expect(quoteData.quotes).toHaveLength(2);
	for(const quote of quoteData.quotes){
		expect(quote.source).toBe('Aurevia Internal');
		expect(quote.price).toBeGreaterThan(0);
	}
	const historyResponse=await page.request.get('/api/live-markets/AAPL?timeframe=1d');
	expect(historyResponse.ok()).toBe(true);
	expect((await historyResponse.json()).source).toBe('Aurevia Internal');
	await page.goto('/markets');
	await expect(page.getByText('Market data: Internal reference').first()).toBeVisible();
	await expect(page.getByText('AUREVIA INTERNAL REFERENCE DATA')).toBeVisible();
});

test('signed-in users can ask AI to explain unavailable quote and history sources without substituting data',async({page})=>{
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await page.goto('/markets');
	const quoteExplanation=page.getByRole('button',{name:'Explain quote availability'});
	await expect(quoteExplanation).toBeVisible();
	const requests:Array<{symbol:string;dataType:string;timeframe?:string}>=[];
	await page.route('**/api/market/data-explanation',async route=>{
		const payload=route.request().postDataJSON() as {symbol:string;dataType:'quote'|'history';timeframe?:string};
		requests.push(payload);
		await route.fulfill({json:{
			symbol:payload.symbol,
			dataType:payload.dataType,
			status:'internal_reference',
			explanation:{
				explanation:'Only internal reference data is currently available.',
				recommendedAction:'configure_market_provider',
				caveat:'This AI explanation does not provide live market data or investment advice.',
			},
		}});
	});

	await quoteExplanation.click();
	await expect(page.getByText('Only internal reference data is currently available.')).toBeVisible();
	const historyExplanation=page.getByRole('button',{name:'Explain chart history'});
	await expect(historyExplanation).toBeVisible();
	await historyExplanation.click();
	await expect(page.getByText('This AI explanation does not provide live market data or investment advice.')).toBeVisible();
	expect(requests).toHaveLength(2);
	expect(requests.map(request=>request.dataType)).toEqual(['quote','history']);
	expect(requests.every(request=>request.symbol==='DJI')).toBe(true);
});

test('portfolio timeframe controls filter authenticated snapshot history accessibly on mobile',async({page})=>{
	await page.setViewportSize({width:320,height:800});
	await loginAs(page,fixture('LEGACY_USER_EMAIL'),fixture('LEGACY_USER_PASSWORD'));
	const instrument=(await page.request.get('/api/market').then(response=>response.json())).find((item:{price:number})=>Number(item.price)<100);
	if(!instrument)throw new Error('The isolated market fixture has no affordable DEMO instrument.');
	const position=await page.request.post('/api/orders',{headers:{'Idempotency-Key':randomUUID()},data:{instrumentId:instrument.id,side:'BUY',type:'MARKET',quantity:1,expectedPrice:Number(instrument.price),observedAt:instrument.lastUpdatedAt||instrument.updatedAt}});
	expect(position.status()).toBe(201);
	const portfolio=await page.request.get('/api/portfolio').then(response=>response.json());
	expect(Number(portfolio.totalValue)).toBeCloseTo(Number(portfolio.cashBalance)+Number(portfolio.positionValue)+Number(portfolio.investmentValue),2);
	expect(Number(portfolio.totalInvested)).toBeCloseTo(portfolio.holdings.reduce((sum:number,item:{invested:string})=>sum+Number(item.invested),0),2);
	expect(Number(portfolio.totalCurrentValue)).toBeCloseTo(portfolio.holdings.reduce((sum:number,item:{value:string})=>sum+Number(item.value),0),2);
	expect(portfolio.allocations.reduce((sum:number,item:{percentage:string})=>sum+Number(item.percentage),0)).toBeCloseTo(100,2);
	await page.goto('/portfolio');
	await expect(page.getByRole('heading',{name:'My Portfolio'})).toBeVisible();
	await expect(page.getByRole('status',{name:'Market data source: DEMO prices'})).toBeVisible();
	const controls=page.getByRole('group',{name:'Performance timeframe'});
	await controls.getByRole('button',{name:'1W'}).click();
	await expect(controls.getByRole('button',{name:'1W'})).toHaveAttribute('aria-pressed','true');
	await controls.getByRole('button',{name:'All'}).click();
	await expect(controls.getByRole('button',{name:'All'})).toHaveAttribute('aria-pressed','true');
	const holdingSearch=page.getByLabel('Search holdings');
	await expect(holdingSearch).toBeVisible();
	await holdingSearch.fill(instrument.name);
	await expect(page.locator('.portfolio-holding')).toHaveCount(1);
	await holdingSearch.fill('no-matching-holding');
	await expect(page.getByText('No holdings match these filters.')).toBeVisible();
	await expectNoHorizontalOverflow(page);
});

test('desktop 3D emblem renders with a mobile static fallback',async({browser})=>{
	const desktopContext=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'no-preference'});
	await desktopContext.addInitScript(()=>{sessionStorage.setItem('aurevia-startup-complete','1');localStorage.setItem('aurevia-policy-consent-v1',JSON.stringify({version:1,choice:'accepted',updatedAt:new Date().toISOString()}));});
	try{
		const desktopPage=await desktopContext.newPage();
		await desktopPage.goto('/');
		await waitForStartup(desktopPage);
		const canvas=desktopPage.locator('.home-market-depth .market-depth-canvas canvas');
		if(await canvas.count()){
			await expect(canvas).toBeVisible();
			const image=PNG.sync.read(await canvas.screenshot());
			let visiblePixels=0;
			for(let index=0;index<image.data.length;index+=4){
				if(image.data[index+3]>4&&image.data[index]+image.data[index+1]+image.data[index+2]>24)visiblePixels++;
			}
			expect(visiblePixels,'desktop 3D canvas should render visible pixels').toBeGreaterThan(20);
		}else{
			await expect(desktopPage.locator('.home-market-depth .market-depth-fallback')).toBeVisible();
		}
		await expectNoHorizontalOverflow(desktopPage);
	}finally{
		await desktopContext.close();
	}

	const mobileContext=await browser.newContext({viewport:{width:320,height:800},reducedMotion:'no-preference'});
	await mobileContext.addInitScript(()=>{sessionStorage.setItem('aurevia-startup-complete','1');localStorage.setItem('aurevia-policy-consent-v1',JSON.stringify({version:1,choice:'accepted',updatedAt:new Date().toISOString()}));});
	try{
		const mobilePage=await mobileContext.newPage();
		await mobilePage.goto('/');
		await waitForStartup(mobilePage);
		await expect(mobilePage.locator('.home-market-depth .market-depth-fallback')).toBeVisible();
		await expect(mobilePage.locator('.home-market-depth .market-depth-canvas')).toHaveCount(0);
		await expectNoHorizontalOverflow(mobilePage);
	}finally{
		await mobileContext.close();
	}
});

test('floating support launcher can be dragged horizontally and vertically',async({page})=>{
	await page.setViewportSize({width:1440,height:900});
	await page.addInitScript(()=>localStorage.setItem('aurevia-support-chat-position',JSON.stringify({left:1100,top:650})));
	await page.goto('/');
	await waitForStartup(page);
	const launcher=await revealSupportChat(page);
	const initial=await launcher.boundingBox();
	expect(initial).not.toBeNull();
	if(!initial)return;
	await page.mouse.move(initial.x+28,initial.y+28);
	await page.mouse.down();
	await page.mouse.move(initial.x-292,initial.y-292,{steps:12});
	await page.mouse.up();
	await expect.poll(async()=>{
		const moved=await launcher.boundingBox();
		return moved?Math.abs(moved.x-initial.x):0;
	}).toBeGreaterThan(100);
	await expect.poll(async()=>{
		const moved=await launcher.boundingBox();
		return moved?Math.abs(moved.y-initial.y):0;
	}).toBeGreaterThan(100);
	await expect(launcher).toBeVisible();
});

test('Vercel scheduled market tick requires its secret and advances simulated prices',async({page})=>{
	const unauthorized = await page.request.get('/api/cron/market-tick');
	expect(unauthorized.status()).toBe(401);
	const authorized = await page.request.get('/api/cron/market-tick', { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
	expect(authorized.status()).toBe(200);
	expect(await authorized.json()).toMatchObject({ ok: true, updated: expect.any(Number) });
});

test('waitlist form submits and shows a truthful success state',async({page})=>{
	await page.setViewportSize({ width: 375, height: 812 });
	await page.goto('/waitlist');
	await expect(page.locator('.waitlist-page')).toHaveAttribute('data-waitlist-ready', 'true');
	await waitForStartup(page);
	const waitlistName = page.locator('.waitlist-form input[autocomplete="name"]');
	const waitlistEmail = page.locator('.waitlist-form input[autocomplete="email"]');
	await waitlistName.fill('Temporary E2E Waitlist');
	await expect(waitlistName).toHaveValue('Temporary E2E Waitlist');
	const email = `waitlist-${randomUUID()}@example.invalid`;
	await waitlistEmail.fill(email);
	await expect(waitlistEmail).toHaveValue(email);
	await page.locator('.waitlist-form select').first().selectOption('US');
	await page.locator('.waitlist-form input[type="checkbox"]').check();
	await page.getByRole('button', { name: /Join (the )?waitlist/i }).click();
	await expect(page.locator('.waitlist-success')).toContainText(/waitlist|access|request/i);
	await expect(page.locator('.waitlist-page')).not.toContainText(/position\s*#?\d+/i);
	await expectNoHorizontalOverflow(page);
});

test('mobile navigation opens and navigates to Login',async({page})=>{
	await page.setViewportSize({width:320,height:800});
	await page.goto('/');
	await page.getByRole('button',{name:'Open navigation'}).click();
	const nav=page.getByRole('navigation',{name:'Primary navigation'});
	await expect(nav).toBeVisible();
	const firstLink=nav.getByRole('link').first();
	await expect.poll(()=>firstLink.evaluate(element=>{
		const bounds=element.getBoundingClientRect();
		const target=document.elementFromPoint(bounds.left+bounds.width/2,bounds.top+bounds.height/2);
		return target===element||element.contains(target);
	})).toBe(true);
	await page.getByRole('button',{name:'Close navigation'}).click();
	await expect(page.getByRole('button',{name:'Open navigation'})).toHaveAttribute('aria-expanded','false');
	await page.getByRole('button',{name:'Open navigation'}).click();
	await nav.getByRole('link',{name:'Sign in'}).click();
	await expect(page).toHaveURL(/\/login$/);
	await expect(page.getByRole('heading',{name:'Welcome back'})).toBeVisible();
	await expectNoHorizontalOverflow(page);
});

test('login and registration fields receive real pointer and keyboard input',async({page})=>{
	await page.setViewportSize({width:390,height:844});
	await page.goto('/login');
	await waitForStartup(page);
	const identifier=page.getByLabel('Email or administrator username');
	const password=page.getByLabel('Password',{exact:true});
	await typeInto(page,identifier,'invalid-user@example.test');
	await typeInto(page,password,'NotARealPassword123!');
	await page.getByRole('button',{name:'Show password'}).click();
	await expect(password).toHaveAttribute('type','text');
	await expect(password).toHaveValue('NotARealPassword123!');
	await page.getByRole('button',{name:'Hide password'}).click();
	await page.getByRole('button',{name:'Sign in'}).click();
	await expect(page.locator('.auth-error[role="alert"]')).toContainText(/sign-in failed/i);
	await expect(identifier).toHaveValue('invalid-user@example.test');

	await page.goto('/register');
	await waitForStartup(page);
	await page.getByRole('navigation',{name:'Registration sections'}).getByRole('link',{name:'Contact information'}).click();
	await expect(page).toHaveURL(/#register-contact$/);
	await expect(page.locator('#register-contact')).toBeVisible();
	await typeInto(page,page.getByLabel('First name'),'Browser');
	await typeInto(page,page.getByLabel('Last name'),'Input Test');
	const dateOfBirth=page.getByLabel('Date of birth');
	await dateOfBirth.click();
	await expect.poll(()=>dateOfBirth.evaluate(element=>document.activeElement===element)).toBe(true);
	await dateOfBirth.fill('1990-01-01');
	await expect(dateOfBirth).toHaveValue('1990-01-01');
	await typeInto(page,page.getByLabel('Email address'),'input-test@example.test');
	await typeInto(page,page.getByLabel(/Phone number/),'2025550100');
	await typeInto(page,page.getByLabel('Password',{exact:true}),'ValidPassword123!');
	await typeInto(page,page.getByLabel('Confirm password'),'ValidPassword123!');
	await expect(page.locator('#register-account .tier-badge')).toHaveCount(0);
	await page.getByRole('radio',{name:/REAL ACCOUNT/}).click();
	await expect(page.getByRole('radio',{name:/REAL ACCOUNT/})).toBeChecked();
	await expect(page.locator('#register-account .tier-badge')).toHaveText('Tier 1');
	await page.getByRole('radio',{name:/DEMO ACCOUNT/}).click();
	await expect(page.locator('#register-account .tier-badge')).toHaveCount(0);
	await page.getByRole('checkbox').check();
	await expect(page.getByRole('checkbox')).toBeChecked();
	await page.setViewportSize({width:320,height:844});
	await expectNoHorizontalOverflow(page);
});

test('password recovery stays private and usable across mobile and desktop widths',async({page})=>{
	await page.route('**/api/password-reset/request',route=>route.fulfill({
		status:202,
		contentType:'application/json',
		body:JSON.stringify({message:'If an eligible account matches, recovery instructions may be emailed. If no email arrives, contact support.'}),
	}));
	await page.route('**/api/password-reset/confirm',async route=>{
		const body=route.request().postDataJSON() as {token:string;password:string};
		expect(body.token).toBe('R'.repeat(43));
		expect(body.password).toBe('ChangedPassword1');
		await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true})});
	});

	await page.setViewportSize({width:320,height:800});
	await page.goto('/forgot-password');
	await page.getByLabel('Email address').fill('person@example.invalid');
	await page.getByRole('button',{name:'Request recovery link'}).click();
	await expect(page.getByRole('status')).toContainText('If an eligible account matches');
	await expectNoHorizontalOverflow(page);

	const resetResponse=await page.goto(`/reset-password#token=${'R'.repeat(43)}`);
	expect(resetResponse?.headers()['referrer-policy']).toBe('no-referrer');
	const newPassword=page.getByRole('textbox',{name:'New password',exact:true});
	const confirmPassword=page.getByRole('textbox',{name:'Confirm new password',exact:true});
	await expect(newPassword).toBeVisible();
	await expect(page).toHaveURL(/\/reset-password$/);
	for(const width of [320,390,768,1440,1920]){
		await page.setViewportSize({width,height:900});
		await expectNoHorizontalOverflow(page);
	}
	await newPassword.fill('ChangedPassword1');
	await confirmPassword.fill('ChangedPassword1');
	await page.getByRole('button',{name:'Change password'}).click();
	await expect(page.getByRole('status')).toContainText('Password changed');
});

test('dashboard hierarchy remains usable and contained at mobile and desktop widths',async({page})=>{
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	const profile=await page.request.get('/api/profile').then(response=>response.json());
	await page.goto('/dashboard');
	for(const width of [320,375,390,430,1440]){
		await page.setViewportSize({width,height:900});
		if(width<=760){
			await expect(page.locator('.mobile-home-greeting')).toBeVisible();
			await expect(page.locator('.mobile-home-greeting .account-tier-badge')).toHaveText(profile.label);
			await expect(page.locator('.mobile-balance-card')).toBeVisible();
			await expect(page.getByRole('heading',{name:'My assets'})).toBeVisible();
			await expect(page.getByRole('heading',{name:'Recent activity'})).toBeVisible();
			const avatar=page.locator('.mobile-home-avatar');
			const avatarStyle=await avatar.evaluate(element=>{
				const style=getComputedStyle(element);
				const bounds=element.getBoundingClientRect();
				return {width:bounds.width,height:bounds.height,borderRadius:style.borderRadius,overflow:style.overflow,flexShrink:style.flexShrink};
			});
			expect(avatarStyle).toEqual({width:44,height:44,borderRadius:'50%',overflow:'hidden',flexShrink:'0'});
			const avatarImage=avatar.locator('img');
			if(await avatarImage.count()){
				await expect(avatarImage).toHaveCSS('width','44px');
				await expect(avatarImage).toHaveCSS('height','44px');
				await expect(avatarImage).toHaveCSS('object-fit','cover');
				await expect(avatarImage).toHaveCSS('object-position','50% 50%');
			}
		}else{
			await expect(page.getByRole('heading',{name:/Welcome back/})).toBeVisible();
			await expect(page.locator('.dashboard-sidebar-profile .account-tier-badge')).toHaveText(profile.label);
			await expect(page.locator('.user-tier-progress')).toHaveCount(0);
			await expect(page.getByRole('heading',{name:'Market watch'})).toBeVisible();
			await expect(page.getByRole('heading',{name:'My portfolio'})).toBeVisible();
			await expect(page.locator('.dashboard-profile-panel')).toHaveCount(0);
		}
		await expectNoHorizontalOverflow(page);
		if(width>760){
			const layout=await page.evaluate(()=>{
				const dashboard=document.querySelector('.user-dashboard-columns');
				const panels=[...document.querySelectorAll('.user-dashboard-columns > div')].map(panel=>{
					const rect=panel.getBoundingClientRect();
					return {left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom};
				});
				return {columns:getComputedStyle(dashboard!).gridTemplateColumns.split(' ').length,panels};
			});
			expect(layout.columns).toBe(2);
			for(let index=0;index<layout.panels.length;index++){
				for(let other=index+1;other<layout.panels.length;other++){
					const a=layout.panels[index],b=layout.panels[other];
					const overlaps=a.left<b.right-1&&a.right>b.left+1&&a.top<b.bottom-1&&a.bottom>b.top+1;
					expect(overlaps,`portfolio panels ${index} and ${other} overlap at ${width}px`).toBe(false);
				}
			}
		}
	}
	await expect(page.locator('.user-topbar-identity .account-tier-badge')).toHaveText(profile.label);
	await page.getByRole('button',{name:'More account navigation'}).click();
	await expect(page.locator('.user-more-profile .account-tier-badge')).toHaveText(profile.label);
	await page.goto('/settings#profile');
	await expect(page.locator('.account-profile-identity .account-tier-badge')).toHaveText(profile.label);
});

test('authenticated bottom navigation stays fixed across viewports and More destinations',async({page})=>{
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	const navigation=page.getByRole('navigation',{name:'Primary account navigation'});
	const moreButton=page.getByRole('button',{name:'More account navigation'});
	for(const viewport of [{width:320,height:800},{width:390,height:844},{width:768,height:1024}]){
		await page.setViewportSize(viewport);
		await page.goto('/dashboard');
		await expect(navigation).toBeVisible();
		const geometry=await navigation.evaluate(element=>{
			const rect=element.getBoundingClientRect();
			return {position:getComputedStyle(element).position,left:rect.left,right:rect.right,bottom:rect.bottom,height:rect.height,viewportWidth:innerWidth,viewportHeight:innerHeight};
		});
		expect(geometry.position).toBe('fixed');
		expect(geometry.left).toBeGreaterThanOrEqual(0);
		expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth);
		expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight);
		for(const [name,href] of [['Dashboard','/dashboard'],['Markets','/markets'],['Trade markets','/trade'],['Portfolio','/portfolio']] as const){
			await expect(navigation.getByRole('link',{name,exact:true})).toHaveAttribute('href',href);
		}
		await expect(navigation.getByRole('button',{name:'Open account navigation menu'})).toBeVisible();
		await expect(navigation.getByRole('link',{name:'Dashboard',exact:true})).toHaveAttribute('aria-current','page');
		await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));
		await expect(navigation).toBeInViewport();
		await expectNoHorizontalOverflow(page);
	}
	for(const viewport of [{width:1440,height:900}]){
		await page.setViewportSize(viewport);
		await page.goto('/dashboard');
		const sidebar=page.locator('.dashboard-sidebar');
		await expect(sidebar).toBeVisible();
		await expect(sidebar.getByRole('link',{name:'Overview'})).toHaveAttribute('href','/dashboard');
		await expect(sidebar.getByRole('link',{name:'Markets'})).toHaveAttribute('href','/markets');
	}
	expect(await page.getByRole('navigation',{name:'Administrator navigation'}).count()).toBe(0);
	await page.setViewportSize({width:390,height:844});
	await page.goto('/dashboard');
	await expect(navigation.getByRole('link',{name:'Dashboard',exact:true})).toHaveClass(/is-active/);
	await expect(moreButton).toBeVisible();
	await selectAccountMode(page,'REAL');
	await moreButton.click();
	const moreMenu=page.getByRole('dialog',{name:'More'});
	await expect(moreMenu).toBeVisible();
	for(const label of ['Markets','Trade','Portfolio','Investments','Orders','Wallet','Deposits','Withdrawals','Transaction history','Notifications','Identity verification / KYC','Digital cards','Profile','Account settings','Security','Help and support','Tax services','Tier / membership','Testimonials','Logout']){
		await expect(moreMenu.getByRole('link',{name:label}).or(moreMenu.getByRole('button',{name:label}))).toBeVisible();
	}
	await moreMenu.getByRole('link',{name:'Transaction history'}).click();
	await expect(page).toHaveURL(/\/wallet\/transactions/);
	await expect(moreButton).toHaveAttribute('aria-expanded','false');
	await expect(moreButton).toHaveClass(/is-active/);
	await selectAccountMode(page,'DEMO');
});

test('global chat support persists its position and exchanges private admin messages',async({browser,page})=>{
	await page.setViewportSize({width:390,height:844});
	await page.goto('/login');
	await expect(page.getByRole('button',{name:'Show chat support'})).toBeVisible();
	const launcher=await revealSupportChat(page);
	await expect(launcher).toBeVisible();
	await launcher.click();
	await expect(page.getByText('Sign in to send a private message to admin support.')).toBeVisible();
	await page.getByRole('button',{name:'Close chat support'}).click();
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await page.evaluate(()=>localStorage.setItem('aurevia-support-chat-position',JSON.stringify({left:220,top:500})));
	await page.reload();
	const floatingLauncher=await revealSupportChat(page);
	const before=await floatingLauncher.boundingBox();
	expect(before).not.toBeNull();
	const startX=before!.x+before!.width/2;
	const startY=before!.y+before!.height/2;
	await page.mouse.move(startX,startY);
	await page.mouse.down();
	await page.mouse.move(startX-120,startY-120,{steps:8});
	await page.mouse.up();
	await expect.poll(async()=>{
		const moved=await floatingLauncher.boundingBox();
		return moved?Math.abs(moved.x-before!.x)+Math.abs(moved.y-before!.y):0;
	}).toBeGreaterThan(40);
	const savedPosition=await page.evaluate(()=>{
		const value=localStorage.getItem('aurevia-support-chat-position');
		return value?JSON.parse(value) as {left:number;top:number}:null;
	});
	expect(savedPosition).not.toBeNull();
	await page.goto('/markets');
	const restoredLauncher=await revealSupportChat(page);
	await expect.poll(async()=>{
		const afterNavigation=await restoredLauncher.boundingBox();
		return afterNavigation?{x:Math.round(afterNavigation.x),y:Math.round(afterNavigation.y)}:null;
	}).toEqual({x:Math.round(savedPosition!.left),y:Math.round(savedPosition!.top)});
	await (await revealSupportChat(page)).click();
	const subject=`Floating support ${randomUUID().slice(0,8)}`;
	await page.getByLabel('Subject').fill(subject);
	await page.getByRole('textbox',{name:'Message',exact:true}).fill('Please have an administrator reply to this private support request.');
	await page.getByRole('button',{name:'Send to admin'}).click();
	await expect(page.locator('.floating-support-notice')).toContainText('sent to the admin support inbox');
	const conversations=await page.request.get('/api/support').then(response=>response.json());
	const conversation=conversations.find((item:{subject:string})=>item.subject===subject);
	expect(conversation).toBeTruthy();
	const adminContext=await browser.newContext();
	try{
		const adminPage=await adminContext.newPage();
		await loginAs(adminPage,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
		await adminPage.goto('/admin');
		await expect(adminPage.locator('.floating-support')).toHaveCount(0);
		await expect(adminPage.locator('.admin-topbar-icon .admin-unread-dot')).toBeVisible();
		await adminPage.getByRole('link',{name:/View notifications and audit activity/}).click();
		await expect(adminPage).toHaveURL(/\/admin\/audit-logs/);
		await expect(adminPage.locator('.admin-topbar-icon .admin-unread-dot')).toHaveCount(0);
		const storyResponse=await adminPage.request.post('/api/admin/client-stories',{data:{
			displayName:'Aurevia editorial testimonial',
			title:'A simpler way to manage my finances',
			quote:'The platform gives me a clear view of my account.',
			rating:5,
			consentConfirmed:true,
			publicationStatus:'PUBLISHED',
			source:'admin',
		}});
		expect(storyResponse.status()).toBe(201);
		const story=await storyResponse.json();
		expect(story).toMatchObject({userId:null,title:'A simpler way to manage my finances',rating:5,publicationStatus:'PUBLISHED',verifiedClient:false});
		const publicStories=await adminPage.request.get('/api/client-stories').then(response=>response.json());
		expect(publicStories).toContainEqual(expect.objectContaining({id:story.id,title:story.title,rating:5,verifiedClientStory:false}));
		const hiddenStory=await adminPage.request.patch('/api/admin/client-stories',{data:{storyId:story.id,publicationStatus:'DRAFT'}});
		expect(hiddenStory.ok()).toBe(true);
		expect(await adminPage.request.get('/api/client-stories').then(response=>response.json())).not.toContainEqual(expect.objectContaining({id:story.id}));
		const inbox=await adminPage.request.get('/api/admin/support').then(response=>response.json());
		expect(inbox.some((item:{id:string})=>item.id===conversation.id)).toBe(true);
		const response=await adminPage.request.patch('/api/admin/support',{data:{action:'reply',conversationId:conversation.id,message:'Admin reply from the isolated end-to-end test.'}});
		expect(response.ok()).toBe(true);
	}finally{await adminContext.close()}
	await page.getByRole('button',{name:'Close chat support'}).click();
	await expect(page.locator('.floating-support-unread-dot')).toBeVisible({timeout:15_000});
	await (await revealSupportChat(page)).click();
	await expect(page.locator('.floating-support-unread-dot')).toHaveCount(0);
	await expect(page.locator('.floating-support-messages')).toContainText('Admin reply from the isolated end-to-end test.');
	await expectNoHorizontalOverflow(page);
});

test('language selection persists Arabic RTL direction and remains responsive',async({page})=>{
	await page.setViewportSize({width:390,height:844});
	await page.goto('/');
	const languageTrigger=page.getByRole('button',{name:/Select language:/});
	await languageTrigger.click();
	await page.getByRole('menuitemradio',{name:/العربية/}).click();
	await expect(page.locator('html')).toHaveAttribute('lang','ar');
	await expect(page.locator('html')).toHaveAttribute('dir','rtl');
	await expect.poll(()=>page.evaluate(()=>localStorage.getItem('aurevia-locale'))).toBe('ar');
	await page.reload();
	await expect(page.locator('html')).toHaveAttribute('lang','ar');
	await expect(page.locator('html')).toHaveAttribute('dir','rtl');
	await expectNoHorizontalOverflow(page);
});

test('language selector supports keyboard navigation, outside dismissal, and focus restoration',async({page})=>{
	await page.setViewportSize({width:320,height:800});
	await page.goto('/');
	const trigger=page.getByRole('button',{name:/Select language:/});
	await trigger.focus();
	await page.keyboard.press('ArrowDown');
	const menu=page.getByRole('menu',{name:/Languages/});
	await expect(menu).toBeVisible();
	await expect(menu.getByRole('menuitemradio').first()).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(menu).toBeHidden();
	await expect(trigger).toBeFocused();
	await trigger.click();
	await page.locator('body').click({position:{x:5,y:5}});
	await expect(menu).toBeHidden();
	await expect(trigger).not.toBeFocused();
	await expectNoHorizontalOverflow(page);
});

test('startup releases page interaction if session initialization is delayed',async({page})=>{
	let releaseSession!:()=>void;
	const sessionGate=new Promise<void>(resolve=>{releaseSession=resolve});
	await page.route('**/api/auth/session',async route=>{
		await sessionGate;
		await route.fulfill({status:200,contentType:'application/json',body:'{}'});
	});
	await page.goto('/login');
	const startup=page.getByRole('status',{name:'Loading Aurevia Exchange'});
	if(await startup.count())await expect(startup).toBeHidden({timeout:5000});
	const email=page.getByLabel('Email or administrator username');
	await email.fill('qa@example.invalid');
	await expect(email).toHaveValue('qa@example.invalid');
	await expect(page.locator('.scene-content > div[inert]')).toHaveCount(0);
	releaseSession();
	await expect(page.getByRole('heading',{name:'Welcome back'})).toBeVisible();
	await page.getByRole('link',{name:'Create an account'}).click();
	await expect(page.getByRole('heading',{name:'Open an account'})).toBeVisible();
	await expect(startup).toBeHidden();
	await page.goBack();
	await expect(page.getByRole('heading',{name:'Welcome back'})).toBeVisible();
	await page.reload();
	await expect(page.getByRole('heading',{name:'Welcome back'})).toBeVisible();
	await expect(startup).toBeHidden();
});

test('market refresh runs in place without reloading the page',async({page})=>{
	let documentRequests=0;
	let quoteRequests=0;
	let historyRequests=0;
	page.on('request',request=>{if(request.resourceType()==='document')documentRequests++});
	await page.route(/\/api\/live-markets\?symbols=/,route=>{
		quoteRequests++;
		return route.fulfill({status:200,contentType:'application/json',body:'{"quotes":[],"source":"isolated UI test"}'});
	});
	await page.route(/\/api\/live-markets\/[^?]+\?timeframe=/,async route=>{
		const timeframe=new URL(route.request().url()).searchParams.get('timeframe');
		historyRequests++;
		await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({quote:null,candles:[],timeframe,interval:'1m'})});
	});
	await page.goto('/markets');
	await waitForStartup(page);
	const beforeRetry=documentRequests;
	await expect.poll(()=>historyRequests).toBeGreaterThan(0);
	const priorQuotes=quoteRequests;
	const priorHistory=historyRequests;
	await page.getByRole('button',{name:/Refresh quotes|Actualizar cotizaciones/i}).click();
	await expect.poll(()=>quoteRequests).toBeGreaterThan(priorQuotes);
	await expect.poll(()=>historyRequests).toBeGreaterThan(priorHistory);
	expect(documentRequests).toBe(beforeRetry);
});

test('watchlists persist across refresh and remain isolated between accounts',async({page})=>{
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await page.goto('/markets');
	const sidebar=page.getByRole('complementary',{name:/Watchlists|Listas de seguimiento/i});
	await expect(sidebar).toHaveAttribute('aria-busy','false');
	await page.getByRole('button',{name:/Create watchlist|Crear lista de seguimiento/i}).click();
	await page.getByLabel(/New watchlist name|Nombre de la nueva lista/i).fill('User A private list');
	await page.getByRole('button',{name:/Save watchlist|Guardar lista/i}).click();
	await page.getByRole('button',{name:/Add symbol|Añadir símbolo/i}).click();
	await page.getByLabel(/Search for a symbol to add|Buscar símbolo para añadir/i).fill('AAPL');
	await page.locator('.live-symbol-results').getByRole('button').filter({hasText:'AAPL'}).click();
	await expect(page.locator('.live-watch-row').filter({hasText:'AAPL'})).toBeVisible();
	await page.reload();
	await expect(sidebar).toHaveAttribute('aria-busy','false');
	await expect(page.locator('#watchlist-select option',{hasText:'User A private list'})).toHaveCount(1);
	await expect(page.locator('.live-watch-row').filter({hasText:'AAPL'})).toBeVisible();

	await logout(page);
	await loginAs(page,fixture('LEGACY_USER_EMAIL'),fixture('LEGACY_USER_PASSWORD'));
	await page.goto('/markets');
	await expect(sidebar).toHaveAttribute('aria-busy','false');
	await expect(page.locator('#watchlist-select option',{hasText:'User A private list'})).toHaveCount(0);
	await expect(page.locator('.live-watch-row').filter({hasText:'AAPL'})).toHaveCount(0);

	await logout(page);
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await page.goto('/markets');
	await expect(sidebar).toHaveAttribute('aria-busy','false');
	await expect(page.locator('#watchlist-select option',{hasText:'User A private list'})).toHaveCount(1);
	await expect(page.locator('.live-watch-row').filter({hasText:'AAPL'})).toBeVisible();
});

test('country selector searches Nigeria and United Kingdom and shows their dialing codes',async({page})=>{
	await page.setViewportSize({width:320,height:800});
	await page.goto('/register');
	const picker=page.getByRole('button',{name:/phone country and dialing code/i});
	await expect(picker).toHaveAttribute('aria-label',/United States \+1/);
	await picker.click();
	const dialog=page.getByRole('dialog',{name:'Select phone country and dialing code'});
	await expect(dialog).toBeVisible();
	await expectNoHorizontalOverflow(page);
	const search=dialog.getByRole('searchbox');
	await search.fill('Nigeria');
	const nigeria=dialog.getByRole('option',{name:/Nigeria.*NG.*\+234/});
	await expect(nigeria).toBeVisible();
	await search.press('ArrowDown');
	await expect(nigeria).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(picker).toHaveAttribute('aria-label',/Nigeria \+234/);
	await picker.click();
	const ukDialog=page.getByRole('dialog',{name:'Select phone country and dialing code'});
	await ukDialog.getByRole('searchbox').fill('United Kingdom');
	const uk=ukDialog.getByRole('option',{name:/United Kingdom.*GB.*\+44/});
	await expect(uk).toBeVisible();
	await uk.click();
	await expect(picker).toHaveAttribute('aria-label',/United Kingdom \+44/);
	await expectNoHorizontalOverflow(page);
});

test('mobile date entry is calendar-backed and future dates are blocked',async({page})=>{
	await page.setViewportSize({width:320,height:800});
	await page.goto('/register');
	const date=page.getByLabel('Date of birth');
	await expect(date).toHaveAttribute('type','date');
	await expect(date).toHaveAttribute('max',new Date().toISOString().slice(0,10));
	const future=new Date();future.setUTCDate(future.getUTCDate()+1);
	const futureDate=future.toISOString().slice(0,10);
	await date.fill(futureDate);
	await expect(date).toHaveValue(futureDate);
	const rejectsFuture=await date.evaluate((input:HTMLInputElement)=>input.validity.rangeOverflow);
	expect(rejectsFuture).toBe(true);
	await expectNoHorizontalOverflow(page);
});

test('sign-in password visibility, recovery link, and account link are accessible on mobile',async({page})=>{
	await page.setViewportSize({width:320,height:800});
	await page.goto('/login');
	const password=page.getByLabel('Password',{exact:true});
	await password.fill('ExamplePassword123');
	await page.getByRole('button',{name:'Show password'}).click();
	await expect(password).toHaveAttribute('type','text');
	await page.getByRole('button',{name:'Hide password'}).click();
	await expect(password).toHaveAttribute('type','password');
	await expect(page.getByRole('link',{name:'Forgot password?'})).toHaveAttribute('href','/forgot-password');
	await expect(page.getByRole('link',{name:'Create an account'})).toHaveAttribute('href','/register');
	await expectNoHorizontalOverflow(page);
});

test('registration security script can retry without losing form values',async({page})=>{
	let scriptRequests=0;
	await page.route('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',route=>{
		scriptRequests++;
		if(scriptRequests===1)return route.abort();
		return route.fulfill({
			status:200,
			contentType:'application/javascript',
			body:`window.turnstile={render:function(){return 'test-widget';},reset:function(){},remove:function(){}};`,
		});
	});
	await page.setViewportSize({width:390,height:844});
	await page.goto('/register');
	await expect(page.locator('[role="alert"].text-loss')).toContainText('We couldn’t load the security check.');
	await page.getByRole('button',{name:'Retry'}).click();
	await expect(page.getByText('Complete the security check to continue.')).toBeVisible();
	expect(scriptRequests).toBe(2);
	await expectNoHorizontalOverflow(page);
});

test('registration page refresh and Turnstile retries do not submit and render the widget once',async({page})=>{
	let registrationSubmissions=0;
	await page.route('**/api/register',async route=>{
		if(route.request().method()==='POST'){
			registrationSubmissions++;
			await route.fulfill({
				status:429,
				headers:{'Retry-After':'90'},
				contentType:'application/json',
				body:JSON.stringify({error:'Too many registration attempts. Try again later.',retryAfterSeconds:90}),
			});
			return;
		}
		await route.continue();
	});
	await page.route('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',route=>route.fulfill({
		status:200,
		contentType:'application/javascript',
		body:`window.__aureviaTurnstileRenderCount=0;window.turnstile={render:function(_container,options){window.__aureviaTurnstileRenderCount++;window.__aureviaTurnstileOptions=options;return 'test-widget';},reset:function(){window.__aureviaTurnstileResetCount=(window.__aureviaTurnstileResetCount||0)+1;},remove:function(){}};`,
	}));
	await page.goto('/register');
	await expect(page.getByText('Complete the security check to continue.')).toBeVisible();
	const firstName=page.getByLabel('First name');
	const renderCount=()=>page.evaluate(()=>(
		window as Window & {__aureviaTurnstileRenderCount?:number}
	).__aureviaTurnstileRenderCount);
	expect(await renderCount()).toBe(1);
	await page.reload();
	await expect(page.getByText('Complete the security check to continue.')).toBeVisible();
	expect(await renderCount()).toBe(1);
	expect(registrationSubmissions).toBe(0);
	await firstName.fill('Preserved');
	await expect(firstName).toHaveValue('Preserved');

	await page.evaluate(()=>{
		const options=(window as Window & {__aureviaTurnstileOptions?:Record<string,(...args:string[])=>void>}).__aureviaTurnstileOptions;
		options?.['before-interactive-callback']();
	});
	await expect(page.getByText('Verifying the security check…')).toBeVisible();
	await page.evaluate(()=>{
		const options=(window as Window & {__aureviaTurnstileOptions?:Record<string,(...args:string[])=>void>}).__aureviaTurnstileOptions;
		options?.['error-callback']();
	});
	await expect(page.locator('.auth-error')).toContainText('Security verification could not be completed.');
	await page.getByRole('button',{name:'Retry security check'}).click();
	await expect(page.getByText('Complete the security check to continue.')).toBeVisible();
	await expect(firstName).toHaveValue('Preserved');
	await page.evaluate(()=>{
		const options=(window as Window & {__aureviaTurnstileOptions?:Record<string,(...args:string[])=>void>}).__aureviaTurnstileOptions;
		options?.['expired-callback']();
	});
	await expect(page.getByText('Security verification expired. Retry to continue.')).toBeVisible();
	await page.getByRole('button',{name:'Retry security check'}).click();
	await page.evaluate(()=>{
		const options=(window as Window & {__aureviaTurnstileOptions?:Record<string,(...args:string[])=>void>}).__aureviaTurnstileOptions;
		options?.callback('mock-cloudflare-token');
	});
	await expect(page.getByText('Security verification successful.')).toBeVisible();
	await expect(page.getByRole('button',{name:'Create account'})).toBeDisabled();
	await page.getByLabel('First name').fill('Mobile');
	await page.getByLabel('Last name').fill('Retry Test');
	await page.getByLabel('Date of birth').fill('1990-01-01');
	const residencePicker=page.getByRole('button',{name:/country of residence/i});
	await residencePicker.click();
	const residenceDialog=page.getByRole('dialog',{name:'Select country of residence'});
	await residenceDialog.getByRole('searchbox').fill('United States');
	await residenceDialog.getByRole('option',{name:/United States.*US.*\+1/}).click();
	await page.getByLabel('Email address').fill(`retry-${randomUUID()}@example.invalid`);
	await page.getByLabel('Password',{exact:true}).fill('SecureTestPassword1');
	await page.getByLabel('Confirm password').fill('SecureTestPassword1');
	await page.getByRole('checkbox').check();
	const createAccount=page.getByRole('button',{name:'Create account'});
	await expect(createAccount).toBeEnabled();
	await page.locator('form.register-form').evaluate((form:HTMLFormElement)=>{
		form.requestSubmit();
		form.requestSubmit();
	});
	await expect(page.locator('.auth-error')).toContainText('You can retry in 2 minute(s).');
	await expect(page.getByLabel('Email address')).toHaveValue(/^retry-.*@example\.invalid$/);
	await expect(createAccount).toBeDisabled();
	expect(await renderCount()).toBe(1);
	expect(registrationSubmissions).toBe(1);
});

test('mobile verification accepts an existing email code when resend is rate-limited',async({page})=>{
	const email='pending-registration@example.invalid';
	let verificationPayload:Record<string,unknown>|undefined;
	await page.setViewportSize({width:320,height:800});
	await page.route('**/api/register/resend',route=>route.fulfill({
		status:429,
		contentType:'application/json',
		headers:{'Retry-After':'3480'},
		body:JSON.stringify({error:'Please wait before requesting another verification code.',retryAfterSeconds:3480}),
	}));
	await page.route('**/api/register/verify',async route=>{
		verificationPayload=route.request().postDataJSON() as Record<string,unknown>;
		await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({verified:true})});
	});

	await page.goto(`/verify-email?email=${encodeURIComponent(email)}`);
	await expect(page.getByRole('textbox',{name:'Email address'})).toHaveValue(email);
	await expect(page.getByText(email,{exact:true})).toBeVisible();
	await expect(page.locator('.auth-error')).toContainText('58 minute(s)');
	await expect(page.getByLabel('Six-digit email verification code')).toBeVisible();
	await expectNoHorizontalOverflow(page);
	await page.getByLabel('Six-digit email verification code').fill('123456');
	await page.getByRole('button',{name:'Verify email address'}).click();
	await page.waitForURL('/login?verified=1');
	expect(verificationPayload).toEqual({email,code:'123456'});
});

test('mobile verification shows an Akedly quota cooldown without automatically resending',async({page})=>{
	let resendRequests=0;
	await page.setViewportSize({width:320,height:800});
	await page.route('**/api/register/resend',async route=>{
		resendRequests++;
		await route.fulfill({
			status:402,
			contentType:'application/json',
			body:JSON.stringify({error:'The verification route has temporarily reached its delivery limit.',retryAfterSeconds:90}),
		});
	});

	await page.goto('/verify-email?email=quota-test%40example.invalid');
	await expect(page.locator('.auth-error')).toContainText('You can retry in 2 minute(s).');
	await expectNoHorizontalOverflow(page);
	expect(resendRequests).toBe(1);
	await page.waitForTimeout(500);
	expect(resendRequests).toBe(1);
});

test('new registration fails closed without configured phone verification',async({page})=>{
	const email=`phone-verification-unavailable-${randomUUID()}@example.invalid`;
	const response=await page.request.post('/api/register',{
		headers:{'x-forwarded-for':'192.0.2.150'},
		data:{
			name:'Temporary Browser Test',
			email,
			password:'SecureTestPassword1',
			country:'United States',
			dateOfBirth:'2000-02-29',
			phone:'+447400123456',
			accountMode:'DEMO',
			termsAccepted:true,
			captchaToken:'isolated-test-turnstile-token',
		},
	});

	expect(response.status()).toBe(503);
	expect(await response.json()).toMatchObject({
		error:'Phone verification is unavailable right now. Your details were not saved. Please try again later; if this continues, contact support.',
		requestId:expect.any(String),
	});
	expect(await db.user.findUnique({where:{email}})).toBeNull();
	expect(await db.registrationAttempt.findUnique({where:{email}})).toBeNull();
});

test.skip('legacy email-code registration fallback is not used for new signups',async({page})=>{
	const email=fixture('REGISTRATION_EMAIL');
	const password=fixture('REGISTRATION_PASSWORD');
	const openProfileSettings=async()=>{
		await page.goto('/settings');
		await page.getByRole('link',{name:/Account Details/}).click();
	};
	await page.setViewportSize({width:390,height:844});
	await page.goto('/register');
	await expect(page.getByRole('heading',{name:'Open an account'})).toBeVisible();
	await expect(page.getByRole('button',{name:'Create account'})).toBeDisabled();
	await expectNoHorizontalOverflow(page);
	await expect(page.getByRole('radio',{name:/DEMO ACCOUNT/})).toBeVisible();
	const realMode=page.getByRole('radio',{name:/REAL ACCOUNT/});
	await realMode.check();
	await expect(realMode).toBeChecked();
	const demoMode=page.getByRole('radio',{name:/DEMO ACCOUNT/});
	await demoMode.check();
	await expect(demoMode).toBeChecked();
	await page.getByLabel('First name').fill('Temporary');
	await page.getByLabel('Last name').fill('Browser Test');
	await page.getByLabel('Date of birth').fill('2000-02-29');
	const residencePicker=page.getByRole('button',{name:/country of residence/i});
	await residencePicker.click();
	const residenceDialog=page.getByRole('dialog',{name:'Select country of residence'});
	await residenceDialog.getByRole('searchbox').fill('United States');
	await residenceDialog.getByRole('option',{name:/United States.*US.*\+1/}).click();
	const phonePicker=page.getByRole('button',{name:/phone country and dialing code/i});
	await phonePicker.click();
	const phoneDialog=page.getByRole('dialog',{name:'Select phone country and dialing code'});
	await phoneDialog.getByRole('searchbox').fill('United Kingdom');
	await phoneDialog.getByRole('option',{name:/United Kingdom.*GB.*\+44/}).click();
	await page.getByLabel('Email address').fill(email);
	await page.getByLabel(/Phone number/).fill('07400 123456');
	await page.getByLabel('Password', {exact:true}).fill(password);
	await page.getByLabel('Confirm password').fill(password);
	await page.getByRole('checkbox').check();
	await expect(page.getByRole('button',{name:'Create account'})).toBeEnabled();
	const registrationRequest=page.waitForRequest(request=>request.url().endsWith('/api/register')&&request.method()==='POST');
	const registrationResponse=page.waitForResponse(response=>response.url().endsWith('/api/register')&&response.request().method()==='POST');
	await page.getByRole('button',{name:'Create account'}).click();
	const registrationPayload=(await registrationRequest).postDataJSON();
	expect(registrationPayload).toMatchObject({name:'Temporary Browser Test',country:'United States',phone:'+447400123456',dateOfBirth:'2000-02-29'});
	expect(registrationPayload.captchaToken).toEqual(expect.any(String));
	expect(registrationPayload.captchaToken.trim().length).toBeGreaterThan(0);
	const response=await registrationResponse;
	const responseBody=await response.json();
	expect(response.status(),JSON.stringify(responseBody)).toBe(201);
	expect(responseBody).toMatchObject({verificationRequired:true,authMethod:'email-code'});
	await expect(page).toHaveURL(url=>url.pathname==='/verify-email'&&url.searchParams.get('email')===email);
	expect(await db.user.findUnique({where:{email}})).toBeNull();
	await expect.poll(async()=>{
		const attempt=await db.registrationAttempt.findUnique({where:{email},select:{verification:{select:{channel:true}}}});
		return attempt?.verification?.channel??null;
	}).toBe('EMAIL');
	expect(await db.registrationAttempt.findUniqueOrThrow({where:{email},select:{email:true,verification:{select:{channel:true}}}})).toEqual({email,verification:{channel:'EMAIL'}});
	await expect.poll(async()=>await (await page.request.get(`${providerOrigin}/stats`)).json()).toMatchObject({email:1,sms:0});
	const codeResponse=await page.request.get(`${providerOrigin}/test-code?email=${encodeURIComponent(email)}`);
	expect(codeResponse.ok()).toBe(true);
	const {code}=await codeResponse.json() as {code:string};
	await page.goto('/login');
	await page.getByLabel('Email or administrator username').fill(email);
	await page.getByLabel('Password',{exact:true}).fill(password);
	await page.getByRole('button',{name:'Sign in'}).click();
	await expect(page.getByRole('alert')).toBeVisible();
	await page.goto(`${appOrigin}/verify-email?email=${encodeURIComponent(email)}`);
	await expect(page.getByLabel('Six-digit email verification code')).toBeVisible();
	await page.getByLabel('Six-digit email verification code').fill(code);
	const verificationResponse=page.waitForResponse(response=>response.url().endsWith('/api/register/verify')&&response.request().method()==='POST');
	await page.getByRole('button',{name:'Verify email address'}).click();
	const verifiedResponse=await verificationResponse;
	const verificationBody=await verifiedResponse.json();
	expect(verifiedResponse.status(),JSON.stringify(verificationBody)).toBe(200);
	await page.waitForURL('/login?verified=1');
	const verifiedUser=await db.user.findUniqueOrThrow({where:{email},select:{requiresRegistrationVerification:true,emailVerifiedAt:true,aureviaExchangeId:true}});
	expect(verifiedUser).toMatchObject({requiresRegistrationVerification:false,emailVerifiedAt:expect.any(Date)});
	expect(verifiedUser.aureviaExchangeId).toMatch(/^AEX-\d{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
	expect(await db.verificationCode.count({where:{user:{email},channel:'EMAIL'}})).toBe(0);
	const duplicateRegistration=await page.request.post('/api/register',{data:registrationPayload});
	expect(duplicateRegistration.status()).toBe(409);
	await page.getByLabel('Email or administrator username').fill(email);
	await page.getByLabel('Password',{exact:true}).fill(password);
	await page.getByRole('button',{name:'Sign in'}).click();
	await page.waitForURL(/dashboard/);
	await expect(page.getByRole('heading',{name:'My assets'})).toBeVisible();
	await expect(page.locator('.dashboard-profile-panel')).toHaveCount(0);
	await openProfileSettings();
	await expect(page.getByRole('tab',{name:'Profile'})).toBeVisible();
	await expect(page.getByLabel('Email address')).toHaveValue(email);
	await page.getByLabel('First name').fill('Edited');
	await page.getByLabel('Last name').fill('Persistent Owner');
	await page.getByLabel('Phone').fill('+447400123457');
	await page.getByLabel('Country').fill('United Kingdom');
	await page.getByLabel('Address (optional)').fill('42 Persistent Test Road');
	const profilePatchRequest=page.waitForRequest(request=>request.url().endsWith('/api/profile')&&request.method()==='PATCH');
	const profilePatchResponse=page.waitForResponse(response=>response.url().endsWith('/api/profile')&&response.request().method()==='PATCH');
	await page.getByRole('button',{name:'Save profile'}).click();
	const patchRequest=await profilePatchRequest;
	const patchResponse=await profilePatchResponse;
	expect(patchRequest.postDataJSON()).toMatchObject({firstName:'Edited',lastName:'Persistent Owner',phone:'+447400123457',country:'United Kingdom',address:'42 Persistent Test Road'});
	expect(await patchResponse.json()).toMatchObject({name:'Edited Persistent Owner',firstName:'Edited',lastName:'Persistent Owner',phone:'+447400123457',country:'United Kingdom',address:null});
	await expect(page.getByRole('status')).toContainText('Profile saved successfully.');
	await page.reload();
	await page.getByRole('link',{name:/Account Details/}).click();
	await expect(page.getByLabel('First name')).toHaveValue('Edited');
	await expect(page.getByLabel('Last name')).toHaveValue('Persistent Owner');
	await expect(page.getByLabel('Phone')).toHaveValue('+447400123457');
	await expect(page.getByLabel('Country')).toHaveValue('United Kingdom');
	await expect(page.getByLabel('Address (optional)')).toHaveValue('');
	await page.goto('/dashboard');
	await expect(page.getByRole('heading',{name:'My assets'})).toBeVisible();
	const profileResponse=await page.request.get('/api/profile');
	expect(profileResponse.ok()).toBeTruthy();
	const profile=await profileResponse.json();
	expect(profile).toMatchObject({name:'Edited Persistent Owner',firstName:'Edited',lastName:'Persistent Owner',phone:'+447400123457',country:'United Kingdom',address:null});
	expect(profile.phoneVerified).toBe(false);
	expect(profile).not.toHaveProperty('dob');
	expect(profile).not.toHaveProperty('dateOfBirth');
	const kycResponse=await page.request.get('/api/kyc');
	expect(kycResponse.status()).toBe(403);
	const demoWallet=await page.request.get('/api/wallet');
	expect(Number((await demoWallet.json()).balance)).toBe(5000);
	await selectAccountMode(page,'REAL');
	await openProfileSettings();
	await expect(page.getByLabel('Address (optional)')).toHaveValue('42 Persistent Test Road');
	expect(await page.request.get('/api/profile').then(response=>response.json())).toMatchObject({address:'42 Persistent Test Road'});
	expect((await page.request.get('/api/kyc').then(response=>response.json())).dob).toBe('2000-02-29T00:00:00.000Z');
	await page.goto('/dashboard');
	await expect(page.getByRole('heading',{name:'My assets'})).toBeVisible();
	await expect(page.locator('.user-mode-pill')).toContainText('REAL ACCOUNT');
	await expect.poll(async()=>Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(0);
	await selectAccountMode(page,'DEMO');
	await page.goto('/dashboard');
	await expect(page.getByRole('heading',{name:'My assets'})).toBeVisible();
	await expect(page.locator('.user-mode-pill')).toContainText('DEMO MODE · VIRTUAL');
	await expect.poll(async()=>Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(5000);
	await logout(page);
	const healthAfterLogout=await page.request.get('/api/health');
	expect(healthAfterLogout.ok()).toBeTruthy();
	expect(await healthAfterLogout.json()).toMatchObject({ok:true,database:'ok'});
	await loginAs(page,email,password);
	await expect(page.getByRole('heading',{name:'My assets'})).toBeVisible();
	expect(await page.request.get('/api/profile').then(response=>response.json())).toMatchObject({name:'Edited Persistent Owner',address:null});
	await page.goto('/');
	await expect(page.getByRole('link',{name:/Dashboard/}).first()).toBeVisible();
	await expect(page.getByRole('button',{name:/Notifications/})).toBeVisible();
	await expect(page.getByRole('link',{name:'Login'})).toHaveCount(0);
	await page.reload();
	await expect(page.getByRole('button',{name:/Notifications/})).toBeVisible();
	await logout(page);
	await expect(page).toHaveURL(/\/login/);
	await page.setViewportSize({width:390,height:844});
	await page.goto('/');
	await page.getByRole('button',{name:'Open navigation'}).click();
	const primaryNavigation=page.getByRole('navigation',{name:'Primary navigation'});
	await expect(primaryNavigation.getByRole('link',{name:'Sign in',exact:true})).toBeVisible();
	await expect(primaryNavigation.getByRole('link',{name:'Create an account',exact:true})).toBeVisible();
	await expect(page.getByRole('link',{name:'Open account',exact:true}).first()).toBeVisible();
});

test('legacy account without registration verification metadata can still sign in',async({page})=>{
	await loginAs(page,fixture('LEGACY_USER_EMAIL'),fixture('LEGACY_USER_PASSWORD'));
	await expect(page.getByRole('heading',{name:'My Portfolio'})).toBeVisible();
	await expect(page.getByRole('button',{name:/Notifications/})).toBeVisible();
});

test('session replacement is explicit and refresh-safe',async({page,browser})=>{
	const email=fixture('USER_EMAIL');
	const password=fixture('USER_PASSWORD');
	await page.goto('/login');
	await waitForStartup(page);
	await page.getByLabel('Email or administrator username').fill(email);
	await page.getByLabel('Password',{exact:true}).fill(password);
	await page.getByRole('checkbox',{name:/Replace the active Aurevia session/}).check();
	await page.getByRole('button',{name:'Sign in'}).click();
	await page.waitForURL(/dashboard/);
	await page.reload();
	await expect(page.getByRole('heading',{name:'My Portfolio'})).toBeVisible();
	const otherContext=await browser.newContext();
	try{
		const otherDevice=await otherContext.newPage();
		await otherDevice.addInitScript(()=>localStorage.setItem('aurevia-policy-consent-v1',JSON.stringify({version:1,choice:'accepted',updatedAt:new Date().toISOString()})));
		await otherDevice.goto('/login');
		await waitForStartup(otherDevice);
		await otherDevice.getByLabel('Email or administrator username').fill(email);
		await otherDevice.getByLabel('Password',{exact:true}).fill(password);
		await otherDevice.getByRole('checkbox',{name:/Replace the active Aurevia session/}).check();
		await otherDevice.getByRole('button',{name:'Sign in'}).click();
		await otherDevice.waitForURL(/dashboard/);
		const response=await page.request.get('/api/dashboard');
		expect(response.status()).toBe(401);
	}finally{await otherContext.close();}
});

for(const viewport of viewports){
	test(`authenticated routes render without horizontal overflow at ${viewport.width}x${viewport.height}`,async({page})=>{
		await page.setViewportSize(viewport);
		await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
		for(const route of authenticatedRoutes){
			const response=await page.goto(route);
			expect(response?.status(),route).toBe(200);
			await expect(page.locator('main').first(),route).toBeVisible();
			if(await page.locator('h1:visible').count())await expect(page.locator('h1:visible').first(),route).toBeVisible();
			if(route==='/dashboard'&&viewport.width<=640)await expect(page.locator('.mobile-home-greeting'),route).toBeVisible();
			await expectNoHorizontalOverflow(page);
		}
	});
}

test('notifications bell, unread state, mark one/all, and history persist',async({page})=>{
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await page.setViewportSize({width:390,height:844});
	await page.goto('/');
	const bell=page.getByRole('button',{name:/Notifications/});
	await expect(bell).toContainText(/\d/);
	await bell.click();
	const dialog=page.getByRole('dialog',{name:'Notifications'});
	await expect(dialog).toBeVisible();
	const closeButton=dialog.getByRole('button',{name:'Close notifications'});
	await expect.poll(()=>closeButton.evaluate(element=>{
		const bounds=element.getBoundingClientRect();
		const target=document.elementFromPoint(bounds.left+bounds.width/2,bounds.top+bounds.height/2);
		return target===element||element.contains(target);
	})).toBe(true);
	const first=page.locator('.notification-row').filter({hasText:'E2E unread notification one'});
	await expect(first).toBeVisible();
	await first.click();
	await page.getByRole('button',{name:'Mark all notifications as read'}).click();
	await expect(page.locator('.notification-count')).toHaveCount(0);
	await page.goto('/notifications');
	await expect(page.getByRole('heading',{name:'Notifications'})).toBeVisible();
	await expect(page.getByText('All caught up')).toBeVisible();
	await page.reload();
	await expect(page.getByText('All caught up')).toBeVisible();
	await expectNoHorizontalOverflow(page);
});

test('account-mode changes initialize and isolate wallet, trade, history, and support state',async({page})=>{
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	const mode=page.locator('.user-mode-control');
	const demoMode=mode.getByRole('button',{name:'Demo',exact:true});
	const realMode=mode.getByRole('button',{name:'Real',exact:true});
	await page.goto('/wallet?action=DEPOSIT');
	await expect(page.locator('.wallet-page-heading .wallet-eyebrow')).toContainText('DEMO ACCOUNT');
	await expect(page.locator('.wallet-page-heading .status-pill')).toContainText('DEMO');
	let releaseModeUpdate!:()=>void;
	const modeUpdateGate=new Promise<void>(resolve=>{releaseModeUpdate=resolve});
	await page.route('**/api/account/mode',async route=>{await modeUpdateGate;await route.continue()});
	await selectAccountMode(page,'REAL',{waitForCompletion:false});
	await expect(demoMode).toBeDisabled();
	releaseModeUpdate();
	await page.unroute('**/api/account/mode');
	await expect(realMode).toHaveAttribute('aria-pressed','true');
	await expect(page.locator('.wallet-page-heading .wallet-eyebrow')).toContainText('REAL ACCOUNT');
	await expect(page.locator('.wallet-page-heading .status-pill')).toContainText('REAL');
	await expect(page.locator('.wallet-balance-value')).toHaveText('$0.00');
	await page.goto('/wallet/transactions');
	await expect(page.locator('.account-heading .status-pill')).toContainText('REAL ACCOUNT');
	await expect(page.getByText('No transactions yet')).toBeVisible();
	await selectAccountMode(page,'DEMO');
	await expect(page.locator('.account-heading .status-pill')).toContainText('DEMO ACCOUNT');
	await page.goto('/dashboard');
	await expect(page.getByRole('heading',{name:'My portfolio'})).toBeVisible();
	await expect(page.locator('.user-mode-pill')).toContainText('DEMO MODE');
	await page.goto('/portfolio');
	await expect(page.locator('.portfolio-heading-actions .status-pill')).toContainText('DEMO ACCOUNT');
	await selectAccountMode(page,'REAL');
	await expect(page.locator('.portfolio-heading-actions .status-pill')).toContainText('REAL ACCOUNT');
	await page.goto('/trade');
	await selectAccountMode(page,'REAL');
	await expect(page.locator('.account-heading .status-pill')).toContainText('REAL');
	await expect(page.getByText(/Orders go to the shared Alpaca Paper account/)).toBeVisible();
	const realOrderButton=page.getByRole('button',{name:'Place BUY order'});
	const marketResponse=await page.request.get('/api/live-markets?symbols=AAPL');
	expect(marketResponse.ok()).toBeTruthy();
	const marketData=await marketResponse.json() as {quotes?:Array<{asset?:{id?:string};source?:string;isStale?:boolean}>};
	const hasFreshProviderQuote=marketData.quotes?.some(quote=>quote.asset?.id==='AAPL'&&(quote.source==='Finnhub'||quote.source?.startsWith('Alpaca'))&&!quote.isStale)??false;
	if(hasFreshProviderQuote)await expect(realOrderButton).toBeEnabled();
	else{
		await expect(realOrderButton).toBeDisabled();
		await expect(page.locator('.trade-chart-note')).toContainText('No simulated market data is shown for REAL orders.');
	}
	await selectAccountMode(page,'DEMO');
	await expect(page.locator('.account-heading .status-pill')).toContainText('DEMO');
	await expect(page.getByRole('button',{name:'Place BUY order'})).toBeEnabled();
	await page.goto('/support');
	await page.getByRole('button',{name:'Contact Admin'}).click();
	const subject=`Mode-scoped support ${randomUUID().slice(0,8)}`;
	await page.getByLabel('Subject').fill(subject);
	await page.getByRole('textbox',{name:'Message',exact:true}).fill('Temporary DEMO support isolation test.');
	await page.getByRole('button',{name:'Create support ticket'}).click();
	await expect(page.getByRole('button').filter({hasText:subject})).toBeVisible();
	await selectAccountMode(page,'REAL');
	await expect(page.getByRole('button').filter({hasText:subject})).toHaveCount(0);
	await selectAccountMode(page,'DEMO');
	await expect(page.getByRole('button').filter({hasText:subject})).toBeVisible();
});

test('REAL funding remains available while trading stays disabled without brokerage',async({browser,page})=>{
	await loginAs(page,fixture('INVESTOR_EMAIL'),fixture('INVESTOR_PASSWORD'));
	expect((await page.request.get('/api/admin/providers/status')).status()).toBe(403);
	expect((await page.request.post('/api/webhooks/broker/unconfigured',{data:{eventId:'synthetic-test-event'}})).status()).toBe(503);
	await selectAccountMode(page,'REAL');
	await expect.poll(async()=>Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(0);
	const previousGbpRate=await db.exchangeRate.findUnique({where:{baseCurrency_quoteCurrency:{baseCurrency:'USD',quoteCurrency:'GBP'}}});
	try{
		await db.exchangeRate.upsert({
			where:{baseCurrency_quoteCurrency:{baseCurrency:'USD',quoteCurrency:'GBP'}},
			create:{baseCurrency:'USD',quoteCurrency:'GBP',rate:'0.8',source:'E2E configured rate',observedAt:new Date()},
			update:{rate:'0.8',source:'E2E configured rate',observedAt:new Date()},
		});
		await page.request.patch('/api/currency-preference',{data:{currency:'GBP'}});
		const configuredRate=await page.request.get('/api/currency-rates?to=GBP').then(response=>response.json());
		expect(configuredRate).toMatchObject({rate:'0.8',source:'E2E configured rate',status:'CURRENT'});
		await page.goto('/wallet');
		await page.locator('details.wallet-settings > summary').click();
		await expect(page.getByText('Reference rate: 1 USD = 0.8 GBP')).toBeVisible();
		await expect(page.getByText(/Approximate display: £0\.00/)).toBeVisible();
	}finally{
		await page.request.patch('/api/currency-preference',{data:{currency:'USD'}});
		if(previousGbpRate)await db.exchangeRate.update({where:{baseCurrency_quoteCurrency:{baseCurrency:'USD',quoteCurrency:'GBP'}},data:{rate:previousGbpRate.rate,source:previousGbpRate.source,observedAt:previousGbpRate.observedAt}});
		else await db.exchangeRate.deleteMany({where:{baseCurrency:'USD',quoteCurrency:'GBP'}});
	}
	const instruments=await page.request.get('/api/market').then(response=>response.json());
	const isolatedOrder=await page.request.post('/api/orders',{headers:{'Idempotency-Key':randomUUID()},data:{instrumentId:instruments[0].id,side:'BUY',type:'LIMIT',quantity:1,price:0.01,expectedPrice:Number(instruments[0].price),observedAt:instruments[0].lastUpdatedAt||instruments[0].updatedAt}});
	expect(isolatedOrder.status()).toBe(403);
	expect((await isolatedOrder.json()).error).toContain('Alpaca Paper orders are disabled');
	expect(await page.request.get('/api/orders').then(response=>response.json())).toHaveLength(0);

	const adminContext=await browser.newContext();
	try{
		const adminPage=await adminContext.newPage();
		await loginAs(adminPage,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
		const statusResponse=await adminPage.request.get('/api/admin/providers/status');
		expect(statusResponse.ok()).toBe(true);
		const status=await statusResponse.json();
		expect(status.internalSimulation).toMatchObject({adminAuthorization:'AVAILABLE',externalBrokerExecution:'DISABLED',externalPaymentProcessing:'DISABLED',externalInvestmentSettlement:'DISABLED',externalMoneyMovement:'DISABLED'});
		expect(status.internalSimulation.accountLedger).toBe('AVAILABLE');
		expect(status.internalSimulation.simulatedDepositsAndWithdrawals).toBe('AVAILABLE');
		expect(status.marketData.usedForOrderExecution).toBe(false);
		expect(JSON.stringify(status)).not.toContain('://');

		const prooflessDepositApproval=await adminPage.request.patch('/api/admin/funding',{data:{id:fixture('REAL_DEPOSIT_NO_PROOF_ID'),decision:'APPROVED'}});
		expect(prooflessDepositApproval.status()).toBe(200);
		expect(Number((await prooflessDepositApproval.json()).creditedAmount)).toBe(67.5);
		expect(Number((await prooflessDepositApproval.json()).feeAmount)).toBe(7.5);
		const depositApproval=await adminPage.request.patch('/api/admin/funding',{data:{id:fixture('REAL_DEPOSIT_ID'),decision:'APPROVED'}});
		expect(depositApproval.status()).toBe(200);
		expect(Number((await depositApproval.json()).creditedAmount)).toBe(112.5);
		expect(Number((await depositApproval.json()).feeAmount)).toBe(12.5);
		const withdrawalApproval=await adminPage.request.patch('/api/admin/funding',{data:{id:fixture('REAL_WITHDRAWAL_ID'),decision:'APPROVED'}});
		expect(withdrawalApproval.status()).toBe(409);
		expect((await withdrawalApproval.json()).error).toContain('audited approve, process, and externally confirmed completion workflow');
		expect(await db.ledgerTransaction.findUnique({where:{reference:`FUNDING:${fixture('REAL_WITHDRAWAL_ID')}:APPROVED`}})).toBeNull();
		expect(await db.fundingRequest.findUniqueOrThrow({where:{id:fixture('REAL_WITHDRAWAL_ID')},select:{status:true}})).toMatchObject({status:'PENDING_REVIEW'});
		const duplicateApproval=await adminPage.request.patch('/api/admin/funding',{data:{id:fixture('REAL_DEPOSIT_ID'),decision:'APPROVED'}});
		expect(duplicateApproval.status()).toBe(409);
		const fundingHistory=await adminPage.request.get('/api/admin/funding?history=true').then(response=>response.json());
		expect(fundingHistory.find((row:{id:string})=>row.id===fixture('REAL_DEPOSIT_ID'))).toMatchObject({status:'APPROVED',accountMode:'REAL',amount:'125',creditedAmount:'112.5',feeAmount:'12.5'});
		expect(fundingHistory.find((row:{id:string})=>row.id===fixture('REAL_WITHDRAWAL_ID'))).toMatchObject({status:'PENDING_REVIEW',accountMode:'REAL'});
	}finally{await adminContext.close();}

	await expect.poll(async()=>Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(180);
	await expect.poll(async()=>Number((await page.request.get('/api/wallet').then(response=>response.json())).withdrawableBalance)).toBe(155);
	const fundedInstrument=(await page.request.get('/api/market').then(response=>response.json())).find((item:{price:number})=>Number(item.price)<100);
	expect(fundedInstrument,'approved REAL deposits should provide an affordable market instrument').toBeTruthy();
	if(!fundedInstrument)throw new Error('No affordable instrument is available after the simulated REAL deposits.');
	const fundedBuy=await page.request.post('/api/orders',{headers:{'Idempotency-Key':randomUUID()},data:{instrumentId:fundedInstrument.id,side:'BUY',type:'MARKET',quantity:1,expectedPrice:Number(fundedInstrument.price),observedAt:fundedInstrument.lastUpdatedAt||fundedInstrument.updatedAt}});
	expect(fundedBuy.status()).toBe(403);
	expect((await fundedBuy.json()).error).toContain('Alpaca Paper orders are disabled');
	expect(Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(180);
	expect(await page.request.get('/api/positions').then(response=>response.json())).toHaveLength(0);
	expect(await page.request.get('/api/orders').then(response=>response.json())).toHaveLength(0);
	await selectAccountMode(page,'DEMO');
	expect(Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(5000);
	expect(await page.request.get('/api/positions').then(response=>response.json())).toHaveLength(0);
	await selectAccountMode(page,'REAL');
	expect(await page.request.get('/api/positions').then(response=>response.json())).toHaveLength(0);
});

test('Wallet shows the internal funding workflow only in REAL Mode and survives API failures',async({browser,page})=>{
	const adminContext=await browser.newContext();
	const adminPage=await adminContext.newPage();
	try{
		await loginAs(adminPage,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
		await page.setViewportSize({width:390,height:844});
		await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
		await selectAccountMode(page,'DEMO');
		await page.goto('/wallet');
		await expect(page.getByRole('heading',{name:/wallet|funding/i}).first()).toBeVisible();
		await expect(page.locator('.wallet-signature-brand')).toContainText('AUREVIA');
		await expect(page.locator('.wallet-signature-brand')).toContainText('ACCOUNT WALLET');
		await expect(page.locator('.wallet-card-art')).toBeVisible();
		await expect(page.locator('.wallet-signature-card')).toContainText('Available balance');
		await expect(page.locator('.wallet-balance-value')).toHaveText('$5,000.00');
		await expect(page.locator('.wallet-page-heading')).toContainText('DEMO · VIRTUAL');
		await expect(page.locator('.wallet-balance-foot')).toContainText('Practice account · no real funds');
		await expect(page.getByLabel('Payment method')).toHaveCount(0);
		await expect(page.locator('.wallet-type-switch')).toHaveCount(0);
		await expect(page.getByLabel('Amount',{exact:true})).toHaveCount(0);
		await page.getByRole('button',{name:'Hide balance'}).click();
		await expect(page.locator('.wallet-balance-value')).toHaveText('•••••• USD');
		await expect(page.getByRole('button',{name:'Show balance'})).toBeVisible();
		await page.getByRole('button',{name:'Show balance'}).click();
		await expect(page.locator('.wallet-balance-value')).toHaveText('$5,000.00');
		await page.route('**/api/payment-methods',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Payment methods are temporarily unavailable.'})}));
		await page.getByRole('button',{name:'Refresh wallet'}).click();
		await expect(page.getByText('Loading wallet data…')).toHaveCount(0);
		await expect(page.locator('.wallet-balance-value')).toHaveText('$5,000.00');
		await expect(page.locator('.wallet-page-heading')).toContainText('DEMO · VIRTUAL');
		await expect(page.locator('.wallet-balance-foot')).toContainText('Practice account · no real funds');
		await page.unroute('**/api/payment-methods');
		await page.route('**/api/wallet',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Wallet data is temporarily unavailable.'})}));
		await page.getByRole('button',{name:'Refresh wallet'}).click();
		await expect(page.getByText('Loading wallet data…')).toHaveCount(0);
		await expect(page.locator('.wallet-balance-value')).toHaveText('Unavailable');
		await expect(page.getByRole('alert').filter({hasText:'Wallet data is temporarily unavailable.'})).toBeVisible();
		await expect(page.getByLabel('Amount',{exact:true})).toHaveCount(0);
		await page.unroute('**/api/wallet');
		await page.getByRole('button',{name:'Refresh wallet'}).click();
		await expect(page.locator('.wallet-balance-value')).toHaveText('$5,000.00');
		await selectAccountMode(page,'REAL');
		await page.goto('/wallet?action=DEPOSIT');
		const methods=await page.request.get('/api/payment-methods').then(response=>response.json());
		expect(methods).toMatchObject({methods:[],fundingStatus:'AVAILABLE',simulationAvailable:true,realFundingAvailable:true,realWithdrawalAvailable:true,manualDepositReviewAvailable:true,externalPaymentProcessing:'DISABLED',internalLedgerOnly:true});
		await expect(page.getByText(/internal REAL ledger credit request/i)).toBeVisible();
		await expect(page.getByLabel('Amount',{exact:true})).toBeVisible();
		await expect(page.getByLabel('Request reference (optional)')).toBeVisible();
		await expect(page.getByLabel('Bitcoin address')).toHaveCount(0);
		await expect(page.getByLabel('Bitcoin transaction reference')).toHaveCount(0);
		await expect(page.locator('input[type="file"]')).toHaveCount(1);
		await expect(page.getByRole('button',{name:'Submit internal credit request'})).toBeDisabled();
		await expect(page.getByRole('alert').filter({hasText:'Wallet data is temporarily unavailable'})).toHaveCount(0);
		for(const width of [320,375,390,430,1440]){
			await page.setViewportSize({width,height:900});
			await expectNoHorizontalOverflow(page);
		}
	}finally{
		if(await page.request.get('/api/auth/session').then(response=>response.ok()))await page.request.patch('/api/account/mode',{data:{accountMode:'DEMO'}});
		await adminContext.close();
	}
});

test('DEMO trading supports cash-backed buy and owned-unit sell execution',async({browser,page})=>{
	const demoUser=await createIsolatedDemoUser('market-order');
	await loginAs(page,demoUser.email,demoUser.password);
	await selectAccountMode(page,'DEMO');
	const symbol=fixture('INSTRUMENT_B');
	await page.goto('/markets');
	await expect(page.getByRole('heading',{name:'Markets',exact:true})).toBeVisible();
	await expect(page.getByText(/Proveedor no disponible|Se muestra el último precio recibido|Provider quote timestamp is older than five minutes/i)).toHaveCount(0);
	const marketPageUrl=page.url();
	const tradePage=await page.context().newPage();
	try{
		await tradePage.goto('/trade');
		const instrument=tradePage.getByRole('button',{name:new RegExp(symbol.replace('/','\\/'))});
		await expect(instrument).toBeVisible();
		await instrument.click();
		await expect(tradePage.locator('.recharts-surface').first()).toBeVisible();
		await expect(tradePage.getByText('Internal practice market')).toBeVisible();
		const orderResponsePromise=tradePage.waitForResponse(response=>response.url().endsWith('/api/orders')&&response.request().method()==='POST');
		await tradePage.getByRole('button',{name:'Place BUY order'}).click();
		await expect(tradePage.getByRole('status')).toContainText('Order filled.');
		const orderResponse=await orderResponsePromise;
		expect(orderResponse.ok()).toBeTruthy();
		const order=await orderResponse.json();
		expect(order.status).toBe('FILLED');
		expect(order.executions).toHaveLength(1);
		await tradePage.getByRole('button',{name:'Sell',exact:true}).click();
		const sellResponsePromise=tradePage.waitForResponse(response=>response.url().endsWith('/api/orders')&&response.request().method()==='POST');
		await tradePage.getByRole('button',{name:'Place SELL order'}).click();
		await expect(tradePage.getByRole('status')).toContainText('Order filled.');
		const sellResponse=await sellResponsePromise;
		expect(sellResponse.ok()).toBeTruthy();
		expect((await sellResponse.json()).status).toBe('FILLED');
		const openPositions=await tradePage.request.get('/api/positions');
		expect(await openPositions.json()).toHaveLength(0);
		const freshMarkets=await tradePage.request.get('/api/market').then(response=>response.json());
		const freshInstrument=freshMarkets.find((item:{symbol:string})=>item.symbol===symbol);
		const oversell=await tradePage.request.post('/api/orders',{headers:{'Idempotency-Key':randomUUID()},data:{instrumentId:freshInstrument.id,side:'SELL',type:'MARKET',quantity:1,expectedPrice:Number(freshInstrument.price),observedAt:freshInstrument.lastUpdatedAt}});
		expect(oversell.status()).toBe(409);
		expect((await oversell.json()).error).toContain('sell quantity exceeds your available DEMO position');
		const privateActivity=await tradePage.request.get('/api/market/activity').then(response=>response.json());
		expect(privateActivity.source).toBe('DEMO simulated execution records');
		expect(privateActivity.activity.filter((event:{instrument:string;accountMode:string})=>event.instrument===symbol&&event.accountMode==='DEMO')).toHaveLength(2);
		const unrelatedUser=await createIsolatedDemoUser('unrelated-activity');
		const unrelatedContext=await browser.newContext();
		try{
			const unrelatedPage=await unrelatedContext.newPage();
			await loginAs(unrelatedPage,unrelatedUser.email,unrelatedUser.password);
			const unrelatedActivity=await unrelatedPage.request.get('/api/market/activity').then(response=>response.json());
			expect(unrelatedActivity.activity).toHaveLength(0);
		}finally{await unrelatedContext.close();}
		expect(page.url()).toBe(marketPageUrl);
		await selectAccountMode(page,'REAL');
		await expect.poll(async()=>{
			const response=await tradePage.request.get('/api/market/activity');
			return (await response.json()).activity;
		}).toHaveLength(0);
		await selectAccountMode(page,'DEMO');
		await expectNoHorizontalOverflow(page);
	}finally{if(!tradePage.isClosed())await tradePage.close();}
});

test('dashboard presents the current account portfolio hub',async({page})=>{
	const demoUser=await createIsolatedDemoUser('dashboard-hub');
	await loginAs(page,demoUser.email,demoUser.password);
	await selectAccountMode(page,'DEMO');
	await page.goto('/dashboard');
	await expect(page.getByRole('heading',{name:'My Portfolio'})).toBeVisible();
	await expect(page.getByRole('heading',{name:'Market watch'})).toBeVisible();
	await expect(page.getByRole('heading',{name:'Positions'})).toBeVisible();
	await expect(page.getByRole('heading',{name:'Open orders'})).toBeVisible();
	await expect(page.getByRole('link',{name:/Deposit/})).toHaveCount(0);
	await expect(page.getByRole('link',{name:'Order history'})).toHaveAttribute('href','/orders');
	await expect(page.getByRole('button',{name:'1D'})).toBeVisible();
	await expect(page.getByRole('button',{name:'ALL',exact:true})).toBeVisible();
});

test('closing a DEMO position records a sell execution, reconciles portfolio, and notifies',async({page})=>{
	const demoUser=await createIsolatedDemoUser('position-close');
	await loginAs(page,demoUser.email,demoUser.password);
	await selectAccountMode(page,'DEMO');
	const initialWallet=await page.request.get('/api/wallet').then(response=>response.json());
	expect(Number(initialWallet.balance)).toBeGreaterThan(0);
	const instruments=await page.request.get('/api/market').then(response=>response.json());
	const instrument=instruments.find((item:{symbol:string})=>item.symbol===fixture('INSTRUMENT_A'));
	expect(instrument).toBeTruthy();
	const buy=await page.request.post('/api/orders',{headers:{'Idempotency-Key':randomUUID()},data:{instrumentId:instrument.id,side:'BUY',type:'MARKET',quantity:1,expectedPrice:Number(instrument.price),observedAt:instrument.lastUpdatedAt}});
	expect(buy.ok()).toBeTruthy();
	expect((await buy.json()).status).toBe('FILLED');
	const afterBuyWallet=await page.request.get('/api/wallet').then(response=>response.json());
	expect(Number(afterBuyWallet.balance)).toBeLessThan(Number(initialWallet.balance));
	const positions=await page.request.get('/api/positions').then(response=>response.json());
	expect(positions).toHaveLength(1);
	const openPortfolio=await page.request.get('/api/portfolio').then(response=>response.json());
	expect(Number(openPortfolio.totalValue)).toBeCloseTo(Number(openPortfolio.cashBalance)+Number(openPortfolio.positionValue),2);

	const close=await page.request.post('/api/positions',{data:{positionId:positions[0].id}});
	expect(close.ok()).toBeTruthy();
	expect((await page.request.get('/api/positions').then(response=>response.json()))).toHaveLength(0);
	const orders=await page.request.get('/api/orders').then(response=>response.json());
	const closeOrder=orders.find((order:{side:string;instrumentId:string;status:string})=>order.side==='SELL'&&order.instrumentId===instrument.id&&order.status==='FILLED');
	expect(closeOrder).toBeTruthy();
	expect(closeOrder.executions).toHaveLength(1);
	const closedPortfolio=await page.request.get('/api/portfolio').then(response=>response.json());
	expect(Number(closedPortfolio.positionValue)).toBe(0);
	expect(closedPortfolio.realizedPnl).not.toBeNull();
	const notificationResponse=await page.request.get('/api/notifications?limit=100').then(response=>response.json());
	expect(notificationResponse.notifications.some((item:{title:string;relatedId:string|null})=>item.relatedId===closeOrder.id&&item.title==='DEMO position closed')).toBe(true);
});

test('DEMO currency conversion is disabled and leaves DEMO and REAL ledgers unchanged',async({page})=>{
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await selectAccountMode(page,'REAL');
	const realCashBefore=Number((await page.request.get('/api/wallet').then(response=>response.json())).balance);
	await selectAccountMode(page,'DEMO');
	const initial=await page.request.get('/api/wallet').then(response=>response.json());
	const userId=await page.request.get('/api/profile').then(response=>response.json().then(profile=>profile.id));
	const cashBefore=Number(initial.balance);
	const attemptStartedAt=new Date();
	const conversion=await page.request.post('/api/wallet/convert-bitcoin',{headers:{'Idempotency-Key':randomUUID()},data:{direction:'BUY',amount:'100.00'}});
	expect(conversion.status()).toBe(403);
	const afterDemoAttempt=await page.request.get('/api/wallet').then(response=>response.json());
	expect(Number(afterDemoAttempt.balance)).toBe(cashBefore);
	expect(afterDemoAttempt.balances.map((item:{currency:string})=>item.currency)).toEqual(['USD']);
	const conversions=await db.ledgerTransaction.findMany({where:{reference:{startsWith:`DEMO:BTC:CONVERSION:${userId}:`},createdAt:{gte:attemptStartedAt}}});
	expect(conversions).toHaveLength(0);
	await selectAccountMode(page,'REAL');
	const realAttempt=await page.request.post('/api/wallet/convert-bitcoin',{headers:{'Idempotency-Key':randomUUID()},data:{direction:'BUY',amount:'100.00'}});
	expect(realAttempt.status()).toBe(409);
	expect(Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(realCashBefore);
});

test('administrative balance adjustments require authorization and confirmation data, and are idempotent',async({browser,page})=>{
	await loginAs(page,fixture('INVESTOR_EMAIL'),fixture('INVESTOR_PASSWORD'));
	await selectAccountMode(page,'DEMO');
	const userId=await page.request.get('/api/profile').then(response=>response.json().then(profile=>profile.id));
	const initialDemo=await page.request.get('/api/wallet').then(response=>response.json());
	const beforeDemo=Number(initialDemo.balance);
	const unauthorized=await page.request.post('/api/admin/balances',{data:{userId,accountMode:'DEMO',currency:'USD',amount:'25.00',direction:'CREDIT',category:'ADMIN_ALLOCATION',reason:'Approved training allocation',idempotencyKey:randomUUID()}});
	expect(unauthorized.status()).toBe(403);
	const adminContext=await browser.newContext();
	try{
		const adminPage=await adminContext.newPage();
		await loginAs(adminPage,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
		const search=await adminPage.request.get(`/api/admin/users?search=${encodeURIComponent(fixture('INVESTOR_EMAIL'))}`);
		expect(search.ok()).toBeTruthy();
		expect((await search.json()).some((user:{id:string})=>user.id===userId)).toBe(true);
		const key=randomUUID();
		const payload={userId,accountMode:'DEMO',currency:'USD',amount:'25.00',direction:'CREDIT',category:'ADMIN_ALLOCATION',reason:'Approved training allocation',idempotencyKey:key};
		const credited=await adminPage.request.post('/api/admin/balances',{data:payload});
		expect(credited.status()).toBe(201);
		const first=await credited.json();
		expect(first).toMatchObject({replayed:false,previousBalance:String(beforeDemo),newBalance:String(beforeDemo+25)});
		expect(Number.isNaN(Date.parse(first.createdAt))).toBe(false);
		const replay=await adminPage.request.post('/api/admin/balances',{data:payload});
		expect(replay.status()).toBe(200);
		expect((await replay.json()).reference).toBe(first.reference);
		const reused=await adminPage.request.post('/api/admin/balances',{data:{...payload,amount:'26.00'}});
		expect(reused.status()).toBe(409);
		const debit=await adminPage.request.post('/api/admin/balances',{data:{...payload,idempotencyKey:randomUUID(),direction:'DEBIT',category:'CORRECTION',amount:'5.00',reason:'Correct duplicate training allocation'}});
		expect(debit.status()).toBe(201);
		const debitResult=await debit.json();
		const insufficient=await adminPage.request.post('/api/admin/balances',{data:{...payload,idempotencyKey:randomUUID(),direction:'DEBIT',amount:'99999999.00',reason:'Rejected excessive debit'}});
		expect(insufficient.status()).toBe(409);
		const audit=await db.auditLog.findMany({where:{entity:'LEDGER_TRANSACTION',entityId:{in:[first.transactionId,debitResult.transactionId]}}});
		expect(audit).toHaveLength(2);
		const notifications=await page.request.get('/api/notifications?limit=100').then(response=>response.json());
		expect(notifications.notifications.some((item:{message:string})=>item.message.includes(first.reference)&&item.message.includes('25.00 USD'))).toBe(true);
		await expect.poll(async()=>Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(beforeDemo+20);

		const receiptUser=await createIsolatedDemoUser('admin-fund-receipt');
		await adminPage.goto('/admin/users');
		await adminPage.locator('.admin-users-page').getByPlaceholder('Search accounts').fill(receiptUser.email);
		const receiptUserCard=adminPage.locator('article').filter({hasText:receiptUser.email}).first();
		await expect(receiptUserCard).toBeVisible();
		await receiptUserCard.getByText('Account controls, verification, and ledger').click();
		await receiptUserCard.getByLabel('Amount',{exact:true}).fill('5.25');
		await receiptUserCard.getByLabel('Reason',{exact:true}).fill('E2E printable admin funding receipt');
		await receiptUserCard.getByRole('button',{name:'Record ledger adjustment'}).click();
		await expect(receiptUserCard.getByRole('heading',{name:'Direct funding receipt'})).toBeVisible();
		await expect(receiptUserCard.getByText('OFFICIAL RECEIPT')).toBeVisible();
		await expect(receiptUserCard.getByText('DEMO · VIRTUAL ACCOUNT RECORD')).toBeVisible();
		const receiptDownload=adminPage.waitForEvent('download');
		await receiptUserCard.getByRole('button',{name:'Download PDF'}).click();
		expect((await receiptDownload).suggestedFilename()).toContain('credit-completed');
	}
	finally{await adminContext.close();}
});

test('DEMO blocks investment allocations while REAL investment lifecycle remains available',async({browser,page})=>{
	const adminContext=await browser.newContext();
	const adminPage=await adminContext.newPage();
	const priorBitcoinAddress=await db.systemSetting.findUnique({where:{key:SIMULATED_BTC_ADDRESS_SETTING},select:{value:true}});
	try{
		await loginAs(adminPage,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
		const clearedBitcoinAddress=await adminPage.request.put('/api/admin/settings',{data:{key:SIMULATED_BTC_ADDRESS_SETTING,value:''}});
		expect(clearedBitcoinAddress.status()).toBe(200);
		const opportunityResponse=await adminPage.request.post('/api/admin/investments',{data:{title:'E2E simulated opportunity',category:'Test allocation',description:'Disposable investment terms for isolated Playwright coverage.',assetSymbol:null,minimumAmount:100,maximumAmount:10000,targetReturnPercent:8,durationDays:30,startsAt:null,maturesAt:null,riskLevel:'MODERATE',status:'AVAILABLE',demoEligible:true,realEligible:true,requiresApproval:true,targetPrice:null,stopPrice:null}});
		expect(opportunityResponse.status()).toBe(201);
		const opportunity=await opportunityResponse.json();

		await loginAs(page,fixture('INVESTOR_EMAIL'),fixture('INVESTOR_PASSWORD'));
		await selectAccountMode(page,'DEMO');
		const initialDemoWallet=await page.request.get('/api/wallet').then(response=>response.json());
		const initialDemoBalance=Number(initialDemoWallet.balance);
		const blockedDemoRequest=await page.request.post('/api/investments',{headers:{'Idempotency-Key':randomUUID()},data:{opportunityId:opportunity.id,amount:1000}});
		expect(blockedDemoRequest.status()).toBe(403);
		let userInvestments=await page.request.get('/api/investments').then(response=>response.json());
		expect(userInvestments).toMatchObject({accountMode:'DEMO',opportunities:[],requests:[]});
		expect(Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(initialDemoBalance);
		await page.goto('/investments');
		await expect(page.getByLabel('Amount (USD)')).toHaveCount(0);

		const unrelatedContext=await browser.newContext();
		try{
			const unrelatedPage=await unrelatedContext.newPage();
			await loginAs(unrelatedPage,fixture('LEGACY_USER_EMAIL'),fixture('LEGACY_USER_PASSWORD'));
			const isolated=await unrelatedPage.request.get('/api/investments').then(response=>response.json());
			expect(isolated.requests).toHaveLength(0);
			expect((await unrelatedPage.request.get('/api/admin/investments')).status()).toBe(403);
		}finally{await unrelatedContext.close();}

		async function review(requestId:string,action:string,extra:Record<string,unknown>={}){
			const response=await adminPage.request.patch('/api/admin/investments',{data:{requestId,action,...extra}});
			const result=await response.json();
			expect(response.ok(),`${action}: ${result.error||response.status()}`).toBeTruthy();
			return result;
		}

		await selectAccountMode(page,'REAL');
		const initialRealBalance=Number((await page.request.get('/api/wallet').then(response=>response.json())).balance);
		const investorId=await page.request.get('/api/profile').then(response=>response.json().then(profile=>profile.id));
		const realAllocation=await adminPage.request.post('/api/admin/balances',{data:{userId:investorId,accountMode:'REAL',currency:'USD',amount:'1000.00',direction:'CREDIT',category:'ADMIN_ALLOCATION',reason:'Simulated REAL-mode investment and trading test allocation',idempotencyKey:randomUUID()}});
		expect(realAllocation.status()).toBe(201);
		const realWalletAfterAllocation=await page.request.get('/api/wallet').then(response=>response.json());
		expect(realWalletAfterAllocation.adminLedgerReceipts).toContainEqual(expect.objectContaining({reference:(await realAllocation.json()).reference,type:'CREDIT',currency:'USD',amount:'1000'}));
			const unavailableMethods=await page.request.get('/api/payment-methods').then(response=>response.json());
				expect(unavailableMethods).toMatchObject({methods:[],fundingStatus:'AVAILABLE',simulationAvailable:true,realFundingAvailable:true,realWithdrawalAvailable:true,manualDepositReviewAvailable:true,internalLedgerOnly:true});
			const existingFunding=await page.request.get('/api/wallet').then(response=>response.json());
			const blockedFunding=await page.request.post('/api/wallet',depositPostOptions(randomUUID(),{type:'DEPOSIT',paymentMethodId:'not-configured',amount:10,currency:'USD',transactionReference:`E2E-${randomUUID()}`}));
			expect(blockedFunding.status()).toBe(400);
			expect((await blockedFunding.json()).error).toContain('External payment methods are disabled');
			expect(await page.request.get('/api/wallet').then(async response=>(await response.json()).transactions.length)).toBe(existingFunding.transactions.length);
			const nonUsdDeposit=await page.request.post('/api/wallet',{headers:{'Idempotency-Key':randomUUID()},data:{type:'DEPOSIT',amount:0.001,currency:'BTC'}});
			expect(nonUsdDeposit.status()).toBe(400);
			expect((await nonUsdDeposit.json()).error).toContain('USD');
			await page.goto('/wallet');
			await page.getByRole('link',{name:'Deposit'}).click();
			await expect(page.getByText(/internal REAL ledger credit request/i)).toBeVisible();
			await expect(page.getByLabel('Amount',{exact:true})).toBeVisible();
			await expect(page.getByLabel('Request reference (optional)')).toBeVisible();
			await expect(page.getByLabel('BTC address')).toHaveCount(0);
			await expect(page.getByLabel('Optional supporting attachment')).toBeVisible();
		await page.goto('/investments');
		await expect(page.getByText(/REAL investment activity uses internal records/i)).toBeVisible();
		const realRequestResponse=await page.request.post('/api/investments',{headers:{'Idempotency-Key':randomUUID()},data:{opportunityId:opportunity.id,amount:500}});
		expect(realRequestResponse.status()).toBe(201);
		const realRequest=await realRequestResponse.json();
		expect(realRequest.status).toBe('PENDING_APPROVAL');
		expect(Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBeCloseTo(initialRealBalance+500,2);
		await review(realRequest.id,'approve');
		await review(realRequest.id,'activate');
		await review(realRequest.id,'complete');
		await review(realRequest.id,'settle',{simulatedPayout:55000});
		userInvestments=await page.request.get('/api/investments').then(response=>response.json());
		const settledRealRequest=userInvestments.requests.find((item:{id:string})=>item.id===realRequest.id);
		expect(settledRealRequest).toMatchObject({status:'SETTLED',settlementReference:`SIMULATED-SETTLEMENT:REAL:${realRequest.id}`,simulatedPayout:'540'});
		expect(Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBeCloseTo(initialRealBalance+1040,2);
		const tradeableInstrument=(await page.request.get('/api/market').then(response=>response.json())).find((item:{price:number})=>Number(item.price)<500);
		expect(tradeableInstrument,'market should include enabled instruments').toBeTruthy();
		const positionsBeforePaperOrder=await page.request.get('/api/positions').then(response=>response.json());
		const realOrder=await page.request.post('/api/orders',{headers:{'Idempotency-Key':randomUUID()},data:{instrumentId:tradeableInstrument.id,side:'BUY',type:'MARKET',quantity:1,expectedPrice:Number(tradeableInstrument.price),observedAt:tradeableInstrument.lastUpdatedAt||tradeableInstrument.updatedAt}});
		expect([403,503]).toContain(realOrder.status());
		expect((await realOrder.json()).error).toMatch(/Alpaca Paper/);
		expect(await page.request.get('/api/positions').then(response=>response.json())).toHaveLength(positionsBeforePaperOrder.length);
		const realPortfolio=await page.request.get('/api/portfolio').then(response=>response.json());
		expect(realPortfolio.positions.length).toBe(positionsBeforePaperOrder.length);
		expect(['LEDGER_ONLY','PROVIDER_UNAVAILABLE']).toContain(realPortfolio.marketDataMode);
		const finalRealBalance=Number((await page.request.get('/api/wallet').then(response=>response.json())).balance);
		expect(finalRealBalance).toBeCloseTo(initialRealBalance+1040,2);

		await selectAccountMode(page,'DEMO');
			await expect.poll(async()=>Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(initialDemoBalance);
			await logout(page);
		await loginAs(page,fixture('INVESTOR_EMAIL'),fixture('INVESTOR_PASSWORD'));
		const persistedDemoWallet=await page.request.get('/api/wallet').then(response=>response.json());
		expect(Number(persistedDemoWallet.balance)).toBe(initialDemoBalance);
		await page.goto('/portfolio');
		await page.getByRole('button',{name:'Reset Demo Account'}).click();
		await page.getByLabel('Type RESET DEMO ACCOUNT to confirm').fill('RESET DEMO ACCOUNT');
		await page.getByRole('button',{name:'Confirm DEMO reset'}).click();
		await expect(page.getByText(/DEMO portfolio reset to \$5,000\.00/)).toBeVisible();
		expect(Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(5000);
		await selectAccountMode(page,'REAL');
			await expect.poll(async()=>Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(finalRealBalance);
		await expectNoHorizontalOverflow(page);
	}finally{
		if(adminPage.isClosed()===false){
			await adminPage.request.put('/api/admin/settings',{data:{key:SIMULATED_BTC_ADDRESS_SETTING,value:priorBitcoinAddress?.value||''}}).catch(()=>undefined);
		}
		await adminContext.close();
	}
});

test('admin investment initiation reserves once, honors withdrawal reservations, and activates on schedule',async({browser,page})=>{
	const adminContext=await browser.newContext();
	try{
		const adminPage=await adminContext.newPage();
		await loginAs(adminPage,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
		await loginAs(page,fixture('INVESTOR_EMAIL'),fixture('INVESTOR_PASSWORD'));
		await selectAccountMode(page,'DEMO');
		const userId=await page.request.get('/api/profile').then(response=>response.json().then(profile=>profile.id));
		const initialBalance=Number((await page.request.get('/api/wallet').then(response=>response.json())).balance);
		const opportunityResponse=await adminPage.request.post('/api/admin/investments',{data:{title:'E2E admin allocation',category:'Scheduled test',description:'Administrator-initiated simulated investment for ledger reconciliation.',assetSymbol:null,minimumAmount:100,maximumAmount:100000,targetReturnPercent:8,durationDays:30,startsAt:null,maturesAt:null,riskLevel:'MODERATE',status:'AVAILABLE',demoEligible:true,realEligible:true,requiresApproval:true,targetPrice:null,stopPrice:null}});
		expect(opportunityResponse.status()).toBe(201);
		const opportunity=await opportunityResponse.json();
		const startsAt=new Date(Date.now()+3_600_000);
		const maturesAt=new Date(startsAt.getTime()+30*86_400_000);
		const idempotencyKey=randomUUID();
		const payload={action:'initiate',userId,opportunityId:opportunity.id,accountMode:'DEMO',amount:500,targetReturnPercent:null,startsAt:startsAt.toISOString(),maturesAt:maturesAt.toISOString()};
		const initiated=await adminPage.request.post('/api/admin/investments',{headers:{'Idempotency-Key':idempotencyKey},data:payload});
		expect(initiated.status()).toBe(201);
		const investment=await initiated.json();
		expect(investment).toMatchObject({userId,opportunityId:opportunity.id,status:'APPROVED',amount:'500',targetReturnPercent:'8'});
		expect(Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(initialBalance-500);
		const secondOpportunityResponse=await adminPage.request.post('/api/admin/investments',{data:{title:'E2E second allocation',category:'Scheduled test',description:'A second independent opportunity for concurrent allocation coverage.',assetSymbol:null,minimumAmount:100,maximumAmount:100000,targetReturnPercent:null,durationDays:30,startsAt:null,maturesAt:null,riskLevel:'LOW',status:'AVAILABLE',demoEligible:true,realEligible:false,requiresApproval:true,targetPrice:null,stopPrice:null}});
		expect(secondOpportunityResponse.status()).toBe(201);
		const secondOpportunity=await secondOpportunityResponse.json();
		const secondRequestResponse=await adminPage.request.post('/api/admin/investments',{headers:{'Idempotency-Key':randomUUID()},data:{...payload,opportunityId:secondOpportunity.id,amount:250,targetReturnPercent:null}});
		expect(secondRequestResponse.status()).toBe(201);
		const secondRequest=await secondRequestResponse.json();
		const simultaneousRequests=await db.investmentRequest.findMany({where:{userId},select:{id:true}});
		expect(simultaneousRequests.map(item=>item.id)).toEqual(expect.arrayContaining([investment.id,secondRequest.id]));
		expect(Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(initialBalance-750);
		const reserveReference=`INVESTMENT:${investment.id}:RESERVE`;
		expect(await db.ledgerTransaction.count({where:{reference:reserveReference}})).toBe(1);
		const replay=await adminPage.request.post('/api/admin/investments',{headers:{'Idempotency-Key':idempotencyKey},data:payload});
		expect(replay.status()).toBe(200);
		expect((await replay.json()).id).toBe(investment.id);
		expect(await db.ledgerTransaction.count({where:{reference:reserveReference}})).toBe(1);
		const mismatchedReplay=await adminPage.request.post('/api/admin/investments',{headers:{'Idempotency-Key':idempotencyKey},data:{...payload,amount:501}});
		expect(mismatchedReplay.status()).toBe(409);

		await db.fundingRequest.create({data:{userId,type:FundingType.WITHDRAWAL,method:'E2E reserved withdrawal',amount:9000,currency:'USD',accountMode:'DEMO',status:FundingStatus.PENDING_REVIEW,idempotencyKey:`e2e:${randomUUID()}`}});
		const blocked=await adminPage.request.post('/api/admin/investments',{headers:{'Idempotency-Key':randomUUID()},data:{...payload,amount:91000}});
		expect(blocked.status()).toBe(400);
		expect((await blocked.json()).error).toBe('insufficient simulated balance');
		expect(await db.investmentRequest.count({where:{userId,opportunityId:opportunity.id}})).toBe(1);
		expect(Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(initialBalance-750);

		await settleMaturedSimulatedInvestments(new Date(startsAt.getTime()+1000));
		expect((await db.investmentRequest.findUniqueOrThrow({where:{id:investment.id}})).status).toBe('ACTIVE');
		expect(Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(initialBalance-750);
		const activationNotification=await db.notification.findFirst({where:{userId,relatedEntity:'INVESTMENT',relatedId:investment.id,title:'DEMO investment started'},select:{accountMode:true}});
		expect(activationNotification).toMatchObject({accountMode:'DEMO'});
	}finally{await adminContext.close();}
});

test('Nova escalation reaches admin and admin response appears with notification',async({page})=>{
	const subject=`E2E support ${randomUUID().slice(0,8)}`;
	const reply='Temporary Playwright admin response.';
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await page.goto('/support');
	await expect(page.getByRole('heading',{name:'Nova AI',exact:true})).toBeVisible();
	const wallet=await page.request.get('/api/wallet').then(response=>response.json());
	const novaResponse=await page.request.post('/api/support/nova',{data:{question:'What is my wallet balance?',conversationId:randomUUID()}});
	expect(novaResponse.status()).toBe(200);
	expect((await novaResponse.json()).answer).toContain(String(wallet.balance));
	const portfolioReply=await page.request.post('/api/support/nova',{data:{question:'What are my positions and order history?',conversationId:randomUUID(),userId:'another-user-id'}});
	expect(portfolioReply.status()).toBe(200);
	expect((await portfolioReply.json()).answer).toContain('DEMO account');
	expect((await portfolioReply.json()).answer).toContain('order history contains');
	const watchlistReply=await page.request.post('/api/support/nova',{data:{question:'What is my watchlist?',conversationId:randomUUID()}});
	expect((await watchlistReply.json()).answer).toContain('cannot read a saved watchlist from the server');
	const notificationReply=await page.request.post('/api/support/nova',{data:{question:'How many unread notifications do I have?',conversationId:randomUUID()}});
	expect((await notificationReply.json()).answer).toMatch(/\d+ unread notification/);
	const investmentReply=await page.request.post('/api/support/nova',{data:{question:'What are my investment requests and available plans?',conversationId:randomUUID()}});
	expect(investmentReply.status()).toBe(200);
	expect((await investmentReply.json()).answer).toContain('Investment allocations are not available in DEMO mode');
	const paymentReply=await page.request.post('/api/support/nova',{data:{question:'How do I make a deposit?',conversationId:randomUUID()}});
	expect((await paymentReply.json()).answer).toContain('DEMO');
	expect((await paymentReply.json()).answer).toContain('DEMO funds are virtual and remain separate from REAL account balances.');
	const supportContact=await page.request.get('/api/support/contact').then(response=>response.json());
	if(supportContact.email)await expect(page.getByRole('link',{name:new RegExp(supportContact.email.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'))})).toBeVisible();
	else await expect(page.getByText('Direct email is not configured. Authenticated support tickets remain available.')).toBeVisible();
	await page.getByRole('button',{name:'Contact Admin'}).click();
	await page.getByLabel('Category').selectOption('FUNDING');
	await page.getByLabel('Subject').fill(subject);
	await page.getByRole('textbox',{name:'Message',exact:true}).fill('Please review this disposable browser test ticket.');
	await page.getByRole('button',{name:'Create support ticket'}).click();
	await expect(page.getByRole('status')).toContainText(/created\./i);
	await logout(page);
	await expect(page).toHaveURL(/\/login/);
	await loginAs(page,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
	await page.goto('/admin/support');
	await page.getByRole('button',{name:new RegExp(subject)}).click();
	const priority=page.locator('.admin-support-ticket-controls select').nth(1);
	await priority.selectOption('HIGH');
	await expect(priority).toHaveValue('HIGH');
	await page.getByLabel('Admin response').fill(reply);
	await page.getByRole('button',{name:'Send response'}).click();
	await expect(page.getByRole('status')).toContainText('Response sent to the user');
	await logout(page);
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await page.goto('/notifications');
	const replyNotification=page.locator('.notification-history-item').filter({hasText:subject});
	await expect(replyNotification.getByText('Admin replied to your support ticket',{exact:true})).toBeVisible();
	await page.goto('/support');
	const ticket=page.getByRole('button').filter({hasText:subject});
	await ticket.click();
	await expect(page.getByText(reply)).toBeVisible();
	const conversationId=await page.request.get('/api/support').then(async response=>{
		expect(response.ok()).toBe(true);
		const tickets=await response.json();
		return tickets.find((item:{subject:string})=>item.subject===subject).id as string;
	});
	await logout(page);
	await loginAs(page,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
	const closed=await page.request.patch('/api/admin/support',{data:{action:'status',conversationId,status:'CLOSED'}});
	expect(closed.ok()).toBe(true);
	await logout(page);
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await page.goto('/support');
	await page.getByRole('button').filter({hasText:subject}).click();
	await expect(page.getByText(/CLOSED/)).toBeVisible();
	await expect(page.getByRole('textbox',{name:'Reply to support ticket'})).toHaveCount(0);
	const replyToClosed=await page.request.post('/api/support',{data:{action:'reply',conversationId,message:'Reply to a closed ticket.'}});
	expect(replyToClosed.status()).toBe(409);
});

test('profile completion and administrator identity review progress the account through all tiers',async({browser,page})=>{
	const user=await createIsolatedDemoUser('tier-progression');
	await db.user.update({where:{email:user.email},data:{requiresRegistrationVerification:false}});
	await loginAs(page,user.email,user.password);
	const profileUpdate=await page.request.patch('/api/profile',{data:{name:'Profile Complete User',country:'United States',phone:'+14155552671'}});
	expect(profileUpdate.ok()).toBe(true);
	const forgedTier=await page.request.patch('/api/profile',{data:{name:'Profile Complete User',approvedTier:3}});
	expect(forgedTier.ok()).toBe(true);
	expect((await forgedTier.json()).label).toBe('TIER 2');
	await page.goto('/dashboard');
	await expect(page.locator('.user-dashboard-profile-line').getByLabel('Current account tier: TIER 2')).toBeVisible();
	await page.setViewportSize({width:320,height:800});
	await page.goto('/tier');
	await expect(page.getByRole('heading',{name:'Account tiers'})).toBeVisible();
	await expect(page.getByRole('region',{name:'Current tier progress'})).toContainText('TIER 2');
	await expect(page.locator('.tier-step.is-current')).toContainText('Current');
	await expectNoHorizontalOverflow(page);
	const state=await page.request.get('/api/tier-requests').then(response=>response.json());
	expect(state.currentTier).toBe(2);
	expect(state.permissions.tierBenefits).toBe(true);
	expect(state.permissions.realMoneyServices).toBe(false);
	const demoRequest=await page.request.post('/api/tier-requests',{data:{message:'Should not be accepted in DEMO mode.'}});
	expect(demoRequest.status()).toBe(403);
	await page.setViewportSize({width:1280,height:900});
	await page.goto('/dashboard');
	await selectAccountMode(page,'REAL');
	const blockedRequest=await page.request.post('/api/tier-requests',{data:{message:'KYC is not submitted for this isolated profile.'}});
	expect(blockedRequest.status()).toBe(409);
	const denied=await page.request.patch('/api/admin/tier-requests',{data:{id:'not-a-real-request',status:'APPROVED',reason:'Should be denied for a user.'}});
	expect(denied.status()).toBe(403);

	const isolated=await db.user.findUniqueOrThrow({where:{email:user.email},select:{id:true}});
	const submittedAt=new Date();
	await db.$transaction(async tx=>{
		await tx.user.update({where:{id:isolated.id},data:{phoneVerified:true,phoneVerifiedAt:submittedAt,kycStatus:'APPROVED',verifiedAt:submittedAt}});
		await tx.kycProfile.create({data:{userId:isolated.id,legalName:'Profile Complete User',dob:new Date('1990-01-01'),address:'Test address',idType:'PASSPORT',idNumber:'E2E-IDENTITY',submittedAt,reviewedAt:submittedAt}});
		await tx.kycDocument.create({data:{userId:isolated.id,kind:'IDENTITY_DOCUMENT',filename:'tier-review-test.jpg',storageKey:`e2e/tier-review/${randomUUID()}.jpg`,mimeType:'image/jpeg',size:1024,status:'APPROVED',reviewedAt:submittedAt}});
	});
	const submittedRequest=await page.request.post('/api/tier-requests',{data:{message:'Isolated tier progression review.'}});
	expect(submittedRequest.status()).toBe(201);
	const requestRecord=await submittedRequest.json();

	const adminContext=await browser.newContext();
	const adminPage=await adminContext.newPage();
	await loginAs(adminPage,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
	const informationNeeded=await adminPage.request.patch('/api/admin/tier-requests',{data:{id:requestRecord.id,status:'NEEDS_INFORMATION',reason:'Please confirm the identity record.'}});
	expect(informationNeeded.ok()).toBe(true);
	const userReply=await page.request.patch('/api/tier-requests',{data:{id:requestRecord.id,message:'The submitted identity record is accurate.'}});
	expect(userReply.ok()).toBe(true);
	const approved=await adminPage.request.patch('/api/admin/tier-requests',{data:{id:requestRecord.id,status:'APPROVED',reason:'Identity record reviewed in the isolated test.'}});
	expect(approved.ok()).toBe(true);
	await adminPage.goto('/admin/tiers');
	await expect(adminPage.getByRole('heading',{name:'Tier management'})).toBeVisible();
	const directory=await adminPage.request.get(`/api/admin/tier-requests?search=${encodeURIComponent(user.email)}`);
	expect(directory.ok()).toBe(true);
	const directoryData=await directory.json();
	expect(directoryData.accounts).toEqual(expect.arrayContaining([expect.objectContaining({email:user.email,currentTier:3})]));
	await adminContext.close();
	const updated=await page.request.get('/api/tier-requests').then(response=>response.json());
	expect(updated.currentTier).toBe(3);
	await page.setViewportSize({width:320,height:800});
	await page.goto('/tier');
	await expect(page.locator('.tier-step.is-current')).toContainText('Current');
	await expectNoHorizontalOverflow(page);
	const instrument=(await page.request.get('/api/market').then(response=>response.json()))[0];
	const realOrder=await page.request.post('/api/orders',{headers:{'Idempotency-Key':randomUUID()},data:{instrumentId:instrument.id,side:'BUY',type:'MARKET',quantity:1,expectedPrice:Number(instrument.price),observedAt:instrument.lastUpdatedAt||instrument.updatedAt}});
	expect(realOrder.status()).toBe(403);
});

test('administrator email sign-in persists through refresh and logout removes admin access',async({page})=>{
	await page.goto('/admin/login');
	await waitForStartup(page);
	await page.getByLabel('Admin username').fill(fixture('ADMIN_EMAIL'));
	await page.getByLabel('Admin password',{exact:true}).fill(fixture('ADMIN_PASSWORD'));
	await page.getByRole('checkbox',{name:/Replace another active Aurevia session/}).check();
	await page.getByRole('button',{name:'Enter control center'}).click();
	await page.waitForURL(/\/admin$/);
	await expect(page.getByRole('heading',{name:'CRM Dashboard'})).toBeVisible();
	await expect(page.getByRole('navigation',{name:'Administrator navigation'}).getByRole('link',{name:'CRM Dashboard'})).toBeVisible();
	await page.setViewportSize({width:390,height:844});
	await page.getByRole('banner').getByRole('button',{name:'Open admin menu'}).click();
	const adminNavigation=page.getByRole('navigation',{name:'Administrator navigation'});
	await expect(adminNavigation.getByRole('link',{name:'CRM Dashboard'})).toBeVisible();
	await expect(adminNavigation.getByRole('link',{name:'Verified accounts'})).toBeVisible();
	await expect(adminNavigation.getByRole('link',{name:'Funding'})).toBeVisible();
	expect(await page.getByRole('navigation',{name:'Primary navigation'}).count()).toBe(0);
	await page.reload();
	await expect(page.getByRole('heading',{name:'CRM Dashboard'})).toBeVisible();
	await page.setViewportSize({width:1440,height:900});
	await logout(page);
	await expect(page).toHaveURL(/\/login/);
	await page.goto('/admin');
	await expect(page).toHaveURL(/\/login/);
});

test('account navigation exposes learning, news, activity, conversion, and Nova assistant',async({page})=>{
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await page.getByRole('button',{name:'More account navigation'}).click();
	const menu=page.getByRole('dialog',{name:'More'});
	await expect(menu.getByRole('link',{name:'Investment education'})).toBeVisible();
	await expect(menu.getByRole('link',{name:'News & updates'})).toBeVisible();
	await expect(menu.getByRole('link',{name:'Account activity'})).toBeVisible();
	await expect(menu.getByRole('link',{name:'Currency conversion'})).toBeVisible();
	await menu.getByRole('link',{name:'AI Assistant'}).click();
	await expect(page).toHaveURL(/\/support#nova$/);
	await expect(page.locator('#nova')).toBeInViewport();
});

test('admin ledger adjustments update isolated DEMO and REAL accounts with audit and idempotency',async({page})=>{
	await loginAs(page,fixture('INVESTOR_EMAIL'),fixture('INVESTOR_PASSWORD'));
	await selectAccountMode(page,'DEMO');
	const userId=await page.request.get('/api/auth/session').then(async response=>(await response.json()).user.id as string);
	const before=Number((await page.request.get('/api/wallet').then(response=>response.json())).balance);
	await selectAccountMode(page,'REAL');
	const beforeRealBalance=Number((await page.request.get('/api/wallet').then(response=>response.json())).balance);
	await selectAccountMode(page,'DEMO');
	await logout(page);
	await loginAs(page,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
	const unverifiedCustomer=await db.user.findUniqueOrThrow({where:{email:fixture('USER_EMAIL')},select:{id:true,kycStatus:true}});
	expect(unverifiedCustomer.kycStatus).toBe('PENDING');
	const unverifiedRealAccount=await db.ledgerAccount.findUnique({where:{code:`USER:${unverifiedCustomer.id}:REAL:USD`},select:{id:true}});
	const unverifiedRealBalance=unverifiedRealAccount?await ledgerBalance(db,unverifiedRealAccount.id):new Prisma.Decimal(0);
	const unverifiedCredit=await page.request.post('/api/admin/balances',{data:{userId:unverifiedCustomer.id,accountMode:'REAL',currency:'USD',amount:'10.00',direction:'CREDIT',category:'PROMOTIONAL',reason:'Free simulated account allocation',idempotencyKey:randomUUID()}});
	expect(unverifiedCredit.status()).toBe(201);
	expect(Number((await unverifiedCredit.json()).newBalance)).toBeCloseTo(Number(unverifiedRealBalance)+10,2);
	expect(await db.auditLog.count({where:{action:'ADMIN_ACCOUNT_CREDIT',entity:'LEDGER_TRANSACTION',metadata:{path:['administrativeRealAllocation'],equals:true}}})).toBeGreaterThan(0);
	const creditKey=randomUUID();
	const demoCredit=await page.request.post('/api/admin/balances',{data:{userId,accountMode:'DEMO',currency:'USD',amount:'25.50',direction:'CREDIT',category:'ADMIN_ALLOCATION',reason:'Approved simulated training allocation',idempotencyKey:creditKey}});
	expect(demoCredit.status()).toBe(201);
	expect((await demoCredit.json()).newBalance).toBe(String(before+25.5));
	const duplicateDemoCredit=await page.request.post('/api/admin/balances',{data:{userId,accountMode:'DEMO',currency:'USD',amount:'25.50',direction:'CREDIT',category:'ADMIN_ALLOCATION',reason:'Approved simulated training allocation',idempotencyKey:creditKey}});
	expect(duplicateDemoCredit.status()).toBe(200);
	const realKey=randomUUID();
	const realCredit=await page.request.post('/api/admin/balances',{data:{userId,accountMode:'REAL',currency:'USD',amount:'25.50',direction:'CREDIT',category:'ADMIN_ALLOCATION',reason:'Administrator-recorded allocation pending external settlement',idempotencyKey:realKey}});
	expect(realCredit.status()).toBe(201);
	await page.goto('/admin/users');
	await page.getByRole('textbox',{name:'Search users by name, email, or account ID'}).fill(fixture('INVESTOR_EMAIL'));
	const investorAccount=page.locator('article').filter({hasText:fixture('INVESTOR_EMAIL')}).first();
	await expect(investorAccount).toBeVisible();
	await investorAccount.getByText('Account controls, verification, and ledger').click();
	const adjustmentForm=investorAccount.locator('form').first();
	await adjustmentForm.getByLabel('Account').selectOption('REAL');
	await adjustmentForm.getByLabel('Amount').fill('2500.00');
	await adjustmentForm.getByLabel('Reason').fill('Approved administrator-recorded allocation pending settlement');
	await adjustmentForm.getByRole('button',{name:'Record ledger adjustment'}).click();
	await expect(page.getByRole('status')).toContainText('Recorded credit of 2500.00 USD in REAL');
	await logout(page);
	await loginAs(page,fixture('INVESTOR_EMAIL'),fixture('INVESTOR_PASSWORD'));
	await selectAccountMode(page,'REAL');
	const realWallet=await page.request.get('/api/wallet').then(response=>response.json());
	const realBalance=Number(realWallet.balance);
	expect(realBalance).toBeCloseTo(beforeRealBalance+2525.5,2);
	const realActivity=await page.request.get('/api/activity?category=account&limit=100').then(response=>response.json());
	expect(realActivity.data.items.some((item:{sourceLabel:string;adminInitiated:boolean})=>item.sourceLabel.startsWith('ADMIN:REAL:')&&item.adminInitiated)).toBe(true);
	await selectAccountMode(page,'DEMO');
	const after=Number((await page.request.get('/api/wallet').then(response=>response.json())).balance);
	expect(after).toBeCloseTo(before+25.5,2);
});

test('a normal customer cannot access the administrator dashboard',async({page})=>{
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await page.goto('/admin');
	await expect(page).toHaveURL(/\/login/);
	expect((await page.request.get('/api/admin/verified-accounts')).status()).toBe(403);
});

test('administrator sessions stay in the isolated console and cannot use customer APIs',async({page})=>{
	await loginAs(page,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
	await page.goto('/dashboard');
	await expect(page).toHaveURL(/\/admin$/);
	await expect(page.getByRole('heading',{name:'CRM Dashboard'})).toBeVisible();
	await expect(page.getByRole('link',{name:'User portal'})).toHaveCount(0);
	expect((await page.request.get('/api/profile')).status()).toBe(403);
	await page.goto('/wallet');
	await expect(page).toHaveURL(/\/admin$/);
});

test('verified personal details remain read-only during the two-month lock window',async({page})=>{
	const user=await db.user.findUniqueOrThrow({where:{email:fixture('USER_EMAIL')},select:{id:true,name:true,kycStatus:true,verifiedAt:true}});
	const verifiedAt=new Date();
	verifiedAt.setUTCMonth(verifiedAt.getUTCMonth()-1);
	try{
		await db.user.update({where:{id:user.id},data:{kycStatus:'APPROVED',verifiedAt}});
		await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
		await selectAccountMode(page,'REAL');
		await page.goto('/settings');
		await expect(page.getByRole('status').filter({hasText:'Verified profile details are locked'})).toBeVisible();
		await expect(page.getByLabel('First name')).toBeDisabled();
		const avatarInput=page.getByLabel('Choose profile photo');
		await expect(avatarInput).toBeEnabled();
		await avatarInput.setInputFiles({name:'avatar.png',mimeType:'image/png',buffer:PNG.sync.write(new PNG({width:1,height:1}))});
		await expect(page.getByRole('button',{name:'Upload photo'})).toBeEnabled();
		await expect(page.getByRole('button',{name:'Save profile'})).toBeDisabled();
		const update=await page.request.patch('/api/profile',{data:{name:'Changed Name',country:'Test',address:'Changed address'}});
		expect(update.status()).toBe(423);
		expect((await update.json()).error).toContain('locked');
		expect((await db.user.findUniqueOrThrow({where:{id:user.id},select:{name:true}})).name).toBe(user.name);
	}finally{
		await db.user.update({where:{id:user.id},data:{kycStatus:user.kycStatus,verifiedAt:user.verifiedAt}});
	}
});

test('administrator user and KYC actions persist and report protected actions',async({page})=>{
	await loginAs(page,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
	await page.goto('/admin');
	await expect(page.getByRole('heading',{name:'CRM Dashboard'})).toBeVisible();
	const shortcuts=page.getByRole('navigation',{name:'Administrator dashboard shortcuts'});
	for(const label of ['Users','KYC verification','Funding','Investments','Orders and ledger','Settings'])await expect(shortcuts.getByRole('link',{name:label})).toBeVisible();
	const users=await page.request.get('/api/admin/users').then(response=>response.json());
	const user=users.find((item:{email:string})=>item.email===fixture('USER_EMAIL'));
	const investor=users.find((item:{email:string})=>item.email===fixture('INVESTOR_EMAIL'));
	expect(user).toBeTruthy();
	expect(investor).toBeTruthy();
	expect(users.some((item:{role:string})=>item.role==='ADMIN')).toBe(false);
	await db.user.update({where:{id:investor.id},data:{requiresRegistrationVerification:true,verifiedAt:null}});
	const selfId=await page.request.get('/api/auth/session').then(response=>response.json().then(session=>session.user.id as string));
	const selfDemotion=await page.request.patch('/api/admin/users',{data:{userId:selfId,role:'USER'}});
	expect(selfDemotion.status()).toBe(409);
	expect((await selfDemotion.json()).error).toContain('roles are managed separately');
	const frozen=await page.request.patch('/api/admin/users',{data:{userId:user.id,status:'FROZEN'}});
	expect(frozen.ok()).toBeTruthy();
	await page.goto('/admin/users');
	await expect(page.getByRole('heading',{name:'User accounts'})).toBeVisible();
	const userRow=page.locator('article').filter({hasText:fixture('USER_EMAIL')}).first();
	await expect(userRow.getByRole('button',{name:'Unfreeze'})).toBeVisible();
	await userRow.getByRole('button',{name:'Unfreeze'}).click();
	await expect(userRow.getByRole('button',{name:'Freeze'})).toBeVisible();
	await expect(userRow.getByRole('button',{name:/Make (?:admin|user)/})).toHaveCount(0);
	const userRoleChange=await page.request.patch('/api/admin/users',{data:{userId:user.id,role:'ADMIN'}});
	expect(userRoleChange.status()).toBe(409);
	expect((await page.request.get('/api/admin/users').then(response=>response.json())).find((item:{id:string})=>item.id===user.id)?.role).toBe('USER');
	const controls=userRow.getByText('Account controls, verification, and ledger');
	await controls.click();
	await userRow.getByRole('button',{name:'Disable deposits'}).click();
	await expect.poll(async()=>{const refreshed=await page.request.get('/api/admin/users').then(response=>response.json());return refreshed.find((item:{id:string})=>item.id===user.id)?.depositEnabled}).toBe(false);
	await userRow.getByRole('button',{name:'Enable deposits'}).click();
	await userRow.getByRole('button',{name:'Disable withdrawals'}).click();
	await expect.poll(async()=>{const refreshed=await page.request.get('/api/admin/users').then(response=>response.json());return refreshed.find((item:{id:string})=>item.id===user.id)?.withdrawalEnabled}).toBe(false);
	await userRow.getByRole('button',{name:'Enable withdrawals'}).click();
	await userRow.getByLabel('Restriction reason').fill('E2E account review');
	await userRow.getByRole('button',{name:'Restrict account'}).click();
	await expect.poll(async()=>{const refreshed=await page.request.get('/api/admin/users').then(response=>response.json());return refreshed.find((item:{id:string})=>item.id===user.id)?.accountRestricted}).toBe(true);
	await userRow.getByRole('button',{name:'Remove account restriction'}).click();
	const adjustmentForm=userRow.locator('form');
	await adjustmentForm.getByRole('combobox').nth(0).selectOption('DEMO');
	await adjustmentForm.getByRole('combobox').nth(1).selectOption('CREDIT');
	await adjustmentForm.getByRole('combobox').nth(2).selectOption('ADMIN_ALLOCATION');
	await adjustmentForm.getByRole('combobox').nth(3).selectOption('USD');
	await adjustmentForm.locator('input[type="number"]').fill('10');
	await adjustmentForm.locator('input[minlength="3"]').fill('E2E simulated account allocation');
	await adjustmentForm.getByRole('button',{name:'Record ledger adjustment'}).click();
	await expect(page.getByRole('status')).toContainText('Recorded credit of 10.00 USD in DEMO');
	expect(await db.ledgerTransaction.count({where:{description:{contains:'E2E simulated account allocation'}}})).toBe(1);
	await page.goto('/admin/kyc');
	const kycPanel=page.locator('#kyc-verification');
	const kycReviewRows=kycPanel.locator('div.mt-3.divide-y').locator('article');
	await expect(kycReviewRows.filter({hasText:fixture('INVESTOR_EMAIL')})).toHaveCount(0);
	await kycPanel.getByLabel('Review queue').selectOption('ALL');
	const investorRow=kycPanel.locator('article').filter({hasText:fixture('INVESTOR_EMAIL')}).first();
	await investorRow.getByRole('button',{name:'Reject',exact:true}).click();
	await expect.poll(async()=>{
		const refreshed=await page.request.get('/api/admin/users').then(response=>response.json());
		return refreshed.find((item:{id:string})=>item.id===investor.id)?.kycStatus;
	}).toBe('REJECTED');
	await investorRow.getByRole('button',{name:'Request information'}).click();
	await expect.poll(async()=>{
		const refreshed=await page.request.get('/api/admin/users').then(response=>response.json());
		return refreshed.find((item:{id:string})=>item.id===investor.id)?.kycStatus;
	}).toBe('NEEDS_CHANGES');
	await investorRow.getByRole('button',{name:'Approve'}).click();
	await expect.poll(async()=>{
		const refreshed=await page.request.get('/api/admin/users').then(response=>response.json());
		return refreshed.find((item:{id:string})=>item.id===investor.id)?.kycStatus;
	}).toBe('APPROVED');
	const approvedInvestor=await db.user.findUniqueOrThrow({where:{id:investor.id},select:{requiresRegistrationVerification:true,verifiedAt:true,emailVerifiedAt:true}});
	expect(approvedInvestor.requiresRegistrationVerification).toBe(true);
	expect(approvedInvestor.verifiedAt).toBeInstanceOf(Date);
	expect(approvedInvestor.emailVerifiedAt).toBeNull();
	const verifiedResponse=await page.request.get(`/api/admin/verified-accounts?search=${encodeURIComponent(fixture('INVESTOR_EMAIL'))}&tier=1&status=ACTIVE`);
	expect(verifiedResponse.ok()).toBe(true);
	const verifiedResults=await verifiedResponse.json();
	expect(verifiedResults.total).toBe(1);
	expect(verifiedResults.items[0]).toMatchObject({id:investor.id,email:fixture('INVESTOR_EMAIL'),kycStatus:'APPROVED',approvedTier:1,approval:{reviewedBy:{email:fixture('ADMIN_EMAIL')}}});
	await page.goto('/admin/verified-accounts');
	await expect(page.getByRole('heading',{name:'Verified Accounts'})).toBeVisible();
	await page.getByRole('textbox',{name:'Search',exact:true}).fill(fixture('INVESTOR_EMAIL'));
	await expect(page.getByText(fixture('INVESTOR_EMAIL'),{exact:true})).toBeVisible();
	await page.getByText(fixture('INVESTOR_EMAIL'),{exact:true}).click();
	await expect(page.getByText(fixture('ADMIN_EMAIL'),{exact:false})).toBeVisible();
	const softDelete=await page.request.patch('/api/admin/users',{data:{userId:user.id,status:'DELETED'}});
	expect(softDelete.ok()).toBeTruthy();
	expect((await softDelete.json()).status).toBe('DELETED');
	expect((await page.request.get('/api/admin/users').then(response=>response.json())).some((item:{id:string})=>item.id===user.id)).toBe(false);
	expect((await page.request.get('/api/admin/users?showDeleted=true').then(response=>response.json())).some((item:{id:string;status:string})=>item.id===user.id&&item.status==='DELETED')).toBe(true);
	await page.goto('/admin/users');
	await page.getByLabel('Show deleted accounts').check();
	const deletedUserRow=page.locator('article').filter({hasText:fixture('USER_EMAIL')}).first();
	await expect(deletedUserRow.getByRole('button',{name:'Restore'})).toBeVisible();
	await deletedUserRow.getByRole('button',{name:'Restore'}).click();
	await expect.poll(async()=>db.user.findUniqueOrThrow({where:{id:user.id},select:{status:true}}).then(account=>account.status)).toBe('ACTIVE');
});

test('Nova activity is redacted and visible only to administrators',async({page})=>{
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await selectAccountMode(page,'DEMO');
	const userId=await page.request.get('/api/auth/session').then(async response=>(await response.json()).user.id as string);
	const question='What is my balance? e2e-private-question-marker';
	const novaResponse=await page.request.post('/api/support/nova',{data:{question}});
	expect(novaResponse.status()).toBe(200);
	const calculation=await page.request.post('/api/support/nova',{data:{question:'calculate position size: risk $100, entry $50, stop $45, target $60, long'}});
	expect(calculation.status()).toBe(200);
	expect(await calculation.json()).toMatchObject({answer:expect.stringContaining('20 units')});
	const forbidden=await page.request.get('/api/admin/nova-activity');
	expect(forbidden.status()).toBe(403);

	const symbol=fixture('INSTRUMENT_A');
	const beforeOrders=await page.request.get('/api/orders').then(response=>response.json() as Promise<Array<{id:string}>>);
	await page.goto('/support');
	await page.getByLabel('Ask Nova AI').fill(`prepare demo order: buy 2 ${symbol}`);
	await page.getByRole('button',{name:'Send question'}).click();
	const confirmOrder=page.getByRole('button',{name:'Confirm DEMO order'});
	await expect(confirmOrder).toBeVisible();
	const previewOrders=await page.request.get('/api/orders').then(response=>response.json() as Promise<Array<{id:string}>>);
	expect(previewOrders.map(order=>order.id)).toEqual(beforeOrders.map(order=>order.id));
	await confirmOrder.click();
	await expect(page.getByText(/Your explicitly confirmed DEMO order/)).toBeVisible();
	const ordersResponse=await page.request.get('/api/orders');
	const afterOrders=await ordersResponse.json() as Array<{id:string;instrument:{symbol:string};side:string;quantity:string;status:string}>;
	const confirmation=await page.locator('.nova-message').last().innerText();
	const orderId=confirmation.match(/Order reference: ([A-Za-z0-9]+)/)?.[1];
	const confirmed=afterOrders.find(order=>order.id===orderId);
	expect(confirmed).toBeTruthy();
	expect(confirmed).toMatchObject({instrument:{symbol},side:'BUY',status:'FILLED'});
	expect(Number(confirmed?.quantity)).toBe(2);
	const unsupportedOrder=await page.request.post('/api/support/nova',{data:{question:`prepare limit order: buy 1 ${symbol} at $10`}});
	expect(unsupportedOrder.status()).toBe(200);
	expect(await unsupportedOrder.json()).toMatchObject({answer:expect.stringContaining('market-order previews only')});
	await selectAccountMode(page,'REAL');
	const realDraft=await page.request.post('/api/support/nova',{data:{question:`prepare demo order: buy 1 ${symbol}`}});
	expect(realDraft.status()).toBe(200);
	expect(await realDraft.json()).toMatchObject({answer:expect.stringContaining('REAL trading is not available through Nova')});
	await selectAccountMode(page,'DEMO');

	await logout(page);
	await loginAs(page,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
	const report=await page.request.get('/api/admin/nova-activity');
	expect(report.status()).toBe(200);
	const events=await report.json();
	const event=events.find((item:{userId:string;eventTypes:string[]})=>item.userId===userId&&item.eventTypes.includes('WALLET_BALANCE_LOOKUP'));
	expect(event).toBeTruthy();
	expect(events.some((item:{userId:string;eventTypes:string[]})=>item.userId===userId&&item.eventTypes.includes('TRADE_PLAN_CALCULATED'))).toBe(true);
	expect(events.some((item:{userId:string;eventTypes:string[]})=>item.userId===userId&&item.eventTypes.includes('DEMO_ORDER_PREPARED'))).toBe(true);
	expect(JSON.stringify(events)).not.toContain('e2e-private-question-marker');
});

for(const viewport of viewports){
	test(`admin routes render without overflow at ${viewport.width}px`,async({page})=>{
		await page.setViewportSize(viewport);
		const loginResponse=await page.goto('/admin/login');
		expect(loginResponse?.status(),'/admin/login').toBe(200);
		await expect(page.locator('h1:visible').first(),'/admin/login').toBeVisible();
		await expectNoHorizontalOverflow(page);

		await loginAs(page,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
		for(const route of adminRoutes.filter(path=>path!=='/admin/login')){
			const response=await page.goto(route);
			expect(response?.status(),route).toBe(200);
			await expect(page.locator('main').first(),route).toBeVisible();
			if(await page.locator('h1:visible').count())await expect(page.locator('h1:visible').first(),route).toBeVisible();
			if(viewport.width<=1020)await expect(page.getByRole('button',{name:'Open admin menu'}),route).toBeVisible();
			else await expect(page.getByRole('navigation',{name:'Administrator navigation'}).getByRole('link',{name:'CRM Dashboard',exact:true}),route).toBeVisible();
			await expectNoHorizontalOverflow(page);
		}
	});
}

test('DEMO order idempotency prevents duplicate fills and user history stays isolated',async({browser,page})=>{
	const demoUser=await createIsolatedDemoUser('order-idempotency');
	await loginAs(page,demoUser.email,demoUser.password);
	const startingBalance=Number((await page.request.get('/api/wallet').then(response=>response.json())).balance);
	expect(startingBalance).toBe(5000);
	const symbol=fixture('INSTRUMENT_A');
	const instruments=await page.request.get('/api/market').then(response=>response.json());
	const instrument=instruments.find((item:{symbol:string})=>item.symbol===symbol);
	expect(instrument).toBeTruthy();
	const key=randomUUID();
	const payload={instrumentId:instrument.id,side:'BUY',type:'MARKET',quantity:1,expectedPrice:Number(instrument.price),observedAt:instrument.lastUpdatedAt};
	const first=await page.request.post('/api/orders',{headers:{'Idempotency-Key':key},data:payload});
	const replay=await page.request.post('/api/orders',{headers:{'Idempotency-Key':key},data:payload});
	expect(first.status()).toBe(201);
	expect(replay.status()).toBe(201);
	const firstOrder=await first.json();
	const replayOrder=await replay.json();
	expect(replayOrder.id).toBe(firstOrder.id);
	expect(replayOrder.executions).toHaveLength(1);
	const afterBalance=Number((await page.request.get('/api/wallet').then(response=>response.json())).balance);
	expect(afterBalance).toBeLessThan(startingBalance);
	expect(Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(afterBalance);
	expect(await page.request.get('/api/orders').then(response=>response.json()).then((orders:Array<{id:string}>)=>orders.filter(order=>order.id===firstOrder.id))).toHaveLength(1);
	let position=(await page.request.get('/api/positions').then(response=>response.json()))[0];
	expect(Number(position.quantity)).toBe(1);

	const updatedMarket=await page.request.get('/api/market').then(response=>response.json());
	const updatedInstrument=updatedMarket.find((item:{symbol:string})=>item.symbol===symbol);
	const secondBuy=await page.request.post('/api/orders',{headers:{'Idempotency-Key':randomUUID()},data:{instrumentId:updatedInstrument.id,side:'BUY',type:'MARKET',quantity:1,expectedPrice:Number(updatedInstrument.price),observedAt:updatedInstrument.lastUpdatedAt}});
	expect(secondBuy.status()).toBe(201);
	position=(await page.request.get('/api/positions').then(response=>response.json()))[0];
	expect(Number(position.quantity)).toBe(2);
	const openPortfolio=await page.request.get('/api/portfolio').then(response=>response.json());
	expect(Number(openPortfolio.totalValue)).toBeCloseTo(Number(openPortfolio.cashBalance)+Number(openPortfolio.positionValue),2);
	expect(Number(openPortfolio.unrealizedPnl)).toBeCloseTo(Number(position.unrealizedPnl),2);

	const sellMarket=await page.request.get('/api/market').then(response=>response.json());
	const sellInstrument=sellMarket.find((item:{symbol:string})=>item.symbol===symbol);
	const partialSell=await page.request.post('/api/orders',{headers:{'Idempotency-Key':randomUUID()},data:{instrumentId:sellInstrument.id,side:'SELL',type:'MARKET',quantity:0.5,expectedPrice:Number(sellInstrument.price),observedAt:sellInstrument.lastUpdatedAt}});
	expect(partialSell.status()).toBe(201);
	position=(await page.request.get('/api/positions').then(response=>response.json()))[0];
	expect(Number(position.quantity)).toBe(1.5);
	expect(Number(position.realizedPnl)).not.toBe(0);
	const close=await page.request.post('/api/positions',{data:{positionId:position.id}});
	expect(close.ok()).toBeTruthy();
	expect(await page.request.get('/api/positions').then(response=>response.json())).toHaveLength(0);
	const closedPortfolio=await page.request.get('/api/portfolio').then(response=>response.json());
	expect(Number(closedPortfolio.positionValue)).toBe(0);
	expect(Number(closedPortfolio.realizedPnl)).not.toBe(0);

	const otherContext=await browser.newContext();
	try{
		const otherPage=await otherContext.newPage();
		await loginAs(otherPage,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
		const otherOrders=await otherPage.request.get('/api/orders').then(response=>response.json());
		expect(otherOrders.some((order:{id:string})=>order.id===firstOrder.id)).toBe(false);
	}finally{await otherContext.close();}
});

test('DEMO deposits and withdrawals are unavailable in the wallet and rejected by the API',async({page})=>{
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await selectAccountMode(page,'DEMO');
	const user=await page.request.get('/api/profile').then(response=>response.json());
	const walletBefore=await page.request.get('/api/wallet').then(response=>response.json());
	const methods=await page.request.get('/api/payment-methods').then(response=>response.json());
	expect(methods).toMatchObject({btcAddress:null,fundingStatus:'DISABLED',realFundingAvailable:false,realWithdrawalAvailable:false});
	const fundingCount=await db.fundingRequest.count({where:{userId:user.id,accountMode:'DEMO'}});
	await page.goto('/wallet?action=DEPOSIT');
	await expect(page.getByRole('status').filter({hasText:'Deposits and withdrawals are available in REAL Mode only.'})).toBeVisible();
	await expect(page.getByRole('button',{name:/Deposit|Withdrawal/})).toHaveCount(0);
	await expect(page.getByLabel('Bitcoin address')).toHaveCount(0);
	await expect(page.locator('input[type="file"]')).toHaveCount(0);
	await page.goto('/dashboard');
	await expect(page.getByRole('link',{name:'Deposit'})).toHaveCount(0);
	await expect(page.getByRole('link',{name:'Request withdrawal'})).toHaveCount(0);

	const demoDeposit=await page.request.post('/api/wallet',{headers:{'Idempotency-Key':randomUUID()},data:{type:'DEPOSIT',amount:25,currency:'USD',accountMode:'REAL'}});
	expect(demoDeposit.status()).toBe(403);
	expect((await demoDeposit.json()).error).toBe('Deposits and withdrawals are available in REAL Mode only.');
	const demoWithdrawal=await page.request.post('/api/wallet',{headers:{'Idempotency-Key':randomUUID()},data:{type:'WITHDRAWAL',amount:10,currency:'USD',accountMode:'REAL'}});
	expect(demoWithdrawal.status()).toBe(403);
	expect((await demoWithdrawal.json()).error).toBe('Deposits and withdrawals are available in REAL Mode only.');
	const directRealBitcoin=await page.request.post('/api/wallet',{headers:{'Idempotency-Key':randomUUID()},data:{type:'DEPOSIT',amount:0.001,currency:'BTC',accountMode:'REAL'}});
	expect(directRealBitcoin.status()).toBe(403);
	expect(await db.fundingRequest.count({where:{userId:user.id,accountMode:'DEMO'}})).toBe(fundingCount);
	const walletAfter=await page.request.get('/api/wallet').then(response=>response.json());
	expect(walletAfter).toMatchObject({accountMode:'DEMO'});
	expect(Number(walletAfter.balance)).toBe(Number(walletBefore.balance));
});

test('REAL withdrawal requests reserve balance until an attested payout debits once',async({browser,page})=>{
	const isolated=await createIsolatedDemoUser('real-withdrawal');
	const user=await db.user.findUniqueOrThrow({where:{email:isolated.email}});
	await db.user.update({where:{id:user.id},data:{accountMode:'REAL',kycStatus:'APPROVED',verifiedAt:new Date(),depositEnabled:true,withdrawalEnabled:true,accountRestricted:false}});
	await db.$transaction(tx=>initializePaperAccount(tx,user.id,'REAL'));
	await db.kycProfile.create({data:{userId:user.id,legalName:'E2E REAL Withdrawal User',dob:new Date('1990-01-01'),address:'123 Test Street',idType:'PASSPORT',idNumber:`E2E-${randomUUID()}`,submittedAt:new Date()}});
	await db.kycDocument.create({data:{userId:user.id,kind:'IDENTITY_DOCUMENT',filename:'e2e-identity.pdf',storageKey:`${user.id}/${randomUUID()}.pdf`,mimeType:'application/pdf',size:128,status:'APPROVED'}});

	const adminContext=await browser.newContext();
	try{
		const adminPage=await adminContext.newPage();
		await loginAs(page,isolated.email,isolated.password);
		await selectAccountMode(page,'REAL');
		const walletBefore=await page.request.get('/api/wallet').then(response=>response.json());
		expect(walletBefore).toMatchObject({accountMode:'REAL',balance:'0',withdrawableBalance:'0'});
		const destinationResponse=await page.request.post('/api/withdrawal-destinations',{data:{
			type:'BANK_TRANSFER',nickname:'E2E test destination',countryCode:'US',bankName:'Test Bank',
			beneficiaryName:'E2E REAL Withdrawal User',accountNumber:'123456789',accountType:'CHECKING',routingNumber:'123456789',
		}});
		expect(destinationResponse.status()).toBe(201);
		const destination=await destinationResponse.json().then(body=>body.destination);
		const deposit=await page.request.post('/api/wallet',{headers:{'Idempotency-Key':randomUUID()},data:{type:'DEPOSIT',amount:100,currency:'USD'}});
		expect(deposit.status()).toBe(201);
		const depositRequest=await deposit.json();
		expect(Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(0);

		await loginAs(adminPage,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
		const depositApproval=await adminPage.request.patch('/api/admin/funding',{data:{id:depositRequest.id,decision:'APPROVED',note:'Approve internal test credit'}});
		expect(depositApproval.status()).toBe(200);
		const fundedWallet=await page.request.get('/api/wallet').then(response=>response.json());
		expect(Number(fundedWallet.balance)).toBe(90);

		await loginAs(page,isolated.email,isolated.password);
		await selectAccountMode(page,'REAL');
		const submission=await page.request.post('/api/wallet',{
			headers:{'Idempotency-Key':randomUUID()},
			data:{type:'WITHDRAWAL',amount:25,currency:'USD',withdrawalDestinationId:destination.id,destinationConfirmed:true},
		});
		expect(submission.status()).toBe(201);
		const request=await submission.json();
		expect(request).toMatchObject({type:'WITHDRAWAL',accountMode:'REAL',status:'PENDING_REVIEW'});
		const walletPending=await page.request.get('/api/wallet').then(response=>response.json());
		expect(Number(walletPending.balance)).toBe(90);
		expect(Number(walletPending.withdrawableBalance)).toBe(65);

		const withdrawalQueue=await adminPage.request.get('/api/admin/funding?type=WITHDRAWAL').then(response=>response.json());
		expect(withdrawalQueue.some((item:{id:string})=>item.id===request.id)).toBe(true);
		expect(withdrawalQueue.some((item:{type:string})=>item.type==='DEPOSIT')).toBe(false);
		await adminPage.goto('/admin/payments?type=WITHDRAWAL');
		await expect(adminPage.getByRole('heading',{name:'Withdrawal review'})).toBeVisible();
		const requestRow=adminPage.locator('.admin-funding-row').filter({hasText:user.email});
		await expect(requestRow).toBeVisible();
		await requestRow.getByRole('button',{name:'Approve · reserve funds'}).click();
		await expect(adminPage.getByRole('status').filter({hasText:'Withdrawal approved; amount remains reserved and no payment is confirmed.'})).toBeVisible();
		const walletReserved=await page.request.get('/api/wallet').then(response=>response.json());
		expect(Number(walletReserved.balance)).toBe(90);
		expect(Number(walletReserved.withdrawableBalance)).toBe(65);

		const processingKey=randomUUID();
		const processing=await adminPage.request.post('/api/admin/funding/withdrawal',{headers:{'Idempotency-Key':processingKey},data:{id:request.id,action:'PROCESS'}});
		expect(processing.status()).toBe(200);
		const completionKey=randomUUID();
		const payout={id:request.id,action:'COMPLETE',processingReference:`E2E-${randomUUID()}`,confirmExternalProcessing:true};
		const completed=await adminPage.request.post('/api/admin/funding/withdrawal',{headers:{'Idempotency-Key':completionKey},data:payout});
		expect(completed.status()).toBe(200);
		const replay=await adminPage.request.post('/api/admin/funding/withdrawal',{headers:{'Idempotency-Key':completionKey},data:payout});
		expect(replay.status()).toBe(200);
		expect(await db.ledgerTransaction.count({where:{reference:`FUNDING:${request.id}:EXTERNAL_WITHDRAWAL`}})).toBe(1);
		const walletApproved=await page.request.get('/api/wallet').then(response=>response.json());
		expect(Number(walletApproved.balance)).toBe(65);
		expect(Number(walletApproved.withdrawableBalance)).toBe(65);
	}finally{
		await adminContext.close();
	}
});

test('DEMO users cannot access configured legacy address details or receipt uploads',async({browser,page})=>{
	const address='bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
	const adminContext=await browser.newContext();
	try{
		const adminPage=await adminContext.newPage();
		await loginAs(adminPage,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
		const configured=await adminPage.request.put('/api/admin/settings',{data:{key:SIMULATED_BTC_ADDRESS_SETTING,value:address}});
		expect(configured.status()).toBe(200);

		await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
		await selectAccountMode(page,'DEMO');
		const user=await page.request.get('/api/profile').then(response=>response.json());
		const before=await page.request.get('/api/wallet').then(response=>response.json());
		const fundingCount=await db.fundingRequest.count({where:{userId:user.id,accountMode:'DEMO'}});
		const inaccessibleRealRequest=await db.fundingRequest.create({data:{userId:user.id,type:'DEPOSIT',method:'E2E REAL funding record',amount:10,currency:'USD',accountMode:'REAL',status:'PENDING_REVIEW',idempotencyKey:randomUUID()}});
		const methods=await page.request.get('/api/payment-methods').then(response=>response.json());
		expect(methods).toMatchObject({btcAddress:null,externalPaymentProcessing:'DISABLED',fundingStatus:'DISABLED'});
		await page.goto('/wallet?action=DEPOSIT');
		await expect(page.getByRole('status').filter({hasText:'Deposits and withdrawals are available in REAL Mode only.'})).toBeVisible();
		await expect(page.getByText(address,{exact:true})).toHaveCount(0);
		await expect(page.getByRole('img',{name:'QR code for the administrator-configured Bitcoin address'})).toHaveCount(0);
		await expect(page.locator('input[type="file"]')).toHaveCount(0);
		const realRequestDetail=await page.request.get(`/api/funding/${inaccessibleRealRequest.id}`);
		expect(realRequestDetail.status()).toBe(404);
		const uploadBody=new FormData();
		uploadBody.append('file',new Blob([PNG.sync.write(new PNG({width:1,height:1}))],{type:'image/png'}),'proof.png');
		const receiptUpload=await page.request.post(`/api/wallet/${inaccessibleRealRequest.id}/receipt`,{multipart:uploadBody});
		expect(receiptUpload.status()).toBe(403);
		expect((await receiptUpload.json()).error).toBe('Receipt management is available in REAL mode only.');
		const directDeposit=await page.request.post('/api/wallet',depositPostOptions(randomUUID(),{type:'DEPOSIT',amount:20,currency:'USD',accountMode:'REAL',simulatedBitcoinAddress:address,simulatedBitcoinAddressAcknowledged:true}));
		expect(directDeposit.status()).toBe(403);
		expect(await db.fundingRequest.count({where:{userId:user.id,accountMode:'DEMO'}})).toBe(fundingCount);
		const after=await page.request.get('/api/wallet').then(response=>response.json());
		expect(Number(after.balance)).toBe(Number(before.balance));
	}finally{
		const adminPage=adminContext.pages()[0];
		if(adminPage)await adminPage.request.put('/api/admin/settings',{data:{key:SIMULATED_BTC_ADDRESS_SETTING,value:''}}).catch(()=>undefined);
		await adminContext.close();
	}
});

test('display currency preference persists across account and activity surfaces without changing ledger cash',async({page})=>{
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await selectAccountMode(page,'DEMO');
	const balanceBefore=Number((await page.request.get('/api/wallet').then(response=>response.json())).balance);
	expect((await page.request.get('/api/currency-preference').then(response=>response.json())).currency).toBe('USD');
	const updated=await page.request.patch('/api/currency-preference',{data:{currency:'GBP'}});
	expect(updated.ok()).toBe(true);
	expect((await updated.json()).currency).toBe('GBP');
	const fallbackRate=await page.request.get('/api/currency-rates?to=GBP');
	expect(fallbackRate.ok()).toBe(true);
	expect((await fallbackRate.json()).status).toBe('INTERNAL');
	await page.goto('/portfolio');
	await expect(page.getByLabel('Preferred display currency')).toHaveValue('GBP');
	await page.getByLabel('Preferred display currency').selectOption('EUR');
	await expect.poll(async()=>(await page.request.get('/api/currency-preference').then(response=>response.json())).currency).toBe('EUR');
	await page.goto('/activity');
	await expect(page.getByLabel('Preferred display currency')).toHaveValue('EUR');
	await page.goto('/wallet/transactions');
	await expect(page.getByLabel('Preferred display currency')).toHaveValue('EUR');
	expect(Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(balanceBefore);
});

test('administrator market tick is protected, deterministic, and idempotent',async({browser,page})=>{
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	const unauthorized=await page.request.post('/api/admin/market/tick',{headers:{'Idempotency-Key':randomUUID()},data:{symbol:'BTC/USD',direction:'UP',volatilityPercent:1}});
	expect(unauthorized.status()).toBe(403);
	const btc=await db.instrument.findUniqueOrThrow({where:{symbol:'BTC/USD'},select:{id:true,price:true}});
	const adminContext=await browser.newContext();
	try{
		const adminPage=await adminContext.newPage();
		await loginAs(adminPage,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
		const idempotencyKey=randomUUID();
		const payload={symbol:'BTC/USD',direction:'UP',volatilityPercent:1};
		const tick=await adminPage.request.post('/api/admin/market/tick',{headers:{'Idempotency-Key':idempotencyKey},data:payload});
		expect(tick.status()).toBe(201);
		const first=await tick.json();
		expect(first).toMatchObject({symbol:'BTC/USD',dataMode:'SIMULATED',replayed:false});
		expect(Number(first.previousPrice)).toBeGreaterThan(0);
		expect(Number(first.price)).toBeCloseTo(Number(first.previousPrice)*1.01,8);
		const replay=await adminPage.request.post('/api/admin/market/tick',{headers:{'Idempotency-Key':idempotencyKey},data:payload});
		expect(replay.status()).toBe(200);
		expect(await replay.json()).toMatchObject({price:first.price,replayed:true});
		const conflict=await adminPage.request.post('/api/admin/market/tick',{headers:{'Idempotency-Key':idempotencyKey},data:{...payload,direction:'DOWN'}});
		expect(conflict.status()).toBe(409);
		expect(await db.auditLog.count({where:{action:'SIMULATED_MARKET_TICK',entityId:btc.id}})).toBe(1);
	}finally{await adminContext.close();}
});

test('REAL internal deposit request remains uncredited until administrator approval',async({browser,page})=>{
	const adminContext=await browser.newContext();
	try{
		const adminPage=await adminContext.newPage();
		await loginAs(adminPage,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
		await loginAs(page,fixture('INVESTOR_EMAIL'),fixture('INVESTOR_PASSWORD'));
		await selectAccountMode(page,'REAL');
		const before=await page.request.get('/api/wallet').then(response=>response.json());
		await page.goto('/wallet?action=DEPOSIT');
		await expect(page.getByText(/internal REAL ledger credit request/i)).toBeVisible();
		await expect(page.getByRole('heading',{name:'Administrator Review'})).toBeVisible();
		await expect(page.getByText(/no external payment is processed/i)).toBeVisible();
		await expect(page.getByLabel('Bitcoin address')).toHaveCount(0);
		await expect(page.getByRole('img',{name:/Bitcoin address/})).toHaveCount(0);
		await page.getByLabel('Amount',{exact:true}).fill('20.00');
		await page.getByLabel('Request reference (optional)').fill(`E2E-${randomUUID()}`);
		await page.getByRole('button',{name:'Submit internal credit request'}).click();
		await expect(page.getByRole('heading',{name:'Confirm deposit request'})).toBeVisible();
		await expect(page.getByText(/This is an internal ledger request only; no external payment occurs/)).toBeVisible();
		await page.getByRole('button',{name:'Confirm request'}).click();
		await expect(page.getByText(/The ledger has not been posted/)).toBeVisible();
		const after=await page.request.get('/api/wallet').then(response=>response.json());
		const request=after.transactions[0];
		expect(request).toMatchObject({type:'DEPOSIT',status:'PENDING_REVIEW',currency:'USD',amount:'20',hasReceipt:false});
		expect(Number(after.balance)).toBe(Number(before.balance));
		expect(Number(after.withdrawableBalance)).toBe(Number(before.withdrawableBalance));
		const approval=await adminPage.request.patch('/api/admin/funding',{data:{id:request.id,decision:'APPROVED',note:'Approved internal ledger credit'}});
		expect(approval.status()).toBe(200);
		expect(Number((await approval.json()).creditedAmount)).toBe(18);
		expect(Number((await approval.json()).feeAmount)).toBe(2);
		const credited=await page.request.get('/api/wallet').then(response=>response.json());
		expect(Number(credited.balance)).toBe(Number(before.balance)+18);
		expect(credited.transactions.find((item:{id:string})=>item.id===request.id)).toMatchObject({status:'APPROVED',amount:'20',creditedAmount:'18',feeAmount:'2',accountMode:'REAL'});
	}finally{
		await adminContext.close();
	}
});

test('REAL internal transaction detail preserves pending review status',async({page})=>{
	await loginAs(page,fixture('INVESTOR_EMAIL'),fixture('INVESTOR_PASSWORD'));
	await selectAccountMode(page,'REAL');
	const response=await page.goto(`/wallet/transactions/${fixture('REAL_DETAIL_ID')}`);
	expect(response?.status()).toBe(200);
	await expect(page.getByRole('heading',{name:'Deposit request'})).toBeVisible();
	await expect(page.getByText(/No payment processor, broker, bank, or cryptocurrency network is contacted/i)).toBeVisible();
	await expect(page.getByText(/This request awaits administrator review/i)).toBeVisible();
	await expect(page.getByText(/User-submitted information for administrator review; not independently verified/i)).toBeVisible();
});

test('external payment methods cannot be configured or exposed to users',async({browser,page})=>{
	const adminContext=await browser.newContext();
	try{
		const adminPage=await adminContext.newPage();
		await loginAs(adminPage,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
		const created=await adminPage.request.post('/api/admin/payment-methods',{data:{name:`E2E Bitcoin ${randomUUID()}`,enabled:true,demoOnly:false,depositEnabled:true,withdrawalEnabled:false,requiresNetwork:true,currencies:['BTC'],destination:'bc1qexampleaddress',instructions:'Use the Bitcoin network.',minimumAmount:0,maximumAmount:null,processingNotes:null,displayOrder:999}});
		expect(created.status()).toBe(409);
		expect((await created.json()).error).toContain('External payment processing is disabled');
		expect(await adminPage.request.get('/api/admin/payment-methods').then(response=>response.json())).toEqual([]);
		await loginAs(page,fixture('INVESTOR_EMAIL'),fixture('INVESTOR_PASSWORD'));
		await selectAccountMode(page,'REAL');
		await page.goto('/wallet?action=DEPOSIT');
		const methods=await page.request.get('/api/payment-methods').then(response=>response.json());
		expect(methods).toMatchObject({methods:[],externalPaymentProcessing:'DISABLED'});
		await expect(page.getByLabel('Request reference (optional)')).toBeVisible();
		await expect(page.getByLabel('Optional supporting attachment')).toBeVisible();
		await expect(page.getByLabel('Bitcoin transaction reference')).toHaveCount(0);
		await expect(page.getByText(/no external payment is processed/i)).toBeVisible();
	}finally{await adminContext.close();}
});

test('DEMO funding stays disabled regardless of user deposit and withdrawal permissions',async({browser,page})=>{
	const fundingUser=await createIsolatedDemoUser('funding-permissions');
	const adminContext=await browser.newContext();
	const adminPage=await adminContext.newPage();
	const priorBitcoinAddress=await db.systemSetting.findUnique({where:{key:SIMULATED_BTC_ADDRESS_SETTING},select:{value:true}});
	const bitcoinAddress='bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
	try{
		await loginAs(page,fundingUser.email,fundingUser.password);
		const userProfile=await page.request.get('/api/profile').then(response=>response.json());
		const methods=await page.request.get('/api/payment-methods').then(async response=>(await response.json()).methods);
		expect(methods).toHaveLength(0);
		const startingWallet=await page.request.get('/api/wallet').then(response=>response.json());
		await loginAs(adminPage,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
		const configured=await adminPage.request.put('/api/admin/settings',{data:{key:SIMULATED_BTC_ADDRESS_SETTING,value:bitcoinAddress}});
		expect(configured.status()).toBe(200);
		const disabled=await adminPage.request.patch('/api/admin/users',{data:{userId:userProfile.id,depositEnabled:false,withdrawalEnabled:false}});
		expect(disabled.ok()).toBeTruthy();
		expect(await disabled.json()).toMatchObject({depositEnabled:false,withdrawalEnabled:false});
		const accessPanel=adminPage.getByRole('heading',{name:'User deposit and withdrawal access'});
		await adminPage.goto('/admin/kyc');
		await expect(accessPanel).toBeVisible();
		await expect(adminPage.getByRole('button',{name:`Enable deposits for ${userProfile.email}`})).toBeVisible();
		const blockedDeposit=await page.request.post('/api/wallet',{headers:{'Idempotency-Key':randomUUID()},data:{type:'DEPOSIT',amount:25,currency:'USD'}});
		expect(blockedDeposit.status()).toBe(403);
		expect((await blockedDeposit.json()).error).toBe('Deposits and withdrawals are available in REAL Mode only.');
		const blockedWithdrawal=await page.request.post('/api/wallet',{headers:{'Idempotency-Key':randomUUID()},data:{type:'WITHDRAWAL',amount:10,currency:'USD'}});
		expect(blockedWithdrawal.status()).toBe(403);
		expect((await blockedWithdrawal.json()).error).toBe('Deposits and withdrawals are available in REAL Mode only.');
		const enabled=await adminPage.request.patch('/api/admin/users',{data:{userId:userProfile.id,depositEnabled:true,withdrawalEnabled:true}});
		expect(enabled.ok()).toBeTruthy();
		const deposit=await page.request.post('/api/wallet',depositPostOptions(randomUUID(),{type:'DEPOSIT',amount:25,currency:'USD',simulatedBitcoinAddress:bitcoinAddress,simulatedBitcoinAddressAcknowledged:true}));
		const withdrawal=await page.request.post('/api/wallet',{headers:{'Idempotency-Key':randomUUID()},data:{type:'WITHDRAWAL',amount:10,currency:'USD'}});
		expect(deposit.status()).toBe(403);
		expect(withdrawal.status()).toBe(403);
		expect(Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(Number(startingWallet.balance));
		expect((await page.request.get('/api/wallet').then(response=>response.json())).transactions).toHaveLength(startingWallet.transactions.length);
		expect(await db.fundingRequest.count({where:{userId:userProfile.id,accountMode:'DEMO'}})).toBe(startingWallet.transactions.length);
		const legacyDemoRequest=await db.fundingRequest.create({data:{userId:userProfile.id,type:'DEPOSIT',method:'Legacy DEMO funding request',amount:25,currency:'USD',accountMode:'DEMO',status:'PENDING_REVIEW',idempotencyKey:randomUUID()}});
		const legacyApproval=await adminPage.request.patch('/api/admin/funding',{data:{id:legacyDemoRequest.id,decision:'APPROVED'}});
		expect(legacyApproval.status()).toBe(409);
		expect((await legacyApproval.json()).error).toContain('REAL Mode only');
		expect(await db.ledgerTransaction.findUnique({where:{reference:`FUNDING:${legacyDemoRequest.id}:APPROVED`}})).toBeNull();
		const legacyRejection=await adminPage.request.patch('/api/admin/funding',{data:{id:legacyDemoRequest.id,decision:'REJECTED'}});
		expect(legacyRejection.status()).toBe(200);
		expect((await legacyRejection.json()).status).toBe('REJECTED');
		const legacyWithdrawal=await db.fundingRequest.create({data:{userId:userProfile.id,type:'WITHDRAWAL',method:'Legacy DEMO withdrawal',amount:10,currency:'USD',accountMode:'DEMO',status:'APPROVED',idempotencyKey:randomUUID()}});
		const settlement=await adminPage.request.post('/api/admin/funding/settle',{headers:{'Idempotency-Key':randomUUID()},data:{id:legacyWithdrawal.id,note:'Reject legacy simulated payout'}});
		expect(settlement.status()).toBe(409);
		expect((await settlement.json()).error).toContain('DEMO withdrawals are disabled');
		expect(await db.ledgerTransaction.findUnique({where:{reference:`FUNDING:${legacyWithdrawal.id}:SETTLED`}})).toBeNull();
		expect(Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(Number(startingWallet.balance));
	}finally{
		if(!adminPage.isClosed())await adminPage.request.put('/api/admin/settings',{data:{key:SIMULATED_BTC_ADDRESS_SETTING,value:priorBitcoinAddress?.value||''}}).catch(()=>undefined);
		await adminContext.close();
	}
});

test('approved internal deposit receipts show gross amount, deducted fee, net credit, and reviewer audit',async({browser,page})=>{
	const adminContext=await browser.newContext();
	const adminPage=await adminContext.newPage();
	try{
		await loginAs(adminPage,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
		await loginAs(page,fixture('INVESTOR_EMAIL'),fixture('INVESTOR_PASSWORD'));
		await selectAccountMode(page,'REAL');
		const startingBalance=Number((await page.request.get('/api/wallet').then(response=>response.json())).balance);
		const deposit=await page.request.post('/api/wallet',depositPostOptions(randomUUID(),{type:'DEPOSIT',amount:100,currency:'USD',transactionReference:`E2E-${randomUUID()}`}));
		expect(deposit.status()).toBe(201);
		const request=await deposit.json();
		await logout(page);
		const approval=await adminPage.request.patch('/api/admin/funding',{data:{id:request.id,decision:'APPROVED',note:'Approved internal ledger credit'}});
		expect(approval.status()).toBe(200);
		expect(Number((await approval.json()).creditedAmount)).toBe(90);
		expect(Number((await approval.json()).feeAmount)).toBe(10);
		await loginAs(page,fixture('INVESTOR_EMAIL'),fixture('INVESTOR_PASSWORD'));
		await selectAccountMode(page,'REAL');
		const wallet=await page.request.get('/api/wallet').then(response=>response.json());
		expect(Number(wallet.balance)).toBeCloseTo(startingBalance+90,2);
		const transaction=wallet.transactions.find((item:{id:string})=>item.id===request.id);
		expect(transaction).toMatchObject({status:'APPROVED',amount:'100',creditedAmount:'90',feeAmount:'10',reviewedBy:{email:fixture('ADMIN_EMAIL')}});
		expect(transaction.reviewedAt).toBeTruthy();
		await page.goto('/wallet');
		await page.locator('.wallet-ledger-records > summary').click();
		const receiptDetails=page.locator('.wallet-receipt-list > details').filter({hasText:request.id}).first();
		await receiptDetails.locator('summary').click();
		await expect(receiptDetails.getByText('$100.00',{exact:true}).first()).toBeVisible();
		await expect(receiptDetails.getByText('$10.00',{exact:true}).first()).toBeVisible();
		await expect(receiptDetails.getByText('$90.00',{exact:true}).first()).toBeVisible();
		await expect(receiptDetails.getByRole('heading',{name:'Transaction Details'})).toBeVisible();
		await expect(receiptDetails.getByText(fixture('ADMIN_EMAIL'),{exact:true})).toHaveCount(0);
		const downloadPromise=page.waitForEvent('download');
		await receiptDetails.getByRole('button',{name:'Download PDF'}).click();
		expect((await downloadPromise).suggestedFilename()).toContain('approved');
	}finally{await adminContext.close();}
});

test('DEMO investment submissions cannot create settlement payouts',async({page})=>{
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await selectAccountMode(page,'DEMO');
	const userId=await page.request.get('/api/profile').then(response=>response.json().then(profile=>profile.id));
	const startingBalance=Number((await page.request.get('/api/wallet').then(response=>response.json())).balance);
	const requestResponse=await page.request.post('/api/investments',{headers:{'Idempotency-Key':randomUUID()},data:{opportunityId:'not-a-demo-opportunity',amount:500}});
	expect(requestResponse.status()).toBe(403);
	expect(Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(startingBalance);
	expect(await db.investmentRequest.count({where:{userId,accountMode:'DEMO',opportunityId:'not-a-demo-opportunity'}})).toBe(0);
});

test('KYC access is owner-scoped and unavailable signed Storage access fails closed',async({browser,page})=>{
	const documentId=fixture('KYC_DOCUMENT_ID');
	const pendingUser=await createIsolatedDemoUser('kyc-access');
	await loginAs(page,pendingUser.email,pendingUser.password);
	expect((await page.request.get(`/api/kyc/documents/${documentId}`)).status()).toBe(403);
	expect((await page.request.get(`/api/admin/kyc/documents/${documentId}`)).status()).toBe(403);

	const unauthenticatedContext=await browser.newContext();
	try{
		const unauthenticatedPage=await unauthenticatedContext.newPage();
		expect((await unauthenticatedPage.request.get(`/api/kyc/documents/${documentId}`)).status()).toBe(401);
	}finally{await unauthenticatedContext.close();}

	const investorContext=await browser.newContext();
	try{
		const investorPage=await investorContext.newPage();
		await loginAs(investorPage,fixture('INVESTOR_EMAIL'),fixture('INVESTOR_PASSWORD'));
		await selectAccountMode(investorPage,'REAL');
		const documents=await investorPage.request.get('/api/kyc/documents').then(response=>response.json());
		expect(documents.map((document:{id:string})=>document.id)).toContain(documentId);
		const ownerAccess=await investorPage.request.get(`/api/kyc/documents/${documentId}`);
		expect(ownerAccess.status()).toBe(502);
		expect((await ownerAccess.json()).error).toBeTruthy();

		const approvedUpload=await investorPage.request.post('/api/kyc/documents',{multipart:{
			kind:'IDENTITY_DOCUMENT',
			file:{name:'approved-e2e.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4\\nApproved account upload must be blocked\\n%%EOF\\n')},
		}});
		expect(approvedUpload.status()).toBe(409);
		expect((await investorPage.request.get('/api/kyc/documents').then(response=>response.json()))).toHaveLength(documents.length);
	}finally{await investorContext.close();}
	await db.user.update({where:{email:pendingUser.email},data:{accountMode:'REAL'}});
	const pendingDocuments=await page.request.get('/api/kyc/documents').then(response=>response.json());
	const upload=await page.request.post('/api/kyc/documents',{multipart:{
		kind:'IDENTITY_DOCUMENT',
		file:{name:'temporary-e2e.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4\\nDisposable E2E document\\n%%EOF\\n')},
	}});
	expect(upload.status()).toBe(201);
	expect((await page.request.get('/api/kyc/documents').then(response=>response.json()))).toHaveLength(pendingDocuments.length+1);

	const adminContext=await browser.newContext();
	try{
		const adminPage=await adminContext.newPage();
		await loginAs(adminPage,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
		const adminAccess=await adminPage.request.get(`/api/admin/kyc/documents/${documentId}`);
		expect(adminAccess.status()).toBe(502);
		expect((await adminAccess.json()).error).toBeTruthy();
	}finally{await adminContext.close();}
});

test('profile settings persist for the owner and remain inaccessible to signed-out clients',async({browser,page})=>{
	const settingsUser=await createIsolatedDemoUser('profile-settings');
	await loginAs(page,settingsUser.email,settingsUser.password);
	const initialProfile=await page.request.get('/api/profile').then(response=>response.json());
	expect(initialProfile).toMatchObject({twoFactorEnabled:false,twoFactorAvailable:false});
	const enableTwoFactor=await page.request.patch('/api/profile',{data:{name:'Temporary E2E User',country:'Test',twoFactorEnabled:true}});
	expect(enableTwoFactor.status()).toBe(409);
	expect((await enableTwoFactor.json()).error).toContain('Two-factor authentication is unavailable');
	const updated=await page.request.patch('/api/profile',{data:{name:'Temporary Settings Update',country:'Test Country',address:'Isolated test address',twoFactorEnabled:false}});
	expect(updated.ok()).toBeTruthy();
	expect(await page.request.get('/api/profile').then(response=>response.json())).toMatchObject({name:'Temporary Settings Update',twoFactorEnabled:false,twoFactorAvailable:false});
	await page.goto('/settings');
	await page.getByRole('tab',{name:'Security'}).click();
	await expect(page.getByText('Unavailable — this account is not protected by two-factor authentication. Enrollment and login challenges are not configured.')).toBeVisible();
	await expect(page.getByText('Not enabled',{exact:true})).toBeVisible();
	const signedOutContext=await browser.newContext();
	try{
		const signedOutPage=await signedOutContext.newPage();
		expect((await signedOutPage.request.get('/api/profile')).status()).toBe(401);
	}finally{await signedOutContext.close();}
});

test('browser notification settings explain denied permission without prompting again',async({page})=>{
	const settingsUser=await createIsolatedDemoUser('push-denied');
	await page.context().grantPermissions([],{origin:appOrigin});
	await loginAs(page,settingsUser.email,settingsUser.password);
	await page.setViewportSize({width:390,height:844});
	await page.goto('/settings');
	await page.getByRole('link',{name:/Preferences/}).click();
	await waitForStartup(page);
	await expect(page.getByRole('heading',{name:'Appearance'})).toBeVisible();
	await page.getByRole('button',{name:'Switch to light mode'}).last().click();
	await expect(page.locator('html')).toHaveAttribute('data-theme','light');
	await expect(page.locator('body')).toHaveCSS('background-color','rgb(249, 251, 253)');
	await expect(page.getByRole('button',{name:'Switch to dark mode'})).toHaveCount(2);
	await page.getByRole('button',{name:'Switch to dark mode'}).last().click();
	await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
	await expect(page.locator('body')).toHaveCSS('background-color','rgb(11, 15, 26)');
	await expect(page.getByRole('heading',{name:'Browser notifications'})).toBeVisible();
	await expect(page.getByText('Permission: Blocked')).toBeVisible();
	await expect(page.getByText(/Aurevia cannot prompt again/)).toBeVisible();
	await expect(page.getByRole('button',{name:'Enable notifications'})).toBeDisabled();
	await expectNoHorizontalOverflow(page);
});

test('account deletion preserves ledger history and re-registration fails closed without Akedly',async({page})=>{
	const userId=fixture('DELETE_USER_ID');
	const email=fixture('DELETE_EMAIL');
	const password=fixture('DELETE_PASSWORD');
	await loginAs(page,email,password);
	const ledgerAccountIds=(await db.ledgerAccount.findMany({where:{userId},select:{id:true}})).map(account=>account.id);
	const ledgerBefore=await db.ledgerEntry.findMany({where:{accountId:{in:ledgerAccountIds}},select:{type:true,amount:true}});
	const balanceBefore=ledgerBefore.reduce((balance,entry)=>balance+(entry.type==='CREDIT'?1:-1)*Number(entry.amount),0);

	const invalidPassword=await page.request.post('/api/account/delete',{data:{password:'Incorrect-password-99',confirmation:'DELETE'}});
	expect(invalidPassword.status()).toBe(403);
	const rejectedConfirmation=await page.request.post('/api/account/delete',{data:{password,confirmation:'DELETE ACCOUNT'}});
	expect(rejectedConfirmation.status()).toBe(400);
	expect((await db.user.findUniqueOrThrow({where:{id:userId}})).status).toBe('ACTIVE');

	const deleted=await page.request.post('/api/account/delete',{data:{password,confirmation:'DELETE'}});
	expect(deleted.status()).toBe(204);
	const closed=await db.user.findUniqueOrThrow({where:{id:userId},select:{email:true,name:true,status:true,activeSessionId:true}});
	expect(closed).toMatchObject({email:`deleted+${userId}@account.invalid`,name:null,status:'CLOSED',activeSessionId:null});
	expect(await db.kycProfile.findUnique({where:{userId}})).toBeNull();
	expect(await page.request.get('/api/profile').then(response=>response.status())).toBe(401);
	const ledgerAfter=await db.ledgerEntry.findMany({where:{accountId:{in:ledgerAccountIds}},select:{type:true,amount:true}});
	expect(ledgerAfter).toHaveLength(ledgerBefore.length);
	expect(ledgerAfter.reduce((balance,entry)=>balance+(entry.type==='CREDIT'?1:-1)*Number(entry.amount),0)).toBeCloseTo(balanceBefore,8);

	const newPassword='NewE2e1!Password';
	const registered=await page.request.post('/api/register',{data:{name:'Replacement E2E User',email,password:newPassword,country:'Test',dateOfBirth:'1990-01-01',accountMode:'DEMO',termsAccepted:true}});
	expect(registered.status()).toBe(503);
	expect(await db.user.findUnique({where:{email}})).toBeNull();
});

test('admin broadcast lifecycle is persisted and visible to active users without inventing a stream',async({browser,page})=>{
	await loginAs(page,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
	const userContext=await browser.newContext();
	try{
		const userPage=await userContext.newPage();
		await loginAs(userPage,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
		expect((await userPage.request.get('/api/admin/broadcasts')).status()).toBe(403);
		const scheduledAt=new Date(Date.now()+86_400_000).toISOString();
		const createdResponse=await page.request.post('/api/admin/broadcasts',{data:{title:'E2E configured broadcast',description:'A published session without a configured video source.',streamUrl:null,startsAt:scheduledAt,status:'DRAFT'}});
		expect(createdResponse.status()).toBe(201);
		const created=await createdResponse.json();
		const scheduled=await page.request.patch('/api/admin/broadcasts',{data:{id:created.id,action:'schedule'}});
		expect((await scheduled.json()).status).toBe('SCHEDULED');
		const published=await page.request.patch('/api/admin/broadcasts',{data:{id:created.id,action:'publish'}});
		expect((await published.json()).status).toBe('PUBLISHED');
		const userBroadcasts=await userPage.request.get('/api/broadcasts').then(response=>response.json());
		expect(userBroadcasts.eligibilityTier).toBe(1);
		expect(userBroadcasts.broadcasts.find((item:{id:string})=>item.id===created.id)).toMatchObject({status:'PUBLISHED',streamUrl:null});
		await userPage.goto('/broadcasts');
		await expect(userPage.getByRole('heading',{name:'E2E configured broadcast'})).toBeVisible();
		await expect(userPage.getByText('No stream source configured')).toBeVisible();
		const ended=await page.request.patch('/api/admin/broadcasts',{data:{id:created.id,action:'end'}});
		expect((await ended.json()).status).toBe('ENDED');
		const endedBroadcasts=await userPage.request.get('/api/broadcasts').then(response=>response.json());
		expect(endedBroadcasts.broadcasts.find((item:{id:string})=>item.id===created.id).status).toBe('ENDED');
	}finally{await userContext.close();}
});

test('Deleted Items enforces admin access and supports audited soft delete, bulk restore, and permanent removal',async({browser,page})=>{
	await loginAs(page,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
	const userContext=await browser.newContext();
	const userPage=await userContext.newPage();
	try{
		await loginAs(userPage,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
		expect((await userPage.request.get('/api/admin/deleted-items')).status()).toBe(403);
		await userPage.goto('/admin/deleted-items');
		await expect(userPage).toHaveURL(/\/login(?:\?|$)/);
	}finally{await userContext.close();}
	const adminId=await db.user.findUniqueOrThrow({where:{email:fixture('ADMIN_EMAIL')},select:{id:true}}).then(user=>user.id);
	const suffix=randomUUID();
	const waitlist=await db.waitlistEntry.create({data:{email:`deleted-${suffix}@example.invalid`,name:'Recycle Bin Waitlist',country:'GB',consent:true}});
	const story=await db.clientStory.create({data:{displayName:'Recycle Bin Story',country:'GB',quote:'A private test story for deleted-item lifecycle coverage.'}});
	const broadcast=await db.broadcast.create({data:{title:'Recycle Bin Broadcast',description:'A private test broadcast for deleted-item lifecycle coverage.',createdById:adminId}});
	const removedWaitlist=await page.request.delete('/api/admin/waitlist',{data:{id:waitlist.id}});
	const removedStory=await page.request.delete('/api/admin/client-stories',{data:{storyId:story.id}});
	const removedBroadcast=await page.request.delete('/api/admin/broadcasts',{data:{id:broadcast.id}});
	expect(removedWaitlist.status()).toBe(200);
	expect(removedStory.status()).toBe(200);
	expect(removedBroadcast.status()).toBe(200);
	const deleted=await page.request.get('/api/admin/deleted-items').then(response=>response.json());
	expect(deleted).toHaveLength(3);
	expect(deleted.map((item:{type:string})=>item.type).sort()).toEqual(['BROADCAST','CLIENT_STORY','WAITLIST_ENTRY']);
	expect(deleted.every((item:{deletedBy:{email:string}|null;originalLocation:string})=>item.deletedBy?.email===fixture('ADMIN_EMAIL')&&item.originalLocation.startsWith('/admin/'))).toBe(true);
	await page.goto('/admin/deleted-items');
	await expect(page.getByRole('heading',{name:'Deleted Items'})).toBeVisible();
	await expect(page.getByText('Recycle Bin Broadcast')).toBeVisible();
	await expect(page.getByText('Recycle Bin Story')).toBeVisible();
	await page.getByLabel('Filter by item type').selectOption('WAITLIST_ENTRY');
	await expect(page.getByText('Recycle Bin Waitlist')).toBeVisible();
	await page.getByLabel('Filter by item type').selectOption('ALL');
	await page.getByLabel('Search deleted items').fill('Recycle Bin Story');
	await expect(page.getByText('Recycle Bin Story')).toBeVisible();
	await expect(page.getByText('Recycle Bin Broadcast')).toHaveCount(0);
	await page.getByLabel('Search deleted items').clear();
	await expect(page.getByText('Recycle Bin Broadcast')).toBeVisible();
	for(const name of ['Recycle Bin Waitlist','Recycle Bin Story','Recycle Bin Broadcast'])await page.getByRole('checkbox',{name:`Select ${name}`}).check();
	await page.getByRole('button',{name:'Restore selected'}).click();
	await expect(page.getByText('3 items restored.')).toBeVisible();
	expect(await db.waitlistEntry.findUnique({where:{id:waitlist.id}}).then(item=>item?.deletedAt)).toBeNull();
	expect(await db.clientStory.findUnique({where:{id:story.id}}).then(item=>item?.deletedAt)).toBeNull();
	expect(await db.broadcast.findUnique({where:{id:broadcast.id}}).then(item=>item?.deletedAt)).toBeNull();
	const restoredEvents=await db.auditLog.count({where:{entityId:{in:[waitlist.id,story.id,broadcast.id]},action:{in:['WAITLIST_ENTRY_RESTORED','CLIENT_STORY_RESTORED','BROADCAST_RESTORED']}}});
	expect(restoredEvents).toBe(3);
	await page.request.delete('/api/admin/waitlist',{data:{id:waitlist.id}});
	await page.request.delete('/api/admin/client-stories',{data:{storyId:story.id}});
	await page.request.delete('/api/admin/broadcasts',{data:{id:broadcast.id}});
	const secondListing=await page.request.get('/api/admin/deleted-items').then(response=>response.json());
	const permanentlyDeleted=await page.request.post('/api/admin/deleted-items',{data:{action:'permanently-delete',items:secondListing.map((item:{type:string;id:string})=>({type:item.type,id:item.id}))}});
	expect(permanentlyDeleted.status()).toBe(200);
	expect((await permanentlyDeleted.json()).affected).toBe(3);
	expect(await db.waitlistEntry.findUnique({where:{id:waitlist.id}})).toBeNull();
	expect(await db.clientStory.findUnique({where:{id:story.id}})).toBeNull();
	expect(await db.broadcast.findUnique({where:{id:broadcast.id}})).toBeNull();
	const lifecycleEvents=await db.auditLog.count({where:{entityId:{in:[waitlist.id,story.id,broadcast.id]}}});
	expect(lifecycleEvents).toBe(12);
});

test('admin investment initiation is idempotent and reconciles against reserved ledger funds',async({browser,page})=>{
	await loginAs(page,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
	const demoUser=await createIsolatedDemoUser('admin-investment');
	const opportunityResponse=await page.request.post('/api/admin/investments',{data:{title:'E2E admin initiated plan',category:'Internal simulation',description:'Disposable plan for administrator-initiated investment coverage.',assetSymbol:null,minimumAmount:50,maximumAmount:1_000_000_000,targetReturnPercent:8,durationDays:30,startsAt:null,maturesAt:null,riskLevel:'MODERATE',status:'AVAILABLE',demoEligible:true,realEligible:true,requiresApproval:true,targetPrice:null,stopPrice:null}});
	expect(opportunityResponse.status()).toBe(201);
	const opportunity=await opportunityResponse.json();
	const userContext=await browser.newContext();
	try{
		const userPage=await userContext.newPage();
		await loginAs(userPage,demoUser.email,demoUser.password);
		await selectAccountMode(userPage,'DEMO');
		const userId=await userPage.request.get('/api/profile').then(response=>response.json().then(profile=>profile.id));
		const before=Number((await userPage.request.get('/api/wallet').then(response=>response.json())).balance);
		const initialEligible=await userPage.request.get('/api/investments').then(response=>response.json());
		expect(initialEligible).toMatchObject({accountMode:'DEMO',availableBalance:'0',opportunities:[],requests:[]});
		await db.fundingRequest.create({data:{userId,type:'WITHDRAWAL',method:'E2E reserved withdrawal',amount:500,currency:'USD',accountMode:'DEMO',status:'PENDING_REVIEW'}});
		const userOverdraw=await userPage.request.post('/api/investments',{headers:{'Idempotency-Key':randomUUID()},data:{opportunityId:opportunity.id,amount:100}});
		expect(userOverdraw.status()).toBe(403);
		expect((await userOverdraw.json()).error).toContain('unavailable in DEMO');
		const expectedAvailable=Prisma.Decimal.max(0,new Prisma.Decimal(before).minus(500)).toString();
		expect((await userPage.request.get('/api/investments').then(response=>response.json())).availableBalance).toBe('0');
		const eligibleUsers=await page.request.get(`/api/admin/investments/users?search=${encodeURIComponent(demoUser.email)}`).then(response=>response.json());
		expect(eligibleUsers.items.find((item:{id:string})=>item.id===userId).availableBalances.DEMO).toBe(expectedAvailable);
		expect((await userPage.request.get('/api/investments').then(response=>response.json())).opportunities).toEqual([]);
		const idempotencyKey=randomUUID();
		const startsAt=new Date(Date.now()-1000);
		const maturesAt=new Date(startsAt.getTime()+30*86_400_000);
		const payload={action:'initiate',userId,opportunityId:opportunity.id,accountMode:'DEMO',amount:250,targetReturnPercent:8,startsAt:startsAt.toISOString(),maturesAt:maturesAt.toISOString()};
		const initiated=await page.request.post('/api/admin/investments',{headers:{'Idempotency-Key':idempotencyKey},data:payload});
		expect(initiated.status()).toBe(201);
		const investment=await initiated.json();
		expect(investment).toMatchObject({userId,accountMode:'DEMO',amount:'250',status:'ACTIVE',targetReturnPercent:'8'});
		const replay=await page.request.post('/api/admin/investments',{headers:{'Idempotency-Key':idempotencyKey},data:payload});
		expect(replay.status()).toBe(200);
		expect((await replay.json()).id).toBe(investment.id);
		const mismatchedReplay=await page.request.post('/api/admin/investments',{headers:{'Idempotency-Key':idempotencyKey},data:{...payload,amount:300}});
		expect(mismatchedReplay.status()).toBe(409);
		expect(await db.ledgerTransaction.count({where:{reference:`INVESTMENT:${investment.id}:RESERVE`}})).toBe(1);
		expect(Number((await userPage.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(before-250);
		expect((await userPage.request.get('/api/investments').then(response=>response.json())).requests).toEqual([]);

		const scheduledStart=new Date(Date.now()+60_000);
		const scheduledEnd=new Date(scheduledStart.getTime()+7*86_400_000);
		const scheduledResponse=await page.request.post('/api/admin/investments',{headers:{'Idempotency-Key':randomUUID()},data:{...payload,amount:100,startsAt:scheduledStart.toISOString(),maturesAt:scheduledEnd.toISOString()}});
		expect(scheduledResponse.status()).toBe(201);
		const scheduled=await scheduledResponse.json();
		expect(scheduled.status).toBe('APPROVED');
		await settleMaturedSimulatedInvestments(new Date(scheduledStart.getTime()+1));
		expect((await db.investmentRequest.findUniqueOrThrow({where:{id:scheduled.id}})).status).toBe('ACTIVE');
		expect(Number((await userPage.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(before-350);
		await db.investmentRequest.update({where:{id:scheduled.id},data:{maturesAt:new Date(Date.now()-1000)}});
		await settleMaturedSimulatedInvestments(new Date());
		const settled=await db.investmentRequest.findUniqueOrThrow({where:{id:scheduled.id}});
		expect(settled.status).toBe('SETTLED');
		expect(settled.simulatedPayout?.toFixed(2)).toBe('108.00');
		expect(await db.ledgerTransaction.count({where:{reference:`INVESTMENT:${scheduled.id}:SIMULATED_RETURN`}})).toBe(0);
		expect(Number((await userPage.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(before-242);

		const currentBalance=Number((await userPage.request.get('/api/wallet').then(response=>response.json())).balance);
		const overBalance=await page.request.post('/api/admin/investments',{headers:{'Idempotency-Key':randomUUID()},data:{...payload,amount:currentBalance+1}});
		expect(overBalance.status()).toBe(400);
	}finally{await userContext.close();}
});
