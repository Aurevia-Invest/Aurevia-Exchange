'use client';

import Image from 'next/image';
import {useEffect,useState} from 'react';
import {useSession} from 'next-auth/react';
import {UserRound} from 'lucide-react';

export const profileAvatarUpdatedEvent='aurevia:profile-avatar-updated';

export function notifyProfileAvatarUpdated(url:string){
	window.dispatchEvent(new CustomEvent(profileAvatarUpdatedEvent,{detail:{url}}));
}

export default function ProfileAvatar({className='',size=40,alt=''}:{className?:string;size?:number;alt?:string}){
	const [url,setUrl]=useState('');
	const {status}=useSession();

	useEffect(()=>{
		if(status!=='authenticated'){setUrl('');return}
		let active=true;
		const load=async()=>{
			try{
				const response=await fetch('/api/profile/avatar',{cache:'no-store'});
				if(response.status===401||response.status===403||response.status===404){if(active)setUrl('');return}
				const result=await response.json();
				if(!response.ok)throw new Error(result.error||'Unable to load profile photo.');
				if(active&&typeof result.url==='string')setUrl(result.url);
			}catch(error){
				if(active)console.error('Profile photo is unavailable.',error instanceof Error?error.name:'UnknownError');
			}
		};
		const onAvatarUpdated=(event:Event)=>{
			const detail=(event as CustomEvent<{url?:unknown}>).detail;
			if(typeof detail?.url==='string')setUrl(detail.url);
		};
		void load();
		const refreshTimer=window.setInterval(()=>void load(),90_000);
		window.addEventListener('focus',load);
		window.addEventListener(profileAvatarUpdatedEvent,onAvatarUpdated);
		return()=>{active=false;window.clearInterval(refreshTimer);window.removeEventListener('focus',load);window.removeEventListener(profileAvatarUpdatedEvent,onAvatarUpdated)};
	},[status]);

	return <span className={className} style={{display:'grid',placeItems:'center',boxSizing:'border-box',width:size,height:size,aspectRatio:'1 / 1',flexShrink:0,overflow:'hidden',borderRadius:'50%',clipPath:'circle(50%)'}} role={alt?'img':undefined} aria-label={alt||undefined} aria-hidden={alt?undefined:true}>
		{url?<Image src={url} alt="" width={size} height={size} unoptimized className="profile-avatar-image" style={{width:'100%',height:'100%',borderRadius:'50%',objectFit:'cover',objectPosition:'center',clipPath:'circle(50%)'}}/>:<UserRound size={Math.round(size*.54)} strokeWidth={1.7} className="profile-avatar-fallback-icon" aria-hidden="true"/>}
	</span>;
}
