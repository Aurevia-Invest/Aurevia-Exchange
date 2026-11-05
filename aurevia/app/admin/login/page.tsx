'use client';
import {FormEvent,useState} from 'react';
import {signIn,useSession} from 'next-auth/react';
import {useRouter} from 'next/navigation';
import Image from 'next/image';
import {Eye,EyeOff} from 'lucide-react';

export default function AdminLogin(){
 const [identifier,setIdentifier]=useState('');
 const [password,setPassword]=useState('');
 const [showPassword,setShowPassword]=useState(false);
 const [error,setError]=useState('');
 const [replaceSession,setReplaceSession]=useState(false);
 const [busy,setBusy]=useState(false);
 const router=useRouter();
 const {update}=useSession();
 async function submit(e:FormEvent){
   e.preventDefault();
   if(busy)return;
   setBusy(true); setError('');
   try{
    const result=await signIn('credentials',{username:identifier,email:identifier,adminLogin:'true',password,replaceSession:String(replaceSession),redirect:false,callbackUrl:'/admin'});
    if(result?.ok){
     await update();router.replace('/admin');router.refresh();
    }else{
     setError('Admin username/email or password is incorrect.');
    }
   }catch{setError('Unable to reach the authentication service. Please try again.')}
   finally{setBusy(false)}
 }
 return <main className="admin-login-scene min-h-screen px-4 py-10 sm:py-16">
   <div className="admin-orb admin-orb-a pointer-events-none" aria-hidden="true"/><div className="admin-orb admin-orb-b pointer-events-none" aria-hidden="true"/>
   <div className="admin-login-card card mx-auto max-w-md p-7 sm:p-9">
    <div className="flex justify-center"><Image src="/aurevia-logo.png" alt="Aurevia Exchange" width={92} height={92} className="admin-login-logo" priority/></div>
    <div className="mt-4 text-center"><div className="gold text-xs font-bold tracking-[0.28em]">AUREVIA EXCHANGE</div><h1 className="mt-2 text-3xl font-black">Administrator sign in</h1><p className="mt-2 muted">Restricted control-center access.</p></div>
     <form onSubmit={submit} className="mt-7 space-y-4">
      <label className="block"><span className="mb-1 block text-xs font-semibold uppercase tracking-wider muted">Admin username or email</span><input className="input" type="text" name="username" autoComplete="username" required placeholder="Configured admin username or email" value={identifier} onChange={e=>setIdentifier(e.target.value)}/></label>
      <label className="block"><span className="mb-1 block text-xs font-semibold uppercase tracking-wider muted">Admin password</span><div className="relative"><input className="input pr-12" type={showPassword?'text':'password'} autoComplete="current-password" required placeholder="Admin password" value={password} onChange={e=>setPassword(e.target.value)}/><button className="absolute right-2 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center rounded text-muted hover:text-white" type="button" aria-label={showPassword?'Hide password':'Show password'} aria-pressed={showPassword} onClick={()=>setShowPassword(value=>!value)}>{showPassword?<EyeOff size={17}/>:<Eye size={17}/>}</button></div></label>
        <label className="flex min-h-11 items-start gap-2 text-sm"><input className="mt-1" type="checkbox" checked={replaceSession} onChange={event=>setReplaceSession(event.target.checked)}/><span>Replace another active Aurevia session and sign it out.</span></label>
       {error&&<p className="text-loss text-sm" role="alert">{error}</p>}
       <button className="btn admin-login-button w-full bg-gold text-black" type="submit" disabled={busy}>{busy?'Authenticating…':'Enter control center'}</button>
     </form>
   </div>
 </main>
}
