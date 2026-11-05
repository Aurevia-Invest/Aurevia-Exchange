import type {ReactNode} from 'react';
import {cookies} from 'next/headers';
import Script from 'next/script';
import './globals.css';
import './experience.css';
import './aurevia-loading.css';
import './theme.css';
import StartupShell from '@/components/StartupShell';
import Providers from '@/components/Providers';
import {normalizeLocale} from '@/lib/i18n';
import {getServerSession} from 'next-auth';
import {authOptions} from '@/lib/auth-options';
import {db} from '@/lib/db';
import {isTheme,themeFromPreference,type Theme} from '@/lib/theme';

export const metadata={title:'Aurevia Exchange',description:'Aurevia Exchange — a secure, account-first digital markets platform'};
export const viewport={width:'device-width',initialScale:1,viewportFit:'cover',themeColor:'#07110D'};

export default async function RootLayout({children}:{children:ReactNode}){
  const cookieStore=await cookies();
  const initialLocale=normalizeLocale(cookieStore.get('aurevia-locale')?.value ?? null);
  const direction=initialLocale==='ar'?'rtl':'ltr';
  const anonymousPreference=cookieStore.get('aurevia-anonymous-theme')?.value;
  let initialTheme:Theme=isTheme(anonymousPreference)?anonymousPreference:'forest-green';
  let initialUserId:string|null=null;
  const session=await getServerSession(authOptions);
  if(session?.user?.id&&(session.user.role==='USER'||session.user.role==='ADMIN')){
    initialUserId=session.user.id;
    try{
      const account=await db.user.findUnique({where:{id:initialUserId},select:{preferredTheme:true}});
      initialTheme=account?themeFromPreference(account.preferredTheme):'forest-green';
    }catch(error){
      initialTheme='forest-green';
      console.error('Authenticated theme preference could not be loaded.',error instanceof Error?error.name:'UnknownError');
    }
  }
  const legacyTheme=initialTheme==='premium-dashboard'?'light':'dark';
  const themeBootstrap=`try{if(sessionStorage.getItem('aurevia-startup-complete')==='1')document.documentElement.dataset.aureviaStartupComplete='true'}catch{}try{const root=document.documentElement;if(root.dataset.themeAccount!=='true'){const cookie=document.cookie.split('; ').find(value=>value.startsWith('aurevia-anonymous-theme='))?.split('=')[1];let theme=cookie==='premium-dashboard'?'premium-dashboard':cookie==='forest-green'?'forest-green':root.dataset.themeName;const cached=localStorage.getItem('aurevia-anonymous-theme');if(cached==='premium-dashboard'||cached==='forest-green')theme=cached;else{const legacy=localStorage.getItem('aurevia-theme');if(legacy==='light')theme='premium-dashboard';else if(legacy==='dark')theme='forest-green'}root.dataset.themeName=theme;root.dataset.theme=theme==='premium-dashboard'?'light':'dark';if(cookie!=='premium-dashboard'&&cookie!=='forest-green')document.cookie='aurevia-anonymous-theme='+theme+'; Path=/; Max-Age=31536000; SameSite=Lax';localStorage.removeItem('aurevia-theme')}root.style.colorScheme=root.dataset.themeName==='premium-dashboard'?'light':'dark';const meta=document.querySelector('meta[name="theme-color"]');if(meta)meta.content=root.dataset.themeName==='premium-dashboard'?'#F7F8F5':'#07110D'}catch{}`;
  return <html lang={initialLocale} dir={direction} data-theme={legacyTheme} data-theme-name={initialTheme} data-theme-account={initialUserId?'true':'false'} suppressHydrationWarning><body><Script id="aurevia-startup-state" strategy="beforeInteractive">{themeBootstrap}</Script><Providers initialLocale={initialLocale} initialTheme={initialTheme} initialUserId={initialUserId}><StartupShell>{children}</StartupShell></Providers></body></html>;
}
