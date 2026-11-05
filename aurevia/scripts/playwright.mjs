import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const cliPath=fileURLToPath(new URL('../node_modules/@playwright/test/cli.js',import.meta.url));
const browserPath=resolve('tools/playwright/browsers');
const child=spawn(process.execPath,[cliPath,...process.argv.slice(2)],{
	stdio:'inherit',
	env:{...process.env,PLAYWRIGHT_BROWSERS_PATH:process.env.PLAYWRIGHT_BROWSERS_PATH||browserPath},
});

child.on('error',error=>{
	console.error(`Unable to start Playwright: ${error.message}`);
	process.exitCode=1;
});
child.on('exit',(code,signal)=>{
	process.exitCode=signal?1:code??1;
});
