import {createHash,randomUUID} from 'node:crypto';
import {Prisma} from '@prisma/client';
import {db} from '@/lib/db';
import {RateLimitError} from '@/lib/rate-limit';

function keyHash(key:string){
	return createHash('sha256').update(key).digest('hex');
}

export async function persistentRateLimit(key:string,max:number,windowMs:number){
	const now=new Date();
	const resetAt=new Date(now.getTime()+windowMs);
	const [bucket]=await db.$queryRaw<Array<{count:number;resetAt:Date}>>(Prisma.sql`
		INSERT INTO "SecurityRateLimit" ("id","keyHash","count","resetAt")
		VALUES (${randomUUID()},${keyHash(key)},1,${resetAt})
		ON CONFLICT ("keyHash") DO UPDATE
		SET "count"=CASE
			WHEN "SecurityRateLimit"."resetAt"<=${now} THEN 1
			ELSE LEAST("SecurityRateLimit"."count"+1,${max+1})
		END,
		"resetAt"=CASE
			WHEN "SecurityRateLimit"."resetAt"<=${now} THEN ${resetAt}
			ELSE "SecurityRateLimit"."resetAt"
		END
		RETURNING "count","resetAt"
	`);
	if(!bucket)throw new Error('SECURITY_RATE_LIMIT_UNAVAILABLE');
	if(bucket.count>max)throw new RateLimitError(Math.max(1,Math.ceil((bucket.resetAt.getTime()-now.getTime())/1000)));
}

export async function clearPersistentRateLimit(key:string){
	await db.securityRateLimit.deleteMany({where:{keyHash:keyHash(key)}});
}
