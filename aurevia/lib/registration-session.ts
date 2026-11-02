import {randomUUID} from 'node:crypto';
import {encode} from 'next-auth/jwt';
import {NextResponse} from 'next/server';
import {db} from '@/lib/db';
import {AUTH_SESSION_MAX_AGE_SECONDS} from '@/lib/auth-session';
import {getServerConfiguration} from '@/lib/config/env';

export async function establishRegistrationSession(response:NextResponse,email:string){
	const user=await db.user.findUnique({
		where:{email},
		select:{
			id:true,
			email:true,
			name:true,
			role:true,
			status:true,
			accountMode:true,
			activeSessionId:true,
			requiresRegistrationVerification:true,
			emailVerifiedAt:true,
			phoneVerified:true,
			phoneVerifiedAt:true,
			verifiedChannel:true,
		},
	});
	const emailVerified=user?.verifiedChannel==='EMAIL'&&Boolean(user.emailVerifiedAt);
	const phoneVerified=user?.verifiedChannel==='SMS'&&user.phoneVerified&&Boolean(user.phoneVerifiedAt);
	if(!user||user.role!=='USER'||user.status!=='ACTIVE'||user.requiresRegistrationVerification||(!emailVerified&&!phoneVerified)){
		throw new Error('REGISTRATION_SESSION_NOT_AUTHORIZED');
	}
	const configuration=getServerConfiguration();
	if(!configuration.auth.secret)throw new Error('AUTH_SECRET_REQUIRED');
	const sessionId=randomUUID();
	const sessionToken=await encode({
		token:{
			id:user.id,
			sub:user.id,
			email:user.email,
			name:user.name,
			role:user.role,
			accountMode:user.accountMode,
			sessionId,
		},
		secret:configuration.auth.secret,
		maxAge:AUTH_SESSION_MAX_AGE_SECONDS,
	});
	const sessionStartedAt=new Date();
	const claimed=await db.user.updateMany({
		where:{id:user.id,activeSessionId:user.activeSessionId,status:'ACTIVE',requiresRegistrationVerification:false},
		data:{activeSessionId:sessionId,activeSessionUpdatedAt:sessionStartedAt},
	});
	if(claimed.count!==1)throw new Error('REGISTRATION_SESSION_CHANGED');
	const secureCookie=configuration.auth.url.startsWith('https://')||process.env.NODE_ENV==='production';
	response.cookies.set(`${secureCookie?'__Secure-':''}next-auth.session-token`,sessionToken,{
		httpOnly:true,
		secure:secureCookie,
		sameSite:'lax',
		path:'/',
		maxAge:AUTH_SESSION_MAX_AGE_SECONDS,
	});
	return response;
}
