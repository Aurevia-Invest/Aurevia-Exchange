import {loadEnvConfig} from '@next/env';
import {PrismaClient} from '@prisma/client';

type CleanupCounts={
	candidateUsers:number;
	explicitlyPendingRegistrations:number;
	legacyUnverifiedUsersForManualReview:number;
	verificationCodes:number;
	passwordResetTokens:number;
	kycProfiles:number;
	kycDocuments:number;
	waitlistEntries:number;
	notifications:number;
	auditLogs:number;
	usersWithActiveSessions:number;
	ledgerAccounts:number;
	ledgerEntries:number;
	ledgerTransactions:number;
	fundingRequests:number;
	orders:number;
	positions:number;
	candidatesWithFinancialRecords:number;
	candidatesWithoutFinancialRecords:number;
};

if(!process.argv.includes('--dry-run')||process.argv.includes('--apply')){
	throw new Error('This report is read-only. Run it explicitly with --dry-run; it has no apply mode.');
}

loadEnvConfig(process.cwd());
const db=new PrismaClient();

async function main(){
	const [counts]=await db.$queryRaw<CleanupCounts[]>`
		WITH candidates AS MATERIALIZED (
			SELECT "id","email"
			FROM "User"
			WHERE "role"='USER'
				AND "status"='ACTIVE'
				AND "emailVerifiedAt" IS NULL
				AND "verifiedAt" IS NULL
				AND "verifiedChannel" IS NULL
				AND "phoneVerified"=false
				AND "phoneVerifiedAt" IS NULL
				AND "createdAt"<NOW()-INTERVAL '24 hours'
		),
		explicitly_pending AS (
			SELECT c."id"
			FROM candidates c
			JOIN "User" u ON u."id"=c."id"
			WHERE u."requiresRegistrationVerification"=true
		),
		financially_linked AS (
			SELECT c."id"
			FROM candidates c
			WHERE EXISTS (SELECT 1 FROM "LedgerAccount" a WHERE a."userId"=c."id")
				OR EXISTS (SELECT 1 FROM "Order" o WHERE o."userId"=c."id")
				OR EXISTS (SELECT 1 FROM "Position" p WHERE p."userId"=c."id")
				OR EXISTS (SELECT 1 FROM "FundingRequest" f WHERE f."userId"=c."id")
		)
		SELECT
			(SELECT COUNT(*)::int FROM candidates) AS "candidateUsers",
			(SELECT COUNT(*)::int FROM explicitly_pending) AS "explicitlyPendingRegistrations",
			((SELECT COUNT(*) FROM candidates)-(SELECT COUNT(*) FROM explicitly_pending))::int AS "legacyUnverifiedUsersForManualReview",
			(SELECT COUNT(*)::int FROM candidates c JOIN "VerificationCode" v ON v."userId"=c."id") AS "verificationCodes",
			(SELECT COUNT(*)::int FROM candidates c JOIN "PasswordResetToken" p ON p."userId"=c."id") AS "passwordResetTokens",
			(SELECT COUNT(*)::int FROM candidates c JOIN "KycProfile" k ON k."userId"=c."id") AS "kycProfiles",
			(SELECT COUNT(*)::int FROM candidates c JOIN "KycDocument" k ON k."userId"=c."id") AS "kycDocuments",
			(SELECT COUNT(*)::int FROM candidates c JOIN "WaitlistEntry" w ON w."userId"=c."id" OR w."email"=c."email") AS "waitlistEntries",
			(SELECT COUNT(*)::int FROM candidates c JOIN "Notification" n ON n."userId"=c."id") AS "notifications",
			(SELECT COUNT(DISTINCT a."id")::int FROM candidates c JOIN "AuditLog" a ON a."actorId"=c."id" OR a."entityId"=c."id") AS "auditLogs",
			(SELECT COUNT(*)::int FROM candidates c WHERE EXISTS (SELECT 1 FROM "User" u WHERE u."id"=c."id" AND u."activeSessionId" IS NOT NULL)) AS "usersWithActiveSessions",
			(SELECT COUNT(*)::int FROM candidates c JOIN "LedgerAccount" a ON a."userId"=c."id") AS "ledgerAccounts",
			(SELECT COUNT(*)::int FROM candidates c JOIN "LedgerAccount" a ON a."userId"=c."id" JOIN "LedgerEntry" e ON e."accountId"=a."id") AS "ledgerEntries",
			(SELECT COUNT(DISTINCT t."id")::int FROM candidates c JOIN "LedgerAccount" a ON a."userId"=c."id" JOIN "LedgerEntry" e ON e."accountId"=a."id" JOIN "LedgerTransaction" t ON t."id"=e."transactionId") AS "ledgerTransactions",
			(SELECT COUNT(*)::int FROM candidates c JOIN "FundingRequest" f ON f."userId"=c."id") AS "fundingRequests",
			(SELECT COUNT(*)::int FROM candidates c JOIN "Order" o ON o."userId"=c."id") AS "orders",
			(SELECT COUNT(*)::int FROM candidates c JOIN "Position" p ON p."userId"=c."id") AS "positions",
			(SELECT COUNT(*)::int FROM financially_linked) AS "candidatesWithFinancialRecords",
			((SELECT COUNT(*) FROM candidates)-(SELECT COUNT(*) FROM financially_linked))::int AS "candidatesWithoutFinancialRecords"
	`;

	console.log(JSON.stringify({
		mode:'read-only dry run',
		candidateDefinition:'Active USER accounts older than 24 hours with no email/phone verification timestamps or verification channel.',
		manualReviewRequired:true,
		financiallyLinkedAccountsExcludedFromAnyAutomaticCleanup:true,
		deletionPerformed:false,
		personalDataReturned:false,
		counts,
	},null,2));
}

main().catch(error=>{
	console.error('Registration cleanup dry-run failed.',{errorType:error instanceof Error?error.name:'UnknownError'});
	process.exitCode=1;
}).finally(()=>db.$disconnect());
