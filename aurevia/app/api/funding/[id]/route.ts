import {NextResponse} from 'next/server';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {jsonSafe} from '@/lib/serializers';

export async function GET(_req:Request,{params}:{params:Promise<{id:string}>}){
	try{
		const {id}=await params;
		const user=await requireUser();
		const currentUser=await db.user.findUnique({where:{id:user.id},select:{accountMode:true,status:true,aureviaExchangeId:true}});
		if(!currentUser||currentUser.status!=='ACTIVE')return NextResponse.json({error:'Transaction not found.'},{status:404});
		const funding=await db.fundingRequest.findFirst({where:{id,userId:user.id,accountMode:currentUser.accountMode},include:{paymentMethod:{select:{name:true}},supportConversations:{where:{userId:user.id},select:{id:true,subject:true,status:true}},withdrawalDestination:{select:{nickname:true,countryCode:true,network:true,asset:true,maskedLabel:true}},withdrawalDestinationSnapshot:{select:{type:true,nickname:true,countryCode:true,network:true,asset:true,maskedLabel:true}}}});
		if(!funding)return NextResponse.json({error:'Transaction not found.'},{status:404});
		const history=await db.auditLog.findMany({where:{entity:'FUNDING',entityId:funding.id},select:{action:true,createdAt:true,actor:{select:{name:true,role:true}}},orderBy:{createdAt:'asc'}});
		const {receiptKey,withdrawalDestinationSnapshot,...safeFunding}=funding;
		return NextResponse.json(jsonSafe({transaction:{...safeFunding,aureviaExchangeId:currentUser.aureviaExchangeId,withdrawalDestination:withdrawalDestinationSnapshot||funding.withdrawalDestination,hasEvidence:!!receiptKey},history}),{headers:{'Cache-Control':'private, no-store'}});
	}catch{
		return NextResponse.json({error:'Unable to load this transaction.'},{status:400});
	}
}