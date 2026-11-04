'use client';

import {useEffect,useId,useMemo,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {Check,ChevronDown,Search,X} from 'lucide-react';
import {countrySearchMatches,findCountry,supportedCountries} from '@/lib/countries';

type CountrySelectorProps={label:string;value:string;onChange:(countryCode:string)=>void;required?:boolean;invalid?:boolean;errorId?:string;showDialCode?:boolean};

export default function CountrySelector({label,value,onChange,required=false,invalid=false,errorId,showDialCode=true}:CountrySelectorProps){
	const [open,setOpen]=useState(false);
	const [query,setQuery]=useState('');
	const id=useId();
	const searchRef=useRef<HTMLInputElement>(null);
	const triggerRef=useRef<HTMLButtonElement>(null);
	const dialogRef=useRef<HTMLElement|null>(null);
	const selected=findCountry(value);
	const visibleCountries=useMemo(()=>supportedCountries.filter(country=>countrySearchMatches(country,query)),[query]);

	useEffect(()=>{
		if(!open)return;
		searchRef.current?.focus();
		const previousOverflow=document.body.style.overflow;
		document.body.style.overflow='hidden';
		const handleKeyDown=(event:KeyboardEvent)=>{
			if(event.key==='Escape'){setOpen(false);triggerRef.current?.focus();return;}
			const focusable=Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('input:not([disabled]),button:not([disabled])')||[]);
			if(event.key==='Tab'&&focusable.length){
				const first=focusable[0],last=focusable[focusable.length-1];
				if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
				else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
				return;
			}
			const options=Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]')||[]);
			if(!options.length)return;
			const index=options.indexOf(document.activeElement as HTMLButtonElement);
			if(event.key==='ArrowDown'&&(event.target===searchRef.current||index>=0)){event.preventDefault();options[Math.min(index+1,options.length-1)].focus();}
			if(event.key==='ArrowUp'&&index>=0){event.preventDefault();options[Math.max(index-1,0)].focus();}
			if(event.key==='Home'&&index>=0){event.preventDefault();options[0].focus();}
			if(event.key==='End'&&index>=0){event.preventDefault();options[options.length-1].focus();}
		};
		document.addEventListener('keydown',handleKeyDown);
		return()=>{document.body.style.overflow=previousOverflow;document.removeEventListener('keydown',handleKeyDown)};
	},[open]);

	function choose(code:string){
		onChange(code);setOpen(false);setQuery('');triggerRef.current?.focus();
	}

	return <div className="country-selector">
		<button ref={triggerRef} type="button" className={`country-selector-trigger ${invalid?'is-invalid':''}`} aria-label={`${label}${required?', required':''}: ${selected?`${selected.name} ${selected.dialCode}`:'Select country'}`} aria-haspopup="dialog" aria-expanded={open} aria-describedby={errorId} onClick={()=>setOpen(true)}>
			{selected?<><span className="country-flag" aria-hidden="true">{selected.flag}</span><span className="country-selector-name">{selected.name}</span>{showDialCode&&<span className="country-dial-code">{selected.dialCode}</span>}</>:<span className="muted">Select country</span>}
			<ChevronDown size={16} aria-hidden="true"/>
		</button>
		{open&&typeof document!=='undefined'&&createPortal(<div className="country-picker-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget){setOpen(false);triggerRef.current?.focus()}}}>
			<section ref={dialogRef} className="country-picker-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}>
				<header className="country-picker-header"><div><p className="account-kicker">INTERNATIONAL DIRECTORY</p><h2 id={`${id}-title`}>Select {label.toLowerCase()}</h2></div><button type="button" className="country-picker-close" aria-label="Close country selector" onClick={()=>{setOpen(false);triggerRef.current?.focus()}}><X size={19}/></button></header>
				<label className="country-picker-search"><Search size={17} aria-hidden="true"/><span className="sr-only">Search country name, country code, or dialing code</span><input ref={searchRef} type="search" value={query} onChange={event=>setQuery(event.target.value)} placeholder="Search name, code, or dial code" autoComplete="off"/></label>
				<p className="country-picker-hint" aria-live="polite">{visibleCountries.length} {visibleCountries.length===1?'country':'countries'} · Select the country matching your phone number; delivery coverage may vary.</p>
				<div className="country-picker-list" id={`${id}-options`} role="listbox" aria-label={`${label} options`}>
					{visibleCountries.map(country=><button type="button" role="option" aria-selected={country.code===value} className={`country-picker-option ${country.code===value?'is-selected':''}`} key={country.code} onClick={()=>choose(country.code)}>
						<span className="country-flag" aria-hidden="true">{country.flag}</span><span className="country-picker-option-name">{country.name}</span><span className="country-picker-option-code">{country.code}</span><b>{country.dialCode}</b>{country.code===value&&<Check size={16} aria-hidden="true"/>}
					</button>)}
					{!visibleCountries.length&&<p className="country-picker-empty">No matching countries.</p>}
				</div>
			</section>
		</div>,document.body)}
	</div>;
}