import {AccountMode} from '@prisma/client';
import {redirect} from 'next/navigation';
import InvestmentExperience from '@/components/InvestmentExperience';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';

export default async function InvestmentsPage(){
 const user=await requireUser();
 const currentUser=await db.user.findUnique({where:{id:user.id},select:{status:true,accountMode:true}});
 if(!currentUser||currentUser.status!=='ACTIVE')redirect('/login');
 if(currentUser.accountMode!==AccountMode.REAL||user.accountMode!==currentUser.accountMode)redirect('/dashboard');
 return <InvestmentExperience/>;
}