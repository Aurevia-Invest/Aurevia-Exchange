import {NextResponse} from 'next/server';
import {getServerSession} from 'next-auth';
import {authOptions} from '@/lib/auth-options';
import {db} from '@/lib/db';
import {isNewDeviceVerificationFresh} from '@/lib/device-verification';
import {isSameOriginRequest} from '@/lib/push-notifications';
import {createTrustedDeviceToken,readTrustedDeviceToken,TRUSTED_DEVICE_COOKIE,TRUSTED_DEVICE_MAX_AGE_SECONDS,trustedDeviceLabel,trustedDeviceTokenHash} from '@/lib/trusted-device';

export async function POST(request:Request){
	try{
		if(!isSameOriginRequest(request))return NextResponse.json({error:'Cross-origin request blocked.'},{status:403});
		const sessionAuth=await getServerSession(authOptions);
		if(!sessionAuth?.user?.id||!sessionAuth.user.sessionHash)return NextResponse.json({error:'Unauthorized'},{status:401});
		const user=sessionAuth.user;
		const existingToken=readTrustedDeviceToken(request.headers.get('cookie'));
		if(existingToken){
			const existing=await db.trustedDevice.findFirst({
				where:{userId:user.id,tokenHash:trustedDeviceTokenHash(existingToken),revokedAt:null,expiresAt:{gt:new Date()}},
				select:{id:true},
			});
			if(existing)return NextResponse.json({trusted:true});
		}

		const session=await db.securitySession.findFirst({
			where:{userId:user.id,sessionHash:user.sessionHash,revokedAt:null,expiresAt:{gt:new Date()}},
			select:{id:true,userAgent:true,deviceVerificationAt:true},
		});
		if(!session||!isNewDeviceVerificationFresh(session.deviceVerificationAt))return NextResponse.json({error:'New-device verification is required.'},{status:403});

		const token=createTrustedDeviceToken();
		const now=new Date();
		await db.$transaction(async tx=>{
			const claimed=await tx.securitySession.updateMany({
				where:{id:session.id,deviceVerificationAt:session.deviceVerificationAt,revokedAt:null,expiresAt:{gt:now}},
				data:{deviceVerificationAt:null},
			});
			if(claimed.count!==1)throw new Error('DEVICE_VERIFICATION_ALREADY_USED');
			await tx.trustedDevice.create({data:{
				userId:user.id,
				tokenHash:trustedDeviceTokenHash(token),
				deviceLabel:trustedDeviceLabel(session.userAgent),
				userAgent:session.userAgent,
				expiresAt:new Date(now.getTime()+TRUSTED_DEVICE_MAX_AGE_SECONDS*1000),
			}});
		});

		const response=NextResponse.json({trusted:true});
		response.cookies.set(TRUSTED_DEVICE_COOKIE,token,{
			httpOnly:true,
			secure:process.env.NODE_ENV==='production',
			sameSite:'lax',
			path:'/',
			maxAge:TRUSTED_DEVICE_MAX_AGE_SECONDS,
		});
		return response;
	}catch(error){
		if(error instanceof Error&&error.message==='DEVICE_VERIFICATION_ALREADY_USED')return NextResponse.json({error:'New-device verification has already been used.'},{status:409});
		console.error('[auth] Trusted-device enrollment failed.',error instanceof Error?error.name:'UnknownError');
		return NextResponse.json({error:'Unable to remember this device right now.'},{status:503});
	}
}
