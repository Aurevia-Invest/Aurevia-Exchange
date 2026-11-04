import {NextResponse} from 'next/server';
import {withAuth,type NextRequestWithAuth} from 'next-auth/middleware';

const protectedRoutes=['/dashboard','/trade','/portfolio','/orders','/investments','/wallet','/kyc','/settings','/notifications','/activity','/tier'];
const isProtectedRoute=(pathname:string)=>protectedRoutes.some(route=>pathname===route||pathname.startsWith(`${route}/`));

export default withAuth(function middleware(request:NextRequestWithAuth){
	const role=request.nextauth.token?.role;
	const pathname=request.nextUrl.pathname;
	if(role==='ADMIN'&&!pathname.startsWith('/admin'))return NextResponse.redirect(new URL('/admin',request.url));
	if(role==='USER'&&pathname.startsWith('/admin')&&pathname!=='/admin/login')return NextResponse.redirect(new URL('/dashboard',request.url));
	return NextResponse.next();
},{callbacks:{authorized:({token,req})=>{
	const pathname=req.nextUrl.pathname;
	if(pathname==='/admin/login')return true;
	if(pathname.startsWith('/admin'))return token?.role==='ADMIN';
	if(token?.role==='ADMIN')return true;
	if(isProtectedRoute(pathname))return token?.role==='USER';
	return true;
}}});

export const config={matcher:['/((?!api|_next/static|_next/image|favicon.ico|.*\\..*).*)']};
