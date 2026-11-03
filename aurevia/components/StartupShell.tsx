'use client';

import {useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {ReactNode} from 'react';
import Image from 'next/image';
import {usePathname} from 'next/navigation';
import {useSession} from 'next-auth/react';
import AureviaStartup from '@/components/AureviaStartup';

const startupKey='aurevia-startup-complete';
const exitDurationMs=180;
const maximumStartupWaitMs=1200;
const pageTransitionDurationMs=220;

export default function StartupShell({children}:{children:ReactNode}){
	const {status}=useSession();
	const pathname=usePathname();
	const contentRef=useRef<HTMLDivElement>(null);
	const currentPath=useRef(pathname);
	const pageTransitionTimer=useRef<number|undefined>(undefined);
	const [ready,setReady]=useState(false);
	const [showStartup,setShowStartup]=useState(true);
	const [isExiting,setIsExiting]=useState(false);
	const [showPageTransition,setShowPageTransition]=useState(false);

	const markStartupComplete=useCallback(()=>{
		try{sessionStorage.setItem(startupKey,'1')}catch{}
		document.documentElement.dataset.aureviaStartupComplete='true';
		setShowStartup(false);
	},[]);

	useEffect(()=>{
		try{
			if(sessionStorage.getItem(startupKey)==='1'){
				document.documentElement.dataset.aureviaStartupComplete='true';
				setShowStartup(false);
			}
		}catch{}
		setReady(true);
	},[]);

	useEffect(()=>{
		contentRef.current?.toggleAttribute('inert',showStartup);
	},[showStartup]);

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
		if(!ready||!showStartup)return;
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
	},[markStartupComplete,ready,showStartup,status]);

	return <div className="app-shell">
		<div className="scene-depth" aria-hidden="true"/>
		<div className="scene-content"><div ref={contentRef} aria-hidden={showStartup}>{children}</div>{showStartup&&<AureviaStartup isExiting={isExiting}/>}
			{showPageTransition&&<div className="page-transition-loading" role="status" aria-live="polite"><Image src="/aurevia-logo.png" alt="" width={64} height={64} priority/><p>Loading the next page…</p></div>}
		</div>
	</div>;
}
