import {db} from '@/lib/db';

export function cleanupExpiredRegistrationAttempts(now=new Date()){
	return db.registrationAttempt.deleteMany({
		where:{
			OR:[
				{expiresAt:{lte:now}},
				{verification:{is:{expiresAt:{lte:now}}}},
			],
		},
	});
}
