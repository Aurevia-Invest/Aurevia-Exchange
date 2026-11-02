import {NextResponse} from 'next/server';
import {randomUUID} from 'node:crypto';
import {z,ZodError} from 'zod';
import {Prisma,VerificationChannel} from '@prisma/client';
import {db} from '@/lib/db';
import {akedlyIsConfigured} from '@/lib/akedly';
import {startAkedlyVerification} from '@/lib/akedly-verification';
import {rateLimit} from '@/lib/rate-limit';
import {deliverVerificationCode,generateVerificationCode,hashVerificationCode,hasConfiguredVerificationProvider} from '@/lib/verification-delivery';
import {verificationConfig} from '@/lib/config';

const schema=z.object({email:z.string().trim().email().max(254)});
const genericResponse={message:'If the account is eligible, email verification can continue after the resend cooldown.'};

export async function POST(request:Request){
	try{
		const {email:rawEmail}=schema.parse(await request.json());
		const email=rawEmail.toLowerCase();
		const ip=request.headers.get('x-forwarded-for')||'unknown';
		rateLimit(`akedly-register-ip:${ip}`,5,60*60_000);
		rateLimit(`akedly-register-email:${email}`,3,60*60_000);
		const user=await db.user.findUnique({where:{email},select:{id:true,email:true,name:true,phone:true,emailVerifiedAt:true,requiresRegistrationVerification:true,role:true,status:true}});
		if(!user||user.role!=='USER'||user.status!=='ACTIVE'||user.emailVerifiedAt||!user.requiresRegistrationVerification)return NextResponse.json(genericResponse,{status:202});
		if(akedlyIsConfigured()){
			try{
				const attempt=await startAkedlyVerification(user.id,VerificationChannel.EMAIL,{email:user.email});
				return NextResponse.json({method:'akedly',message:'Complete the secure email verification widget.',...attempt},{status:200});
			}catch(error){
				if(error instanceof Error&&['AKEDLY_RESEND_COOLDOWN','AKEDLY_ATTEMPT_RESERVATION_LOST'].includes(error.message))throw error;
				const providerFailure=error instanceof Error&&[
					'AKEDLY_PROVIDER_UNAVAILABLE',
					'AKEDLY_ATTEMPT_REJECTED',
					'AKEDLY_INVALID_PROVIDER_RESPONSE',
					'AKEDLY_INVALID_WIDGET_URL',
				].includes(error.message);
				if(!providerFailure||!hasConfiguredVerificationProvider(VerificationChannel.EMAIL))throw error;
			}
		}
		if(!hasConfiguredVerificationProvider(VerificationChannel.EMAIL))return NextResponse.json({error:'Email verification is temporarily unavailable. Please try again later.'},{status:503});
		const now=new Date();
		const existing=await db.verificationCode.findUnique({where:{userId:user.id}});
		if(existing&&existing.resendAfter>now){
			if(existing.channel===VerificationChannel.EMAIL&&!existing.providerReference&&existing.expiresAt>now){
				return NextResponse.json({method:'email-code',message:'A verification code was already requested. Check your email.',resendAfterSeconds:Math.ceil((existing.resendAfter.getTime()-now.getTime())/1000)},{status:200});
			}
			return NextResponse.json({error:'Please wait before requesting another verification code.'},{status:429});
		}
		const code=generateVerificationCode();
		const codeHash=hashVerificationCode(user.id,code);
		const reservation=hashVerificationCode(user.id,`reservation:${randomUUID()}`);
		const expiresAt=new Date(now.getTime()+verificationConfig.expiresInMinutes*60_000);
		const resendAfter=new Date(now.getTime()+verificationConfig.resendCooldownSeconds*1000);
		if(existing){
			const reserved=await db.verificationCode.updateMany({
				where:{id:existing.id,resendAfter:{lte:now}},
				data:{codeHash:reservation,channel:VerificationChannel.EMAIL,providerReference:null,expiresAt,resendAfter,attempts:0},
			});
			if(reserved.count!==1)return NextResponse.json({error:'Please wait before requesting another verification code.'},{status:429});
		}else{
			try{
				await db.verificationCode.create({data:{userId:user.id,codeHash:reservation,channel:VerificationChannel.EMAIL,expiresAt,resendAfter}});
			}catch(error){
				if(error instanceof Prisma.PrismaClientKnownRequestError&&error.code==='P2002')return NextResponse.json({error:'Please wait before requesting another verification code.'},{status:429});
				throw error;
			}
		}
		const delivered=await deliverVerificationCode(VerificationChannel.EMAIL,user,code);
		if(!delivered){
			if(existing){
				await db.verificationCode.updateMany({where:{id:existing.id,codeHash:reservation},data:{
					codeHash:existing.codeHash,channel:existing.channel,providerReference:existing.providerReference,
					expiresAt:existing.expiresAt,resendAfter:existing.resendAfter,attempts:existing.attempts,
				}});
			}else{
				await db.verificationCode.deleteMany({where:{userId:user.id,codeHash:reservation}});
			}
			return NextResponse.json({error:'Email verification delivery failed. Please try again later.'},{status:502});
		}
		const saved=await db.verificationCode.updateMany({where:{userId:user.id,codeHash:reservation},data:{codeHash,channel:VerificationChannel.EMAIL,providerReference:null}});
		if(saved.count!==1)return NextResponse.json({error:'The verification request changed. Please request a new code.'},{status:409});
		return NextResponse.json({method:'email-code',message:'The email provider accepted the verification request. Delivery may take a short time.',resendAfterSeconds:verificationConfig.resendCooldownSeconds},{status:200});
	}catch(error){
		if(error instanceof ZodError)return NextResponse.json({error:'Enter a valid email address.'},{status:400});
		if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json(genericResponse,{status:202});
		if(error instanceof Error&&error.message==='AKEDLY_RESEND_COOLDOWN')return NextResponse.json({error:'Please wait before requesting another verification attempt.'},{status:429});
		if(error instanceof Error&&error.message.startsWith('AKEDLY_'))return NextResponse.json({error:'Email verification is temporarily unavailable. Please try again shortly.'},{status:503});
		console.error('[akedly-registration] Unable to create verification attempt.',{errorType:error instanceof Error?error.name:'UnknownError'});
		return NextResponse.json({error:'Unable to start email verification right now.'},{status:503});
	}
}
