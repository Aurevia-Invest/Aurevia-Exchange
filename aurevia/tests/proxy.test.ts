import {describe,expect,it,vi} from 'vitest';

vi.mock('next-auth/middleware',()=>({withAuth:(handler:unknown)=>handler}));

import middleware from '../proxy';

function request(pathname:string,role:'USER'|'ADMIN'){
	return {
		nextauth:{token:{role}},
		nextUrl:{pathname},
		url:`https://aurevia.test${pathname}`,
	} as never;
}

describe('admin route middleware',()=>{
	it('allows a signed-in user to open the administrator sign-in page',async()=>{
		const response=await middleware(request('/admin/login','USER'),{} as never);

		expect(response?.status).toBe(200);
		expect(response?.headers.get('location')).toBeNull();
	});

	it('continues to keep regular users out of the admin dashboard',async()=>{
		const response=await middleware(request('/admin','USER'),{} as never);

		expect(response?.status).toBe(307);
		expect(response?.headers.get('location')).toBe('https://aurevia.test/dashboard');
	});
});
