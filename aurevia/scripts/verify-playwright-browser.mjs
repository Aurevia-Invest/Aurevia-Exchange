import {access,constants} from 'node:fs/promises';
import {chromium} from '@playwright/test';

const executable=chromium.executablePath();
await access(executable,constants.X_OK);
const browser=await chromium.launch({headless:true});
try{
	const page=await browser.newPage();
	await page.setContent('<!doctype html><title>Aurevia Chromium verification</title><main>Chromium is ready.</main>');
	const title=await page.title();
	if(title!=='Aurevia Chromium verification')throw new Error('Headless Chromium smoke page did not render.');
}finally{
	await browser.close();
}
console.log(`Chromium executable: ${executable}`);
console.log('Headless Chromium launch: passed');
