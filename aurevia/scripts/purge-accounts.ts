import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createInterface} from 'node:readline/promises';
import {PrismaClient,Role} from '@prisma/client';
import {loadEnvConfig} from '@next/env';
import {createAccountPurgePlan,maskEmail,runAccountPurgeWorkflow,type PurgeUser} from '@/lib/purge-accounts';

const confirmationPhrase='DELETE ALL NON-ADMIN ACCOUNTS';
const batchSize=100;
const accountBackupRelations={
	orders:{include:{executions:true}},
	funding:{include:{withdrawalDestinationSnapshot:true,supportConversations:{include:{messages:true}},clientStory:true}},
	ledgerAccounts:{include:{entries:{include:{transaction:true}}}},
	supportConversations:{include:{messages:true}},
	taxCases:{include:{documents:true,messages:true,statusHistory:true}},
	cardApplications:{include:{issuedCard:true}},
	communityLoans:{include:{installments:{include:{payments:true}},payments:true}},
	hiddenAdminDashboardActivities:true,
	restoredAdminDashboardActivities:true,
	kycDocuments:true,
	withdrawalDestinations:true,
	kyc:true,
	notifications:true,
	activityVisibilityPreferences:true,
	pushPreference:true,
	pushSubscriptions:true,
	pushOutbox:true,
	kycEmailOutbox:true,
	verificationCode:true,
	passwordResetTokens:true,
	clientStories:true,
	investments:true,
	portfolioSnapshots:true,
	createdInvestmentOpportunities:true,
	createdBroadcasts:true,
	createdStories:true,
	deletedStories:true,
	deletedWaitlistEntries:true,
	deletedClientStories:true,
	deletedBroadcasts:true,
	waitlistEntry:true,
	tierRequests:true,
	taxServiceAccess:true,
	taxAccessGrants:true,
	taxCaseAssignments:true,
	taxCaseMessages:true,
	cardCatalogUpdates:true,
	cardApplicationReviews:true,
	communityCampaigns:true,
	communityDonations:true,
	reviewedCommunityLoans:true,
	disbursedCommunityLoans:true,
	recordedCommunityLoanPayments:true,
	auditLogs:true,
};

function cliKeepEmail(args:string[]){
	const entries=args.filter(argument=>argument.startsWith('--keep-email='));
	if(entries.length!==1)return undefined;
	return entries[0].slice('--keep-email='.length)||undefined;
}

function executeRequested(args:string[]){
	return args.includes('--execute');
}

async function askForConfirmation(){
	if(!process.stdin.isTTY||!process.stdout.isTTY)throw new Error('Execution requires an interactive terminal.');
	const readline=createInterface({input:process.stdin,output:process.stdout});
	try{
		const answer=await readline.question(`Type "${confirmationPhrase}" to continue: `);
		return answer===confirmationPhrase;
	}finally{
		readline.close();
	}
}

async function exportBackup(db:PrismaClient,users:PurgeUser[]){
	const ids=users.map(user=>user.id);
	const records=await db.user.findMany({
		where:{id:{in:ids}},
		include:accountBackupRelations,
	});
	if(records.length!==users.length)throw new Error('BACKUP_USER_COUNT_MISMATCH');
	const directory=path.resolve(process.cwd(),'backups');
	await mkdir(directory,{recursive:true,mode:0o700});
	const file=path.join(directory,`account-purge-${new Date().toISOString().replaceAll(':','-')}.json`);
	await writeFile(file,JSON.stringify(records,null,2),{encoding:'utf8',mode:0o600,flag:'wx'});
	return file;
}

async function deleteUsers(db:PrismaClient,users:PurgeUser[],keep:PurgeUser,keepEmail:string){
	const ids=users.map(user=>user.id);
	await db.$transaction(async tx=>{
		const exactKeep=await tx.user.findMany({where:{email:keepEmail},select:{id:true,role:true}});
		if(exactKeep.length!==1||exactKeep[0].id!==keep.id||exactKeep[0].role!==Role.USER)throw new Error('KEEP_USER_CHANGED');
		const remainingCandidates=await tx.user.findMany({where:{id:{in:ids},role:Role.USER},select:{id:true}});
		if(remainingCandidates.length!==ids.length)throw new Error('PURGE_TARGETS_CHANGED');
		for(let index=0;index<ids.length;index+=batchSize){
			const batch=ids.slice(index,index+batchSize);
			const result=await tx.user.deleteMany({where:{id:{in:batch},role:Role.USER}});
			if(result.count!==batch.length)throw new Error('PURGE_BATCH_COUNT_MISMATCH');
		}
		const nonAdminUsers=await tx.user.findMany({where:{role:Role.USER},select:{id:true}});
		if(nonAdminUsers.length!==1||nonAdminUsers[0].id!==keep.id)throw new Error('FINAL_NON_ADMIN_COUNT_MISMATCH');
	},{isolationLevel:'Serializable',maxWait:5_000,timeout:120_000});
}

export async function main(args=process.argv.slice(2)){
	loadEnvConfig(process.cwd());
	const keepEmail=cliKeepEmail(args);
	if(!keepEmail){
		console.error('Provide exactly one --keep-email=<email> argument.');
		return 1;
	}
	const execute=executeRequested(args);
	const db=new PrismaClient();
	try{
		const users=await db.user.findMany({select:{id:true,email:true,role:true}});
		const plan=createAccountPurgePlan(users as PurgeUser[],keepEmail);
		if(!execute){
			console.log(`Dry run: ${plan.usersToDelete.length} non-admin account(s) would be deleted.`);
			console.log(`Kept account: ${maskEmail(plan.keep.email)} (requested account).`);
			console.log(`Kept administrator accounts (${plan.admins.length}): ${plan.admins.length?plan.admins.map(user=>maskEmail(user.email)).join(', '):'none'}.`);
			console.log('No data was changed. Add --execute and confirm interactively to proceed.');
			return 0;
		}
		if(!await askForConfirmation()){
			console.log('Confirmation did not match; no data was changed.');
			return 1;
		}
		let backupPath='';
		await runAccountPurgeWorkflow({
			users:users as PurgeUser[],
			keepEmail,
			execute:true,
			exportBackup:async targets=>{backupPath=await exportBackup(db,targets)},
			deleteUsers:targets=>deleteUsers(db,targets,plan.keep,keepEmail),
		});
		console.log(`Deleted ${plan.usersToDelete.length} account(s). Backup saved to ${path.relative(process.cwd(),backupPath)}.`);
		console.log(`Kept account: ${maskEmail(plan.keep.email)}. Kept administrator accounts: ${plan.admins.length}.`);
		return 0;
	}catch(error){
		const code=error instanceof Error?error.message:'UNKNOWN_ERROR';
		const safeMessages:Record<string,string>={
			KEEP_EMAIL_REQUIRED:'A keep email is required.',
			KEEP_EMAIL_MUST_MATCH_EXACTLY_ONE_USER:'The supplied keep email must match exactly one account.',
			KEEP_EMAIL_MUST_MATCH_A_NON_ADMIN_USER:'The supplied keep email must match one non-admin account.',
			KEEP_USER_CHANGED:'The keep account changed during cleanup; no deletion was committed.',
			PURGE_TARGETS_CHANGED:'The target accounts changed during cleanup; no deletion was committed.',
			PURGE_BATCH_COUNT_MISMATCH:'A deletion batch did not match its planned count; no deletion was committed.',
			FINAL_NON_ADMIN_COUNT_MISMATCH:'Final account count check failed; no deletion was committed.',
			BACKUP_USER_COUNT_MISMATCH:'Could not create a complete backup; no deletion was attempted.',
		};
		console.error(safeMessages[code]||'Account cleanup failed; no successful completion was confirmed.');
		return 1;
	}finally{
		await db.$disconnect();
	}
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
	process.exitCode=await main();
}
