'use client';

import {useEffect,useState} from 'react';
import {useSession} from 'next-auth/react';
import {Bell,RotateCcw,Volume2} from 'lucide-react';
import {
	defaultNotificationSoundSettings,
	getNotificationSoundSettings,
	notificationSoundCategories,
	notificationSoundSettingsEventName,
	NotificationSoundCategory,
	NotificationSoundSettings,
	previewNotificationSound,
	resetNotificationSoundSettings,
	saveNotificationSoundSettings,
	unlockNotificationAudio,
} from '@/lib/notification-sounds';

const categoryLabels:Record<NotificationSoundCategory,string>={
	newNotification:'New notification',
	orderSubmitted:'Order submitted',
	orderFilled:'Order filled',
	orderRejected:'Order rejected',
	depositApproved:'Deposit approved',
	depositRejected:'Deposit rejected',
	withdrawalApproved:'Withdrawal approved',
	withdrawalRejected:'Withdrawal rejected',
	withdrawalCompleted:'Withdrawal completed',
	adminMessage:'Admin message',
	priceAlert:'Price alert',
	securityImportant:'Important security notification',
};

export default function NotificationSoundSettingsPanel(){
	const {data:session}=useSession();
	const userId=session?.user?.id;
	const [settings,setSettings]=useState<NotificationSoundSettings>(defaultNotificationSoundSettings);
	const [loading,setLoading]=useState(true);
	const [error,setError]=useState('');
	const [message,setMessage]=useState('');
	const [previewing,setPreviewing]=useState<NotificationSoundCategory|null>(null);

	useEffect(()=>{
		if(!userId){setLoading(false);return}
		const sync=()=>setSettings(getNotificationSoundSettings(userId));
		sync();
		const eventName=notificationSoundSettingsEventName();
		window.addEventListener(eventName,sync);
		window.addEventListener('storage',sync);
		setLoading(false);
		return()=>{window.removeEventListener(eventName,sync);window.removeEventListener('storage',sync)};
	},[userId]);

	function save(next:NotificationSoundSettings){
		if(!userId)return false;
		setError('');setMessage('');
		try{setSettings(saveNotificationSoundSettings(userId,next));setMessage('Sound preferences are saved on this device.');return true}
		catch(exception){setError(exception instanceof Error?exception.message:'Unable to save sound preferences.');return false}
	}

	async function toggleSounds(enabled:boolean){
		const unlocked=enabled?await unlockNotificationAudio():true;
		if(save({...settings,enabled})&&enabled&&!unlocked)setError('Sound is enabled, but this browser did not unlock audio. Use a preview button or check browser audio settings.');
	}

	function toggleCategory(category:NotificationSoundCategory,enabled:boolean){
		save({...settings,categories:{...settings.categories,[category]:enabled}});
	}

	async function preview(category:NotificationSoundCategory){
		if(!userId||previewing)return;
		setPreviewing(category);setError('');setMessage('');
		try{
			const played=await previewNotificationSound(category,userId);
			if(!played)throw new Error('This browser could not play the preview. Try a current browser and interact with the page first.');
			setMessage(`${categoryLabels[category]} preview played.`);
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to play this preview.')}
		finally{setPreviewing(null)}
	}

	function restoreDefaults(){
		if(!userId)return;
		setError('');setMessage('');
		try{setSettings(resetNotificationSoundSettings(userId));setMessage('Default sound preferences restored.')}
		catch(exception){setError(exception instanceof Error?exception.message:'Unable to restore sound preferences.')}
	}

	return <section className="account-panel notification-sound-settings" aria-labelledby="notification-sounds-title">
		<div className="account-panel-title"><div><h3 id="notification-sounds-title">Notification sounds</h3><p className="account-panel-subtitle">Choose the sounds used while Aurevia is open. Background notification sounds remain controlled by your device.</p></div><Volume2 size={18} className="gold" aria-hidden="true"/></div>
		<div className="notification-sound-master">
			<label className="notification-sound-master-toggle"><input type="checkbox" checked={settings.enabled} disabled={loading||!userId} onChange={event=>void toggleSounds(event.target.checked)}/><span><b>Enable notification sounds</b><small>Audio starts after an explicit interaction, such as enabling sounds or previewing a tone.</small></span></label>
			<button type="button" className="button-secondary notification-sound-reset" disabled={loading||!userId} onClick={restoreDefaults}><RotateCcw size={14}/> Restore defaults</button>
		</div>
		<label className="notification-sound-volume"><span><b>Volume</b><output htmlFor="notification-sound-volume">{Math.round(settings.volume*100)}%</output></span><input id="notification-sound-volume" type="range" min="0" max="1" step="0.01" value={settings.volume} disabled={loading||!userId} onChange={event=>save({...settings,volume:Number(event.target.value)})}/></label>
		<div className="notification-sound-category-list" aria-label="Notification sound categories">
			{notificationSoundCategories.map(category=><div className="notification-sound-category" key={category}>
				<label><input type="checkbox" checked={settings.categories[category]} disabled={loading||!userId} onChange={event=>toggleCategory(category,event.target.checked)}/><span>{categoryLabels[category]}</span></label>
				<button type="button" className="button-secondary" aria-label={`Preview ${categoryLabels[category]} sound`} disabled={loading||!userId||previewing!==null} onClick={()=>void preview(category)}><Bell size={13}/>{previewing===category?'Playing…':'Preview'}</button>
			</div>)}
		</div>
		<p className="notification-sound-note">Sounds play only for new notifications received while this page is visible. Historical notifications never trigger playback. Preferences are stored locally for this account on this device.</p>
		{error&&<p className="account-callout notification-sound-feedback" role="alert">{error}</p>}
		{message&&<p className="notification-sound-feedback is-success" role="status">{message}</p>}
	</section>;
}
