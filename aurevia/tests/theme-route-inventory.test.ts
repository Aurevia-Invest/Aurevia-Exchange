import {readdirSync,statSync} from 'node:fs';
import {join,relative,sep} from 'node:path';
import {describe,expect,it} from 'vitest';
import {themeRouteGroups,themeRoutePaths} from './e2e/theme-route-inventory';

function findPageFiles(directory:string):string[]{
	return readdirSync(directory).flatMap(name=>{
		const path=join(directory,name);
		if(statSync(path).isDirectory())return findPageFiles(path);
		return name==='page.tsx'||name==='page.ts'?[path]:[];
	});
}

function pageFileToRoute(path:string){
	const relativePath=relative(join(process.cwd(),'app'),path).split(sep).join('/');
	if(relativePath==='page.tsx'||relativePath==='page.ts')return '/';
	const route=relativePath.replace(/\/page\.(tsx|ts)$/,'');
	return `/${route}`;
}

describe('theme route coverage inventory',()=>{
	it('includes every App Router page file in at least one route sweep',()=>{
		const discovered=findPageFiles(join(process.cwd(),'app')).map(pageFileToRoute).sort();
		expect(themeRoutePaths.slice().sort()).toEqual(discovered);
	});

	it('covers nested routes and all authenticated roles',()=>{
		expect(themeRouteGroups.authenticated).toContain('/cards/[id]');
		expect(themeRouteGroups.authenticated).toContain('/tax-services/request/[id]');
		expect(themeRouteGroups.authenticated).toContain('/wallet/transactions/[id]');
		expect(themeRouteGroups.admin).toContain('/admin/news-feed');
		expect(themeRouteGroups.public).toContain('/auth/akedly/callback');
	});
});
