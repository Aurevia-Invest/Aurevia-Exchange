'use client';

import {useCallback,useEffect,useState} from 'react';
import {Check,ChevronDown,Edit3,Landmark,Plus,Trash2,Wallet} from 'lucide-react';
import {ibanCountryCodes,supportedCountries} from '@/lib/countries';

type Destination={id:string;type:'BANK_TRANSFER'|'CRYPTOCURRENCY';nickname:string;countryCode:string;network:string|null;asset:string|null;maskedLabel:string;createdAt:string;updatedAt:string};
type Props={selectedId:string;onSelect:(id:string,label?:string,asset?:string|null,network?:string|null)=>void;disabled?:boolean};
type FormValues=Record<string,string>;

const labels:Record<string,string>={
	bankName:'Bank or institution name',beneficiaryName:'Account holder / beneficiary full legal name',
	routingNumber:'Routing number',accountNumber:'Account number',accountType:'Account type',
	sortCode:'Sort code',bankCode:'Bank code',iban:'IBAN',bic:'BIC / SWIFT',
	bankIdentifier:'Local bank identifier (if applicable)',beneficiaryAddress:'Beneficiary address (international transfers)',
	bankAddress:'Bank branch/address (optional when required)',
};
const examples:Record<string,string>={routingNumber:'9 digits',accountNumber:'Keep all leading zeros',sortCode:'6 digits, e.g. 001234',bankCode:'3 digits',iban:'Country code + checksum + account details',bic:'8 or 11 characters'};
const errorsFor=(data:unknown)=>data&&typeof data==='object'&&'issues'in data&&Array.isArray(data.issues)?data.issues.map((issue:{message?:string})=>issue.message).filter(Boolean).join(' '):'';

export default function WithdrawalDestinationPanel({selectedId,onSelect,disabled=false}:Props){
	const [items,setItems]=useState<Destination[]>([]);
	const [type,setType]=useState<'BANK_TRANSFER'|'CRYPTOCURRENCY'>('BANK_TRANSFER');
	const [values,setValues]=useState<FormValues>({});
	const [countryCode,setCountryCode]=useState('US');
	const [asset,setAsset]=useState<'BTC'|'ETH'>('BTC');
	const [search,setSearch]=useState('');
	const [editing,setEditing]=useState('');
	const [showForm,setShowForm]=useState(false);
	const [busy,setBusy]=useState(false);
	const [error,setError]=useState('');
	const [notice,setNotice]=useState('');

	const load=useCallback(async()=>{
		try{
			const response=await fetch('/api/withdrawal-destinations',{cache:'no-store'});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Saved destinations unavailable.');
			const next:Destination[]=result.destinations||[];
			setItems(next);
			if(selectedId&&!next.some(item=>item.id===selectedId))onSelect('');
		}catch(exception){setError(exception instanceof Error?exception.message:'Saved destinations unavailable.')}
	},[onSelect,selectedId]);
	useEffect(()=>{void load()},[load]);

	function setValue(field:string,value:string){setValues(current=>({...current,[field]:value}))}

	async function edit(item:Destination){
		setError('');setNotice('');
		try{
			const response=await fetch(`/api/withdrawal-destinations/${encodeURIComponent(item.id)}`,{cache:'no-store'});
			const result=await response.json();if(!response.ok)throw new Error(result.error||'Destination details unavailable.');
			const details=result.destination.details as Record<string,string|undefined>;
			setType(item.type);setCountryCode(item.countryCode);setAsset((item.asset as 'BTC'|'ETH')||'BTC');setValues(Object.fromEntries(Object.entries(details).filter((entry):entry is [string,string]=>typeof entry[1]==='string')));
			setEditing(item.id);setShowForm(true);
		}catch(exception){setError(exception instanceof Error?exception.message:'Destination details unavailable.')}
	}

	async function save(event:React.FormEvent<HTMLFormElement>){
		event.preventDefault();if(busy||disabled)return;
		setBusy(true);setError('');setNotice('');
		const destination={
			type,nickname:values.nickname?.trim()||'',countryCode,
			...(type==='BANK_TRANSFER'?{
				bankName:values.bankName,beneficiaryName:values.beneficiaryName,accountNumber:values.accountNumber,
				accountType:values.accountType,routingNumber:values.routingNumber,sortCode:values.sortCode,bankCode:values.bankCode,
				iban:values.iban,bic:values.bic,bankIdentifier:values.bankIdentifier,beneficiaryAddress:values.beneficiaryAddress,bankAddress:values.bankAddress,
			}:{asset,network:asset==='BTC'?'BITCOIN_MAINNET':'ETHEREUM_MAINNET',walletAddress:values.walletAddress,email:values.email?.trim()||undefined}),
		};
		try{
			const response=await fetch('/api/withdrawal-destinations',{method:editing?'PATCH':'POST',headers:{'content-type':'application/json'},body:JSON.stringify(editing?{id:editing,destination}:destination)});
			const result=await response.json();
			if(!response.ok)throw new Error([result.error,errorsFor(result)].filter(Boolean).join(' '));
			const item:Destination=result.destination;
			setItems(current=>[item,...current.filter(existing=>existing.id!==item.id)]);
			onSelect(item.id,item.maskedLabel);setNotice(editing?'Destination updated.':'Destination saved securely.');
			setEditing('');setShowForm(false);setValues({});
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to save destination.')}
		finally{setBusy(false)}
	}

	async function remove(item:Destination){
		if(busy||disabled)return;
		setBusy(true);setError('');setNotice('');
		try{
			const response=await fetch('/api/withdrawal-destinations',{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({id:item.id})});
			const result=await response.json();if(!response.ok)throw new Error(result.error||'Unable to remove destination.');
			setItems(current=>current.filter(existing=>existing.id!==item.id));if(selectedId===item.id)onSelect('');
			setNotice('Destination removed.');
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to remove destination.')}
		finally{setBusy(false)}
	}

	const filtered=items.filter(item=>item.type===type&&`${item.nickname} ${item.maskedLabel} ${item.countryCode} ${item.asset||''}`.toLowerCase().includes(search.toLowerCase()));
	const usesIban=ibanCountryCodes.has(countryCode)&&!['US','GB','NG'].includes(countryCode);
	const input=(name:string,label=labels[name]||name)=> <label className="account-label" key={name}>{label}<input className="input" type="text" autoComplete="off" value={values[name]||''} onChange={event=>setValue(name,event.target.value)} required={!['bic','bankIdentifier','bankAddress','beneficiaryAddress'].includes(name)} placeholder={examples[name]||''}/>{examples[name]&&<small className="muted">{examples[name]}</small>}</label>;

	return <section className="withdrawal-destinations">
		<div className="account-panel-title"><div><h3>Withdrawal destination</h3><p className="account-panel-subtitle">Saved details are encrypted at rest. Selecting a bank does not verify ownership or guarantee the transfer can be received.</p></div></div>
		<div className="mt-3 grid grid-cols-2 gap-2" role="group" aria-label="Withdrawal method"><button type="button" aria-pressed={type==='BANK_TRANSFER'} className={`withdrawal-method-card ${type==='BANK_TRANSFER'?'is-selected':''}`} onClick={()=>{setType('BANK_TRANSFER');if(items.find(item=>item.id===selectedId)?.type!=='BANK_TRANSFER')onSelect('')}}><Landmark size={16}/>Bank transfer</button><button type="button" aria-pressed={type==='CRYPTOCURRENCY'} className={`withdrawal-method-card ${type==='CRYPTOCURRENCY'?'is-selected':''}`} onClick={()=>{setType('CRYPTOCURRENCY');if(items.find(item=>item.id===selectedId)?.type!=='CRYPTOCURRENCY')onSelect('')}}><Wallet size={16}/>Cryptocurrency wallet</button></div>
		{items.length>0&&<><label className="account-label mt-3 block">Search saved destinations<input className="input mt-1" value={search} onChange={event=>setSearch(event.target.value)} placeholder="Nickname, bank, country or asset"/></label><div className="mt-2 grid gap-2">{filtered.map(item=><div key={item.id} className={`withdrawal-destination-option ${selectedId===item.id?'is-selected':''}`}><label className="min-w-0 flex-1"><input type="radio" name="withdrawalDestination" value={item.id} checked={selectedId===item.id} disabled={disabled} onChange={()=>onSelect(item.id,item.maskedLabel,item.asset,item.network)}/><span className="min-w-0"><b>{item.nickname}</b><small>{item.countryCode} · {item.maskedLabel}</small></span></label><button type="button" className="icon-action" aria-label={`Edit ${item.nickname}`} disabled={disabled||busy} onClick={()=>void edit(item)}><Edit3 size={14}/></button><button type="button" className="icon-action" aria-label={`Remove ${item.nickname}`} disabled={disabled||busy} onClick={()=>void remove(item)}><Trash2 size={14}/></button></div>)}</div></>}
		{!showForm?<button className="text-link mt-3" type="button" disabled={disabled} onClick={()=>{setEditing('');setValues({});setShowForm(true)}}><Plus size={14}/> Add a {type==='BANK_TRANSFER'?'bank':'wallet'} destination</button>:<form className="mt-4 grid gap-3" onSubmit={save}>
			<label className="account-label">Destination nickname<input className="input" value={values.nickname||''} onChange={event=>setValue('nickname',event.target.value)} required maxLength={80} placeholder="e.g. Personal checking"/></label>
			{type==='BANK_TRANSFER'?<>
				<label className="account-label">Country or territory<select className="input" value={countryCode} onChange={event=>{setCountryCode(event.target.value);setValues(current=>({nickname:current.nickname||'',bankName:current.bankName||'',beneficiaryName:current.beneficiaryName||'',bankAddress:current.bankAddress||''}))}} required>{supportedCountries.map(country=><option key={country.code} value={country.code}>{country.name} ({country.code})</option>)}</select><small className="muted">Manual bank details are supported by country. Aurevia does not claim a complete or verified bank directory.</small></label>
				{input('bankName')}{input('beneficiaryName')}
				{countryCode==='US'&&<><div className="grid gap-3 sm:grid-cols-2">{input('routingNumber')}{input('accountNumber')}</div><label className="account-label">Account type<select className="input" value={values.accountType||''} onChange={event=>setValue('accountType',event.target.value)} required><option value="">Choose type</option><option value="CHECKING">Checking</option><option value="SAVINGS">Savings</option><option value="BUSINESS">Business</option></select></label></>}
				{countryCode==='GB'&&<div className="grid gap-3 sm:grid-cols-2">{input('sortCode')}{input('accountNumber')}</div>}
				{countryCode==='NG'&&<div className="grid gap-3 sm:grid-cols-2">{input('bankCode')}{input('accountNumber')}</div>}
				{usesIban&&<><label className="account-label">IBAN<input className="input font-mono" value={values.iban||''} onChange={event=>setValue('iban',event.target.value)} required autoCapitalize="characters" placeholder="Country-specific IBAN"/></label>{input('bic')}</>}
				{!['US','GB','NG'].includes(countryCode)&&!usesIban&&<>{input('accountNumber')}{input('bankIdentifier')}</>}
				{!usesIban&&input('bic')}
				{!!values.bic&&!usesIban&&countryCode!=='US'&&countryCode!=='GB'&&countryCode!=='NG'&&input('beneficiaryAddress')}
				{input('bankAddress')}
				<label className="account-label">Payout currency<input className="input" value="USD · Aurevia internal ledger currency" readOnly/><small className="muted">Aurevia does not perform FX conversion or guarantee the bank accepts USD.</small></label>
			</>:<>
				<label className="account-label">Asset<select className="input" value={asset} onChange={event=>setAsset(event.target.value as 'BTC'|'ETH')}><option value="BTC">Bitcoin (BTC)</option><option value="ETH">Ether (ETH)</option></select></label>
				<label className="account-label">Blockchain network<input className="input" readOnly value={asset==='BTC'?'Bitcoin Mainnet':'Ethereum Mainnet'}/></label>
				{input('walletAddress','Destination wallet address')}
				<label className="account-label">Email for this wallet (optional)<input className="input" type="email" autoComplete="email" value={values.email||''} onChange={event=>setValue('email',event.target.value)} maxLength={254} placeholder="name@example.com"/></label>
				<p className="text-xs leading-5 muted">Address format is checked locally; this does not prove wallet ownership. Crypto payout conversion and fees are not configured. Requests remain pending administrator processing and are denominated in USD.</p>
			</>}
			{error&&<p className="text-sm text-loss" role="alert">{error}</p>}
			<div className="flex flex-wrap gap-2"><button className="btn bg-gold text-black" type="submit" disabled={busy||disabled}>{busy?'Saving…':editing?'Save changes':'Save destination'}</button><button className="btn bg-white/5" type="button" disabled={busy} onClick={()=>{setShowForm(false);setEditing('');setError('')}}>Cancel</button></div>
		</form>}
		{notice&&<p className="mt-2 text-sm text-profit" role="status"><Check size={14} className="inline"/> {notice}</p>}
		{error&&!showForm&&<p className="mt-2 text-sm text-loss" role="alert">{error}</p>}
		{!items.length&&!showForm&&<p className="account-empty mt-2">No saved bank or wallet destinations.</p>}
		{selectedId&&!showForm&&<p className="mt-2 text-xs muted">Destination selected for this withdrawal. Full details remain hidden in the summary.</p>}
		<details className="mt-3 text-xs muted"><summary className="flex cursor-pointer items-center gap-2"><ChevronDown size={13}/> Supported coverage and verification</summary><p className="mt-2">Country selection uses ISO country/territory codes. This app has no connected bank-directory, account-ownership, payout, or blockchain verification provider. Enter bank details manually; only format checks are performed.</p></details>
	</section>;
}
