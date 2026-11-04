import {NextResponse} from 'next/server';
import {AccountMode,EntryType,FundingStatus,FundingType,Prisma,Role,UserStatus} from '@prisma/client';
import {z,ZodError} from 'zod';
import {requireAdmin} from '@/lib/auth';
import {db} from '@/lib/db';
import {roundUsdAmount} from '@/lib/ledger';
import {jsonSafe} from '@/lib/serializers';

const querySchema=z.object({search:z.string().trim().max(120).default('')});

export async function GET(request:Request){
	try{
		await requireAdmin();
		const input=querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
		const users=await db.user.findMany({
			where:{role:Role.USER,status:{not:UserStatus.CLOSED},accountMode:AccountMode.REAL,...(input.search?{OR:[{id:{contains:input.search,mode:'insensitive'}},{email:{contains:input.search,mode:'insensitive'}},{name:{contains:input.search,mode:'insensitive'}}]}:{})},
			select:{id:true,name:true,email:true,status:true,accountMode:true,approvedTier:true,accountRestricted:true,depositEnabled:true,withdrawalEnabled:true},
			orderBy:{createdAt:'desc'},take:50,
		});
		const userIds=users.map(user=>user.id);
		const accounts=userIds.length?await db.ledgerAccount.findMany({where:{userId:{in:userIds},currency:'USD',accountMode:AccountMode.REAL},select:{userId:true,accountMode:true,id:true}}):[];
		const reservations=userIds.length?await db.fundingRequest.groupBy({by:['userId','accountMode'],where:{userId:{in:userIds},accountMode:AccountMode.REAL,currency:'USD',type:FundingType.WITHDRAWAL,status:{in:[FundingStatus.PENDING,FundingStatus.PENDING_REVIEW,FundingStatus.APPROVED,FundingStatus.PROCESSING]}},_sum:{amount:true}}):[];
		const ledgerEntries=accounts.length?await db.ledgerEntry.groupBy({by:['accountId','type'],where:{accountId:{in:accounts.map(account=>account.id)}},_sum:{amount:true}}):[];
		const balanceByAccount=new Map<string,Prisma.Decimal>();
		for(const entry of ledgerEntries){
			const current=balanceByAccount.get(entry.accountId)??new Prisma.Decimal(0);
			const amount=entry._sum.amount??new Prisma.Decimal(0);
			balanceByAccount.set(entry.accountId,entry.type===EntryType.CREDIT?current.plus(amount):current.minus(amount));
		}
		const accountByUserMode=new Map(accounts.map(account=>[`${account.userId}:${account.accountMode}`,account.id]));
		const reservationByAccount=new Map(reservations.map(reservation=>[`${reservation.userId}:${reservation.accountMode}`,reservation._sum.amount??new Prisma.Decimal(0)]));
		const items=users.map(user=>{
			const available=(mode:AccountMode)=>{
				const key=`${user.id}:${mode}`;
				const total=balanceByAccount.get(accountByUserMode.get(key)??'')??new Prisma.Decimal(0);
				return Prisma.Decimal.max(new Prisma.Decimal(0),roundUsdAmount(total).minus(reservationByAccount.get(key)??0));
			};
			return {...user,availableBalances:{REAL:available(AccountMode.REAL)}};
		});
		return NextResponse.json(jsonSafe({items}),{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'Forbidden'},{status:403});
		if(error instanceof ZodError)return NextResponse.json({error:'Invalid user search.'},{status:400});
		return NextResponse.json({error:'Eligible accounts are temporarily unavailable.'},{status:503});
	}
}