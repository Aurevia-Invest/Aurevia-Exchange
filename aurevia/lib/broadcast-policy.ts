import type {BroadcastStatus} from '@prisma/client';

export type BroadcastAction='schedule'|'publish'|'end'|'archive';

const transitions:Record<BroadcastStatus,Partial<Record<BroadcastAction,BroadcastStatus>>>= {
	DRAFT:{schedule:'SCHEDULED',publish:'PUBLISHED',archive:'ARCHIVED'},
	SCHEDULED:{publish:'PUBLISHED',archive:'ARCHIVED'},
	PUBLISHED:{end:'ENDED',archive:'ARCHIVED'},
	ENDED:{archive:'ARCHIVED'},
	ARCHIVED:{},
};

export function nextBroadcastStatus(status:BroadcastStatus,action:BroadcastAction){
	const next=transitions[status][action];
	if(!next)throw new Error('BROADCAST_TRANSITION_NOT_ALLOWED');
	return next;
}

export function validateBroadcastUrl(value:string|null){
	if(value===null)return null;
	let url:URL;
	try{url=new URL(value)}catch{throw new Error('INVALID_BROADCAST_URL')}
	if(url.protocol!=='https:'||url.username||url.password)throw new Error('INVALID_BROADCAST_URL');
	return url.toString();
}

export function broadcastMediaSource(value:string|null):{kind:'video'|'embed';url:string}|null{
	if(!value)return null;
	let url:URL;
	try{url=new URL(value)}catch{return null}
	if(url.protocol!=='https:'||url.username||url.password)return null;
	const host=url.hostname.toLowerCase();
	const videoPath=/\.(mp4|webm|ogg|m3u8)$/i.test(url.pathname);
	if(videoPath)return {kind:'video',url:url.toString()};
	if(host==='youtu.be'){
		const videoId=url.pathname.slice(1);
		return /^[A-Za-z0-9_-]{6,20}$/.test(videoId)?{kind:'embed',url:`https://www.youtube-nocookie.com/embed/${videoId}`}:null;
	}
	if(host==='youtube.com'||host==='www.youtube.com'||host==='youtube-nocookie.com'||host==='www.youtube-nocookie.com'){
		const videoId=url.pathname==='/watch'?url.searchParams.get('v'):url.pathname.split('/').at(-1);
		return videoId&&/^[A-Za-z0-9_-]{6,20}$/.test(videoId)?{kind:'embed',url:`https://www.youtube-nocookie.com/embed/${videoId}`}:null;
	}
	if(host==='vimeo.com'||host==='www.vimeo.com'||host==='player.vimeo.com'){
		const videoId=url.pathname.split('/').filter(Boolean).at(-1)||'';
		return videoId&&/^\d{1,20}$/.test(videoId)?{kind:'embed',url:`https://player.vimeo.com/video/${videoId}`}:null;
	}
	return null;
}