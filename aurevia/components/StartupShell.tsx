'use client';

import {useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {MouseEvent,ReactNode} from 'react';
import {usePathname} from 'next/navigation';
import {useSession} from 'next-auth/react';
import AureviaStartup,{AureviaStartupLoader} from '@/components/AureviaStartup';
import AureviaLoading from '@/components/AureviaLoading';

const startupKey='aurevia-startup-complete';
const introductionKey='aurevia-introduction-complete';
const exitDurationMs=180;
const maximumStartupWaitMs=1200;
const navigationLoaderDelayMs=100;
const navigationLoaderTimeoutMs=15_000;
const introductionDurationMs=10_250;
const introductionExitDurationMs=420;
type StartupMode='loading'|'cinematic'|'hidden';

export default function StartupShell({children}:{children:ReactNode}){
	const {status}=useSession();
	const pathname=usePathname();
	const currentPath=useRef(pathname);
	const startupInitialized=useRef(false);
	const introductionTimers=useRef<{start?:number;exit?:number}>({});
	const navigationLoaderTimer=useRef<number|undefined>(undefined);
	const navigationTimeoutTimer=useRef<number|undefined>(undefined);
	const [ready,setReady]=useState(false);
	const [startupMode,setStartupMode]=useState<StartupMode>('loading');
	const [introductionStarted,setIntroductionStarted]=useState(false);
	const [isExiting,setIsExiting]=useState(false);
	const [showPageTransition,setShowPageTransition]=useState(false);
	const showStartup=startupMode!=='hidden';

	const clearNavigationTimers=useCallback(()=>{
		if(navigationLoaderTimer.current!==undefined)window.clearTimeout(navigationLoaderTimer.current);
		if(navigationTimeoutTimer.current!==undefined)window.clearTimeout(navigationTimeoutTimer.current);
		navigationLoaderTimer.current=undefined;
		navigationTimeoutTimer.current=undefined;
	},[]);

	const startNavigation=useCallback(()=>{
		if(!ready||startupMode!=='hidden'||window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;
		clearNavigationTimers();
		navigationLoaderTimer.current=window.setTimeout(()=>setShowPageTransition(true),navigationLoaderDelayMs);
		navigationTimeoutTimer.current=window.setTimeout(()=>{
			setShowPageTransition(false);
			clearNavigationTimers();
		},navigationLoaderTimeoutMs);
	},[clearNavigationTimers,ready,startupMode]);

	const handleNavigationClick=useCallback((event:MouseEvent<HTMLDivElement>)=>{
		if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
		if(!(event.target instanceof Element))return;
		const anchor=event.target.closest('a');
		if(!anchor||anchor.target&&anchor.target!=='_self'||anchor.hasAttribute('download'))return;
		const destination=new URL(anchor.href,window.location.href);
		if(destination.origin!==window.location.origin||destination.pathname===window.location.pathname)return;
		startNavigation();
	},[startNavigation]);

	const markStartupComplete=useCallback(()=>{
		try{sessionStorage.setItem(startupKey,'1')}catch{}
		document.documentElement.dataset.aureviaStartupComplete='true';
		setStartupMode('hidden');
	},[]);

	const markIntroductionComplete=useCallback(()=>{
		try{sessionStorage.setItem(introductionKey,'1')}catch{}
		markStartupComplete();
	},[markStartupComplete]);

	const skipIntroduction=useCallback(()=>{
		if(introductionTimers.current.start!==undefined)window.clearTimeout(introductionTimers.current.start);
		if(introductionTimers.current.exit!==undefined)window.clearTimeout(introductionTimers.current.exit);
		setIsExiting(true);
		introductionTimers.current.exit=window.setTimeout(markIntroductionComplete,introductionExitDurationMs);
	},[markIntroductionComplete]);

	useEffect(()=>{
		if(startupInitialized.current){
			setReady(true);
			return;
		}
		startupInitialized.current=true;
		let introductionSeen=false;
		let startupSeen=false;
		try{
			introductionSeen=sessionStorage.getItem(introductionKey)==='1';
			startupSeen=sessionStorage.getItem(startupKey)==='1';
		}catch{}
		if(pathname==='/'&&!introductionSeen)setStartupMode('cinematic');
		else if(startupSeen){
			document.documentElement.dataset.aureviaStartupComplete='true';
			setStartupMode('hidden');
		}
		setReady(true);
	},[pathname]);

	useEffect(()=>{
		if(startupMode!=='cinematic'||pathname==='/')return;
		markIntroductionComplete();
	},[markIntroductionComplete,pathname,startupMode]);

	useEffect(()=>{
		if(!ready||startupMode!=='cinematic')return;
		const policyDialog=document.querySelector<HTMLDialogElement>('.policy-consent-dialog');
		if(!policyDialog){
			setIntroductionStarted(true);
			return;
		}
		const updateIntroductionState=()=>setIntroductionStarted(!policyDialog.open);
		const observer=new MutationObserver(updateIntroductionState);
		observer.observe(policyDialog,{attributes:true,attributeFilter:['open']});
		const initialCheck=window.setTimeout(updateIntroductionState,80);
		return()=>{
			window.clearTimeout(initialCheck);
			observer.disconnect();
		};
	},[ready,startupMode]);

	useLayoutEffect(()=>{
		if(currentPath.current===pathname)return;
		currentPath.current=pathname;
		clearNavigationTimers();
		setShowPageTransition(false);
	},[clearNavigationTimers,pathname]);

	useEffect(()=>{
		window.addEventListener('popstate',startNavigation);
		return()=>{
			window.removeEventListener('popstate',startNavigation);
			clearNavigationTimers();
		};
	},[clearNavigationTimers,startNavigation]);

	useEffect(()=>{
		if(!ready||startupMode!=='loading')return;
		if(window.matchMedia('(prefers-reduced-motion: reduce)').matches){
			markStartupComplete();
			return;
		}
		let exitTimer:number|undefined;
		const timer=window.setTimeout(()=>{
			setIsExiting(true);
			exitTimer=window.setTimeout(markStartupComplete,exitDurationMs);
		},status==='loading'?maximumStartupWaitMs:0);
		return()=>{
			window.clearTimeout(timer);
			if(exitTimer!==undefined)window.clearTimeout(exitTimer);
		};
	},[markStartupComplete,ready,startupMode,status]);

	useEffect(()=>{
		if(!ready||startupMode!=='cinematic'||!introductionStarted)return;
		if(window.matchMedia('(prefers-reduced-motion: reduce)').matches){
			markIntroductionComplete();
			return;
		}
		const timers=introductionTimers.current;
		timers.start=window.setTimeout(()=>{
			setIsExiting(true);
			timers.exit=window.setTimeout(markIntroductionComplete,introductionExitDurationMs);
		},introductionDurationMs);
		return()=>{
			if(timers.start!==undefined)window.clearTimeout(timers.start);
			if(timers.exit!==undefined)window.clearTimeout(timers.exit);
		};
	},[introductionStarted,markIntroductionComplete,ready,startupMode]);

	return <div className="app-shell" onClickCapture={handleNavigationClick}>
		<div className="scene-depth" aria-hidden="true"/>
		<div className="scene-content"><div inert={showStartup||showPageTransition} aria-hidden={showStartup||showPageTransition}>{children}</div>
			{startupMode==='cinematic'&&introductionStarted&&<AureviaStartup isExiting={isExiting} onSkip={skipIntroduction}/>}
			{startupMode==='loading'&&<AureviaStartupLoader isExiting={isExiting}/>}
			{showPageTransition&&<AureviaLoading label="Loading the next page" detail="Moving securely through Aurevia Exchange"/>}
		</div>
	</div>;
}
