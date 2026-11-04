import {NextResponse} from 'next/server';
import {AccountMode,NotificationType,Prisma,TierUpgradeStatus} from '@prisma/client';
import {z,ZodError} from 'zod';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {createNotification,notifyActiveAdmins} from '@/lib/notifications';
import {getAccountTier,getTierProfileRequirements} from '@/lib/production-policy';
import {synchronizeCompletedProfileTier} from '@/lib/tier-progression';
import {rateLimit} from '@/lib/rate-limit';
import {jsonSafe} from '@/lib/serializers';

const schema=z.object({message:z.string().trim().max(1000).optional()});
const replySchema=z.object({id:z.string().min(1),message:z.string().trim().min(3).max(1000)});
const openStatuses:TierUpgradeStatus[]=[TierUpgradeStatus.PENDING_REVIEW,TierUpgradeStatus.NEEDS_INFORMATION];

export async function GET(){
	try{
		const user=await requireUser();
		const state=await db.$transaction(async tx=>{
			const activeUser=await tx.user.findUnique({where:{id:user.id},select:{id:true,status:true}});
			if(!activeUser||activeUser.status!=='ACTIVE')throw new Error('ACCOUNT_UNAVAILABLE');
			await synchronizeCompletedProfileTier(tx,user.id);
			const [profile,requests]=await Promise.all([
				tx.user.findUnique({where:{id:user.id},select:{id:true,accountMode:true,approvedTier:true,kycStatus:true,name:true,country:true,phone:true,phoneVerified:true,kyc:{select:{submittedAt:true,address:true}},kycDocuments:{where:{kind:{in:['IDENTITY_DOCUMENT','SELFIE','PROOF_OF_ADDRESS']}},select:{id:true,kind:true,status:true}}}}),
				tx.tierUpgradeRequest.findMany({where:{userId:user.id},orderBy:{createdAt:'desc'},select:{id:true,currentTier:true,requestedTier:true,status:true,userMessage:true,adminReason:true,reviewedAt:true,createdAt:true,updatedAt:true}}),
			]);
			if(!profile)throw new Error('PROFILE_NOT_FOUND');
			const requirements=getTierProfileRequirements(profile);
			const approvedDocuments=profile.kycDocuments.filter(item=>item.kind==='IDENTITY_DOCUMENT'&&item.status==='APPROVED').length;
			const tier=getAccountTier({accountMode:profile.accountMode,kycStatus:profile.kycStatus,verificationDocuments:approvedDocuments,verificationSubmitted:!!profile.kyc?.submittedAt,phoneVerified:profile.phoneVerified,profileComplete:requirements.profileComplete,approvedTier:profile.approvedTier});
			const currentTier=Number(tier.label.at(-1));
			const identityDocumentApproved=profile.kycDocuments.some(item=>item.kind==='IDENTITY_DOCUMENT'&&item.status==='APPROVED');
			const selfieApproved=profile.kycDocuments.some(item=>item.kind==='SELFIE'&&item.status==='APPROVED');
			const proofOfAddressUploaded=profile.kycDocuments.some(item=>item.kind==='PROOF_OF_ADDRESS'&&item.status!=='REJECTED'&&item.status!=='RESUBMISSION_REQUIRED');
			const identityDocumentUploaded=profile.kycDocuments.some(item=>item.kind==='IDENTITY_DOCUMENT'&&item.status!=='REJECTED'&&item.status!=='RESUBMISSION_REQUIRED');
			const selfieUploaded=profile.kycDocuments.some(item=>item.kind==='SELFIE'&&item.status!=='REJECTED'&&item.status!=='RESUBMISSION_REQUIRED');
			const canRequest=currentTier===2&&profile.accountMode===AccountMode.REAL&&requirements.profileComplete&&profile.phoneVerified&&!!profile.kyc?.submittedAt&&Boolean(profile.kyc.address?.trim())&&identityDocumentUploaded&&selfieUploaded&&proofOfAddressUploaded&&!requests.some(request=>openStatuses.includes(request.status));
			return {
				tier:tier.label,
				currentTier,
				progress:tier.progress,
				accountMode:profile.accountMode,
				canRequest,
				requirements:{
					...requirements,
					phoneVerified:profile.phoneVerified,
					verificationSubmitted:!!profile.kyc?.submittedAt,
					identityDocumentUploaded,
					identityDocumentApproved:identityDocumentApproved,
					selfieUploaded,
					selfieApproved,
					proofOfAddressUploaded,
					proofOfAddressSubmitted:proofOfAddressUploaded,
					identityApproved:profile.kycStatus==='APPROVED',
				},
				permissions:{
					basicAccountAccess:true,
					profileManagement:true,
					identityVerification:profile.accountMode===AccountMode.REAL&&requirements.profileComplete,
					tierBenefits:currentTier>=2,
					verifiedAccount:currentTier===3,
					realMoneyServices:profile.accountMode===AccountMode.REAL,
				},
				requests,
			};
		});
		return NextResponse.json(jsonSafe(state),{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		const unauthorized=error instanceof Error&&error.message==='UNAUTHORIZED';
		const status=unauthorized?401:error instanceof Error&&error.message==='ACCOUNT_UNAVAILABLE'?403:503;
		return NextResponse.json({error:unauthorized?'Unauthorized':status===403?'This account is unavailable.':'Unable to load tier status.'},{status,headers:{'Cache-Control':'private, no-store'}});
	}
}

export async function POST(request:Request){
	try{
		const user=await requireUser();
		rateLimit(`tier-request:${user.id}`,3,60*60_000);
		const input=schema.parse(await request.json());
		const result=await db.$transaction(async tx=>{
			const profile=await tx.user.findUniqueOrThrow({where:{id:user.id},select:{id:true,status:true,accountMode:true,approvedTier:true,kycStatus:true,name:true,country:true,phone:true,phoneVerified:true,kyc:{select:{submittedAt:true,address:true}},kycDocuments:{where:{kind:{in:['IDENTITY_DOCUMENT','SELFIE','PROOF_OF_ADDRESS']}},select:{kind:true,status:true}}}});
			if(profile.status!=='ACTIVE')throw new Error('ACCOUNT_UNAVAILABLE');
			if(profile.accountMode!==AccountMode.REAL)throw new Error('REAL_MODE_REQUIRED');
			await synchronizeCompletedProfileTier(tx,user.id);
			const requirements=getTierProfileRequirements(profile);
			const tier=getAccountTier({accountMode:profile.accountMode,kycStatus:profile.kycStatus,verificationDocuments:profile.kycDocuments.filter(item=>item.status==='APPROVED').length,verificationSubmitted:!!profile.kyc?.submittedAt,phoneVerified:profile.phoneVerified,profileComplete:requirements.profileComplete,approvedTier:profile.approvedTier});
			const currentTier=Number(tier.label.at(-1));
			if(currentTier>=3)throw new Error('MAXIMUM_TIER');
			if(!requirements.profileComplete)throw new Error('PROFILE_INCOMPLETE');
			const identityDocumentSubmitted=profile.kycDocuments.some(item=>item.kind==='IDENTITY_DOCUMENT'&&item.status!=='REJECTED'&&item.status!=='RESUBMISSION_REQUIRED');
			const selfieSubmitted=profile.kycDocuments.some(item=>item.kind==='SELFIE'&&item.status!=='REJECTED'&&item.status!=='RESUBMISSION_REQUIRED');
			const proofOfAddressSubmitted=profile.kycDocuments.some(item=>item.kind==='PROOF_OF_ADDRESS'&&item.status!=='REJECTED'&&item.status!=='RESUBMISSION_REQUIRED');
			if(currentTier!==2||!profile.phoneVerified||!profile.kyc?.submittedAt||!profile.kyc.address?.trim()||!identityDocumentSubmitted||!selfieSubmitted||!proofOfAddressSubmitted)throw new Error('VERIFICATION_MISSING');
			const active=await tx.tierUpgradeRequest.findFirst({where:{userId:user.id,status:{in:openStatuses}}});
			if(active)throw new Error('REQUEST_PENDING');
			const requestRecord=await tx.tierUpgradeRequest.create({data:{userId:user.id,currentTier,requestedTier:3,userMessage:input.message||null}});
			await tx.auditLog.create({data:{actorId:user.id,action:'TIER_UPGRADE_REQUESTED',entity:'TIER_REQUEST',entityId:requestRecord.id,metadata:{currentTier,requestedTier:3}}});
			await createNotification(tx,{userId:user.id,type:NotificationType.ACCOUNT,title:'Tier 3 review requested',message:'Your Tier 3 request is awaiting administrator review of your submitted identity information and documents.',dedupeKey:`tier-request:${requestRecord.id}:user`,relatedEntity:'TIER_REQUEST',relatedId:requestRecord.id,actionUrl:'/tier'});
			await notifyActiveAdmins(tx,{type:NotificationType.ACCOUNT,title:'Tier 3 review requested',message:'A user completed the Tier 3 submission requirements and is awaiting administrator identity review.',dedupeKey:`tier-request:${requestRecord.id}:admin`,relatedEntity:'TIER_REQUEST',relatedId:requestRecord.id,actionUrl:'/admin/tiers'});
			return requestRecord;
		},{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
		return NextResponse.json(jsonSafe(result),{status:201,headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		if(error instanceof ZodError)return NextResponse.json({error:'Provide a valid optional note of at most 1,000 characters.'},{status:400});
		if(error instanceof SyntaxError)return NextResponse.json({error:'Tier request data must be valid JSON.'},{status:400});
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		if(error instanceof Error&&error.message==='REAL_MODE_REQUIRED')return NextResponse.json({error:'Tier 3 review is available in REAL mode only.'},{status:403});
		if(error instanceof Error&&error.message==='ACCOUNT_UNAVAILABLE')return NextResponse.json({error:'This account is unavailable.'},{status:403});
		if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'You have submitted several tier requests recently. Try again later.'},{status:429});
		const messages:Record<string,string>={MAXIMUM_TIER:'You are already at the highest available tier.',PROFILE_INCOMPLETE:'Complete your name, country, and phone number in Profile before requesting Tier 3 review.',VERIFICATION_MISSING:'Complete your identity submission, upload an ID, selfie, and proof of address, and verify your phone before requesting Tier 3 review.',REQUEST_PENDING:'A tier request is already awaiting review.'};
		if(error instanceof Error&&messages[error.message])return NextResponse.json({error:messages[error.message]},{status:409});
		const code=error&&typeof error==='object'&&'code' in error?String(error.code):'';
		if(code==='P2002')return NextResponse.json({error:'A tier request is already awaiting review.'},{status:409});
		if(code==='P2034')return NextResponse.json({error:'Tier request state changed. Refresh your tier status and try again.'},{status:409});
		console.error('Tier upgrade request could not be saved.',{errorType:error instanceof Error?error.name:'UnknownError'});
		return NextResponse.json({error:'Unable to submit the tier review request.'},{status:503});
	}
}

export async function PATCH(request:Request){
	try{
		const user=await requireUser();
		rateLimit(`tier-request-reply:${user.id}`,3,60*60_000);
		const input=replySchema.parse(await request.json());
		const result=await db.$transaction(async tx=>{
			const activeUser=await tx.user.findUniqueOrThrow({where:{id:user.id},select:{accountMode:true,status:true}});
			if(activeUser.status!=='ACTIVE')throw new Error('ACCOUNT_UNAVAILABLE');
			if(activeUser.accountMode!==AccountMode.REAL)throw new Error('REAL_MODE_REQUIRED');
			const current=await tx.tierUpgradeRequest.findFirst({where:{id:input.id,userId:user.id,status:TierUpgradeStatus.NEEDS_INFORMATION}});
			if(!current)throw new Error('REQUEST_NOT_FOUND');
			const changed=await tx.tierUpgradeRequest.updateMany({
				where:{id:current.id,userId:user.id,status:TierUpgradeStatus.NEEDS_INFORMATION,updatedAt:current.updatedAt},
				data:{userMessage:input.message,status:TierUpgradeStatus.PENDING_REVIEW,reviewedById:null,reviewedAt:null},
			});
			if(changed.count!==1)throw new Error('REQUEST_CHANGED');
			const updated=await tx.tierUpgradeRequest.findUniqueOrThrow({where:{id:current.id}});
			await tx.auditLog.create({data:{actorId:user.id,action:'TIER_REQUEST_INFORMATION_SUBMITTED',entity:'TIER_REQUEST',entityId:current.id,metadata:{requestedTier:current.requestedTier}}});
			await createNotification(tx,{userId:user.id,type:NotificationType.ACCOUNT,title:'Tier review information submitted',message:`Your additional information for Tier ${current.requestedTier} review was sent to an administrator.`,dedupeKey:`tier-request:${current.id}:user-reply:${updated.updatedAt.toISOString()}`,relatedEntity:'TIER_REQUEST',relatedId:current.id,actionUrl:'/tier'});
			await notifyActiveAdmins(tx,{type:NotificationType.ACCOUNT,title:'Tier review information received',message:`A user submitted additional information for tier request ${current.id}.`,dedupeKey:`tier-request:${current.id}:admin-reply:${updated.updatedAt.toISOString()}`,relatedEntity:'TIER_REQUEST',relatedId:current.id,actionUrl:'/admin/tiers'});
			return updated;
		});
		return NextResponse.json(jsonSafe(result),{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		if(error instanceof ZodError)return NextResponse.json({error:'Provide a response of at least 3 and at most 1,000 characters.'},{status:400});
		if(error instanceof SyntaxError)return NextResponse.json({error:'Tier response must be valid JSON.'},{status:400});
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		if(error instanceof Error&&error.message==='REAL_MODE_REQUIRED')return NextResponse.json({error:'Tier 3 review is available in REAL mode only.'},{status:403});
		if(error instanceof Error&&error.message==='ACCOUNT_UNAVAILABLE')return NextResponse.json({error:'This account is unavailable.'},{status:403});
		if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'You have submitted several tier responses recently. Try again later.'},{status:429});
		if(error instanceof Error&&error.message==='REQUEST_NOT_FOUND')return NextResponse.json({error:'No tier request is waiting for your information.'},{status:404});
		if(error instanceof Error&&error.message==='REQUEST_CHANGED')return NextResponse.json({error:'This tier request changed during submission. Refresh your tier status and try again.'},{status:409});
		console.error('Tier review information could not be saved.',{errorType:error instanceof Error?error.name:'UnknownError'});
		return NextResponse.json({error:'Unable to submit tier review information.'},{status:503});
	}
}
