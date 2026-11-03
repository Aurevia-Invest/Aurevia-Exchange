'use client';

import dynamic from 'next/dynamic';
import {useEffect,useState} from 'react';

const MarketDepthScene=dynamic(()=>import('@/components/MarketDepthScene'),{
	ssr:false,
	loading:()=> <StaticEmblem className="market-depth-canvas--hero"/>,
});

function StaticEmblem({className=''}:{className?:string}){
	return <div className={`market-depth-fallback ${className}`} aria-hidden="true"><span className="market-depth-fallback-mark">A<i>↑</i></span></div>;
}

export default function HomeDepthScene(){
	const [enabled,setEnabled]=useState(false);

	useEffect(()=>{
		const preference=window.matchMedia('(prefers-reduced-motion: reduce)');
		const capableScreen=window.matchMedia('(min-width: 641px) and (pointer: fine)');
		const update=()=>{
			if(preference.matches||!capableScreen.matches){
				setEnabled(false);
				return;
			}
			const probe=document.createElement('canvas');
			const context=probe.getContext('webgl2')||probe.getContext('webgl');
			const supported=Boolean(context);
			context?.getExtension('WEBGL_lose_context')?.loseContext();
			setEnabled(supported);
		};
		update();
		preference.addEventListener('change',update);
		capableScreen.addEventListener('change',update);
		return()=>{
			preference.removeEventListener('change',update);
			capableScreen.removeEventListener('change',update);
		};
	},[]);

	return enabled?<MarketDepthScene className="market-depth-canvas--hero"/>:<StaticEmblem className="market-depth-canvas--hero"/>;
}
