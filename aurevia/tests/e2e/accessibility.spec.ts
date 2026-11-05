import AxeBuilder from '@axe-core/playwright';
import {test,expect,loginAs,logout,waitForStartup} from './fixtures';

async function expectAccessible(page:import('@playwright/test').Page,label:string){
	const {violations}=await new AxeBuilder({page}).analyze();
	expect(violations.map(({id,impact,help,nodes})=>({
		id,impact,help,
		elements:nodes.slice(0,12).map(node=>({target:node.target,details:node.any.map(result=>result.data)})),
	})),label).toEqual([]);
}

test('signup, dashboard, and admin pages pass axe accessibility checks',async({page})=>{
	await page.goto('/register');
	await waitForStartup(page);
	await expectAccessible(page,'signup');

	await loginAs(page,process.env.AUREVIA_E2E_USER_EMAIL!,process.env.AUREVIA_E2E_USER_PASSWORD!);
	await page.goto('/dashboard');
	await waitForStartup(page);
	await expectAccessible(page,'dashboard');

	await page.setViewportSize({width:390,height:844});
	await page.goto('/settings#security');
	await waitForStartup(page);
	await expect(page.getByRole('heading',{name:'Financial Account Security Center'})).toBeVisible();
	await expectAccessible(page,'mobile security settings');

	await page.setViewportSize({width:1440,height:900});
	await logout(page);
	await loginAs(page,process.env.AUREVIA_E2E_ADMIN_EMAIL!,process.env.AUREVIA_E2E_ADMIN_PASSWORD!);
	await page.goto('/admin');
	await waitForStartup(page);
	await expectAccessible(page,'admin');
});
