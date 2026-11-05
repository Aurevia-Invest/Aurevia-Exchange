import nextEnv from '@next/env';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:net';

const {loadEnvConfig}=nextEnv;
const projectRoot=process.cwd();
for(const name of ['DATABASE_URL','DIRECT_URL'])delete process.env[name];
loadEnvConfig(projectRoot,false,undefined,true);

function run(command,args,options={}){
	return new Promise((resolve,reject)=>{
		const child=spawn(command,args,{cwd:projectRoot,stdio:'inherit',...options});
		child.on('error',reject);
		child.on('exit',code=>resolve(code));
	});
}

function capture(command,args,{input}={}){
	return new Promise((resolve,reject)=>{
		const child=spawn(command,args,{cwd:projectRoot,stdio:['pipe','pipe','pipe']});
		let stdout='';
		let stderr='';
		child.stdout.setEncoding('utf8').on('data',chunk=>stdout+=chunk);
		child.stderr.setEncoding('utf8').on('data',chunk=>stderr+=chunk);
		if(input)child.stdin.end(input);else child.stdin.end();
		child.on('error',reject);
		child.on('exit',code=>resolve({code,stdout:stdout.trim(),stderr:stderr.trim()}));
	});
}

async function reserveLoopbackPort(){
	const server=createServer();
	await new Promise((resolve,reject)=>{
		server.once('error',reject);
		server.listen(0,'127.0.0.1',resolve);
	});
	const address=server.address();
	if(!address||typeof address==='string')throw new Error('Unable to reserve an isolated E2E port.');
	return {port:address.port,server};
}

function releasePortReservation(server){
	return new Promise((resolve,reject)=>{
		if(!server.listening)return resolve();
		server.close(error=>error?reject(error):resolve());
	});
}

const containerName=`aurevia-e2e-${randomUUID()}`;
const databaseName='aurevia_e2e';
const databaseUser='aurevia_e2e';
const portReservations=[];
let containerStarted=false;
let exitCode=1;

try{
	const started=await capture('docker',['run','--detach','--rm','--name',containerName,'--publish','127.0.0.1::5432','--env',`POSTGRES_DB=${databaseName}`,'--env',`POSTGRES_USER=${databaseUser}`,'--env','POSTGRES_HOST_AUTH_METHOD=trust','postgres:16-alpine']);
	if(started.code!==0)throw new Error(`Unable to start the isolated PostgreSQL container: ${started.stderr.slice(0,500)}`);
	containerStarted=true;
	const published=await capture('docker',['port',containerName,'5432/tcp']);
	const portMatch=/^127\.0\.0\.1:(\d+)$/.exec(published.stdout);
	if(published.code!==0||!portMatch)throw new Error('Unable to confirm the loopback-only PostgreSQL port.');
	const databaseUrl=`postgresql://${databaseUser}@127.0.0.1:${portMatch[1]}/${databaseName}?schema=public`;
	const appPortReservation=await reserveLoopbackPort();
	portReservations.push(appPortReservation.server);
	const providerPortReservation=await reserveLoopbackPort();
	portReservations.push(providerPortReservation.server);
	const appUrl=`http://127.0.0.1:${appPortReservation.port}`;
	const providerUrl=`http://127.0.0.1:${providerPortReservation.port}`;
	const environment={...process.env,DATABASE_URL:databaseUrl,DIRECT_URL:databaseUrl,AUREVIA_E2E_DATABASE_URL:databaseUrl,AUREVIA_E2E_DIRECT_URL:databaseUrl,AUREVIA_E2E_APP_PORT:String(appPortReservation.port),AUREVIA_E2E_PROVIDER_PORT:String(providerPortReservation.port),AUREVIA_E2E_APP_URL:appUrl,AUREVIA_E2E_PROVIDER_URL:providerUrl,CRON_SECRET:randomUUID(),PORT:String(appPortReservation.port),NODE_ENV:'production',ALPACA_PAPER_ORDERS_ENABLED:'false',REAL_EXECUTION_ENABLED:'false',FINNHUB_API_KEY:'',AKEDLY_ENABLED:'false',AKEDLY_API_KEY:'',AKEDLY_PIPELINE_ID:'',AKEDLY_WIDGET_ID:'',AKEDLY_PUBLIC_KEY:'',AKEDLY_WIDGET_SECRET:'',AKEDLY_WEBHOOK_SECRET:'',WITHDRAWAL_DESTINATION_ENCRYPTION_KEY:Buffer.alloc(32,1).toString('base64'),TOTP_ENCRYPTION_KEY:Buffer.alloc(32,2).toString('base64')};
	for(const name of Object.keys(environment))if(/SUPABASE|STORAGE/i.test(name))environment[name]='';
	Object.assign(environment,{SUPABASE_URL:'',SUPABASE_SERVICE_ROLE_KEY:'',NEXT_PUBLIC_SUPABASE_URL:'',NEXT_PUBLIC_SUPABASE_ANON_KEY:''});
	let ready=false;
	for(let attempt=0;attempt<60;attempt++){
		const logs=await capture('docker',['logs',containerName]);
		const initComplete=`${logs.stdout}\n${logs.stderr}`.includes('PostgreSQL init process complete; ready for start up.');
		if(initComplete){
			const check=await capture('docker',['exec',containerName,'psql','-v','ON_ERROR_STOP=1','-U',databaseUser,'-d',databaseName,'-c','SELECT 1']);
			if(check.code===0){ready=true;break;}
		}
		await new Promise(resolve=>setTimeout(resolve,1000));
	}
	if(!ready)throw new Error('The isolated PostgreSQL container did not become ready.');
	const storageBootstrap=`CREATE ROLE postgres SUPERUSER LOGIN;\nDO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;\nDO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;\nCREATE SCHEMA storage;\nCREATE TABLE storage.buckets (id text PRIMARY KEY, name text NOT NULL, public boolean NOT NULL DEFAULT false, file_size_limit bigint, owner uuid, owner_id text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), avif_autodetection boolean NOT NULL DEFAULT false);\nCREATE TABLE storage.objects (id bigserial PRIMARY KEY, bucket_id text NOT NULL REFERENCES storage.buckets(id), name text NOT NULL, UNIQUE(bucket_id,name));\nINSERT INTO storage.buckets (id,name,public,file_size_limit) VALUES ('kyc-documents','kyc-documents',false,10485760),('profile-avatars','profile-avatars',false,5242880),('wallet-receipts','wallet-receipts',false,10485760),('support-attachments','support-attachments',false,10485760);\n`;
	const bootstrapped=await capture('docker',['exec','-i',containerName,'psql','-v','ON_ERROR_STOP=1','-U',databaseUser,'-d',databaseName],{input:storageBootstrap});
	if(bootstrapped.code!==0)throw new Error(`Unable to initialize isolated Storage policy prerequisites: ${bootstrapped.stderr.slice(0,500)}`);
	const migrated=await run('npx',['prisma','migrate','deploy'],{env:environment});
	if(migrated!==0)throw new Error('Prisma migrations failed on the isolated E2E database.');
	console.log('Running Playwright against a disposable loopback-only PostgreSQL database.');
	await Promise.all(portReservations.map(releasePortReservation));
	exitCode=await run('npm',['run','test:e2e','--',...process.argv.slice(2)],{env:environment});
}catch(error){
	console.error(error instanceof Error?error.message:'Isolated E2E setup failed.');
}finally{
	await Promise.all(portReservations.map(releasePortReservation));
	if(containerStarted){
		const removed=await capture('docker',['rm','--force',containerName]);
		if(removed.code!==0){console.error('Unable to remove the isolated E2E PostgreSQL container.');exitCode=1;}
	}
}
process.exitCode=exitCode??1;
