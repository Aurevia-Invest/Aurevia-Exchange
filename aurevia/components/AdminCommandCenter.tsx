'use client';

import {useEffect,useState} from 'react';
import {Activity,AlertTriangle,Check,ExternalLink,KeyRound,RefreshCw,ShieldCheck,X} from 'lucide-react';

type Status='CONNECTED'|'MISSING_CREDENTIALS'|'CONFIGURATION_REQUIRED'|'CONNECTION_FAILED'|'PROVIDER_UNAVAILABLE'|'PENDING_ADMIN_APPROVAL'|'NOT_CONFIGURED'|'DISABLED';
type Integration={id:string;name:string;status:Status;detail:string;feature:string;documentation:string;checkedAt:string;canTest:boolean};
type AiProvider={provider:string;status:Status;model:string|null;availableModels:number};
type AiFeature={id:string;label:string;description:string;enabled:boolean};
type CommandData={checkedAt:string;integrations:Integration[];ai:{configuredProvider:string;configuredModel:string;activeProvider:string|null;activeModel:string|null;providers:AiProvider[];backupProviders:string[]};aiFeatures:AiFeature[];usage:{window:string;requests:number;succeeded:number;failed:number;totalTokens:number;rateLimit:string;recent:Array<{id:string;action:string;metadata:Record<string,unknown>;createdAt:string}>};healthHistory:Array<{id:string;action:string;metadata:Record<string,unknown>;createdAt:string}>;approvalQueue:Array<{id:string;provider:string;submittedBy:string;submittedAt:string|null;status:string}>};

const statusClass=(status:Status)=>status==='CONNECTED'?'is-connected':status==='MISSING_CREDENTIALS'||status==='NOT_CONFIGURED'?'is-missing':status==='PENDING_ADMIN_APPROVAL'?'is-pending':'is-attention';

export default function AdminCommandCenter(){
	const [data,setData]=useState<CommandData|null>(null);
	const [loading,setLoading]=useState(true);
	const [busy,setBusy]=useState('');
	const [error,setError]=useState('');
	const [notice,setNotice]=useState('');
	const [provider,setProvider]=useState<'openrouter'|'gemini'|'groq'>('openrouter');
	const [apiKey,setApiKey]=useState('');
	const [assistantQuestion,setAssistantQuestion]=useState('');
	const [assistantAnswer,setAssistantAnswer]=useState('');

	async function load(){
		setLoading(true);
		try{
			const response=await fetch('/api/admin/command-center',{cache:'no-store'});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to load command center.');
			setData(result as CommandData);setError('');
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to load command center.')}
		finally{setLoading(false)}
	}

	useEffect(()=>{void load()},[]);

	async function testIntegration(id:string){
		setBusy(id);setError('');setNotice('');
		try{
			const response=await fetch('/api/admin/command-center/test',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({integration:id})});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Integration check failed.');
			setNotice(`${result.integration.name}: ${result.integration.status}`);
			await load();
		}catch(exception){setError(exception instanceof Error?exception.message:'Integration check failed.')}
		finally{setBusy('')}
	}

	async function submitCredential(event:React.FormEvent<HTMLFormElement>){
		event.preventDefault();
		if(!apiKey.trim())return;
		setBusy('credential');setError('');setNotice('');
		try{
			const response=await fetch('/api/admin/command-center/credentials',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({provider,apiKey})});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to submit provider credential.');
			setApiKey('');setNotice('Credential encrypted and submitted for a second administrator’s approval.');
			await load();
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to submit provider credential.')}
		finally{setBusy('')}
	}

	async function reviewCredential(proposalId:string,decision:'APPROVE'|'REJECT'){
		setBusy(proposalId);setError('');setNotice('');
		try{
			const response=await fetch('/api/admin/command-center/credentials',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({proposalId,decision})});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to review credential proposal.');
			setNotice(`AI credential ${String(result.proposal.status).toLowerCase()}.`);
			await load();
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to review credential proposal.')}
		finally{setBusy('')}
	}

	async function updateAiFeature(feature:AiFeature){
		setBusy(feature.id);setError('');setNotice('');
		try{
			const response=await fetch('/api/admin/command-center/ai-features',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({feature:feature.id,enabled:!feature.enabled})});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to update the AI feature.');
			setData(current=>current?{...current,aiFeatures:current.aiFeatures.map(item=>item.id===feature.id?result.feature:item)}:current);
			setNotice(`${feature.label} ${feature.enabled?'disabled':'enabled'}.`);
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to update the AI feature.')}
		finally{setBusy('')}
	}

	async function askAssistant(event:React.FormEvent<HTMLFormElement>){
		event.preventDefault();
		setBusy('assistant');setError('');setAssistantAnswer('');
		try{
			const response=await fetch('/api/admin/command-center/assistant',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({question:assistantQuestion})});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Configuration assistance is unavailable.');
			setAssistantAnswer(String(result.answer||''));
		}catch(exception){setError(exception instanceof Error?exception.message:'Configuration assistance is unavailable.')}
		finally{setBusy('')}
	}

	const missing=data?.integrations.filter(item=>item.status==='MISSING_CREDENTIALS'||item.status==='CONFIGURATION_REQUIRED'||item.status==='DISABLED')||[];
	return <div className="admin-command-center">
		<section className="admin-command-center-overview" aria-label="AI engine status">
			<div><span className="admin-command-center-kicker"><Activity size={14}/> CENTRAL AI ENGINE</span><h2>{data?.ai.activeProvider?`${data.ai.activeProvider} · ${data.ai.activeModel}`:'No verified free model active'}</h2><p>Configured preference: {data?`${data.ai.configuredProvider} · ${data.ai.configuredModel}`:'Checking providers…'} · AI output is generated analysis, not verified external information.</p></div>
			<div className="admin-command-center-overview-stats"><span><b>{data?.ai.backupProviders.length??0}</b> eligible backups</span><span><b>{data?.usage.requests??0}</b> recent requests</span><span><b>{missing.length}</b> configuration notices</span></div>
		</section>
		{error&&<p className="admin-command-center-message is-error" role="alert"><AlertTriangle size={15}/>{error}</p>}
		{notice&&<p className="admin-command-center-message" role="status"><Check size={15}/>{notice}</p>}
		<section className="admin-command-center-section" aria-labelledby="ai-provider-heading">
			<header><div><h2 id="ai-provider-heading">AI provider health</h2><p>Provider/model catalog checks use authentication and free-model availability; no paid-model fallback is permitted.</p></div><button className="btn min-h-11 bg-white/5" type="button" onClick={()=>void load()} disabled={loading}><RefreshCw size={15}/>{loading?'Checking…':'Refresh all'}</button></header>
			<div className="admin-command-center-ai-grid">{data?.ai.providers.map(item=><article key={item.provider}><div><b>{item.provider}</b><span className={`admin-integration-status ${statusClass(item.status)}`}>{item.status.replaceAll('_',' ')}</span></div><p>{item.model||'No approved free model selected'}</p><small>{item.availableModels} available free/eligible models</small></article>)}</div>
		</section>
		<section className="admin-command-center-section" aria-labelledby="ai-features-heading">
			<header><div><h2 id="ai-features-heading">AI feature controls</h2><p>Changes are audited. Disabled services cannot send requests through the central AI gateway.</p></div><ShieldCheck size={18}/></header>
			<div className="admin-integration-grid">{data?.aiFeatures.map(feature=><article className="admin-integration-card" key={feature.id}>
				<div className="admin-integration-card-heading"><h3>{feature.label}</h3><span className={`admin-integration-status ${feature.enabled?'is-connected':'is-missing'}`}>{feature.enabled?'ENABLED':'DISABLED'}</span></div>
				<p>{feature.description}</p><footer><button type="button" onClick={()=>void updateAiFeature(feature)} disabled={busy===feature.id}>{busy===feature.id?'Saving…':feature.enabled?'Disable':'Enable'}</button></footer>
			</article>)}</div>
		</section>
		<section className="admin-command-center-section" aria-labelledby="integration-heading">
			<header><div><h2 id="integration-heading">API integration inventory</h2><p>Connectivity is only marked connected after a successful read-only check.</p></div></header>
			{loading&&!data?<p className="muted" role="status">Checking configured integrations…</p>:<div className="admin-integration-grid">{data?.integrations.map(item=><article className="admin-integration-card" key={item.id}>
				<div className="admin-integration-card-heading"><h3>{item.name}</h3><span className={`admin-integration-status ${statusClass(item.status)}`}>{item.status.replaceAll('_',' ')}</span></div>
				<p>{item.detail}</p><small>{item.feature}</small>
				<footer><a href={item.documentation} target="_blank" rel="noreferrer">Official docs <ExternalLink size={12}/></a>{item.canTest&&<button type="button" onClick={()=>void testIntegration(item.id)} disabled={busy===item.id}>{busy===item.id?'Testing…':'Test connection'}</button>}</footer>
			</article>)}</div>}
		</section>
		<div className="admin-command-center-columns">
			<section className="admin-command-center-section" aria-labelledby="usage-heading">
				<header><div><h2 id="usage-heading">AI usage &amp; activity</h2><p>{data?.usage.rateLimit}</p></div></header>
				<div className="admin-ai-usage-stats"><div><b>{data?.usage.requests??0}</b><span>Requests logged</span></div><div><b>{data?.usage.succeeded??0}</b><span>Completed</span></div><div><b>{data?.usage.failed??0}</b><span>Failed</span></div><div><b>{data?.usage.totalTokens.toLocaleString()??0}</b><span>Tokens reported</span></div></div>
				<div className="admin-ai-event-list">{data?.usage.recent.slice(0,8).map(event=><article key={event.id}><b>{String(event.metadata.service||'AI request').replaceAll('_',' ')}</b><span>{String(event.metadata.provider||'provider')} · {String(event.metadata.model||'model')}</span><small>{event.action==='AI_REQUEST_COMPLETED'?'Completed':`Failed · ${String(event.metadata.errorCode||'provider error')}`} · {new Date(event.createdAt).toLocaleString()}</small></article>)}{!data?.usage.recent.length&&<p className="muted">No AI requests have been logged.</p>}</div>
			</section>
			<section className="admin-command-center-section" aria-labelledby="approval-heading">
				<header><div><h2 id="approval-heading">Administrator approval queue</h2><p>Credential proposals require a different administrator’s explicit approval.</p></div><ShieldCheck size={18}/></header>
				{data?.approvalQueue.length?<div className="admin-ai-event-list">{data.approvalQueue.map(proposal=><article key={proposal.id}><b>{proposal.provider} credential</b><span>Submitted by {proposal.submittedBy}</span><small>{proposal.submittedAt?new Date(proposal.submittedAt).toLocaleString():'Submission time unavailable'}</small><div className="admin-ai-approval-actions"><button type="button" onClick={()=>void reviewCredential(proposal.id,'APPROVE')} disabled={busy===proposal.id}><Check size={14}/>Approve</button><button type="button" onClick={()=>void reviewCredential(proposal.id,'REJECT')} disabled={busy===proposal.id}><X size={14}/>Reject</button></div></article>)}</div>:<p className="muted">No credential proposals are awaiting review.</p>}
				<form className="admin-ai-credential-form" onSubmit={submitCredential}><h3><KeyRound size={15}/> Submit AI provider credential</h3><p>Stored encrypted and inactive until another administrator approves it. Environment variables take precedence.</p><div><label>Provider<select value={provider} onChange={event=>setProvider(event.target.value as typeof provider)}><option value="openrouter">OpenRouter</option><option value="gemini">Google Gemini</option><option value="groq">Groq</option></select></label><label>API key<input value={apiKey} onChange={event=>setApiKey(event.target.value)} type="password" autoComplete="new-password" maxLength={500} required/></label></div><button className="btn bg-gold text-black" type="submit" disabled={busy==='credential'||!apiKey.trim()}>{busy==='credential'?'Encrypting…':'Submit for approval'}</button></form>
			</section>
		</div>
		<section className="admin-command-center-section" aria-labelledby="health-history-heading"><header><div><h2 id="health-history-heading">Provider health history</h2><p>Recent checks are redacted and recorded in the administrator audit log.</p></div></header><div className="admin-ai-event-list">{data?.healthHistory.slice(0,10).map(event=><article key={event.id}><b>{String(event.metadata.integration||'Integration')}</b><span>{String(event.metadata.status||'UNKNOWN')}</span><small>{String(event.metadata.detail||'Health check completed')} · {new Date(event.createdAt).toLocaleString()}</small></article>)}{!data?.healthHistory.length&&<p className="muted">No provider health checks recorded yet.</p>}</div></section>
		<section className="admin-command-center-section" aria-labelledby="configuration-assistant-heading"><header><div><h2 id="configuration-assistant-heading">API configuration assistance</h2><p>Generated guidance based on current integration checks; it cannot change deployment settings or verify a provider by itself.</p></div></header><form className="admin-ai-assistant-form" onSubmit={askAssistant}><label htmlFor="admin-api-question">Question</label><div><input id="admin-api-question" value={assistantQuestion} onChange={event=>setAssistantQuestion(event.target.value)} minLength={3} maxLength={1000} placeholder="Which setting enables live Finnhub quotes?" required/><button type="submit" disabled={busy==='assistant'||assistantQuestion.trim().length<3}>{busy==='assistant'?'Checking…':'Ask assistant'}</button></div></form>{assistantAnswer&&<p className="admin-ai-assistant-answer" role="status">Generated analysis · {assistantAnswer}</p>}</section>
		<p className="admin-command-center-footnote">Render deployment secrets remain managed in Render. AI credentials entered here require AI_SECRETS_ENCRYPTION_KEY and are never written to logs. No integration test performs trades, transfers, messages, or financial record changes.</p>
	</div>;
}