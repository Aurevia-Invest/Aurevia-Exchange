'use client';

import {useEffect,useState} from 'react';
import Image from 'next/image';
import Link from 'next/link';
import {ArrowLeft,ArrowRight,ArrowUpRight,ShieldCheck} from 'lucide-react';

type ClientStory={
	id:string;
	displayName:string;
	country:string|null;
	cityOrRegion:string|null;
	title?:string|null;
	quote:string;
	imageUrl:string|null;
	rating?:number|null;
	verifiedClientStory?:boolean;
	withdrawalAmount?:string;
	currency?:string;
};

const ROTATE_MS=6_500;

export default function ClientStoryShowcase(){
	const [stories,setStories]=useState<ClientStory[]>([]);
	const [index,setIndex]=useState(0);
	const [loading,setLoading]=useState(true);
	const [error,setError]=useState('');
	const [paused,setPaused]=useState(false);

	useEffect(()=>{
		let active=true;
		void fetch('/api/client-stories',{cache:'no-store'}).then(async response=>{
			const result=await response.json();
			if(!response.ok)throw new Error(typeof result?.error==='string'?result.error:'Stories unavailable');
			if(!active)return;
			const list:ClientStory[]=Array.isArray(result)?result:[];
			setStories(list);
			setError('');
		}).catch(exception=>{
			if(active)setError(exception instanceof Error?exception.message:'Stories unavailable.');
		}).finally(()=>{if(active)setLoading(false)});
		return ()=>{active=false};
	},[]);

	useEffect(()=>{
		if(paused||stories.length<2)return;
		const timer=window.setInterval(()=>setIndex(current=>(current+1)%stories.length),ROTATE_MS);
		return ()=>window.clearInterval(timer);
	},[paused,stories.length]);

	const current=stories[index]??null;
	const go=(delta:number)=>{
		if(!stories.length)return;
		setIndex(currentIndex=>(currentIndex+delta+stories.length)%stories.length);
	};

	return (
		<section
			className="home-section client-stories-rotator"
			aria-labelledby="client-stories-heading"
			onMouseEnter={()=>setPaused(true)}
			onMouseLeave={()=>setPaused(false)}
			onFocusCapture={()=>setPaused(true)}
			onBlurCapture={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))setPaused(false);}}
		>
			<div className="section-heading">
				<div>
					<p className="eyebrow">CUSTOMER EXPERIENCES</p>
					<h2 id="client-stories-heading">Investment testimonials</h2>
					<p className="section-intro">Profiles and stories rotate automatically. Pause by hovering or focusing the panel.</p>
				</div>
				<Link className="text-link" href="/client-stories">View all stories <ArrowUpRight size={14}/></Link>
			</div>

			{loading&&<p className="client-stories-empty text-sm" role="status">Loading customer stories…</p>}
			{!loading&&error&&<p className="client-stories-empty text-sm" role="status">{error}</p>}

			{!loading&&!error&&current&&(
				<div className="client-story-stage card p-5 sm:p-7" aria-live="polite">
					<div className="client-story-stage-grid">
						<div className="client-story-stage-portrait">
							<span className="client-story-avatar client-story-avatar-lg">
								{current.imageUrl?(
									<Image src={current.imageUrl} alt={`Portrait for ${current.displayName}`} width={160} height={160} unoptimized className="client-story-portrait"/>
								):(
									<span className="client-story-monogram client-story-monogram-lg" aria-hidden="true">{current.displayName.trim().charAt(0).toUpperCase()}</span>
								)}
							</span>
							{Boolean(current.verifiedClientStory)&&(
								<span className="client-story-verified"><ShieldCheck size={14}/> Verified client story</span>
							)}
						</div>
						<div className="client-story-stage-body">
							{current.title&&<p className="eyebrow">{current.title}</p>}
							{current.rating&&<p className="client-story-rating" aria-label={`Rated ${current.rating} out of 5`}>{'★'.repeat(current.rating)}<span className="sr-only">Rated {current.rating} out of 5</span></p>}
							<blockquote className="client-story-quote whitespace-pre-line break-words">“{current.quote}”</blockquote>
							<div className="mt-5">
								<h3 className="font-semibold text-lg">{current.displayName}</h3>
								<p className="muted text-sm">{[current.cityOrRegion,current.country].filter(Boolean).join(', ')}</p>
								{current.withdrawalAmount&&(
									<p className="mt-3 text-sm gold">Verified withdrawal · {Number(current.withdrawalAmount).toLocaleString()} {current.currency}</p>
								)}
							</div>
							<div className="client-story-controls">
								<button type="button" className="client-story-nav-btn" aria-label="Previous story" onClick={()=>go(-1)}><ArrowLeft size={16}/></button>
								<div className="client-story-dots" role="tablist" aria-label="Story slides">
									{stories.map((story,i)=>(
										<button
											key={story.id}
											type="button"
											role="tab"
											aria-selected={i===index}
											className={`client-story-dot ${i===index?'is-active':''}`}
											onClick={()=>setIndex(i)}
											aria-label={`Show story ${i+1} of ${stories.length}`}
										/>
									))}
								</div>
								<button type="button" className="client-story-nav-btn" aria-label="Next story" onClick={()=>go(1)}><ArrowRight size={16}/></button>
								<span className="client-story-count muted text-xs">{index+1} / {stories.length}</span>
							</div>
						</div>
					</div>
				</div>
			)}

			{!loading&&!error&&!stories.length&&(
				<div className="client-stories-empty card p-6">
					<span className="client-story-verified"><ShieldCheck size={14}/> Consent-first publication</span>
					<p className="mt-3 max-w-2xl text-sm leading-7 muted">
						No published client stories yet. When administrators publish consented profiles under <strong>Admin → Client stories</strong>, they will rotate here automatically—one profile after another.
					</p>
					<p className="mt-2 text-xs muted">Stories are not invented on the homepage. Publish real consented entries from the admin console to populate this rotator.</p>
				</div>
			)}
		</section>
	);
}
