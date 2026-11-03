import {describe,expect,it} from 'vitest';
import {clampSupportChatPosition,dockSupportChatPosition,nearestSupportChatSide} from '@/lib/support-chat-position';

describe('support chat edge docking',()=>{
	const viewport={width:800,height:600};

	it('snaps a dragged widget to its nearest edge',()=>{
		expect(nearestSupportChatSide(80,false,viewport)).toBe('left');
		expect(nearestSupportChatSide(680,false,viewport)).toBe('right');
	});

	it('keeps the selected edge when the launcher opens as a panel',()=>{
		expect(dockSupportChatPosition({left:200,top:25},'left',true,viewport)).toEqual({left:12,top:25});
		expect(dockSupportChatPosition({left:200,top:25},'right',true,viewport)).toEqual({left:428,top:25});
	});

	it('clamps the widget within the viewport after resizing',()=>{
		expect(clampSupportChatPosition({left:900,top:900},true,viewport)).toEqual({left:428,top:28});
	});
});
