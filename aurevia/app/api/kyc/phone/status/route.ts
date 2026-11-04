import {randomUUID} from 'node:crypto';
import {NextResponse} from 'next/server';
import {z,ZodError} from 'zod';
import {requireUser} from '@/lib/auth';
import {rateLimit} from '@/lib/rate-limit';
import {AkedlyProviderError} from '@/lib/akedly';
import {getAkedlyVerificationState,reconcileAkedlyAttempt} from '@/lib/akedly-verification';
import {VerificationChannel} from '@prisma/client';
import {db} from '@/lib/db';
import {isTierThreePhoneVerificationEligible,getTierProfileRequirements} from '@/lib/production-policy';

const schema=z.object({attemptId:z.string().min(8).max(200)});

export async function POST(request:Request){
	try{
		const user=await requireUser();
		const {attemptId}=schema.parse(await request.json());
		const account=await db.user.findUnique({where:{id:user.id},select:{
			accountMode:true,status:true,approvedTier:true,name:true,country:true,phone:true,
		}});
		if(!account||!isTierThreePhoneVerificationEligible({
			accountMode:account.accountMode,
			accountStatus:account.status,
			approvedTier:account.approvedTier,
			profileComplete:getTierProfileRequirements(account).profileComplete,
		}))return NextResponse.json({error:'Complete your name and country in Profile before checking phone verification.'},{status:403});
		rateLimit(`akedly-phone-status-ip:${request.headers.get('x-forwarded-for')||'unknown'}`,30,60_000);
		rateLimit(`akedly-phone-status-user:${user.id}`,30,60_000);
		let state=await getAkedlyVerificationState(user.id,attemptId,VerificationChannel.SMS);
		if(!state)return NextResponse.json({error:'Verification attempt not found.'},{status:404});
		if(state.verified)return NextResponse.json({verified:true});
		if(state.expiresAt<=new Date())return NextResponse.json({verified:false,expired:true});
		try{
			await reconcileAkedlyAttempt(attemptId,user.id);
			state=await getAkedlyVerificationState(user.id,attemptId,VerificationChannel.SMS);
		}catch(error){
			const requestId=randomUUID();
			console.warn('[akedly-phone] Provider status reconciliation failed.',{
				requestId,
				referenceId:requestId,
				endpoint:'/api/kyc/phone/status',
				failureCode:error instanceof AkedlyProviderError?error.message:error instanceof Error?error.name:'UNKNOWN_ERROR',
				failureTimestamp:error instanceof AkedlyProviderError?error.failureTimestamp:new Date().toISOString(),
				providerEndpoint:error instanceof AkedlyProviderError?error.providerEndpoint:null,
				providerAttemptId:error instanceof AkedlyProviderError?error.providerAttemptId||null:null,
				providerHttpStatus:error instanceof AkedlyProviderError?error.httpStatus||null:null,
				...(error instanceof AkedlyProviderError&&error.providerCode?{providerCode:error.providerCode}:{}),
			});
			return NextResponse.json({
				error:'Unable to check phone verification right now.',
				requestId,
				referenceId:requestId,
			},{status:503,headers:{'Cache-Control':'no-store'}});
		}
		if(!state)return NextResponse.json({error:'Verification attempt not found.'},{status:404});
		if(state.verified)return NextResponse.json({verified:true});
		return NextResponse.json({verified:false,expired:state.expiresAt<=new Date()});
	}catch(error){
		if(error instanceof ZodError)return NextResponse.json({error:'Invalid phone verification status request.'},{status:400});
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Sign in to check phone verification.'},{status:401});
		if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'Please wait before checking verification again.'},{status:429});
		console.error('[akedly-phone] Unable to check verification status.',{errorType:error instanceof Error?error.name:'UnknownError'});
		return NextResponse.json({error:'Unable to check phone verification right now.'},{status:503});
	}
}
