'use client';

import {useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {ReactNode} from 'react';
import Image from 'next/image';
import {usePathname} from 'next/navigation';
import {useSession} from 'next-auth/react';
import AureviaStartup,{AureviaStartupLoader} from '@/components/AureviaStartup';

const startupKey='aurevia-startup-complete';
const introductionKey='aurevia-introduction-complete';
const exitDurationMs=180;
const maximumStartupWaitMs=1200;
const pageTransitionDurationMs=220;
const introductionDurationMs=10_250;
const introductionExitDurationMs=420;
type StartupMode='loading'|'cinematic'|'hidden';

export default function StartupShell({children}:{children:ReactNode}){
	const {status}=useSession();
	const pathname=usePathname();
	const contentRef=useRef<HTMLDivElement>(null);
	const currentPath=useRef(pathname);
	const startupInitialized=useRef(false);
	const introductionTimers=useRef<{start?:number;exit?:number}>({});
	const pageTransitionTimer=useRef<number|undefined>(undefined);
	const [ready,setReady]=useState(false);
	const [startupMode,setStartupMode]=useState<StartupMode>('loading');
	const [introductionStarted,setIntroductionStarted]=useState(false);
	const [isExiting,setIsExiting]=useState(false);
	const [showPageTransition,setShowPageTransition]=useState(false);
	const showStartup=startupMode!=='hidden';

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
		contentRef.current?.toggleAttribute('inert',showStartup);
	},[showStartup]);

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
		if(window.matchMedia('(prefers-reduced-motion: reduce)').matches){
			setShowPageTransition(false);
			return;
		}
		setShowPageTransition(true);
		if(pageTransitionTimer.current!==undefined)window.clearTimeout(pageTransitionTimer.current);
		pageTransitionTimer.current=window.setTimeout(()=>setShowPageTransition(false),pageTransitionDurationMs);
	},[pathname]);

	useEffect(()=>()=>{if(pageTransitionTimer.current!==undefined)window.clearTimeout(pageTransitionTimer.current)},[]);

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

	return <div className="app-shell">
		<div className="scene-depth" aria-hidden="true"/>
		<div className="scene-content"><div ref={contentRef} aria-hidden={showStartup}>{children}</div>
			{startupMode==='cinematic'&&introductionStarted&&<AureviaStartup isExiting={isExiting} onSkip={skipIntroduction}/>}
			{startupMode==='loading'&&<AureviaStartupLoader isExiting={isExiting}/>}
			{showPageTransition&&<div className="page-transition-loading" role="status" aria-live="polite"><Image src="/aurevia-logo.png" alt="" width={64} height={64} priority/><p>Loading the next page…</p></div>}
		</div>
	</div>;
}
