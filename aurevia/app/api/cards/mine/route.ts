import {NextResponse} from 'next/server';
import {AccountMode} from '@prisma/client';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {jsonSafe} from '@/lib/serializers';

export async function GET(){
	try{
		const user=await requireUser();
		const activeUser=await db.user.findUnique({where:{id:user.id},select:{accountMode:true,status:true,aureviaExchangeId:true}});
		if(!activeUser||activeUser.status!=='ACTIVE')return NextResponse.json({error:'This account is unavailable.'},{status:403});
		if(activeUser.accountMode!==AccountMode.REAL)return NextResponse.json({cards:[],applications:[],aureviaExchangeId:activeUser.aureviaExchangeId},{headers:{'Cache-Control':'private, no-store'}});
		const [cards,applications]=await Promise.all([
			db.simulatedCard.findMany({where:{userId:user.id},orderBy:{issuedAt:'desc'}}),
			db.cardApplication.findMany({where:{userId:user.id},include:{catalogItem:{select:{displayName:true,key:true}}},orderBy:{createdAt:'desc'},take:50}),
		]);
		return NextResponse.json(jsonSafe({cards,applications,aureviaExchangeId:activeUser.aureviaExchangeId}),{headers:{'Cache-Control':'private, no-store'}});
	}catch{
		return NextResponse.json({error:'Unauthorized'},{status:401});
	}
}
