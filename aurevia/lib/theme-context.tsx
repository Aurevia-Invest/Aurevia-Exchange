'use client';

import {createContext,useCallback,useContext,useEffect,useRef,useState,type ReactNode} from 'react';
import {useSession} from 'next-auth/react';
import {isTheme,type Theme} from '@/lib/theme-shared';

const anonymousThemeKey='aurevia-anonymous-theme';
const anonymousThemeCookie='aurevia-anonymous-theme';

type ThemeContextValue={
	theme:Theme;
	selectTheme:(theme:Theme)=>Promise<void>;
	isSaving:boolean;
	isReady:boolean;
	error:string;
};

const ThemeContext=createContext<ThemeContextValue|null>(null);

function applyTheme(theme:Theme){
	document.documentElement.dataset.themeName=theme;
	document.documentElement.dataset.theme=theme==='premium-dashboard'?'light':'dark';
	document.documentElement.style.colorScheme=theme==='premium-dashboard'?'light':'dark';
	const themeColor=document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
	if(themeColor)themeColor.content=theme==='premium-dashboard'?'#F7F8F5':'#07110D';
	window.dispatchEvent(new CustomEvent('aurevia-theme-change',{detail:theme}));
}

function readAnonymousTheme():Theme{
	try{
		const stored=localStorage.getItem(anonymousThemeKey);
		if(isTheme(stored))return stored;
	}catch(error){
		console.warn('Anonymous theme preference is unavailable.',error instanceof Error?error.name:'UnknownError');
	}
	const cookie=document.cookie.split('; ').find(value=>value.startsWith(`${anonymousThemeCookie}=`))?.split('=')[1];
	if(isTheme(cookie))return cookie;
	return 'forest-green';
}

function persistAnonymousTheme(theme:Theme){
	let saved=false;
	try{
		localStorage.setItem(anonymousThemeKey,theme);
		saved=true;
	}catch(error){
		console.warn('Anonymous theme preference could not be stored locally.',error instanceof Error?error.name:'UnknownError');
	}
	try{
		document.cookie=`${anonymousThemeCookie}=${theme}; Path=/; Max-Age=31536000; SameSite=Lax`;
		saved=true;
	}catch(error){
		console.warn('Anonymous theme preference cookie could not be stored.',error instanceof Error?error.name:'UnknownError');
	}
	return saved;
}

export function ThemeProvider({children,initialTheme,initialUserId}:{children:ReactNode;initialTheme:Theme;initialUserId:string|null}){
	const {data:session,status}=useSession();
	const [theme,setTheme]=useState(initialTheme);
	const [isSaving,setIsSaving]=useState(false);
	const [error,setError]=useState('');
	const activeUserId=useRef<string|null>(initialUserId);
	const requestGeneration=useRef(0);

	useEffect(()=>{
		const bootstrapped=document.documentElement.dataset.themeName;
		if(isTheme(bootstrapped)){
			setTheme(bootstrapped);
			applyTheme(bootstrapped);
		}else applyTheme(initialTheme);
	},[initialTheme]);

	useEffect(()=>{
		if(status==='loading')return;
		const nextUserId=status==='authenticated'?session?.user?.id||null:null;
		if(nextUserId===activeUserId.current)return;
		activeUserId.current=nextUserId;
		setError('');
		if(!nextUserId){
			const anonymousTheme=readAnonymousTheme();
			setTheme(anonymousTheme);
			applyTheme(anonymousTheme);
			return;
		}
		const generation=++requestGeneration.current;
		let active=true;
		setTheme('forest-green');
		applyTheme('forest-green');
		void fetch('/api/theme-preference',{cache:'no-store'}).then(async response=>{
			const result=await response.json().catch(()=>null) as {theme?:unknown;error?:unknown}|null;
			if(!response.ok)throw new Error(typeof result?.error==='string'?result.error:`Theme preference request failed (${response.status}).`);
			if(!result||!isTheme(result.theme))throw new Error('Theme preference response was invalid.');
			if(active&&requestGeneration.current===generation&&activeUserId.current===nextUserId){
				setTheme(result.theme);
				applyTheme(result.theme);
			}
		}).catch(exception=>{
			if(!active||requestGeneration.current!==generation||activeUserId.current!==nextUserId)return;
			setError('The account theme could not be loaded. Choose a theme to try again.');
			console.error('Account theme preference could not be loaded.',exception instanceof Error?exception.name:'UnknownError');
		});
		return()=>{active=false};
	},[session?.user?.id,status]);

	const selectTheme=useCallback(async(nextTheme:Theme)=>{
		if(status==='loading'||isSaving||nextTheme===theme)return;
		setTheme(nextTheme);
		applyTheme(nextTheme);
		setError('');
		if(activeUserId.current){
			setIsSaving(true);
			try{
				const response=await fetch('/api/theme-preference',{
					method:'PATCH',
					headers:{'content-type':'application/json'},
					body:JSON.stringify({theme:nextTheme}),
				});
				if(!response.ok){
					const result=await response.json().catch(()=>null) as {error?:unknown}|null;
					throw new Error(typeof result?.error==='string'?result.error:`Theme preference request failed (${response.status}).`);
				}
			}catch(exception){
				setError(exception instanceof Error?exception.message:'Your theme changed for this session but could not be saved to your account.');
				console.error('Account theme preference could not be saved.',exception instanceof Error?exception.name:'UnknownError');
			}finally{
				setIsSaving(false);
			}
			return;
		}
		if(!persistAnonymousTheme(nextTheme))setError('Your theme changed, but this browser could not save the preference.');
	},[isSaving,status,theme]);

	return <ThemeContext.Provider value={{theme,selectTheme,isSaving,isReady:status!=='loading',error}}>{children}</ThemeContext.Provider>;
}

export function useTheme(){
	const context=useContext(ThemeContext);
	if(!context)throw new Error('useTheme must be used within ThemeProvider.');
	return context;
}
