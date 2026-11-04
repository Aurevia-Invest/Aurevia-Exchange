import {NextResponse} from 'next/server';
import {AccountMode,TierUpgradeStatus,UserStatus} from '@prisma/client';
import {z} from 'zod';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {runAiService} from '@/lib/ai-services';
import {AiGatewayError} from '@/lib/ai-gateway';
import {rateLimit} from '@/lib/rate-limit';
import {getAccountTier,getTierProfileRequirements} from '@/lib/production-policy';

const responseSchema=z.object({
	summary:z.string().trim().min(1).max(500),
	caveat:z.string().trim().min(1).max(300),
}).strict();
const openTierRequestStatuses:TierUpgradeStatus[]=[TierUpgradeStatus.PENDING_REVIEW,TierUpgradeStatus.NEEDS_INFORMATION];

type OnboardingStep={id:string;title:string;href:string};

function getOnboardingSteps(input:{
	accountMode:AccountMode;
	requirements:ReturnType<typeof getTierProfileRequirements>;
	phoneVerified:boolean;
	kycStatus:string;
	verificationSubmitted:boolean;
	documents:Array<{status:string}>;
	currentTier:number;
	tierRequestStatus:string|null;
}):OnboardingStep[]{
	const steps:OnboardingStep[]=[];
	if(!input.requirements.nameComplete)steps.push({id:'complete_name',title:'Add your full name',href:'/settings#profile'});
	if(!input.requirements.countryComplete)steps.push({id:'select_country',title:'Select your country',href:'/settings#profile'});
	if(!input.requirements.phoneComplete)steps.push({id:'add_phone',title:'Add a valid phone number',href:'/settings#profile'});

	if(input.accountMode===AccountMode.REAL&&input.requirements.profileComplete){
		if(!input.phoneVerified){
			steps.push({id:'verify_phone',title:'Verify your phone number',href:'/kyc'});
		}else if(input.kycStatus==='REJECTED'||input.kycStatus==='NEEDS_CHANGES'||input.documents.some(document=>['REJECTED','RESUBMISSION_REQUIRED'].includes(document.status))){
			steps.push({id:'review_identity_feedback',title:'Review identity-verification updates',href:'/kyc'});
		}else if(!input.verificationSubmitted){
			steps.push({id:'submit_identity',title:'Submit identity information',href:'/kyc'});
		}else if(!input.documents.length){
			steps.push({id:'upload_identity_document',title:'Upload an identity document',href:'/kyc'});
		}else if(input.kycStatus!=='APPROVED'||!input.documents.some(document=>document.status==='APPROVED')){
			steps.push({id:'await_identity_review',title:'Check your identity-review status',href:'/kyc'});
		}else if(input.tierRequestStatus==='NEEDS_INFORMATION'){
			steps.push({id:'provide_tier_information',title:'Respond to the tier-review information request',href:'/tier'});
		}else if(input.tierRequestStatus==='PENDING_REVIEW'){
			steps.push({id:'await_tier_review',title:'Check your pending tier review',href:'/tier'});
		}else if(input.currentTier===2){
			steps.push({id:'request_tier_review',title:'Request Tier 3 administrator review',href:'/tier'});
		}
	}
	return steps;
}

export async function POST(){
	try{
		const user=await requireUser();
		rateLimit(`onboarding-ai:${user.id}`,8,60_000);
		const profile=await db.user.findUnique({
			where:{id:user.id},
			select:{
				role:true,status:true,accountMode:true,approvedTier:true,kycStatus:true,name:true,country:true,phone:true,
				phoneVerified:true,kyc:{select:{submittedAt:true}},
				kycDocuments:{where:{kind:'IDENTITY_DOCUMENT'},select:{status:true}},
			},
		});
		if(!profile||profile.role!=='USER'||profile.status!==UserStatus.ACTIVE)return NextResponse.json({error:'This account is unavailable.'},{status:403});
		const openRequest=await db.tierUpgradeRequest.findFirst({
			where:{userId:user.id,status:{in:openTierRequestStatuses}},
			orderBy:{createdAt:'desc'},
			select:{status:true},
		});
		const requirements=getTierProfileRequirements(profile);
		const approvedDocuments=profile.kycDocuments.filter(document=>document.status==='APPROVED').length;
		const tier=getAccountTier({
			accountMode:profile.accountMode,
			kycStatus:profile.kycStatus,
			verificationDocuments:approvedDocuments,
			verificationSubmitted:!!profile.kyc?.submittedAt,
			phoneVerified:profile.phoneVerified,
			profileComplete:requirements.profileComplete,
			approvedTier:profile.approvedTier,
		});
		const steps=getOnboardingSteps({
			accountMode:profile.accountMode,
			requirements,
			phoneVerified:profile.phoneVerified,
			kycStatus:profile.kycStatus,
			verificationSubmitted:!!profile.kyc?.submittedAt,
			documents:profile.kycDocuments,
			currentTier:Number(tier.label.at(-1)),
			tierRequestStatus:openRequest?.status??null,
		});
		const result=await runAiService('smart_onboarding',[
			{role:'system',content:'Explain the supplied Aurevia onboarding checklist in concise, plain language. Use only the supplied account mode, tier label, and locally determined checklist steps. Do not infer missing data, claim anything was submitted or approved, tell a DEMO user to switch account modes, promise eligibility or financial access, or make a KYC decision. Return only JSON with exactly {"summary":"string","caveat":"string"}. If no steps are supplied, say the profile checklist is complete for the current mode and that this does not establish REAL-account or financial eligibility. State that KYC and tier changes require the normal authorized workflow.'},
			{role:'user',content:JSON.stringify({accountMode:profile.accountMode,tier:tier.label,steps:steps.map(({id,title})=>({id,title}))})},
		],{actorId:user.id,temperature:0.1,maxTokens:350});
		let parsed:unknown;
		try{parsed=JSON.parse(result.content)}
		catch{return NextResponse.json({error:'The onboarding assistant returned an invalid explanation.'},{status:502,headers:{'Cache-Control':'private, no-store'}})}
		const guidance=responseSchema.safeParse(parsed);
		if(!guidance.success)return NextResponse.json({error:'The onboarding assistant returned an unsupported explanation.'},{status:502,headers:{'Cache-Control':'private, no-store'}});

		await db.auditLog.create({data:{
			actorId:user.id,
			action:'AI_ONBOARDING_GUIDANCE',
			entity:'AI_ACTIVITY',
			metadata:{accountMode:profile.accountMode,tier:tier.label,stepIds:steps.map(step=>step.id),generatedAnalysis:true,externalAction:false},
		}});
		return NextResponse.json({guidance:guidance.data,steps,accountMode:profile.accountMode,tier:tier.label,provider:result.provider,model:result.model},{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Sign in to view onboarding guidance.'},{status:401});
		if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'Forbidden'},{status:403});
		if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'Too many onboarding assistant requests. Try again shortly.'},{status:429});
		if(error instanceof Error&&error.message==='AI_FEATURE_DISABLED')return NextResponse.json({error:'Smart onboarding is disabled by an administrator.'},{status:503});
		if(error instanceof AiGatewayError)return NextResponse.json({error:'The onboarding assistant is temporarily unavailable.'},{status:error.status,headers:{'Cache-Control':'private, no-store'}});
		console.error('Onboarding assistant failed.',error instanceof Error?error.name:'UnknownError');
		return NextResponse.json({error:'Onboarding assistance is temporarily unavailable.'},{status:503,headers:{'Cache-Control':'private, no-store'}});
	}
}
