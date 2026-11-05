import {NextAuthOptions} from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import {createHash,randomUUID} from 'node:crypto';
import {isIP} from 'node:net';
import type {IncomingHttpHeaders} from 'node:http';
import bcrypt from 'bcryptjs';
import {NotificationType,Prisma,Role,UserStatus} from '@prisma/client';
import {db} from '@/lib/db';
import {createNotification} from '@/lib/notifications';
import {RateLimitError,rateLimit} from '@/lib/rate-limit';
import {matchesConfiguredAdminIdentity,matchesConfiguredAdminPassword,resolveCredentialLookup} from '@/lib/credential-lookup';
import {getServerConfiguration} from '@/lib/config/env';
import {AUTH_SESSION_MAX_AGE_SECONDS,isAuthSessionExpired} from '@/lib/auth-session';
import {hashSessionId} from '@/lib/security';
import {clearPersistentRateLimit,persistentRateLimit} from '@/lib/security-rate-limit';

function headerValue(value:string|string[]|undefined){return Array.isArray(value)?value[0]||'':value||''}
function sessionDeviceLabel(userAgent:string|null){
  if(!userAgent)return 'Unknown device';
  const browser=/Edg\//.test(userAgent)?'Edge':/Firefox\//.test(userAgent)?'Firefox':/Chrome\//.test(userAgent)?'Chrome':/Safari\//.test(userAgent)?'Safari':'Browser';
  const platform=/iPhone|iPad/.test(userAgent)?'iOS':/Android/.test(userAgent)?'Android':/Windows/.test(userAgent)?'Windows':/Mac OS/.test(userAgent)?'macOS':/Linux/.test(userAgent)?'Linux':'Device';
  return `${browser} on ${platform}`;
}
function auditClientIp(headers:IncomingHttpHeaders){
  const forwarded=headerValue(headers['x-forwarded-for']).split(',').at(-1)?.trim();
  const real=headerValue(headers['x-real-ip']).trim();
  const candidate=forwarded&&isIP(forwarded)?forwarded:real&&isIP(real)?real:'';
  return candidate||null;
}
function safeAuditError(error:unknown){
  const code=error&&typeof error==='object'&&'code' in error?String(error.code):'';
  return /^[A-Z0-9_]{2,32}$/.test(code)?code:error instanceof Error?error.name:'UnknownError';
}
function hasPrismaCode(error:unknown,code:string){
  return !!error&&typeof error==='object'&&'code' in error&&error.code===code;
}
function isPrismaSchemaMismatch(error:unknown){
  return hasPrismaCode(error,'P2021')||hasPrismaCode(error,'P2022');
}
function authFailureCategory(error:unknown){
  const code=error&&typeof error==='object'&&'code' in error?String(error.code):'';
  if(['P2021','P2022'].includes(code))return 'DATABASE_SCHEMA_MISMATCH';
  if(['P1001','P1002','P1017'].includes(code))return 'DATABASE_UNAVAILABLE';
  return 'AUTHENTICATION_DEPENDENCY_FAILURE';
}
const credentialUserSelect={
  id:true,
  email:true,
  name:true,
  passwordHash:true,
  role:true,
  accountMode:true,
  status:true,
} satisfies Prisma.UserSelect;
export const authOptions:NextAuthOptions={
  session:{strategy:'jwt',maxAge:AUTH_SESSION_MAX_AGE_SECONDS},
  jwt:{maxAge:AUTH_SESSION_MAX_AGE_SECONDS},
  pages:{signIn:'/login'},
  providers:[CredentialsProvider({
    name:'credentials',
    credentials:{
      email:{label:'Email',type:'email'},
      username:{label:'Username',type:'text'},
      password:{label:'Password',type:'password'},
      adminLogin:{label:'Administrator sign-in',type:'text'},
    },
    async authorize(c,request){
      const referenceId=randomUUID();
      const password=c?.password;
      if(!password)return null;
      const username=(c?.username||'').trim();
      const email=(c?.email||username).trim().toLowerCase();
      const passwordForAuthentication=typeof c?.password==='string'?c.password:'';
      const headers=request.headers as IncomingHttpHeaders|undefined;
      const ipAddress=headers?auditClientIp(headers):null;
      const userAgent=(headers?headerValue(headers['user-agent']):'').replace(/[\u0000-\u001f\u007f]/g,'').slice(0,500)||null;
      const identifierHash=createHash('sha256').update(email||username||'unknown').digest('hex');
      const writeLoginAudit=async(status:'SUCCESS'|'FAILED',userId?:string,sessionId?:string,reason?:string)=>{
        try{
          await db.auditLog.create({data:{
            actorId:userId||null,
            action:`LOGIN_${status}`,
            entity:'LOGIN',
            entityId:userId||identifierHash,
            metadata:{status,authMethod:'credentials',clientIp:ipAddress,userAgent,sessionRef:sessionId?createHash('sha256').update(sessionId).digest('hex').slice(0,24):null,reason:reason||null},
          }});
        }catch(error){console.warn(`Login audit write failed (${safeAuditError(error)}).`)}
      };
      const ipAttemptKey=`credential-login:${ipAddress||'unknown'}`;
      const serverConfig=getServerConfiguration();
      const authConfig=serverConfig.auth;
      const {isAdminUsername,lookupEmail}=resolveCredentialLookup(username,email,authConfig.adminUsername,authConfig.adminEmail,c?.adminLogin==='true');
      if(!lookupEmail){await writeLoginAudit('FAILED',undefined,undefined,'MISSING_IDENTIFIER');return null;}
      try{
      let u=await db.user.findFirst({where:{email:{equals:lookupEmail,mode:'insensitive'}},select:credentialUserSelect});
      if((!u||u.role!==Role.ADMIN)&&c?.adminLogin==='true'&&authConfig.adminUsername&&authConfig.adminEmail&&authConfig.adminPassword?.length>=12&&matchesConfiguredAdminIdentity(username,email,authConfig.adminUsername,authConfig.adminEmail)&&matchesConfiguredAdminPassword(passwordForAuthentication,authConfig.adminPassword)){
        const configuredEmail=authConfig.adminEmail.trim().toLowerCase();
        const passwordHash=await bcrypt.hash(authConfig.adminPassword,12);
        u=await db.$transaction(async tx=>{
          const account=await tx.user.findUnique({where:{email:configuredEmail},select:credentialUserSelect});
          const existingAdmin=await tx.user.findFirst({where:{role:Role.ADMIN},select:{id:true}});
          if(existingAdmin&&existingAdmin.id!==account?.id){
            if(account)return account;
            return tx.user.update({where:{id:existingAdmin.id},data:{email:configuredEmail,passwordHash,name:authConfig.adminUsername!.trim(),status:UserStatus.ACTIVE},select:credentialUserSelect});
          }
          if(account){
            if(account.role===Role.ADMIN)return account;
            return null;
          }
          return tx.user.create({data:{email:configuredEmail,passwordHash,name:authConfig.adminUsername!.trim(),role:Role.ADMIN,status:UserStatus.ACTIVE},select:credentialUserSelect});
        },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
      }
      if(!u||u.status!=='ACTIVE'){
        try{rateLimit(ipAttemptKey,20,15*60_000)}catch{
          await writeLoginAudit('FAILED',u?.id,undefined,'RATE_LIMITED');
          return null;
        }
        await writeLoginAudit('FAILED',u?.id,undefined,!u?'ACCOUNT_NOT_FOUND':'ACCOUNT_INACTIVE');
        return null;
      }
      const authenticatedUser=u;
      const accountAttemptKey=`credential-login-account:${authenticatedUser.id}`;
      const usesConfiguredAdminPassword=!!authConfig.adminEmail&&lookupEmail.toLowerCase()===authConfig.adminEmail.toLowerCase();
      const ok=usesConfiguredAdminPassword
        ?matchesConfiguredAdminPassword(passwordForAuthentication,authConfig.adminPassword)
        :await bcrypt.compare(passwordForAuthentication,authenticatedUser.passwordHash);
      if(!ok){
        try{
          rateLimit(ipAttemptKey,20,15*60_000);
          await persistentRateLimit(accountAttemptKey,12,15*60_000);
        }catch(error){
          if(!(error instanceof RateLimitError))throw error;
          await writeLoginAudit('FAILED',authenticatedUser.id,undefined,'RATE_LIMITED');
          try{await createNotification(db,{userId:authenticatedUser.id,type:NotificationType.SECURITY,title:'Suspicious sign-in attempts',message:'Repeated unsuccessful sign-in attempts were detected. If you do not recognize this activity, change your password and review active sessions.',dedupeKey:`security:${authenticatedUser.id}:login-rate-limited:${Math.floor(Date.now()/900_000)}`,actionUrl:'/settings#security'});}catch{console.warn('Unable to persist authentication security notification.')}
          return null;
        }
        await writeLoginAudit('FAILED',authenticatedUser.id,undefined,'INVALID_CREDENTIALS');
        return null;
      }
      if(isAdminUsername&&authenticatedUser.role!=='ADMIN'){await writeLoginAudit('FAILED',authenticatedUser.id,undefined,'ADMIN_ROLE_REQUIRED');return null;}
      const now=new Date();
      try{
        await clearPersistentRateLimit(accountAttemptKey);
      }catch(error){
        if(!isPrismaSchemaMismatch(error))throw error;
        console.warn('[auth] Persistent sign-in rate-limit storage is unavailable; continuing with valid credentials.',{
          referenceId,
          errorCode:hasPrismaCode(error,'P2021')?'P2021':'P2022',
        });
      }
      const sessionId=randomUUID();
      const label=sessionDeviceLabel(userAgent);
      try{
        await db.securitySession.create({data:{userId:authenticatedUser.id,sessionHash:hashSessionId(sessionId),deviceLabel:label,userAgent,expiresAt:new Date(now.getTime()+AUTH_SESSION_MAX_AGE_SECONDS*1000)},select:{id:true}});
      }catch(error){
        if(!isPrismaSchemaMismatch(error))throw error;
        const legacySession=await db.user.updateMany({where:{id:authenticatedUser.id},data:{activeSessionId:sessionId,activeSessionUpdatedAt:now}});
        if(legacySession.count!==1)throw error;
        console.warn('[auth] Security-session storage is unavailable; using legacy single-session storage.',{
          referenceId,
          errorCode:hasPrismaCode(error,'P2021')?'P2021':'P2022',
        });
      }
      await writeLoginAudit('SUCCESS',authenticatedUser.id,sessionId);
      return {id:authenticatedUser.id,email:authenticatedUser.email,name:authenticatedUser.name,role:authenticatedUser.role,accountMode:authenticatedUser.accountMode,sessionId};
      }catch(error){
        const code=error&&typeof error==='object'&&'code' in error?String(error.code):'';
        console.error('[auth] Credential authorization failed.',{
          referenceId,
          category:authFailureCategory(error),
          errorName:error instanceof Error?error.name:'UnknownError',
          ...(/^[A-Z0-9_]{2,32}$/.test(code)?{errorCode:code}:{}),
        });
        throw new Error(`AUTHENTICATION_SERVICE_UNAVAILABLE:${referenceId}`);
      }
    }
  })],
  callbacks:{
    async jwt({token,user,trigger}){
      if(user){token.id=user.id;token.name=user.name;token.email=user.email;token.role=user.role;token.accountMode=user.accountMode;token.sessionId=user.sessionId;}
      if(trigger==='update'&&token.id&&typeof token.sessionId==='string'){
        const currentHash=hashSessionId(token.sessionId);
        try{
          const pending=await db.securitySession.findFirst({where:{userId:String(token.id),sessionHash:currentHash,revokedAt:null,rotationRequired:true,expiresAt:{gt:new Date()}},select:{id:true}});
          if(pending){
            const rotatedId=randomUUID();
            await db.securitySession.update({where:{id:pending.id},data:{sessionHash:hashSessionId(rotatedId),rotationRequired:false,reauthenticatedAt:new Date()}});
            token.sessionId=rotatedId;
          }
        }catch(error){
          if(!isPrismaSchemaMismatch(error))throw error;
          const rotatedId=randomUUID();
          const result=await db.user.updateMany({where:{id:String(token.id),activeSessionId:token.sessionId},data:{activeSessionId:rotatedId,activeSessionUpdatedAt:new Date()}});
          if(result.count===1)token.sessionId=rotatedId;
        }
      }
      if(token.id){
        const current=await db.user.findUnique({where:{id:String(token.id)},select:{name:true,email:true,role:true,status:true,accountMode:true,activeSessionId:true,activeSessionUpdatedAt:true}});
        let activeSession: {id:string;lastActivityAt:Date}|null=null;
        let usesLegacySession=false;
        if(token.sessionId){
          try{
            activeSession=await db.securitySession.findFirst({where:{userId:String(token.id),sessionHash:hashSessionId(token.sessionId),revokedAt:null,expiresAt:{gt:new Date()}},select:{id:true,lastActivityAt:true}});
          }catch(error){
            if(!isPrismaSchemaMismatch(error))throw error;
            usesLegacySession=true;
            if(current?.activeSessionId===token.sessionId&&!isAuthSessionExpired(current.activeSessionUpdatedAt)){
              activeSession={id:'legacy-session',lastActivityAt:current.activeSessionUpdatedAt!};
            }
          }
        }
        if(!activeSession&&current?.activeSessionId&&current.activeSessionId===token.sessionId&&!isAuthSessionExpired(current.activeSessionUpdatedAt)){
          const oldTimestamp=current.activeSessionUpdatedAt!;
          try{
            activeSession=await db.securitySession.create({data:{userId:String(token.id),sessionHash:hashSessionId(token.sessionId!),createdAt:oldTimestamp,lastActivityAt:oldTimestamp,expiresAt:new Date(oldTimestamp.getTime()+AUTH_SESSION_MAX_AGE_SECONDS*1000)},select:{id:true,lastActivityAt:true}});
          }catch(error){
            if(isPrismaSchemaMismatch(error)){
              usesLegacySession=true;
              activeSession={id:'legacy-session',lastActivityAt:oldTimestamp};
            }else{
              if(!(error instanceof Prisma.PrismaClientKnownRequestError&&error.code==='P2002'))throw error;
              activeSession=await db.securitySession.findFirst({where:{userId:String(token.id),sessionHash:hashSessionId(token.sessionId!),revokedAt:null,expiresAt:{gt:new Date()}},select:{id:true,lastActivityAt:true}});
            }
          }
        }
        if(!current||current.status!=='ACTIVE'||!activeSession){token.id='';token.name=null;token.email=null;token.role=undefined;token.accountMode=undefined;token.sessionId=undefined;}
        else{
          if(!usesLegacySession&&Date.now()-activeSession.lastActivityAt.getTime()>5*60_000)await db.securitySession.updateMany({where:{id:activeSession.id,revokedAt:null},data:{lastActivityAt:new Date()}});
          token.name=current.name;token.email=current.email;token.role=current.role;token.accountMode=current.accountMode;
        }
      }
      return token;
    },
    async session({session,token}){if(session.user){session.user.id=String(token.id||'');session.user.name=typeof token.name==='string'?token.name:null;session.user.email=typeof token.email==='string'?token.email:null;session.user.role=token.role as 'USER'|'ADMIN';session.user.accountMode=token.accountMode as 'DEMO'|'REAL';const sessionHash=typeof token.sessionId==='string'?hashSessionId(token.sessionId):'';session.user.sessionId=sessionHash.slice(0,12);session.user.sessionHash=sessionHash;}return session}
  },
  events:{
    async signIn({user}){
      if(!user.id)return;
      const bucket=Math.floor(Date.now()/300_000);
      try{
        await createNotification(db,{userId:user.id,type:NotificationType.SECURITY,title:'New sign-in',message:'A successful sign-in to your Aurevia Exchange account was recorded.',dedupeKey:`security:${user.id}:signin:${bucket}`,actionUrl:'/settings#security'});
      }catch{
        console.warn('Unable to persist sign-in notification.');
      }
    },
    async signOut(message){
      const token='token' in message?message.token:undefined;
      const userId=token?.id||token?.sub;
      const sessionId=typeof token?.sessionId==='string'?token.sessionId:null;
      if(!userId)return;
      if(sessionId){
        try{
          await db.securitySession.updateMany({where:{userId:String(userId),sessionHash:hashSessionId(sessionId),revokedAt:null},data:{revokedAt:new Date()}});
        }catch(error){
          if(!isPrismaSchemaMismatch(error))console.warn('Unable to revoke the security session.',{errorCode:safeAuditError(error)});
        }
        try{
          await db.user.updateMany({where:{id:String(userId),activeSessionId:sessionId},data:{activeSessionId:null,activeSessionUpdatedAt:null}});
        }catch(error){console.warn('Unable to clear the active account session.',{errorCode:safeAuditError(error)});}
      }
      try{
        await db.auditLog.create({data:{actorId:String(userId),action:'LOGOUT_SUCCESS',entity:'LOGIN',entityId:String(userId),metadata:{status:'SUCCESS',authMethod:'credentials',sessionRef:sessionId?createHash('sha256').update(sessionId).digest('hex').slice(0,24):null}}});
      }catch{console.warn('Unable to persist logout audit.');}
    }
  },
};