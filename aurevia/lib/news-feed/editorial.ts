import {NewsFeedCategory} from '@prisma/client';
import {broadcastMediaSource} from '@/lib/broadcast-policy';

export function validateEditorialUrl(value:string){
	let url:URL;
	try{url=new URL(value)}catch{throw new Error('INVALID_EDITORIAL_URL')}
	if(url.protocol!=='https:'||url.username||url.password)throw new Error('INVALID_EDITORIAL_URL');
	return url.toString();
}

export function editorialMediaSource(value:string):{kind:'video'|'embed';url:string}|null{
	return broadcastMediaSource(value);
}

export const editorialCategories=Object.values(NewsFeedCategory);
