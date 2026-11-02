'use client';

import {useState} from 'react';
import {Check,Copy} from 'lucide-react';

export async function copyAureviaExchangeId(id:string,clipboard:Pick<Clipboard,'writeText'>){
	await clipboard.writeText(id);
}

export default function AureviaExchangeId({id,className=''}:{id:string|null|undefined;className?:string}){
	const [feedback,setFeedback]=useState('');
	const exchangeId=typeof id==='string'?id:'';
	if(!exchangeId)return null;

	async function copy(){
		try{
			await copyAureviaExchangeId(exchangeId,navigator.clipboard);
			setFeedback('Aurevia Exchange ID copied.');
		}catch{
			setFeedback('Unable to copy the Aurevia Exchange ID.');
		}
	}

	return <div className={`min-w-0 rounded-lg border border-white/10 bg-white/[0.03] p-3 ${className}`}>
		<div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
			<div className="min-w-0">
				<span className="block text-xs uppercase tracking-wider muted">Aurevia Exchange ID</span>
				<code className="mt-1 block break-all font-mono text-sm tracking-wider">{exchangeId}</code>
			</div>
			<button type="button" className="btn min-h-10 shrink-0 bg-white/5" onClick={()=>void copy()} aria-label="Copy Aurevia Exchange ID">
				{feedback==='Aurevia Exchange ID copied.'?<Check size={14}/>:<Copy size={14}/>} Copy
			</button>
		</div>
		{feedback&&<p className={`mt-2 text-xs ${feedback.startsWith('Unable')?'text-loss':'text-profit'}`} role="status">{feedback}</p>}
	</div>;
}
