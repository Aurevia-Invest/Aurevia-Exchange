'use client';

import dynamic from 'next/dynamic';
import Image from 'next/image';
import {Component,useEffect,useRef,type ReactNode} from 'react';

const StartupEmblemScene=dynamic(()=>import('@/components/StartupEmblemScene'),{
	ssr:false,
	loading:()=>null,
});

type SceneBoundaryProps={children:ReactNode;fallback:ReactNode};
type SceneBoundaryState={hasError:boolean};

class StartupSceneBoundary extends Component<SceneBoundaryProps,SceneBoundaryState>{
	state:SceneBoundaryState={hasError:false};

	static getDerivedStateFromError():SceneBoundaryState{
		return {hasError:true};
	}

	componentDidCatch(error:Error){
		console.warn('[startup] 3D scene unavailable; using the static emblem.',error.name);
	}

	render(){
		return this.state.hasError?this.props.fallback:this.props.children;
	}
}

export default function AureviaStartup({isExiting,onSkip}:{isExiting:boolean;onSkip:()=>void}){
	const skipButton=useRef<HTMLButtonElement>(null);

	useEffect(()=>{
		skipButton.current?.focus({preventScroll:true});
	},[]);

	const staticEmblem=<div className="intro-scene-fallback" aria-hidden="true"/>;

	return <div className={`startup-screen cinematic-intro${isExiting?' is-exiting':''}`} role="dialog" aria-modal="true" aria-label="Aurevia Exchange introduction">
		<div className="intro-ambient intro-ambient-one" aria-hidden="true"/>
		<div className="intro-ambient intro-ambient-two" aria-hidden="true"/>
		<button className="intro-skip" type="button" onClick={onSkip} ref={skipButton}>Skip introduction</button>
		<div className="intro-scene" aria-hidden="true">
			<StartupSceneBoundary fallback={staticEmblem}>
				<StartupEmblemScene/>
			</StartupSceneBoundary>
			<Image className="intro-emblem-image" src="/aurevia-logo.png" alt="" width={1280} height={1280} priority sizes="(max-width: 600px) 78vw, 370px"/>
		</div>
		<div className="intro-copy">
			<p className="intro-overline">AUREVIA EXCHANGE</p>
			<h1 className="intro-brand"><span>AUREVIA</span><span>EXCHANGE</span></h1>
			<div className="intro-rule" aria-hidden="true"/>
			<p className="intro-tagline">Where Financial Vision Meets Opportunity.</p>
			<p className="intro-description">A modern financial platform built for informed investing and market participation.</p>
		</div>
		<p className="intro-footnote" aria-hidden="true">AUREVIA EXCHANGE</p>
	</div>;
}

export function AureviaStartupLoader({isExiting}:{isExiting:boolean}){
	return <div className={`startup-screen${isExiting?' is-exiting':''}`} role="status" aria-live="polite" aria-label="Loading Aurevia Exchange">
		<div className="startup-glow" aria-hidden="true"/>
		<div className="startup-card">
			<div className="startup-emblem" aria-hidden="true"><svg viewBox="0 0 72 72"><defs><linearGradient id="startup-gold" x1="0" x2="1" y1="0" y2="1"><stop stopColor="#f4dfa7"/><stop offset=".48" stopColor="#c5a46b"/><stop offset="1" stopColor="#82612b"/></linearGradient></defs><path d="M10 62 29 10h14l19 52H48l-5-15H29l-5 15z" fill="url(#startup-gold)" stroke="#f4dfa7" strokeLinejoin="round" strokeWidth="1.2"/><path d="m36 21 11 12h-7v11h-8V33h-7z" fill="#0b1b14"/></svg></div>
			<div className="startup-brand">AUREVIA <span>EXCHANGE</span></div>
			<p>Restoring your workspace</p>
			<div className="startup-track" aria-hidden="true"><div className="startup-progress"/></div>
		</div>
	</div>;
}
