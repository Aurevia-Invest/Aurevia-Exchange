import {NextAuthOptions} from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import {createHash,randomUUID} from 'node:crypto';
import {isIP} from 'node:net';
import type {IncomingHttpHeaders} from 'node:http';
import bcrypt from 'bcryptjs';
import {NotificationType,Prisma,Role,UserStatus} from '@prisma/client';
import {db} from '@/lib/db';
import {createNotification} from '@/lib/notifications';
import {rateLimit} from '@/lib/rate-limit';
import {matchesConfiguredAdminIdentity,matchesConfiguredAdminPassword,resolveCredentialLookup} from '@/lib/credential-lookup';
import {getServerConfiguration} from '@/lib/config/env';
import {AUTH_SESSION_MAX_AGE_SECONDS,isAuthSessionExpired} from '@/lib/auth-session';

function headerValue(value:string|string[]|undefined){return Array.isArray(value)?value[0]||'':value||''}
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
      replaceSession:{label:'Replace active session',type:'text'}
    },
    async authorize(c,request){
      const password=c?.password;
      if(!password)return null;
      const username=(c?.username||'').trim();
      const email=(c?.email||username).trim().toLowerCase();
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
      try{rateLimit(`credential-login:${ipAddress||'unknown'}`,20,15*60_000)}catch{await writeLoginAudit('FAILED',undefined,undefined,'RATE_LIMITED');return null}
      const serverConfig=getServerConfiguration();
      const authConfig=serverConfig.auth;
      const {isAdminUsername,lookupEmail}=resolveCredentialLookup(username,email,authConfig.adminUsername,authConfig.adminEmail,c?.adminLogin==='true');
      if(!lookupEmail){await writeLoginAudit('FAILED',undefined,undefined,'MISSING_IDENTIFIER');return null;}
      let u=await db.user.findUnique({where:{email:lookupEmail}});
      if((!u||u.role!==Role.ADMIN)&&c?.adminLogin==='true'&&authConfig.adminUsername&&authConfig.adminEmail&&authConfig.adminPassword?.length>=12&&matchesConfiguredAdminIdentity(username,email,authConfig.adminUsername,authConfig.adminEmail)&&matchesConfiguredAdminPassword(password,authConfig.adminPassword)){
        const configuredEmail=authConfig.adminEmail.trim().toLowerCase();
        const passwordHash=await bcrypt.hash(authConfig.adminPassword,12);
        u=await db.$transaction(async tx=>{
          const account=await tx.user.findUnique({where:{email:configuredEmail}});
          const existingAdmin=await tx.user.findFirst({where:{role:Role.ADMIN},select:{id:true}});
          if(existingAdmin&&existingAdmin.id!==account?.id){
            if(account)return account;
            return tx.user.update({where:{id:existingAdmin.id},data:{email:configuredEmail,passwordHash,name:authConfig.adminUsername!.trim(),status:UserStatus.ACTIVE}});
          }
          if(account){
            if(account.role===Role.ADMIN)return account;
            return null;
          }
          return tx.user.create({data:{email:configuredEmail,passwordHash,name:authConfig.adminUsername!.trim(),role:Role.ADMIN,status:UserStatus.ACTIVE}});
        },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
      }
      if(!u||u.status!=='ACTIVE'){
        await writeLoginAudit('FAILED',u?.id,undefined,!u?'ACCOUNT_NOT_FOUND':'ACCOUNT_INACTIVE');
        return null;
      }
      const usesConfiguredAdminPassword=!!authConfig.adminEmail&&lookupEmail.toLowerCase()===authConfig.adminEmail.toLowerCase();
      const ok=usesConfiguredAdminPassword
        ?matchesConfiguredAdminPassword(password,authConfig.adminPassword)
        :await bcrypt.compare(password,u.passwordHash);
      if(!ok){await writeLoginAudit('FAILED',u.id,undefined,'INVALID_CREDENTIALS');return null;}
      if(isAdminUsername&&u.role!=='ADMIN'){await writeLoginAudit('FAILED',u.id,undefined,'ADMIN_ROLE_REQUIRED');return null;}
      const activeSessionExpired=!!u.activeSessionId&&isAuthSessionExpired(u.activeSessionUpdatedAt);
      if(u.activeSessionId&&!activeSessionExpired&&c?.replaceSession!=='true'){await writeLoginAudit('FAILED',u.id,undefined,'ACTIVE_SESSION_REPLACEMENT_REQUIRED');return null;}
      const sessionId=randomUUID();
      const claimed=await db.user.updateMany({where:{id:u.id,activeSessionId:u.activeSessionId},data:{activeSessionId:sessionId,activeSessionUpdatedAt:new Date()}});
      if(claimed.count!==1){await writeLoginAudit('FAILED',u.id,undefined,'SESSION_CLAIM_FAILED');return null;}
      await writeLoginAudit('SUCCESS',u.id,sessionId);
      return {id:u.id,email:u.email,name:u.name,role:u.role,accountMode:u.accountMode,sessionId};
    }
  })],
  callbacks:{
    async jwt({token,user}){
      if(user){token.id=user.id;token.name=user.name;token.email=user.email;token.role=user.role;token.accountMode=user.accountMode;token.sessionId=user.sessionId;}
      if(token.id){
        const current=await db.user.findUnique({where:{id:String(token.id)},select:{name:true,email:true,role:true,status:true,accountMode:true,activeSessionId:true}});
        if(!current||current.status!=='ACTIVE'||(token.sessionId&&current.activeSessionId!==token.sessionId)){token.id='';token.name=null;token.email=null;token.role=undefined;token.accountMode=undefined;token.sessionId=undefined;}
        else{token.name=current.name;token.email=current.email;token.role=current.role;token.accountMode=current.accountMode;}
      }
      return token;
    },
    async session({session,token}){if(session.user){session.user.id=String(token.id||'');session.user.name=typeof token.name==='string'?token.name:null;session.user.email=typeof token.email==='string'?token.email:null;session.user.role=token.role as 'USER'|'ADMIN';session.user.accountMode=token.accountMode as 'DEMO'|'REAL';session.user.sessionId=typeof token.sessionId==='string'?token.sessionId.slice(0,8):'legacy';}return session}
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
        try{await db.user.updateMany({where:{id:String(userId),activeSessionId:sessionId},data:{activeSessionId:null,activeSessionUpdatedAt:null}});}
        catch{console.warn('Unable to clear the active account session.');}
      }
      try{
        await db.auditLog.create({data:{actorId:String(userId),action:'LOGOUT_SUCCESS',entity:'LOGIN',entityId:String(userId),metadata:{status:'SUCCESS',authMethod:'credentials',sessionRef:sessionId?createHash('sha256').update(sessionId).digest('hex').slice(0,24):null}}});
      }catch{console.warn('Unable to persist logout audit.');}
    }
  },
};