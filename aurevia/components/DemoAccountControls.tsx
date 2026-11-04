'use client';

import {FormEvent,useState} from 'react';
import {RefreshCw,ShieldCheck} from 'lucide-react';
import {formatUsd} from '@/lib/currency-format';

export default function DemoAccountControls({startingBalance,onReset}:{startingBalance:string;onReset:()=>void|Promise<void>}){
	const [open,setOpen]=useState(false);
	const [confirmation,setConfirmation]=useState('');
	const [busy,setBusy]=useState(false);
	const [error,setError]=useState('');
	const [notice,setNotice]=useState('');

	async function reset(event:FormEvent<HTMLFormElement>){
		event.preventDefault();
		if(busy||confirmation!=='RESET DEMO ACCOUNT')return;
		setBusy(true);setError('');setNotice('');
		try{
			const response=await fetch('/api/account/demo-reset',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({confirmation})});
			const result=await response.json() as {error?:string;balance?:string};
			if(!response.ok)throw new Error(result.error||'Unable to reset the DEMO account.');
			setNotice(`DEMO cash restored to ${formatUsd(result.balance||startingBalance)}. Real account records are unchanged.`);
			setConfirmation('');setOpen(false);await onReset();
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to reset the DEMO account.');}
		finally{setBusy(false);}
	}

	return <section className="demo-account-controls" aria-label="DEMO account controls">
		<div><span><ShieldCheck size={14}/> DEMO MODE · VIRTUAL USD</span><b>Starting balance {formatUsd(startingBalance)}</b><p>Reset closes open DEMO positions and orders, cancels unsettled practice investments, restores virtual cash, and retains history. REAL records are not changed.</p></div>
		{notice&&<p className="demo-account-notice" role="status">{notice}</p>}
		{error&&<p className="demo-account-error" role="alert">{error}</p>}
		{!open?<button type="button" onClick={()=>{setOpen(true);setError('');}}><RefreshCw size={14}/> Reset Demo Account</button>:<form onSubmit={event=>void reset(event)}>
			<label>Type RESET DEMO ACCOUNT to confirm<input className="input" autoComplete="off" value={confirmation} onChange={event=>setConfirmation(event.target.value)}/></label>
			<div><button type="submit" disabled={busy||confirmation!=='RESET DEMO ACCOUNT'}>{busy?'Resetting…':'Confirm Demo reset'}</button><button type="button" onClick={()=>{setOpen(false);setConfirmation('');}} disabled={busy}>Cancel</button></div>
		</form>}
	</section>;
}
