'use client';

import {useEffect,useState} from 'react';
import {Moon,Sun} from 'lucide-react';

type Theme='dark'|'light';
const themeKey='aurevia-theme';
const themeChangeEvent='aurevia-theme-change';

function applyTheme(theme:Theme){
	document.documentElement.dataset.theme=theme;
	document.documentElement.style.colorScheme=theme;
	const themeColor=document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
	if(themeColor)themeColor.content=theme==='light'?'#f9fbfd':'#07110d';
	window.dispatchEvent(new CustomEvent(themeChangeEvent,{detail:theme}));
}

export default function ThemeToggle(){
	const [theme,setTheme]=useState<Theme>('dark');

	useEffect(()=>{
		const saved=localStorage.getItem(themeKey);
		const initial=saved==='light'?'light':'dark';
		setTheme(initial);
		applyTheme(initial);
		const onThemeChange=(event:Event)=>{
			if(!(event instanceof CustomEvent))return;
			const next=event.detail==='light'?'light':'dark';
			setTheme(next);
		};
		const onStorage=(event:StorageEvent)=>{
			if(event.key!==themeKey)return;
			const next=event.newValue==='light'?'light':'dark';
			setTheme(next);
			applyTheme(next);
		};
		window.addEventListener(themeChangeEvent,onThemeChange);
		window.addEventListener('storage',onStorage);
		return()=>{
			window.removeEventListener(themeChangeEvent,onThemeChange);
			window.removeEventListener('storage',onStorage);
		};
	},[]);

	function toggle(){
		const next=theme==='dark'?'light':'dark';
		setTheme(next);
		applyTheme(next);
		try{localStorage.setItem(themeKey,next)}catch(error){console.error('Theme preference could not be saved.',error instanceof Error?error.name:'UnknownError')}
	}

	const nextLabel=theme==='dark'?'Switch to light mode':'Switch to dark mode';
	const Icon=theme==='dark'?Sun:Moon;
	return <button type="button" className="theme-toggle" onClick={toggle} aria-label={nextLabel} title={nextLabel}><Icon size={16} aria-hidden="true"/><span>{theme==='dark'?'Light':'Dark'}</span></button>;
}
