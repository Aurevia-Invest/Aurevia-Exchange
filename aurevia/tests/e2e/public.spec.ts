import {test,expect,expectNoHorizontalOverflow,waitForStartup} from './fixtures';

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

const publicRoutes=['/','/login','/register','/markets','/stories','/client-stories','/about','/education','/support','/waitlist','/terms','/privacy','/risk-disclosure','/forgot-password','/reset-password'];

test.describe('public routes and responsive layout',()=>{
	for(const viewport of viewports){
		test(`public routes render without horizontal overflow at ${viewport.width}x${viewport.height}`,async({page})=>{
			await page.setViewportSize(viewport);
			for(const route of publicRoutes){
				const response=await page.goto(route);
				expect(response?.status(),route).toBe(200);
				await expect(page.locator('h1').first(),route).toBeVisible();
				if(route==='/markets')await expect(page.getByRole('heading',{name:'Markets',exact:true})).toBeVisible();
				if(route==='/support')await expect(page.getByRole('heading',{name:'Nova AI',exact:true})).toBeVisible();
				if(route==='/register'){
					await expect(page.getByRole('radio',{name:/DEMO ACCOUNT/})).toBeVisible();
					await expect(page.getByRole('radio',{name:/REAL ACCOUNT/})).toBeVisible();
				}
				await expectNoHorizontalOverflow(page);
			}
		});
	}
});

test('homepage keeps Stories in navigation and off the landing content',async({page})=>{
	for(const width of [320,375,414]){
		await page.setViewportSize({width,height:844});
		await page.goto('/');
		await expect(page.locator('.stories-section')).toHaveCount(0);
		await expect(page.locator('.client-stories-rotator')).toHaveCount(0);
		const menu=page.getByRole('button',{name:'Open navigation'});
		if(await menu.isVisible())await menu.click();
		await expect(page.locator('#primary-navigation').getByRole('link',{name:'Stories',exact:true})).toHaveAttribute('href','/stories');
		await expectNoHorizontalOverflow(page);
	}
});

test('homepage hero actions remain usable with reduced motion',async({browser,page})=>{
	await page.setViewportSize({width:1280,height:900});
	await page.goto('/');
	await expect(page.locator('.home-hero').locator('h1').first()).toBeVisible();
	await expect(page.locator('.home-hero-actions a[href="/register"]')).toBeVisible();
	await expect(page.locator('.home-hero-actions a[href="/login"]')).toBeVisible();
	await expectNoHorizontalOverflow(page);

	const nextSession=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce'});
	try{
		const nextPage=await nextSession.newPage();
		await nextPage.goto('/');
		await waitForStartup(nextPage);
		await expect(nextPage.locator('.home-hero').locator('h1').first()).toBeVisible();
		await expect(nextPage.locator('.home-hero-actions a[href="/register"]')).toBeVisible();
		await expectNoHorizontalOverflow(nextPage);
	}finally{await nextSession.close();}
});

test('homepage labels internal reference prices as non-live market data',async({page})=>{
	await page.goto('/');
	await expect(page.locator('.market-time .live-pill')).toHaveText('REFERENCE');
	await expect(page.locator('.market-feed-status')).toContainText('Internal reference feed');
});

test('homepage accurately lists the seeded demo stock instrument',async({page})=>{
	await page.goto('/');
	const stocks=page.locator('.asset-item').filter({has:page.getByRole('heading',{name:'Stocks',exact:true})});
	await expect(stocks).toContainText('Available in demo');
	await expect(stocks).toContainText('NVDA');
	await expect(stocks).toContainText('not a live quote');
	await expect(stocks.getByRole('link')).toHaveAttribute('href','/login?callbackUrl=%2Ftrade');
});

test('site theme preference switches globally and persists across navigation',async({page})=>{
	await page.goto('/');
	const themeToggle=page.getByRole('button',{name:'Switch to light mode'});
	await themeToggle.click();
	await expect(page.locator('html')).toHaveAttribute('data-theme','light');
	await expect(page.locator('body')).toHaveCSS('background-color','rgb(249, 251, 253)');
	await page.goto('/about');
	await expect(page.locator('html')).toHaveAttribute('data-theme','light');
	await page.getByRole('button',{name:'Switch to dark mode'}).click();
	await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
});

test('public disclosures distinguish simulated activity, paper orders, and internal wallet funds',async({page})=>{
	await page.goto('/terms');
	await expect(page.getByText(/Alpaca Paper Trading only/)).toBeVisible();
	await expect(page.getByText(/broker-reported paper cash or returns are not Aurevia wallet funds/)).toBeVisible();
	await page.goto('/risk-disclosure');
	await expect(page.getByText(/not live-market executions/)).toBeVisible();
	await expect(page.getByText(/are not withdrawable through the Aurevia wallet/)).toBeVisible();
	await page.goto('/privacy');
	await expect(page.getByText(/private object-storage bucket/)).toBeVisible();
	await expect(page.locator('.info-note')).toContainText('short-lived links');
});
