import {afterEach,describe,expect,it,vi} from 'vitest';
import {
	classifyNotificationSound,
	defaultNotificationSoundSettings,
	getNotificationSoundSettings,
	normalizeNotificationSoundSettings,
	observeNotificationBatch,
	playNotificationSoundOnce,
	resetNotificationSoundSettings,
	saveNotificationSoundSettings,
	unlockNotificationAudio,
} from '@/lib/notification-sounds';

const storage=new Map<string,string>();

function installBrowserMocks(){
	const localStorage={
		getItem:(key:string)=>storage.get(key)??null,
		setItem:(key:string,value:string)=>{storage.set(key,value)},
		removeItem:(key:string)=>{storage.delete(key)},
		key:(index:number)=>Array.from(storage.keys())[index]??null,
		get length(){return storage.size;},
	};
	const gainLevels:number[]=[];
	const context={
		state:'suspended',
		currentTime:0,
		destination:{},
		resume:vi.fn(async function(this:{state:string}){this.state='running'}),
		createOscillator:vi.fn(()=>({type:'sine',frequency:{setValueAtTime:vi.fn()},connect:vi.fn(),start:vi.fn(),stop:vi.fn()})),
		createGain:vi.fn(()=>({gain:{setValueAtTime:vi.fn(),exponentialRampToValueAtTime:vi.fn((value:number)=>gainLevels.push(value))},connect:vi.fn()})),
	};
	const browserWindow={
		localStorage,
		AudioContext:vi.fn(function(){return context}),
		dispatchEvent:vi.fn(),
	};
	vi.stubGlobal('window',browserWindow);
	vi.stubGlobal('document',{visibilityState:'visible'});
	return {context,localStorage,gainLevels};
}

afterEach(()=>{
	storage.clear();
	vi.unstubAllGlobals();
});

describe('notification sound classification',()=>{
	it.each([
		[{id:'1',type:'TRADE',title:'DEMO order submitted',message:'Order submitted'},'orderSubmitted'],
		[{id:'2',type:'TRADE',title:'REAL order filled',message:'Confirmed by provider'},'orderFilled'],
		[{id:'3',type:'TRADE',title:'DEMO order rejected',message:'Rejected'},'orderRejected'],
		[{id:'4',type:'DEPOSIT',title:'REAL deposit approved',message:'Approved'},'depositApproved'],
		[{id:'5',type:'DEPOSIT',title:'REAL deposit rejected',message:'Rejected'},'depositRejected'],
		[{id:'6',type:'WITHDRAWAL',title:'Withdrawal approved',message:'Approved'},'withdrawalApproved'],
		[{id:'7',type:'WITHDRAWAL',title:'Withdrawal rejected',message:'Rejected'},'withdrawalRejected'],
		[{id:'8',type:'WITHDRAWAL',title:'Withdrawal completed',message:'Completed'},'withdrawalCompleted'],
		[{id:'9',type:'SUPPORT',title:'Admin replied to your support ticket',message:'Reply'},'adminMessage'],
		[{id:'10',type:'MARKET',title:'Price alert',message:'Market event'},'priceAlert'],
		[{id:'11',type:'SECURITY',title:'Password changed',message:'Updated'},'securityImportant'],
		[{id:'12',type:'SYSTEM',title:'Account update',message:'Update'},'newNotification'],
	] as const)('maps verified event %s to its own sound category',({id,type,title,message},category)=>{
		expect(classifyNotificationSound({id,type,title,message})).toBe(category);
	});

	it('does not classify a submitted order as a successful fill',()=>{
		expect(classifyNotificationSound({id:'submitted',type:'TRADE',title:'REAL order submitted',message:'Awaiting provider confirmation'})).toBe('orderSubmitted');
	});
});

describe('notification sound preferences and playback',()=>{
	it('persists preferences per account and restores device defaults',()=>{
		installBrowserMocks();
		const userA={...defaultNotificationSoundSettings,enabled:true,volume:0.2};
		saveNotificationSoundSettings('user-a',userA);
		expect(getNotificationSoundSettings('user-a')).toEqual(userA);
		expect(getNotificationSoundSettings('user-b')).toEqual(defaultNotificationSoundSettings);
		expect(resetNotificationSoundSettings('user-a')).toEqual(defaultNotificationSoundSettings);
	});

	it('normalizes invalid stored settings and clamps volume',()=>{
		expect(normalizeNotificationSoundSettings({enabled:true,volume:9,categories:{orderFilled:false,notASetting:true}})).toMatchObject({
			enabled:true,
			volume:1,
			categories:{orderFilled:false,orderSubmitted:true},
		});
	});

	it('seeds the initial history without replaying it, then reports only new IDs once',()=>{
		const observed=new Map<string,Set<string>>();
		const history=[{id:'old-1'},{id:'old-2'}];
		expect(observeNotificationBatch(observed,'user-a:DEMO',history)).toEqual([]);
		expect(observeNotificationBatch(observed,'user-a:DEMO',[{id:'old-2'},{id:'new-1'}])).toEqual([{id:'new-1'}]);
		expect(observeNotificationBatch(observed,'user-a:DEMO',[{id:'new-1'}])).toEqual([]);
		expect(observeNotificationBatch(observed,'user-a:REAL',[{id:'real-1'}])).toEqual([]);
	});

	it('plays a new visible notification once across tabs and respects the saved volume',async()=>{
		const {context,gainLevels}=installBrowserMocks();
		saveNotificationSoundSettings('user-a',{...defaultNotificationSoundSettings,enabled:true,volume:0.25});
		expect(await unlockNotificationAudio()).toBe(true);
		const channel={postMessage:vi.fn()} as unknown as BroadcastChannel;
		const item={id:'notification-1',type:'TRADE',title:'REAL order filled',message:'Confirmed'};
		expect(await playNotificationSoundOnce(item,'user-a','REAL',channel)).toBe(true);
		expect(await playNotificationSoundOnce(item,'user-a','REAL',channel)).toBe(false);
		expect(context.createOscillator).toHaveBeenCalledTimes(3);
		expect(gainLevels).toContain(0.065);
		expect(channel.postMessage).toHaveBeenCalledTimes(1);
	});

	it('does not sound while hidden or when muted',async()=>{
		const {context}=installBrowserMocks();
		saveNotificationSoundSettings('user-a',{...defaultNotificationSoundSettings,enabled:true});
		await unlockNotificationAudio();
		vi.stubGlobal('document',{visibilityState:'hidden'});
		expect(await playNotificationSoundOnce({id:'hidden',type:'SYSTEM',title:'Update',message:''},'user-a','DEMO',null)).toBe(false);
		vi.stubGlobal('document',{visibilityState:'visible'});
		saveNotificationSoundSettings('user-a',{...defaultNotificationSoundSettings,enabled:false});
		expect(await playNotificationSoundOnce({id:'muted',type:'SYSTEM',title:'Update',message:''},'user-a','DEMO',null)).toBe(false);
		expect(context.createOscillator).not.toHaveBeenCalled();
	});
});
