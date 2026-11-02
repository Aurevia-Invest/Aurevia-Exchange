import {NextResponse} from 'next/server';
import {NotificationType,Prisma,VerificationChannel} from '@prisma/client';
import {z,ZodError} from 'zod';
import {db} from '@/lib/db';
import {createNotification} from '@/lib/notifications';
import {rateLimit} from '@/lib/rate-limit';
import {verificationConfig} from '@/lib/config';
import {verificationCodeMatches} from '@/lib/verification-delivery';

const schema=z.object({email:z.string().trim().email().max(254),code:z.string().regex(/^\d{6}$/)});

export async function POST(req:Request){
	try{
		const input=schema.parse(await req.json());
		const email=input.email.toLowerCase();
		const ip=req.headers.get('x-forwarded-for')||'unknown';
		rateLimit(`verify-ip:${ip}`,15,15*60_000);
		rateLimit(`verify-email:${email}`,verificationConfig.maxAttempts*4,60*60_000);
		const user=await db.user.findUnique({where:{email},select:{id:true,emailVerifiedAt:true,requiresRegistrationVerification:true}});
		if(!user||user.emailVerifiedAt)return NextResponse.json({error:'The code is invalid or no longer available.'},{status:400});
		const challenge=await db.verificationCode.findUnique({where:{userId:user.id}});
		if(!challenge||challenge.channel!==VerificationChannel.EMAIL)return NextResponse.json({error:'The code is invalid or no longer available.'},{status:400});
		if(user.requiresRegistrationVerification&&challenge.providerReference?.startsWith('AKEDLY:'))return NextResponse.json({error:'Complete verification in the secure Akedly widget instead.'},{status:409});
		const now=new Date();
		if(challenge.expiresAt<=now){
			await db.verificationCode.deleteMany({where:{id:challenge.id,expiresAt:{lte:now}}});
			return NextResponse.json({error:'This code has expired. Request a new code.'},{status:410});
		}
		if(challenge.attempts>=verificationConfig.maxAttempts)return NextResponse.json({error:'Too many attempts. Request a new code.'},{status:429});
		if(!verificationCodeMatches(user.id,input.code,challenge.codeHash)){
			await db.verificationCode.updateMany({where:{id:challenge.id,attempts:{lt:verificationConfig.maxAttempts},expiresAt:{gt:now}},data:{attempts:{increment:1}}});
			const updated=await db.verificationCode.findUnique({where:{id:challenge.id},select:{attempts:true}});
			return NextResponse.json({error:updated&&updated.attempts>=verificationConfig.maxAttempts?'Too many attempts. Request a new code.':'The code is incorrect.'},{status:updated&&updated.attempts>=verificationConfig.maxAttempts?429:400});
		}
		await db.$transaction(async tx=>{
			const consumed=await tx.verificationCode.deleteMany({where:{id:challenge.id,codeHash:challenge.codeHash,attempts:{lt:verificationConfig.maxAttempts},expiresAt:{gt:now}}});
			if(consumed.count!==1)throw new Error('VERIFICATION_CODE_CONSUMED');
			await tx.user.update({where:{id:user.id},data:{emailVerifiedAt:now,verifiedChannel:VerificationChannel.EMAIL,requiresRegistrationVerification:false}});
			await createNotification(tx,{userId:user.id,type:NotificationType.ACCOUNT,title:'Email address verified',message:'Your email address was verified through the configured email provider.',dedupeKey:`registration:${user.id}:verified:email`,actionUrl:'/dashboard'});
		});
		return NextResponse.json({verified:true});
	}catch(error){
		if(error instanceof ZodError)return NextResponse.json({error:'Enter the email address and six-digit verification code.'},{status:400});
		if(error instanceof Prisma.PrismaClientKnownRequestError&&error.code==='P2025')return NextResponse.json({error:'The code is invalid or no longer available.'},{status:400});
		if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'Too many verification attempts. Try again later.'},{status:429});
		if(error instanceof Error&&error.message==='VERIFICATION_CODE_CONSUMED')return NextResponse.json({error:'The code is invalid or no longer available.'},{status:409});
		return NextResponse.json({error:'Unable to verify this account right now.'},{status:500});
	}
}