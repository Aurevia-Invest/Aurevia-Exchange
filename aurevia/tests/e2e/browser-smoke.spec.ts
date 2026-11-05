import {test,expect} from './fixtures';

test('Aurevia loads in Chromium and reports a healthy isolated application',async({page})=>{
	const homepage=await page.goto('/');
	expect(homepage?.status()).toBe(200);
	await expect(page.locator('.home-hero h1').first()).toBeVisible();

	const health=await page.request.get('/api/health');
	expect(health.status()).toBe(200);
	await expect(health.json()).resolves.toMatchObject({
		ok:true,
		service:'aurevia-exchange',
		database:'ok',
	});
});
