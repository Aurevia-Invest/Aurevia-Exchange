'use client';

import {Check} from 'lucide-react';
import {useTheme} from '@/lib/theme-context';

export default function ThemeToggle(){
	const {theme,selectTheme,isSaving,isReady,error}=useTheme();
	return <div className="theme-toggle" role="group" aria-label="Color theme">
		<button type="button" className="theme-toggle-option" aria-pressed={theme==='forest-green'} disabled={!isReady||isSaving} onClick={()=>void selectTheme('forest-green')}>
			<span>Forest Green</span>{theme==='forest-green'&&<Check size={14} aria-hidden="true"/>}
		</button>
		<button type="button" className="theme-toggle-option" aria-pressed={theme==='premium-dashboard'} disabled={!isReady||isSaving} onClick={()=>void selectTheme('premium-dashboard')}>
			<span>Premium Dashboard</span>{theme==='premium-dashboard'&&<Check size={14} aria-hidden="true"/>}
		</button>
		{isSaving&&<span className="theme-toggle-status" role="status">Saving theme…</span>}
		{error&&<span className="theme-toggle-error" role="alert">{error}</span>}
	</div>;
}
