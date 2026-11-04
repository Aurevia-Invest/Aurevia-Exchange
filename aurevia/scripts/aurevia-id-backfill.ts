import {loadEnvConfig} from '@next/env';
import {PrismaClient} from '@prisma/client';
import {assignMissingAureviaExchangeId} from '../lib/aurevia-exchange-id';

loadEnvConfig(process.cwd());
const db=new PrismaClient();
const args=process.argv.slice(2);
const apply=args.includes('--apply');
if(args.length!==1||(!apply&&args[0]!=='--dry-run')){
	throw new Error('Use only --dry-run or --apply.');
}
if(apply&&process.env.AUREVIA_ID_BACKFILL_CONFIRM!=='APPLY_ACTIVE_USER_IDS'){
	throw new Error('Backfill is gated. Set AUREVIA_ID_BACKFILL_CONFIRM=APPLY_ACTIVE_USER_IDS only after approval.');
}

async function columnExists(){
	const rows=await db.$queryRaw<Array<{exists:boolean}>>`
		SELECT EXISTS (
			SELECT 1
			FROM information_schema.columns
			WHERE table_schema=current_schema()
				AND table_name='User'
				AND column_name='aureviaExchangeId'
		) AS "exists"
	`;
	return rows[0]?.exists===true;
}

async function counts(hasIdColumn:boolean){
	if(!hasIdColumn){
		const rows=await db.$queryRaw<Array<{activeUsers:number}>>`
			SELECT COUNT(*)::int AS "activeUsers"
			FROM "User"
			WHERE "role"='USER' AND "status"='ACTIVE'
		`;
		return {
			activeUsers:rows[0]?.activeUsers??0,
			usersWithAureviaId:0,
			activeUsersMissingAureviaId:rows[0]?.activeUsers??0,
			inactiveUsersWithAureviaId:0,
		};
	}
	const rows=await db.$queryRaw<Array<{
		activeUsers:number;
		usersWithAureviaId:number;
		activeUsersMissingAureviaId:number;
		inactiveUsersWithAureviaId:number;
	}>>`
		SELECT
			COUNT(*) FILTER (WHERE "role"='USER' AND "status"='ACTIVE')::int AS "activeUsers",
			COUNT(*) FILTER (WHERE "aureviaExchangeId" IS NOT NULL)::int AS "usersWithAureviaId",
			COUNT(*) FILTER (WHERE "role"='USER' AND "status"='ACTIVE' AND "aureviaExchangeId" IS NULL)::int AS "activeUsersMissingAureviaId",
			COUNT(*) FILTER (WHERE ("role"!='USER' OR "status"!='ACTIVE') AND "aureviaExchangeId" IS NOT NULL)::int AS "inactiveUsersWithAureviaId"
		FROM "User"
	`;
	return rows[0];
}

async function exchangeIdConstraintExists(){
	const rows=await db.$queryRaw<Array<{exists:boolean;validated:boolean|null}>>`
		SELECT EXISTS (
			SELECT 1
			FROM pg_constraint
			WHERE conrelid='"User"'::regclass
				AND conname='User_verified_requires_aurevia_exchange_id_check'
		) AS "exists",
		(
			SELECT convalidated
			FROM pg_constraint
			WHERE conrelid='"User"'::regclass
				AND conname='User_verified_requires_aurevia_exchange_id_check'
		) AS "validated"
	`;
	return rows[0]??{exists:false,validated:null};
}

async function main(){
	const hasIdColumn=await columnExists();
	const report=await counts(hasIdColumn);
	const constraint=hasIdColumn?await exchangeIdConstraintExists():{exists:false,validated:null};
	if(!apply){
		console.log(JSON.stringify({
			mode:'read-only dry run',
			aureviaExchangeIdColumnPresent:hasIdColumn,
			verifiedUserConstraint:constraint,
			backfillDefinition:'Active customer accounts without an Aurevia Exchange ID.',
			deletionPerformed:false,
			counts:report,
		},null,2));
		return;
	}
	if(!hasIdColumn)throw new Error('Apply the additive Aurevia Exchange ID migration before backfill.');

	const pending=await db.user.findMany({
		where:{role:'USER',status:'ACTIVE',aureviaExchangeId:null},
		select:{id:true,createdAt:true},
		orderBy:{createdAt:'asc'},
	});
	let assigned=0;
	for(const user of pending){
		const result=await assignMissingAureviaExchangeId(
			operation=>db.$transaction(tx=>operation(tx)),
			user.id,
			user.createdAt,
		);
		if(result)assigned++;
	}
	const finalCounts=await counts(hasIdColumn);
	if(finalCounts.activeUsersMissingAureviaId>0)throw new Error('Some active users remain without Aurevia Exchange IDs; constraint validation was not attempted.');
	if(!constraint.exists){
		await db.$executeRaw`ALTER TABLE "User" ADD CONSTRAINT "User_verified_requires_aurevia_exchange_id_check" CHECK ("emailVerifiedAt" IS NULL OR "aureviaExchangeId" IS NOT NULL) NOT VALID`;
	}
	if(!constraint.validated){
		await db.$executeRaw`ALTER TABLE "User" VALIDATE CONSTRAINT "User_verified_requires_aurevia_exchange_id_check"`;
	}
	const finalConstraint=await exchangeIdConstraintExists();
	console.log(JSON.stringify({
		mode:'approved backfill',
		assigned,
		remainingActiveUsersMissingAureviaId:finalCounts.activeUsersMissingAureviaId,
		verifiedUserConstraintValidated:finalConstraint.validated,
		deletionPerformed:false,
	},null,2));
}

main().catch(error=>{
	console.error('Aurevia Exchange ID backfill failed.',{errorType:error instanceof Error?error.name:'UnknownError'});
	process.exitCode=1;
}).finally(()=>db.$disconnect());
