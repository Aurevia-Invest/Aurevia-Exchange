import {NotificationType,Prisma} from '@prisma/client';
import {createNotification} from '@/lib/notifications';
import {getTierProfileRequirements} from '@/lib/production-policy';

export async function synchronizeCompletedProfileTier(tx:Prisma.TransactionClient,userId:string){
	const profile=await tx.user.findUnique({
		where:{id:userId},
		select:{id:true,name:true,country:true,phone:true,approvedTier:true},
	});
	if(!profile)return false;
	const requirements=getTierProfileRequirements(profile);
	if(!requirements.profileComplete||profile.approvedTier>=2)return false;

	const promoted=await tx.user.updateMany({
		where:{id:profile.id,approvedTier:{lt:2}},
		data:{approvedTier:2},
	});
	if(promoted.count!==1)return false;

	await tx.auditLog.create({
		data:{
			actorId:null,
			action:'USER_TIER_AUTO_ADVANCED',
			entity:'USER',
			entityId:profile.id,
			metadata:{previousTier:1,newTier:2,reason:'PROFILE_COMPLETED'},
		},
	});
	await createNotification(tx,{
		userId:profile.id,
		type:NotificationType.ACCOUNT,
		title:'Tier 2 unlocked',
		message:'Your profile is complete and your account has advanced to Tier 2. Identity review remains separate.',
		dedupeKey:`tier:${profile.id}:2:profile-completed`,
		actionUrl:'/tier',
	});
	return true;
}
