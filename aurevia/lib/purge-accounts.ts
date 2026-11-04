export type PurgeUser={id:string;email:string;role:'USER'|'ADMIN'};
export type AccountPurgePlan={keep:PurgeUser;admins:PurgeUser[];usersToDelete:PurgeUser[]};

export function createAccountPurgePlan(users:PurgeUser[],keepEmail:string|undefined):AccountPurgePlan{
	if(!keepEmail)throw new Error('KEEP_EMAIL_REQUIRED');
	const matches=users.filter(user=>user.email===keepEmail);
	if(matches.length!==1)throw new Error('KEEP_EMAIL_MUST_MATCH_EXACTLY_ONE_USER');
	if(matches[0].role==='ADMIN')throw new Error('KEEP_EMAIL_MUST_MATCH_A_NON_ADMIN_USER');
	return {
		keep:matches[0],
		admins:users.filter(user=>user.role==='ADMIN'),
		usersToDelete:users.filter(user=>user.role!=='ADMIN'&&user.id!==matches[0].id),
	};
}

export async function runAccountPurgeWorkflow(input:{
	users:PurgeUser[];
	keepEmail:string|undefined;
	execute:boolean;
	exportBackup:(users:PurgeUser[])=>Promise<void>;
	deleteUsers:(users:PurgeUser[])=>Promise<void>;
}):Promise<AccountPurgePlan>{
	const plan=createAccountPurgePlan(input.users,input.keepEmail);
	if(input.execute){
		await input.exportBackup(plan.usersToDelete);
		await input.deleteUsers(plan.usersToDelete);
	}
	return plan;
}

export function maskEmail(email:string){
	const [local='',domain='']=email.split('@');
	const domainParts=domain.split('.');
	return `${local.slice(0,1)}***@${domainParts[0]?.slice(0,1)||'*'}***.${domainParts.slice(1).join('.')||'***'}`;
}
