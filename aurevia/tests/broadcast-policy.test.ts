import {describe,expect,it} from 'vitest';
import {BroadcastStatus} from '@prisma/client';
import {broadcastMediaSource,nextBroadcastStatus,validateBroadcastUrl} from '../lib/broadcast-policy';

describe('broadcast lifecycle policy',()=>{
	it('allows explicit forward lifecycle transitions only',()=>{
		expect(nextBroadcastStatus(BroadcastStatus.DRAFT,'schedule')).toBe(BroadcastStatus.SCHEDULED);
		expect(nextBroadcastStatus(BroadcastStatus.SCHEDULED,'publish')).toBe(BroadcastStatus.PUBLISHED);
		expect(nextBroadcastStatus(BroadcastStatus.PUBLISHED,'end')).toBe(BroadcastStatus.ENDED);
		expect(nextBroadcastStatus(BroadcastStatus.ENDED,'archive')).toBe(BroadcastStatus.ARCHIVED);
		expect(()=>nextBroadcastStatus(BroadcastStatus.ARCHIVED,'publish')).toThrow('BROADCAST_TRANSITION_NOT_ALLOWED');
	});

	it('accepts only credential-free HTTPS broadcast URLs',()=>{
		expect(validateBroadcastUrl('https://example.test/recording.mp4')).toBe('https://example.test/recording.mp4');
		expect(()=>validateBroadcastUrl('javascript:alert(1)')).toThrow('INVALID_BROADCAST_URL');
		expect(()=>validateBroadcastUrl('https://user:secret@example.test/live')).toThrow('INVALID_BROADCAST_URL');
		expect(validateBroadcastUrl(null)).toBeNull();
	});

	it('renders only supported configured media sources',()=>{
		expect(broadcastMediaSource(null)).toBeNull();
		expect(broadcastMediaSource('https://youtu.be/AbCdEf12345')).toEqual({kind:'embed',url:'https://www.youtube-nocookie.com/embed/AbCdEf12345'});
		expect(broadcastMediaSource('https://player.vimeo.com/video/123456')).toEqual({kind:'embed',url:'https://player.vimeo.com/video/123456'});
		expect(broadcastMediaSource('https://vimeo.com/123456')).toEqual({kind:'embed',url:'https://player.vimeo.com/video/123456'});
		expect(broadcastMediaSource('https://media.example.test/archive.mp4')).toEqual({kind:'video',url:'https://media.example.test/archive.mp4'});
		expect(broadcastMediaSource('https://example.test/page')).toBeNull();
	});
});