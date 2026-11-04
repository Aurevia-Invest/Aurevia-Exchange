import {NextResponse} from 'next/server';
import {AccountMode,NotificationType,Prisma,TierUpgradeStatus,UserStatus} from '@prisma/client';
import {z,ZodError} from 'zod';
import {requireAdmin} from '@/lib/auth';
import {db} from '@/lib/db';
import {createNotification} from '@/lib/notifications';
import {getAccountTier,getTierProfileRequirements,validateTierThreeApproval,validateTierUpgradeApproval} from '@/lib/production-policy';
import {jsonSafe} from '@/lib/serializers';

const querySchema=z.object({
	page:z.coerce.number().int().min(1).default(1),
	search:z.string().trim().max(120).default(''),
	tier:z.coerce.number().int().min(1).max(3).optional(),
	status:z.nativeEnum(UserStatus).optional(),
});
const pageSize=50;
const reviewSchema=z.object({
	id:z.string().min(1),
	status:z.enum([TierUpgradeStatus.APPROVED,TierUpgradeStatus.REJECTED,TierUpgradeStatus.NEEDS_INFORMATION]),
	reason:z.string().trim().min(3).max(1000),
});
const finalStatuses:TierUpgradeStatus[]=[TierUpgradeStatus.APPROVED,TierUpgradeStatus.REJECTED];

export async function GET(request:Request){
	try{
		await requireAdmin();
		const params=Object.fromEntries(new URL(request.url).searchParams);
		const input=querySchema.parse(params);
		const accountWhere:Prisma.UserWhereInput={
			role:'USER',
			...(input.status?{status:input.status}:{}),
			...(input.search?{OR:[
				{id:{contains:input.search,mode:'insensitive'}},
				{email:{contains:input.search,mode:'insensitive'}},
				{name:{contains:input.search,mode:'insensitive'}},
			]}:{}),
		};
		const [requests,users]=await Promise.all([
			db.tierUpgradeRequest.findMany({
				include:{user:{select:{id:true,name:true,email:true,accountMode:true,kycStatus:true,approvedTier:true,phone:true,phoneVerified:true,country:true,kyc:{select:{submittedAt:true,address:true}},kycDocuments:{where:{kind:{in:['IDENTITY_DOCUMENT','SELFIE','PROOF_OF_ADDRESS']}},select:{id:true,kind:true,status:true}}}},reviewedBy:{select:{id:true,name:true,email:true}}},
				orderBy:[{status:'asc'},{createdAt:'desc'}],
				take:200,
			}),
			db.user.findMany({
				where:accountWhere,
				select:{
					id:true,email:true,name:true,country:true,phone:true,phoneVerified:true,status:true,accountMode:true,approvedTier:true,kycStatus:true,createdAt:true,
					kyc:{select:{submittedAt:true,address:true}},
					kycDocuments:{where:{kind:{in:['IDENTITY_DOCUMENT','SELFIE','PROOF_OF_ADDRESS']}},select:{id:true,kind:true,status:true}},
					tierRequests:{orderBy:{createdAt:'desc'},take:5,select:{id:true,currentTier:true,requestedTier:true,status:true,adminReason:true,reviewedAt:true,createdAt:true,reviewedBy:{select:{name:true,email:true}}}},
				},
				orderBy:{createdAt:'desc'},
			}),
		]);
		const matchingAccounts=users.map(account=>{
			const requirements=getTierProfileRequirements(account);
			const tier=getAccountTier({accountMode:account.accountMode,kycStatus:account.kycStatus,verificationDocuments:account.kycDocuments.filter(document=>document.kind==='IDENTITY_DOCUMENT'&&document.status==='APPROVED').length,verificationSubmitted:!!account.kyc?.submittedAt,phoneVerified:account.phoneVerified,profileComplete:requirements.profileComplete,approvedTier:account.approvedTier});
			return {...account,currentTier:Number(tier.label.at(-1)),requirements:{...requirements,phoneVerified:account.phoneVerified,verificationSubmitted:!!account.kyc?.submittedAt,identityDocumentUploaded:account.kycDocuments.some(document=>document.kind==='IDENTITY_DOCUMENT'),identityDocumentApproved:account.kycDocuments.some(document=>document.kind==='IDENTITY_DOCUMENT'&&document.status==='APPROVED'),selfieApproved:account.kycDocuments.some(document=>document.kind==='SELFIE'&&document.status==='APPROVED'),proofOfAddressApproved:account.kycDocuments.some(document=>document.kind==='PROOF_OF_ADDRESS'&&document.status==='APPROVED'),identityApproved:account.kycStatus==='APPROVED'}};
		}).filter(account=>!input.tier||account.currentTier===input.tier);
		const total=matchingAccounts.length;
		const accounts=matchingAccounts.slice((input.page-1)*pageSize,input.page*pageSize);
		return NextResponse.json({requests,accounts,total,page:input.page,pageSize,totalPages:Math.ceil(total/pageSize)},{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'Forbidden'},{status:403});
		if(error instanceof ZodError)return NextResponse.json({error:'Invalid account search or filter values.'},{status:400});
		console.error('Administrator tier review queue could not be loaded.',{errorType:error instanceof Error?error.name:'UnknownError'});
		return NextResponse.json({error:'Tier review queue is temporarily unavailable.'},{status:503,headers:{'Cache-Control':'private, no-store'}});
	}
}

export async function PATCH(request:Request){
	try{
		const admin=await requireAdmin();
		const input=reviewSchema.parse(await request.json());
		const result=await db.$transaction(async tx=>{
			const current=await tx.tierUpgradeRequest.findUnique({where:{id:input.id}});
			if(!current)throw new Error('REQUEST_NOT_FOUND');
			if(finalStatuses.includes(current.status))throw new Error('REQUEST_ALREADY_FINAL');

			let promoteUserId:string|null=null;
			if(input.status===TierUpgradeStatus.APPROVED){
				const profile=await tx.user.findUniqueOrThrow({where:{id:current.userId},select:{accountMode:true,approvedTier:true,kycStatus:true,name:true,country:true,phone:true,phoneVerified:true,kyc:{select:{submittedAt:true,address:true}},kycDocuments:{where:{kind:{in:['IDENTITY_DOCUMENT','SELFIE','PROOF_OF_ADDRESS']}},select:{kind:true,status:true}}}});
				if(profile.accountMode!==AccountMode.REAL)throw new Error('TIER_3_REQUIREMENTS_NOT_MET');
				const requirements=getTierProfileRequirements(profile);
				const approvedDocuments=profile.kycDocuments.filter(document=>document.kind==='IDENTITY_DOCUMENT'&&document.status==='APPROVED').length;
				const actualTier=Number(getAccountTier({accountMode:profile.accountMode,kycStatus:profile.kycStatus,verificationDocuments:approvedDocuments,verificationSubmitted:!!profile.kyc?.submittedAt,phoneVerified:profile.phoneVerified,profileComplete:requirements.profileComplete,approvedTier:profile.approvedTier}).label.at(-1));
				if(current.requestedTier!==3)throw new Error('TIER_2_AUTOMATIC');
				validateTierUpgradeApproval({requestCurrentTier:current.currentTier,requestedTier:current.requestedTier,currentTier:actualTier});
				validateTierThreeApproval({
					profileComplete:requirements.profileComplete,
					phoneVerified:profile.phoneVerified,
					kycStatus:profile.kycStatus,
					verificationSubmitted:!!profile.kyc?.submittedAt,
					approvedIdentityDocuments:approvedDocuments,
					approvedSelfies:profile.kycDocuments.filter(document=>document.kind==='SELFIE'&&document.status==='APPROVED').length,
					approvedProofOfAddress:profile.kycDocuments.filter(document=>document.kind==='PROOF_OF_ADDRESS'&&document.status==='APPROVED').length,
					addressProvided:Boolean(profile.kyc?.address?.trim()),
				});
				promoteUserId=current.userId;
			}

			const changed=await tx.tierUpgradeRequest.updateMany({
				where:{id:current.id,status:current.status,updatedAt:current.updatedAt},
				data:{status:input.status,adminReason:input.reason,reviewedById:admin.id,reviewedAt:input.status===TierUpgradeStatus.NEEDS_INFORMATION?null:new Date()},
			});
			if(changed.count!==1)throw new Error('REQUEST_CHANGED');
			if(promoteUserId){
				const promoted=await tx.user.updateMany({where:{id:promoteUserId,approvedTier:{lt:3}},data:{approvedTier:3}});
				if(promoted.count!==1)throw new Error('TIER_REQUEST_STALE');
			}
			const updated=await tx.tierUpgradeRequest.findUniqueOrThrow({where:{id:current.id}});
			await tx.auditLog.create({data:{actorId:admin.id,action:'TIER_REQUEST_REVIEWED',entity:'TIER_REQUEST',entityId:current.id,metadata:{userId:current.userId,previousTier:current.currentTier,newTier:input.status===TierUpgradeStatus.APPROVED?current.requestedTier:current.currentTier,status:input.status,reason:input.reason}}});
			await createNotification(tx,{userId:current.userId,type:NotificationType.ACCOUNT,title:input.status==='APPROVED'?'Tier 3 approved':input.status==='REJECTED'?'Tier request declined':input.status==='NEEDS_INFORMATION'?'More information requested':'Tier request reviewed',message:input.status==='APPROVED'?'Your profile and identity review are approved. Your account is now Tier 3; account and financial eligibility rules still apply.':`An administrator updated your Tier ${current.requestedTier} request: ${input.reason}`,dedupeKey:`tier-request:${current.id}:${input.status}:${updated.updatedAt.toISOString()}`,relatedEntity:'TIER_REQUEST',relatedId:current.id,actionUrl:'/tier'});
			return updated;
		});
		return NextResponse.json(jsonSafe(result),{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		if(error instanceof Error&&['UNAUTHORIZED','FORBIDDEN'].includes(error.message))return NextResponse.json({error:'Forbidden'},{status:403});
		if(error instanceof ZodError)return NextResponse.json({error:'Select an allowed review outcome and provide a reason.'},{status:400});
		if(error instanceof Error&&error.message==='REQUEST_NOT_FOUND')return NextResponse.json({error:'Tier request not found.'},{status:404});
		if(error instanceof Error&&error.message==='REQUEST_ALREADY_FINAL')return NextResponse.json({error:'This tier request has already been finalized.'},{status:409});
		if(error instanceof Error&&error.message==='REQUEST_CHANGED')return NextResponse.json({error:'This request changed during review. Refresh the queue before deciding.'},{status:409});
		if(error instanceof Error&&error.message==='TIER_REQUEST_STALE')return NextResponse.json({error:'The account tier changed after this request. Refresh the review queue before deciding.'},{status:409});
		if(error instanceof Error&&error.message==='TIER_2_AUTOMATIC')return NextResponse.json({error:'Tier 2 is granted automatically when the profile is complete; only Tier 3 requires administrator approval.'},{status:409});
		if(error instanceof Error&&error.message==='TIER_3_REQUIREMENTS_NOT_MET')return NextResponse.json({error:'Tier 3 approval requires a complete profile, approved Tier 2 KYC, an approved ID and selfie, phone verification, a residential address, and approved proof of address.'},{status:409});
		console.error('Administrator tier review failed.',{errorType:error instanceof Error?error.name:'UnknownError'});
		return NextResponse.json({error:'Unable to update the tier request.'},{status:503});
	}
}
