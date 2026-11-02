import {NextResponse} from 'next/server';
import {AccountMode} from '@prisma/client';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {jsonSafe} from '@/lib/serializers';

type Params={params:Promise<{id:string}>};

export async function GET(_request:Request,{params}:Params){
	try{
		const user=await requireUser();
		const activeUser=await db.user.findUnique({where:{id:user.id},select:{accountMode:true,status:true,aureviaExchangeId:true}});
		if(!activeUser||activeUser.status!=='ACTIVE'||activeUser.accountMode!==AccountMode.REAL)return NextResponse.json({error:'Not found'},{status:404});
		const {id}=await params;
		const card=await db.simulatedCard.findFirst({
			where:{id,userId:user.id},
			include:{application:{select:{reference:true,priceSnapshot:true,currencySnapshot:true,status:true,submittedAt:true}}},
		});
		if(!card)return NextResponse.json({error:'Not found'},{status:404});
		return NextResponse.json(jsonSafe({...card,aureviaExchangeId:activeUser.aureviaExchangeId}),{headers:{'Cache-Control':'private, no-store'}});
	}catch{
		return NextResponse.json({error:'Unauthorized'},{status:401});
	}
}
