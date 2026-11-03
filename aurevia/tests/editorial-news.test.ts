import {describe,expect,it} from 'vitest';
import {editorialMediaSource,validateEditorialUrl} from '@/lib/news-feed/editorial';

describe('editorial news media links',()=>{
	it('allows secure external links without embedding arbitrary sites',()=>{
		const url='https://publisher.example/article';
		expect(validateEditorialUrl(url)).toBe(url);
		expect(editorialMediaSource(url)).toBeNull();
	});

	it('normalizes supported YouTube, Vimeo, and direct video URLs for inline playback',()=>{
		expect(editorialMediaSource('https://youtu.be/AbCdEf_1234')).toEqual({kind:'embed',url:'https://www.youtube-nocookie.com/embed/AbCdEf_1234'});
		expect(editorialMediaSource('https://vimeo.com/123456')).toEqual({kind:'embed',url:'https://player.vimeo.com/video/123456'});
		expect(editorialMediaSource('https://media.example/video.mp4?token=sample')).toEqual({kind:'video',url:'https://media.example/video.mp4?token=sample'});
	});

	it('rejects insecure or credential-bearing publication URLs',()=>{
		expect(()=>validateEditorialUrl('http://publisher.example/video')).toThrow('INVALID_EDITORIAL_URL');
		expect(()=>validateEditorialUrl('https://user:pass@publisher.example/video')).toThrow('INVALID_EDITORIAL_URL');
		expect(editorialMediaSource('https://youtube.com/watch?v=short')).toBeNull();
	});
});
