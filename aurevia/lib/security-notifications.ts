import {db} from '@/lib/db';
import {sendEmail} from '@/lib/email';

export async function sendSecurityEmail(userId:string,input:{subject:string;text:string}){
	const account=await db.user.findUnique({where:{id:userId},select:{email:true,status:true}});
	if(!account||account.status!=='ACTIVE')return;
	try{
		const delivery=await sendEmail({to:account.email,...input});
		if(!delivery.sent)console.warn('Security email could not be delivered.',{reason:delivery.reason||'failed',provider:delivery.provider||'none'});
	}catch(error){
		console.warn('Security email could not be delivered.',{errorName:error instanceof Error?error.name:'UnknownError'});
	}
}
