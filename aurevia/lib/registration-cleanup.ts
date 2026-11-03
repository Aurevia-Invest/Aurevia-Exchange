import {db} from '@/lib/db';

export function cleanupExpiredRegistrationAttempts(now=new Date()){
	return db.$transaction(async tx=>{
		const expiredAttempts=await tx.registrationAttempt.findMany({
			where:{expiresAt:{lte:now}},
			select:{id:true,email:true},
		});
		if(!expiredAttempts.length)return {count:0};

		const existingUsers=await tx.user.findMany({
			where:{
				email:{
					in:expiredAttempts.map(attempt=>attempt.email),
					mode:'insensitive',
				},
			},
			select:{email:true},
		});
		const registeredEmails=new Set(existingUsers.map(user=>user.email.toLowerCase()));
		const eligibleIds=expiredAttempts
			.filter(attempt=>!registeredEmails.has(attempt.email.toLowerCase()))
			.map(attempt=>attempt.id);
		if(!eligibleIds.length)return {count:0};

		return tx.registrationAttempt.deleteMany({
			where:{id:{in:eligibleIds},expiresAt:{lte:now}},
		});
	},{isolationLevel:'Serializable'});
}
