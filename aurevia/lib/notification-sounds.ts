'use client';

export const notificationSoundCategories=[
	'newNotification',
	'orderSubmitted',
	'orderFilled',
	'orderRejected',
	'depositApproved',
	'depositRejected',
	'withdrawalApproved',
	'withdrawalRejected',
	'withdrawalCompleted',
	'adminMessage',
	'priceAlert',
	'securityImportant',
] as const;

export type NotificationSoundCategory=typeof notificationSoundCategories[number];
export type SoundableNotification={id:string;type:string;title:string;message:string};
export type NotificationSoundSettings={
	enabled:boolean;
	volume:number;
	categories:Record<NotificationSoundCategory,boolean>;
};

export const defaultNotificationSoundSettings:NotificationSoundSettings={
	enabled:false,
	volume:0.45,
	categories:{
		newNotification:true,
		orderSubmitted:true,
		orderFilled:true,
		orderRejected:true,
		depositApproved:true,
		depositRejected:true,
		withdrawalApproved:true,
		withdrawalRejected:true,
		withdrawalCompleted:true,
		adminMessage:true,
		priceAlert:true,
		securityImportant:true,
	},
};

const storagePrefix='aurevia.notification-sounds.v1';
const settingsChangedEvent='aurevia:notification-sound-settings';
const soundPatterns:Record<NotificationSoundCategory,number[]> = {
	newNotification:[587.33,783.99],
	orderSubmitted:[493.88,587.33],
	orderFilled:[659.25,783.99,987.77],
	orderRejected:[392,329.63],
	depositApproved:[523.25,659.25,783.99],
	depositRejected:[440,349.23],
	withdrawalApproved:[587.33,698.46,880],
	withdrawalRejected:[415.3,311.13],
	withdrawalCompleted:[659.25,880,1046.5],
	adminMessage:[587.33,698.46],
	priceAlert:[880,1046.5],
	securityImportant:[783.99,587.33,783.99],
};
const playedMarkerLimit=500;
const playedMarkerMaxAge=7*24*60*60*1000;

let audioContext:AudioContext|null=null;
let audioUnlocked=false;
let audioWarningShown=false;
let nextPlaybackTime=0;

function settingsKey(userId:string){return `${storagePrefix}.${encodeURIComponent(userId)}`;}
function defaultSettings():NotificationSoundSettings{
	return {...defaultNotificationSoundSettings,categories:{...defaultNotificationSoundSettings.categories}};
}

export function normalizeNotificationSoundSettings(value:unknown):NotificationSoundSettings{
	if(!value||typeof value!=='object')return defaultSettings();
	const input=value as Partial<NotificationSoundSettings>;
	const categories={...defaultNotificationSoundSettings.categories};
	if(input.categories&&typeof input.categories==='object'){
		for(const category of notificationSoundCategories){
			const enabled=input.categories[category];
			if(typeof enabled==='boolean')categories[category]=enabled;
		}
	}
	return {
		enabled:typeof input.enabled==='boolean'?input.enabled:defaultNotificationSoundSettings.enabled,
		volume:typeof input.volume==='number'&&Number.isFinite(input.volume)?Math.min(1,Math.max(0,input.volume)):defaultNotificationSoundSettings.volume,
		categories,
	};
}

export function getNotificationSoundSettings(userId:string):NotificationSoundSettings{
	try{
		const stored=window.localStorage.getItem(settingsKey(userId));
		return stored?normalizeNotificationSoundSettings(JSON.parse(stored)):defaultSettings();
	}catch(error){
		console.warn('Unable to read notification sound preferences',error instanceof Error?error.name:'UnknownError');
		return defaultSettings();
	}
}

export function saveNotificationSoundSettings(userId:string,settings:NotificationSoundSettings){
	const normalized=normalizeNotificationSoundSettings(settings);
	try{
		window.localStorage.setItem(settingsKey(userId),JSON.stringify(normalized));
		window.dispatchEvent(new Event(settingsChangedEvent));
		return normalized;
	}catch(error){
		console.error('Unable to save notification sound preferences',error instanceof Error?error.name:'UnknownError');
		throw new Error('Unable to save notification sound preferences on this device.');
	}
}

export function resetNotificationSoundSettings(userId:string){
	return saveNotificationSoundSettings(userId,defaultSettings());
}

export function classifyNotificationSound(notification:SoundableNotification):NotificationSoundCategory{
	const title=notification.title.trim().toLowerCase();
	if(notification.type==='TRADE'){
		if(/\border submitted\b/.test(title))return 'orderSubmitted';
		if(/\border rejected\b/.test(title))return 'orderRejected';
		if(/\border (?:filled|partially filled)\b/.test(title)||/\bposition closed\b/.test(title))return 'orderFilled';
	}
	if(notification.type==='DEPOSIT'){
		if(/\bdeposit approved\b/.test(title))return 'depositApproved';
		if(/\bdeposit rejected\b/.test(title))return 'depositRejected';
	}
	if(notification.type==='WITHDRAWAL'){
		if(/\bwithdrawal completed\b/.test(title))return 'withdrawalCompleted';
		if(/\bwithdrawal approved\b/.test(title))return 'withdrawalApproved';
		if(/\bwithdrawal rejected\b/.test(title))return 'withdrawalRejected';
	}
	if(notification.type==='SUPPORT'&&/\b(?:admin|administrator) replied\b/.test(title))return 'adminMessage';
	if(notification.type==='MARKET')return 'priceAlert';
	if(notification.type==='SECURITY')return 'securityImportant';
	return 'newNotification';
}

export function observeNotificationBatch<T extends {id:string}>(
	observedByScope:Map<string,Set<string>>,
	scope:string,
	notifications:T[],
){
	const observed=observedByScope.get(scope);
	if(!observed){
		observedByScope.set(scope,new Set(notifications.map(notification=>notification.id)));
		return [];
	}
	const newlyObserved=notifications.filter(notification=>!observed.has(notification.id));
	for(const notification of notifications)observed.add(notification.id);
	return newlyObserved;
}

function getAudioContext(){
	if(typeof window==='undefined')return null;
	if(audioContext)return audioContext;
	const AudioContextConstructor=window.AudioContext||(window as Window&{webkitAudioContext?:typeof AudioContext}).webkitAudioContext;
	if(!AudioContextConstructor)return null;
	audioContext=new AudioContextConstructor();
	return audioContext;
}

export async function unlockNotificationAudio(){
	try{
		const context=getAudioContext();
		if(!context)return false;
		await context.resume();
		audioUnlocked=context.state==='running';
		return audioUnlocked;
	}catch(error){
		console.warn('Unable to unlock notification audio',error instanceof Error?error.name:'UnknownError');
		return false;
	}
}

function playPattern(category:NotificationSoundCategory,volume:number){
	const context=getAudioContext();
	if(!context||context.state!=='running'||!audioUnlocked)return false;
	const notes=soundPatterns[category];
	const noteSpacing=0.105;
	const duration=0.16;
	const now=Math.max(context.currentTime,nextPlaybackTime);
	nextPlaybackTime=now+notes.length*noteSpacing+0.08;
	notes.forEach((frequency,index)=>{
		const start=now+index*noteSpacing;
		const oscillator=context.createOscillator();
		const gain=context.createGain();
		oscillator.type='sine';
		oscillator.frequency.setValueAtTime(frequency,start);
		gain.gain.setValueAtTime(0.0001,start);
		gain.gain.exponentialRampToValueAtTime(Math.max(0.0002,volume*0.26),start+0.012);
		gain.gain.exponentialRampToValueAtTime(0.0001,start+duration);
		oscillator.connect(gain);
		gain.connect(context.destination);
		oscillator.start(start);
		oscillator.stop(start+duration+0.01);
	});
	return true;
}

export async function previewNotificationSound(category:NotificationSoundCategory,userId:string){
	const settings=getNotificationSoundSettings(userId);
	const unlocked=await unlockNotificationAudio();
	if(!unlocked)return false;
	return playPattern(category,settings.volume);
}

function markerPrefix(userId:string,accountMode:string){
	return `${storagePrefix}.played.${encodeURIComponent(userId)}.${accountMode}.`;
}

function claimSoundMarkerStorage(userId:string,accountMode:string,notificationId:string){
	const key=`${markerPrefix(userId,accountMode)}${encodeURIComponent(notificationId)}`;
	const now=Date.now();
	try{
		if(window.localStorage.getItem(key))return false;
		const token=`${now}:${window.crypto?.randomUUID?.()||Math.random().toString(36).slice(2)}`;
		window.localStorage.setItem(key,token);
		if(window.localStorage.getItem(key)!==token)return false;
		const markers:string[]=[];
		for(let index=0;index<window.localStorage.length;index++){
			const candidate=window.localStorage.key(index);
			if(candidate?.startsWith(markerPrefix(userId,accountMode)))markers.push(candidate);
		}
		if(markers.length>playedMarkerLimit){
			const byAge=markers.map(marker=>({marker,time:Number(window.localStorage.getItem(marker)?.split(':',1)[0])})).sort((a,b)=>a.time-b.time);
			for(const entry of byAge){
				if(markers.length<=playedMarkerLimit/2)break;
				if(!Number.isFinite(entry.time)||now-entry.time>playedMarkerMaxAge)window.localStorage.removeItem(entry.marker);
			}
			const remaining=byAge.filter(entry=>window.localStorage.getItem(entry.marker));
			for(const entry of remaining.slice(0,Math.max(0,remaining.length-playedMarkerLimit/2)))window.localStorage.removeItem(entry.marker);
		}
		return true;
	}catch(error){
		console.warn('Unable to coordinate notification sound playback',error instanceof Error?error.name:'UnknownError');
		return false;
	}
}

async function claimSoundMarker(userId:string,accountMode:string,notificationId:string){
	const claim=()=>claimSoundMarkerStorage(userId,accountMode,notificationId);
	if(typeof navigator!=='undefined'&&navigator.locks){
		try{return await navigator.locks.request(`${storagePrefix}:${encodeURIComponent(userId)}:${accountMode}`,claim)}
		catch(error){
			console.warn('Unable to lock notification sound playback',error instanceof Error?error.name:'UnknownError');
			return claim();
		}
	}
	return claim();
}

export async function playNotificationSoundOnce(
	notification:SoundableNotification,
	userId:string,
	accountMode:string,
	channel:BroadcastChannel|null,
){
	if(typeof document==='undefined'||document.visibilityState!=='visible')return false;
	const category=classifyNotificationSound(notification);
	const settings=getNotificationSoundSettings(userId);
	if(!settings.enabled||!settings.categories[category])return false;
	if(!audioUnlocked)return false;
	const played=await claimSoundMarker(userId,accountMode,notification.id);
	if(!played)return false;
	if(document.visibilityState!=='visible')return false;
	const latestSettings=getNotificationSoundSettings(userId);
	if(!latestSettings.enabled||!latestSettings.categories[category]||!audioUnlocked)return false;
	channel?.postMessage({type:'sound-played',notificationId:notification.id,accountMode});
	if(document.visibilityState!=='visible'||!audioUnlocked)return false;
	try{
		const didPlay=playPattern(category,latestSettings.volume);
		if(!didPlay&&!audioWarningShown){
			audioWarningShown=true;
			console.warn('Notification sound was skipped because audio is not unlocked in this browser tab.');
		}
		return didPlay;
	}catch(error){
		if(!audioWarningShown){
			audioWarningShown=true;
			console.warn('Notification sound playback failed',error instanceof Error?error.name:'UnknownError');
		}
		return false;
	}
}

export function notificationSoundSettingsEventName(){return settingsChangedEvent;}
