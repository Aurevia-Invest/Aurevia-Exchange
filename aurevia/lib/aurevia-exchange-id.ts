import {randomBytes} from 'node:crypto';
import {Prisma} from '@prisma/client';

type IdBackfillTransaction={
	user:{
		updateMany(args:{
			where:{id:string;role:'USER';status:'ACTIVE';aureviaExchangeId:null};
			data:{aureviaExchangeId:string};
		}):Promise<{count:number}>;
	};
};

type IdBackfillTransactionRunner=<T>(operation:(tx:IdBackfillTransaction)=>Promise<T>)=>Promise<T>;

const ID_ALPHABET='0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ID_RANDOM_PART_PATTERN='[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}';
export const AUREVIA_EXCHANGE_ID_PATTERN=new RegExp(`^AEX-\\d{4}-${ID_RANDOM_PART_PATTERN}$`);

export function generateAureviaExchangeId(createdAt=new Date()){
	const random=randomBytes(8);
	const suffix=Array.from(random,byte=>ID_ALPHABET[byte&31]).join('');
	const year=createdAt.getUTCFullYear().toString().padStart(4,'0');
	return `AEX-${year}-${suffix.slice(0,4)}-${suffix.slice(4)}`;
}

export function isAureviaExchangeIdCollision(error:unknown){
	if(!(error instanceof Prisma.PrismaClientKnownRequestError)||error.code!=='P2002')return false;
	const target=error.meta?.target;
	return Array.isArray(target)
		?target.includes('aureviaExchangeId')
		:typeof target==='string'&&target.includes('aureviaExchangeId');
}

export async function retryAureviaExchangeIdCollision<T>(operation:()=>Promise<T>,maxRetries=5){
	for(let attempt=0;;attempt++){
		try{
			return await operation();
		}catch(error){
			if(!isAureviaExchangeIdCollision(error)||attempt>=maxRetries)throw error;
		}
	}
}

export async function assignMissingAureviaExchangeId(
	runTransaction:IdBackfillTransactionRunner,
	userId:string,
	createdAt:Date,
){
	return retryAureviaExchangeIdCollision(()=>runTransaction(async tx=>{
		const aureviaExchangeId=generateAureviaExchangeId(createdAt);
		const updated=await tx.user.updateMany({
			where:{id:userId,role:'USER',status:'ACTIVE',aureviaExchangeId:null},
			data:{aureviaExchangeId},
		});
		return updated.count===1;
	}));
}
