import {NextResponse} from 'next/server';
import {AccountMode,NotificationType,Prisma} from '@prisma/client';
import {z,ZodError} from 'zod';
import {requireAdmin} from '@/lib/auth';
import {db} from '@/lib/db';
import {createNotification} from '@/lib/notifications';
import {enqueueKycEmail,type KycEmailEvent} from '@/lib/kyc-email-outbox';
import {getServerConfiguration} from '@/lib/config/env';
import {AUREVIA_EXCHANGE_ID_PATTERN} from '@/lib/aurevia-exchange-id';
import {getAccountTier,getTierProfileRequirements} from '@/lib/production-policy';

const schema=z.object({
  userId:z.string(),
  name:z.string().trim().max(120).nullable().optional(),
  country:z.string().trim().max(100).nullable().optional(),
  phone:z.string().trim().max(40).nullable().optional(),
  status:z.enum(['ACTIVE','FROZEN','DELETED']).optional(),
  kycStatus:z.enum(['PENDING','APPROVED','REJECTED','NEEDS_CHANGES']).optional(),
  depositEnabled:z.boolean().optional(),
  withdrawalEnabled:z.boolean().optional(),
  accountRestricted:z.boolean().optional(),
  restrictionReason:z.string().trim().max(500).optional(),
  reviewNote:z.string().trim().max(500).optional(),
});

export async function GET(request:Request){
  try{
    await requireAdmin();
    const params=new URL(request.url).searchParams;
    const search=params.get('search')?.trim().slice(0,120)||'';
    const includeDeleted=params.get('showDeleted')==='true';
    const requestedMode=params.get('mode');
    if(requestedMode&&requestedMode!=='DEMO'&&requestedMode!=='REAL')return NextResponse.json({error:'Invalid account mode.'},{status:400});
    const requestedStatus=params.get('status');
    if(requestedStatus&&requestedStatus!=='ACTIVE'&&requestedStatus!=='INACTIVE')return NextResponse.json({error:'Invalid account status filter.'},{status:400});
    const mode=requestedMode==='DEMO'?AccountMode.DEMO:requestedMode==='REAL'?AccountMode.REAL:undefined;
    const configuredAdminEmail=getServerConfiguration().auth.adminEmail.trim().toLowerCase();
    const exchangeIdSearch=search.toUpperCase();
    const matchesExchangeId=AUREVIA_EXCHANGE_ID_PATTERN.test(exchangeIdSearch);
    const searchConditions:Prisma.UserWhereInput[]=[
      {id:{contains:search}},
      {email:{contains:search,mode:'insensitive'}},
      {name:{contains:search,mode:'insensitive'}},
      ...(matchesExchangeId?[{aureviaExchangeId:exchangeIdSearch}]:[{aureviaExchangeId:{contains:search,mode:'insensitive' as const}}]),
    ];
    const where:Prisma.UserWhereInput={
      role:'USER',
      status:includeDeleted?'DELETED':requestedStatus==='ACTIVE'?'ACTIVE':requestedStatus==='INACTIVE'?{in:['FROZEN','SUSPENDED']}:{notIn:['DELETED','CLOSED']},
      ...(mode?{accountMode:mode}:{}),
      ...(configuredAdminEmail?{email:{not:configuredAdminEmail}}:{}),
      ...(search?{OR:searchConditions}:{}),
    };
    const users=await db.user.findMany({
      where,
      select:{id:true,aureviaExchangeId:true,email:true,name:true,country:true,phone:true,phoneVerified:true,approvedTier:true,role:true,status:true,kycStatus:true,accountMode:true,depositEnabled:true,withdrawalEnabled:true,accountRestricted:true,restrictionReason:true,createdAt:true,kyc:{select:{legalName:true,dob:true,address:true,idType:true,idNumber:true,submittedAt:true,reviewedAt:true,reviewNote:true}},kycDocuments:{select:{id:true,kind:true,filename:true,mimeType:true,size:true,status:true,uploadedAt:true,reviewedAt:true,reviewNote:true},orderBy:{uploadedAt:'desc'}}},
      orderBy:{createdAt:'desc'},
      take:search?100:200,
    });
    const usersWithTier=users.map(user=>{
      const requirements=getTierProfileRequirements({name:user.name,country:user.country,phone:user.phone});
      const tier=getAccountTier({
        accountMode:user.accountMode,
        kycStatus:user.kycStatus,
        verificationDocuments:user.kycDocuments.filter(document=>document.kind==='IDENTITY_DOCUMENT'&&document.status==='APPROVED').length,
        verificationSubmitted:Boolean(user.kyc?.submittedAt),
        phoneVerified:user.phoneVerified,
        profileComplete:requirements.profileComplete,
        approvedTier:user.approvedTier,
        accountStatus:user.status,
      });
      return {...user,accountTier:tier.label};
    });
    return NextResponse.json(usersWithTier,{headers:{'Cache-Control':'private, no-store'}});
  }catch{return NextResponse.json({error:'Forbidden'},{status:403})}
}
export async function PATCH(req:Request){
  try{
    const admin=await requireAdmin();
    const body:unknown=await req.json();
    if(body&&typeof body==='object'&&'role' in body)return NextResponse.json({error:'Administrator and customer roles are managed separately.'},{status:409});
    const input=schema.parse(body);
    const configuredAdminEmail=getServerConfiguration().auth.adminEmail.trim().toLowerCase();
    if(input.userId===admin.id&&input.status==='FROZEN')throw new Error('CANNOT_DISABLE_CURRENT_ADMIN');
    const updated=await db.$transaction(async tx=>{
      const current=await tx.user.findUniqueOrThrow({where:{id:input.userId},select:{email:true,name:true,country:true,phone:true,role:true,status:true,kycStatus:true,depositEnabled:true,withdrawalEnabled:true,accountRestricted:true,restrictionReason:true,kyc:{select:{submittedAt:true}},kycDocuments:{where:{kind:{in:['IDENTITY_DOCUMENT','SELFIE']},status:'APPROVED'},select:{kind:true}}}});
      if(input.status==='DELETED'&&(current.role==='ADMIN'||current.status==='CLOSED'))throw new Error('ACCOUNT_CANNOT_BE_SOFT_DELETED');
      if(current.status==='DELETED'&&input.status!=='ACTIVE')throw new Error('DELETED_ACCOUNT_MUST_BE_RESTORED');
      if(configuredAdminEmail&&current.email.toLowerCase()===configuredAdminEmail)throw new Error('ADMIN_ACCOUNT_ISOLATED');
      const removesActiveAdmin=current.role==='ADMIN'&&current.status==='ACTIVE'&&input.status==='FROZEN';
      if(removesActiveAdmin&&await tx.user.count({where:{role:'ADMIN',status:'ACTIVE'}})<=1)throw new Error('LAST_ACTIVE_ADMIN_REQUIRED');
      const kycChanged=input.kycStatus!==undefined&&input.kycStatus!==current.kycStatus;
      const profileChanged=(input.name!==undefined&&input.name!==current.name)||(input.country!==undefined&&input.country!==current.country)||(input.phone!==undefined&&input.phone!==current.phone);
      const controlsChanged=(input.depositEnabled!==undefined&&input.depositEnabled!==current.depositEnabled)||(input.withdrawalEnabled!==undefined&&input.withdrawalEnabled!==current.withdrawalEnabled)||(input.accountRestricted!==undefined&&input.accountRestricted!==current.accountRestricted)||(input.restrictionReason!==undefined&&input.restrictionReason!==current.restrictionReason);
      if(input.kycStatus!==undefined&&!kycChanged)throw new Error('KYC_STATUS_UNCHANGED');
      if(input.kycStatus==='APPROVED'&&(!current.kyc?.submittedAt||!current.kycDocuments.some(document=>document.kind==='IDENTITY_DOCUMENT')||!current.kycDocuments.some(document=>document.kind==='SELFIE')))throw new Error('APPROVED_IDENTITY_DOCUMENT_REQUIRED');
      const statusChanged=input.status!==undefined&&input.status!==current.status;
      const user=await tx.user.update({where:{id:input.userId},data:{name:input.name,country:input.country,phone:input.phone,status:input.status,...(input.status==='DELETED'?{activeSessionId:null}:{}),kycStatus:input.kycStatus,...(input.kycStatus==='APPROVED'?{verifiedAt:new Date()}:input.kycStatus!==undefined?{verifiedAt:null}:{}),depositEnabled:input.depositEnabled,withdrawalEnabled:input.withdrawalEnabled,accountRestricted:input.accountRestricted,...(input.accountRestricted===false?{restrictionReason:null}:input.restrictionReason!==undefined?{restrictionReason:input.restrictionReason||null}:{})},select:{id:true,email:true,name:true,country:true,phone:true,role:true,status:true,kycStatus:true,accountMode:true,createdAt:true,depositEnabled:true,withdrawalEnabled:true,accountRestricted:true,restrictionReason:true}});
      if(kycChanged)await tx.kycProfile.updateMany({where:{userId:user.id},data:{reviewedAt:new Date(),reviewNote:input.reviewNote||null}});
      const accountStatusAction=input.status==='DELETED'?'USER_SOFT_DELETED':current.status==='DELETED'&&input.status==='ACTIVE'?'USER_RESTORED':null;
      await tx.auditLog.create({data:{actorId:admin.id,action:accountStatusAction||(kycChanged?`KYC_${input.kycStatus}`:controlsChanged?'USER_ACCOUNT_RESTRICTION':profileChanged?'USER_PROFILE_EDITED':statusChanged?'USER_STATUS_UPDATE':'USER_UPDATE'),entity:'USER',entityId:user.id,metadata:{...input,reviewNote:input.reviewNote||null}}});
      if(kycChanged){
        const status=input.kycStatus!;
        const title=status==='APPROVED'?'Identity profile approved by administrator':status==='REJECTED'?'Identity profile rejected by administrator':status==='NEEDS_CHANGES'?'Additional identity information requested':'Identity profile review updated';
        const message=`An administrator marked your identity profile ${status.toLowerCase().replaceAll('_',' ')}. This is not an external identity-provider, AML/sanctions, or regulatory verification.${status==='APPROVED'?' This decision does not change your email-verification or account-access requirements.':''}${input.reviewNote?` Admin note: ${input.reviewNote}`:''}`;
        await createNotification(tx,{userId:user.id,type:NotificationType.KYC,title,message,dedupeKey:`kyc:${user.id}:${status}:${user.createdAt.toISOString()}:${new Date().toISOString()}`,actionUrl:'/kyc'});
        const kycEmailEvent:Record<NonNullable<typeof input.kycStatus>,KycEmailEvent>={
          PENDING:'PROFILE_STATUS_UPDATED',
          APPROVED:'PROFILE_APPROVED',
          REJECTED:'PROFILE_REJECTED',
          NEEDS_CHANGES:'PROFILE_NEEDS_CHANGES',
        };
        await enqueueKycEmail(tx,user.id,kycEmailEvent[status],`kyc-email:${user.id}:profile:${status}:${new Date().toISOString()}`);
      }
      if(controlsChanged){
        const disabledActions=[!user.depositEnabled?'deposits':null,!user.withdrawalEnabled?'withdrawals':null,user.accountRestricted?'account access':null].filter(Boolean);
        const enabledActions=[input.depositEnabled===true?'deposits':null,input.withdrawalEnabled===true?'withdrawals':null].filter(Boolean);
        const message=disabledActions.length?`An administrator disabled ${disabledActions.join(' and ')} for your account.${user.restrictionReason?` Reason: ${user.restrictionReason}`:''}`:enabledActions.length?`An administrator enabled ${enabledActions.join(' and ')} for your account.`:'Account controls were updated by an administrator.';
        await createNotification(tx,{userId:user.id,type:NotificationType.SECURITY,title:'Account access updated',message,dedupeKey:`account-control:${user.id}:${Date.now()}`,actionUrl:'/wallet'});
      }
      return user;
    },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
    return NextResponse.json(updated);
  }catch(error){
    if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
    if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'Forbidden'},{status:403});
    if(error instanceof Error&&error.message==='CANNOT_DISABLE_CURRENT_ADMIN')return NextResponse.json({error:'You cannot freeze or demote your own administrator account.'},{status:409});
    if(error instanceof Error&&error.message==='LAST_ACTIVE_ADMIN_REQUIRED')return NextResponse.json({error:'Keep at least one active administrator.'},{status:409});
    if(error instanceof Error&&error.message==='ACCOUNT_CANNOT_BE_SOFT_DELETED')return NextResponse.json({error:'This account cannot be moved to deleted items.'},{status:409});
    if(error instanceof Error&&error.message==='DELETED_ACCOUNT_MUST_BE_RESTORED')return NextResponse.json({error:'Restore this account before changing its status.'},{status:409});
    if(error instanceof Error&&error.message==='ADMIN_ACCOUNT_ISOLATED')return NextResponse.json({error:'Configured administrator accounts are managed separately.'},{status:409});
    if(error instanceof ZodError)return NextResponse.json({error:'Invalid review details.'},{status:400});
    if(error instanceof Error&&error.message==='KYC_STATUS_UNCHANGED')return NextResponse.json({error:'This verification status is already recorded.'},{status:409});
    if(error instanceof Error&&error.message==='APPROVED_IDENTITY_DOCUMENT_REQUIRED')return NextResponse.json({error:'Approve both a government-issued ID and selfie before approving Tier 2 KYC.'},{status:409});
    return NextResponse.json({error:'Unable to update this account.'},{status:400});
  }
}
