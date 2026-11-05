'use client';

import {useState, type ReactNode} from 'react';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {SessionProvider} from 'next-auth/react';
import {usePathname} from 'next/navigation';
import {LocaleProvider} from '@/lib/i18n-context';
import {normalizeLocale,type Locale} from '@/lib/i18n';
import FloatingSupportChat from '@/components/FloatingSupportChat';
import PolicyConsentGate from '@/components/PolicyConsentGate';
import {ThemeProvider} from '@/lib/theme-context';
import type {Theme} from '@/lib/theme';

export default function Providers({children,initialLocale,initialTheme,initialUserId}:{children:ReactNode;initialLocale:Locale;initialTheme:Theme;initialUserId:string|null}){
  const pathname=usePathname();
  const [queryClient]=useState(()=>new QueryClient({
    defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}},
  }));

  return <SessionProvider><QueryClientProvider client={queryClient}><ThemeProvider initialTheme={initialTheme} initialUserId={initialUserId}><LocaleProvider initialLocale={normalizeLocale(initialLocale)}>{children}{!pathname.startsWith('/admin')&&<FloatingSupportChat/>}<PolicyConsentGate/></LocaleProvider></ThemeProvider></QueryClientProvider></SessionProvider>;
}