'use client';

import {useCallback,useEffect,useMemo,useState} from 'react';
import Link from 'next/link';
import {Activity,ArrowDownRight,ArrowRight,ArrowUpRight,BriefcaseBusiness,CheckCircle2,RefreshCw,Send,Settings,ShieldCheck,Sparkles,UsersRound,WalletCards} from 'lucide-react';

type DashboardData={
	generatedAt:string;
	metrics:{
		users:{total:number;newThisWeek:number;previousWeek:number};
		deposits:{totalUsd:string;last7DaysUsd:string;changePercent:number|null};
		withdrawals:{totalUsd:string;last7DaysUsd:string;changePercent:number|null};
		investments:{totalUsd:string;last7DaysUsd:string;changePercent:number|null};
	};
	daily:Array<{date:string;depositsUsd:number;withdrawalsUsd:number}>;
	kyc:{verified:number;pending:number;rejected:number};
	accountTypes:{DEMO:number;REAL:number};
	recentUsers:Array<{id:string;name:string|null;email:string;accountMode:'DEMO'|'REAL';kycStatus:string;status:string;createdAt:string}>;
	recentActivity:DashboardActivity[];
	archivedActivity:DashboardActivity[];
	dismissedActivity:DashboardActivity[];
	limitations:{financialCurrency:string;financialAccountMode:string;investmentTotalMeaning:string;accountTypesMeaning:string};
};

type DashboardActivity={id:string;action:string;entity:string;createdAt:string;actor:{name:string|null}|null};
type Health={ok:boolean;database:string};
type DashboardVisualization={id:string;type:'stat'|'timeseries'|'bar';title:string};
type DashboardConfiguration={
	status:'success'|'clarification_needed';
	interpretation:string;
	clarification_question:string|null;
	visualizations:DashboardVisualization[];
};
type AssistantResponse={configuration:DashboardConfiguration;model:string};

const money=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2});
const integer=new Intl.NumberFormat('en-US');

function relativeTime(value:string,reference:number){
	const age=reference-new Date(value).getTime();
	if(!Number.isFinite(age))return 'Time unavailable';
	const minutes=Math.max(0,Math.floor(age/60_000));
	if(minutes<1)return 'Just now';
	if(minutes<60)return `${minutes}m ago`;
	const hours=Math.floor(minutes/60);
	if(hours<24)return `${hours}h ago`;
	return `${Math.floor(hours/24)}d ago`;
}

function displayAction(value:string){
	return value.toLowerCase().replaceAll('_',' ').replace(/\b\w/g,letter=>letter.toUpperCase());
}

function ActivityRow({event,reference,hidden,busy,onToggle}:{event:DashboardActivity;reference:number;hidden:boolean;busy:boolean;onToggle:(event:DashboardActivity,hidden:boolean)=>void}){
	return <li>
		<span className="admin-activity-marker"><Activity size={13}/></span>
		<span className="admin-activity-copy"><b>{displayAction(event.action)}</b><small>{event.entity.replaceAll('_',' ')}{event.actor?.name?` · ${event.actor.name}`:''}</small></span>
		<time dateTime={event.createdAt} title={new Date(event.createdAt).toLocaleString()}>{relativeTime(event.createdAt,reference)}</time>
		<button type="button" className={hidden?'admin-activity-restore':'admin-activity-dismiss'} disabled={busy} onClick={()=>onToggle(event,!hidden)}>{busy?'Saving…':hidden?'Restore':'Hide'}</button>
	</li>;
}

function MetricCard({label,value,detail,change,icon:Icon}:{label:string;value:string;detail:string;change?:number|null;icon:typeof UsersRound}){
	return <article className="admin-metric-card">
		<div className="admin-metric-top"><span>{label}</span><span className="admin-metric-icon"><Icon size={17}/></span></div>
		<strong>{value}</strong>
		<div className="admin-metric-bottom"><span>{detail}</span>{change!==undefined&&change!==null&&<span className={`admin-metric-change ${change<0?'is-down':''}`}>{change>=0?<ArrowUpRight size={13}/>:<ArrowDownRight size={13}/>} {Math.abs(change)}% vs prior 7d</span>}</div>
	</article>;
}

function DashboardAssistant({data}:{data:DashboardData}){
	const [question,setQuestion]=useState('');
	const [configuration,setConfiguration]=useState<DashboardConfiguration|null>(null);
	const [error,setError]=useState('');
	const [busy,setBusy]=useState(false);
	async function submit(event:React.FormEvent<HTMLFormElement>){
		event.preventDefault();
		setBusy(true);setError('');
		try{
			const response=await fetch('/api/admin/dashboard/assistant',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({question})});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to configure dashboard view.');
			setConfiguration((result as AssistantResponse).configuration);
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to configure dashboard view.')}
		finally{setBusy(false)}
	}
	function visualizationValue(id:string){
		switch(id){
			case 'users_total':return integer.format(data.metrics.users.total);
			case 'users_new_7d':return integer.format(data.metrics.users.newThisWeek);
			case 'deposits_total_usd':return money.format(Number(data.metrics.deposits.totalUsd));
			case 'deposits_7d_usd':return money.format(Number(data.metrics.deposits.last7DaysUsd));
			case 'withdrawals_total_usd':return money.format(Number(data.metrics.withdrawals.totalUsd));
			case 'withdrawals_7d_usd':return money.format(Number(data.metrics.withdrawals.last7DaysUsd));
			case 'investments_total_usd':return money.format(Number(data.metrics.investments.totalUsd));
			case 'investments_activated_7d_usd':return money.format(Number(data.metrics.investments.last7DaysUsd));
			default:return null;
		}
	}
	function visualizationRows(id:string){
		if(id==='kyc_status')return [['Verified',data.kyc.verified],['Pending',data.kyc.pending],['Rejected',data.kyc.rejected]] as const;
		if(id==='account_modes')return [['DEMO',data.accountTypes.DEMO],['REAL',data.accountTypes.REAL]] as const;
		return [];
	}
	const maxDaily=Math.max(1,...data.daily.flatMap(day=>[day.depositsUsd,day.withdrawalsUsd]));

	return <section className="admin-panel admin-dashboard-assistant" aria-labelledby="admin-ai-dashboard-heading">
		<header className="admin-panel-heading"><div><p className="admin-eyebrow">CONFIGURATION ONLY · LIVE ADMIN METRICS</p><h2 id="admin-ai-dashboard-heading"><Sparkles size={17}/> Ask the dashboard</h2><p>Describe the Aurevia metrics you want to focus on.</p></div><span className="admin-ai-badge">AI ASSIST</span></header>
		<form className="admin-dashboard-assistant-form" onSubmit={submit}>
			<label className="sr-only" htmlFor="admin-dashboard-question">Ask about dashboard metrics</label>
			<input id="admin-dashboard-question" value={question} onChange={event=>setQuestion(event.target.value)} maxLength={1000} minLength={3} placeholder="e.g. Compare deposits and withdrawals over the last 7 days" required/>
			<button type="submit" disabled={busy||question.trim().length<3}><Send size={14}/>{busy?'Thinking…':'Configure view'}</button>
		</form>
		{error&&<p className="admin-dashboard-error" role="alert">{error}</p>}
		{configuration&&<div className="admin-dashboard-assistant-result" aria-live="polite">
			<p className="admin-ai-interpretation">{configuration.interpretation}</p>
			{configuration.status==='clarification_needed'?<p className="admin-ai-clarification">{configuration.clarification_question}</p>:<div className="admin-ai-visualizations">
				{configuration.visualizations.map(visualization=>{
					const value=visualizationValue(visualization.id);
					const rows=visualizationRows(visualization.id);
					return <article className={`admin-ai-visualization ${visualization.type}`} key={visualization.id}>
						<h3>{visualization.title}</h3>
						{value!==null?<strong>{value}</strong>:visualization.id==='daily_funding'?<div className="admin-ai-timeseries" role="img" aria-label="Daily REAL USD deposits and withdrawals over the last seven days">{data.daily.map(day=><div key={day.date} title={`${day.date}: deposits ${money.format(day.depositsUsd)}, withdrawals ${money.format(day.withdrawalsUsd)}`}><span><i style={{height:`${day.depositsUsd/maxDaily*100}%`}}/><i style={{height:`${day.withdrawalsUsd/maxDaily*100}%`}}/></span><small>{new Date(`${day.date}T00:00:00Z`).toLocaleDateString(undefined,{weekday:'short',timeZone:'UTC'})}</small></div>)}</div>:<div className="admin-ai-bars">{rows.map(([label,count])=><div key={label}><span>{label}</span><span className="admin-ai-bar-track"><i style={{width:`${count/Math.max(1,...rows.map(([,amount])=>amount))*100}%`}}/></span><b>{integer.format(count)}</b></div>)}</div>}
					</article>;
				})}
			</div>}
			{configuration.status==='success'&&<p className="admin-ai-source-note">Values are read from the loaded admin dashboard aggregates. AI selects presentation only; it cannot query or modify records.</p>}
		</div>}
	</section>;
}

function PlatformChart({daily}:{daily:DashboardData['daily']}){
	const max=Math.max(1,...daily.flatMap(day=>[day.depositsUsd,day.withdrawalsUsd]));
	const points=(key:'depositsUsd'|'withdrawalsUsd')=>daily.map((day,index)=>{
		const x=54+index*(592/Math.max(1,daily.length-1));
		const y=196-(day[key]/max)*160;
		return `${x},${y}`;
	}).join(' ');
	const barWidth=Math.min(34,Math.max(10,592/Math.max(1,daily.length)*.48));
	return <section className="admin-panel admin-chart-panel" aria-labelledby="admin-platform-overview">
		<header className="admin-panel-heading"><div><p className="admin-eyebrow">REAL ACCOUNT ACTIVITY</p><h2 id="admin-platform-overview">Funding activity</h2><p>Approved USD deposits and settled USD withdrawals, daily.</p></div><span className="admin-period-label">LAST 7 DAYS · REAL</span></header>
		<div className="admin-chart-legend"><span><i className="deposit-dot"/>Deposits</span><span><i className="withdrawal-dot"/>Withdrawals</span></div>
		{daily.length===0?<p className="admin-empty-state">Daily activity unavailable.</p>:<>
			<svg className="admin-platform-chart" viewBox="0 0 700 250" role="img" aria-labelledby="admin-chart-title admin-chart-description">
				<title id="admin-chart-title">Daily approved deposits and settled withdrawals</title>
				<desc id="admin-chart-description">{daily.map(day=>`${day.date}: deposits ${money.format(day.depositsUsd)}, withdrawals ${money.format(day.withdrawalsUsd)}`).join('; ')}</desc>
				{[36,76,116,156,196].map(y=><line key={y} x1="54" x2="646" y1={y} y2={y} className="admin-chart-gridline"/>)}
				{daily.map((day,index)=>{
					const x=54+index*(592/Math.max(1,daily.length-1));
					const height=day.depositsUsd/max*160;
					return <rect key={day.date} x={x-barWidth/2} y={196-height} width={barWidth} height={height} rx="4" className="admin-chart-deposit-bar"><title>{day.date}: deposits {money.format(day.depositsUsd)}</title></rect>;
				})}
				<polyline points={points('withdrawalsUsd')} className="admin-chart-withdrawals"/>
				{daily.map((day,index)=>{
					const x=54+index*(592/Math.max(1,daily.length-1));
					const withdrawalY=196-(day.withdrawalsUsd/max)*160;
					return <g key={day.date}><circle cx={x} cy={withdrawalY} r="3" className="admin-chart-withdrawal-point"><title>{day.date}: withdrawals {money.format(day.withdrawalsUsd)}</title></circle><text x={x} y="226" textAnchor="middle" className="admin-chart-label">{new Date(`${day.date}T00:00:00Z`).toLocaleDateString(undefined,{month:'short',day:'numeric',timeZone:'UTC'})}</text></g>;
				})}
			</svg>
			<div className="admin-chart-totals"><span>Deposits this week <b>{money.format(daily.reduce((sum,day)=>sum+day.depositsUsd,0))}</b></span><span>Withdrawals this week <b>{money.format(daily.reduce((sum,day)=>sum+day.withdrawalsUsd,0))}</b></span></div>
		</>}
	</section>;
}

function AccountStatus({kyc}:{kyc:DashboardData['kyc']}){
	const total=kyc.verified+kyc.pending+kyc.rejected;
	const verified=(kyc.verified/Math.max(1,total))*100;
	const pending=(kyc.pending/Math.max(1,total))*100;
	const rejected=(kyc.rejected/Math.max(1,total))*100;
	return <section className="admin-panel" aria-labelledby="admin-kyc-heading">
		<header className="admin-panel-heading"><div><p className="admin-eyebrow">IDENTITY REVIEW</p><h2 id="admin-kyc-heading">Account status</h2></div><Link href="/admin/kyc" className="admin-panel-link">Review <ArrowRight size={14}/></Link></header>
		<div className="admin-status-overview">
			<div className="admin-status-donut" role="img" aria-label={`${kyc.verified} verified, ${kyc.pending} pending review, ${kyc.rejected} rejected`} style={{background:`conic-gradient(var(--color-gold) 0 ${verified}%,var(--color-muted) ${verified}% ${verified+pending}%,var(--color-loss) ${verified+pending}% ${verified+pending+rejected}%,var(--color-border) ${verified+pending+rejected}% 100%)`}}><div><b>{integer.format(total)}</b><span>profiles</span></div></div>
			<div className="admin-status-legend">
				<StatusRow label="Verified" count={kyc.verified} total={total} color="gold"/>
				<StatusRow label="Pending" count={kyc.pending} total={total} color="muted"/>
				<StatusRow label="Rejected" count={kyc.rejected} total={total} color="loss"/>
			</div>
		</div>
	</section>;
}

function StatusRow({label,count,total,color}:{label:string;count:number;total:number;color:string}){
	return <div className="admin-status-row"><span><i className={`admin-status-dot ${color}`}/>{label}</span><b>{integer.format(count)}</b><small>{total?Math.round(count/total*100):0}%</small></div>;
}

export default function AdminDashboard(){
	const [data,setData]=useState<DashboardData|null>(null);
	const [health,setHealth]=useState<Health|null>(null);
	const [loading,setLoading]=useState(true);
	const [error,setError]=useState('');
	const [activityError,setActivityError]=useState('');
	const [activityBusyId,setActivityBusyId]=useState('');

	const load=useCallback(async(showLoading=true)=>{
		if(showLoading)setLoading(true);
		setError('');
		try{
			const [dashboardResponse,healthResponse]=await Promise.all([
				fetch('/api/admin/dashboard',{cache:'no-store'}),
				fetch('/api/health',{cache:'no-store'}),
			]);
			const result=await dashboardResponse.json();
			if(!dashboardResponse.ok)throw new Error(result.error||'Unable to load dashboard data.');
			setData(result as DashboardData);
			if(healthResponse.ok){
				try{setHealth(await healthResponse.json() as Health)}
				catch{setHealth({ok:false,database:'unavailable'})}
			}else setHealth({ok:false,database:'unavailable'});
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to load dashboard data.');}
		finally{setLoading(false);}
	},[]);

	useEffect(()=>{void load()},[load]);
	useEffect(()=>{
		const timer=window.setInterval(()=>void load(false),60_000);
		return()=>window.clearInterval(timer);
	},[load]);

	const hiddenActivityIds=useMemo(()=>new Set(data?.dismissedActivity.map(event=>event.id)||[]),[data?.dismissedActivity]);
	const visibleLiveActivity=data?.recentActivity.filter(event=>!hiddenActivityIds.has(event.id))||[];
	const archivedActivityDays=useMemo(()=>{
		const groups=new Map<string,DashboardActivity[]>();
		for(const event of data?.archivedActivity||[]){
			if(hiddenActivityIds.has(event.id))continue;
			const date=new Date(event.createdAt).toISOString().slice(0,10);
			const day=groups.get(date)||[];
			day.push(event);
			groups.set(date,day);
		}
		return [...groups.entries()];
	},[data?.archivedActivity,hiddenActivityIds]);
	const setActivityVisibility=async(event:DashboardActivity,hidden:boolean)=>{
		setActivityBusyId(event.id);
		setActivityError('');
		try{
			const response=await fetch('/api/admin/dashboard/activity',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({auditLogId:event.id,hidden})});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to update activity visibility.');
			setData(current=>current?{
				...current,
				dismissedActivity:hidden
					?[event,...current.dismissedActivity.filter(item=>item.id!==event.id)]
					:current.dismissedActivity.filter(item=>item.id!==event.id),
			}:current);
		}catch(exception){setActivityError(exception instanceof Error?exception.message:'Unable to update activity visibility.')}
		finally{setActivityBusyId('')}
	};

	return <main className="account-page admin-dashboard-page">
		<header className="admin-dashboard-heading">
			<div><nav className="admin-dashboard-breadcrumb" aria-label="Breadcrumb"><Link href="/admin">Home</Link><span>/</span><span>Dashboards</span><span>/</span><span aria-current="page">CRM Dashboard</span></nav><p className="admin-eyebrow">AUREVIA EXCHANGE · CUSTOMER OPERATIONS</p><h1>CRM Dashboard</h1><p>Live customer, account, and platform activity.</p></div>
			<div className="admin-dashboard-header-actions">
				<nav className="admin-dashboard-shortcuts" aria-label="Administrator dashboard shortcuts">
					<Link href="/admin/users" title="Users" aria-label="Users"><UsersRound size={15}/></Link>
					<Link href="/admin/kyc" title="KYC verification" aria-label="KYC verification"><CheckCircle2 size={15}/></Link>
					<Link href="/admin/payments" title="Funding" aria-label="Funding"><WalletCards size={15}/></Link>
					<Link href="/admin/investments" title="Investments" aria-label="Investments"><BriefcaseBusiness size={15}/></Link>
					<Link href="/admin/operations" title="Orders and ledger" aria-label="Orders and ledger"><Activity size={15}/></Link>
					<Link href="/admin/settings" title="Settings" aria-label="Settings"><Settings size={15}/></Link>
				</nav>
				<button type="button" className="admin-refresh-button" onClick={()=>void load()} disabled={loading}><RefreshCw size={15} className={loading?'admin-refresh-spinning':''}/>Refresh data</button>
			</div>
		</header>
		{data&&<DashboardAssistant data={data}/>}
		{error&&<p className="admin-dashboard-error" role="alert">{error}<button type="button" onClick={()=>void load()}>Retry</button></p>}
		{loading&&!data?<div className="admin-dashboard-loading" role="status"><span className="admin-loading-indicator"/>Loading live platform data…</div>:data&&<>
			<section className="admin-kpi-grid" aria-label="Customer relationship metrics">
				<MetricCard label="Total customers" value={integer.format(data.metrics.users.total)} detail="Registered accounts" icon={UsersRound}/>
				<MetricCard label="New this week" value={integer.format(data.metrics.users.newThisWeek)} detail={`Previous week ${integer.format(data.metrics.users.previousWeek)}`} change={data.metrics.users.previousWeek?((data.metrics.users.newThisWeek-data.metrics.users.previousWeek)/data.metrics.users.previousWeek)*100:null} icon={ArrowUpRight}/>
				<MetricCard label="Pending verification" value={integer.format(data.kyc.pending)} detail={`${integer.format(data.kyc.verified)} verified · ${integer.format(data.kyc.rejected)} rejected`} icon={ShieldCheck}/>
			</section>
			<p className="admin-metric-disclaimer">Customer and verification counts reflect current platform account records. Funding and investment figures below are internal USD ledger records for REAL mode.</p>
			<div className="admin-dashboard-main-grid">
				<PlatformChart daily={data.daily}/>
				<div className="admin-dashboard-side-stack">
					<AccountStatus kyc={data.kyc}/>
					<section className="admin-panel" aria-labelledby="admin-account-types-heading">
						<header className="admin-panel-heading"><div><p className="admin-eyebrow">ACCOUNT MODES</p><h2 id="admin-account-types-heading">Account types</h2></div><UsersRound size={18} className="admin-panel-icon"/></header>
						<div className="admin-account-type-list"><div><span className="admin-mode-icon demo"><Activity size={16}/></span><span><b>DEMO</b><small>Current account mode</small></span><strong>{integer.format(data.accountTypes.DEMO)}</strong></div><div><span className="admin-mode-icon real"><ShieldCheck size={16}/></span><span><b>REAL</b><small>Internal ledger mode</small></span><strong>{integer.format(data.accountTypes.REAL)}</strong></div></div>
						<p className="admin-panel-note">{data.limitations.accountTypesMeaning}</p>
					</section>
				</div>
			</div>
			<section className="admin-quick-actions" aria-labelledby="admin-quick-actions-heading">
				<div><p className="admin-eyebrow">SHORTCUTS</p><h2 id="admin-quick-actions-heading">Quick actions</h2></div>
				<div className="admin-quick-action-list">
					<QuickAction href="/admin/kyc" label="Review KYC" icon={CheckCircle2}/>
					<QuickAction href="/admin/payments" label="Process deposit" icon={WalletCards}/>
					<QuickAction href="/admin/payments?type=WITHDRAWAL" label="Process withdrawal" icon={ArrowUpRight}/>
					<QuickAction href="/admin/investments" label="Investments" icon={BriefcaseBusiness}/>
					<QuickAction href="/admin/cards" label="Cards" icon={WalletCards}/>
				</div>
			</section>
			<div className="admin-dashboard-bottom-grid">
				<section className="admin-panel admin-recent-users" aria-labelledby="admin-recent-users-heading">
					<header className="admin-panel-heading"><div><p className="admin-eyebrow">USER ACCOUNTS</p><h2 id="admin-recent-users-heading">Recent users</h2></div><Link href="/admin/users" className="admin-panel-link">All users <ArrowRight size={14}/></Link></header>
					<div className="admin-table-wrap"><table className="admin-dashboard-table"><thead><tr><th>User</th><th>Mode</th><th>KYC</th><th>Joined</th><th><span className="sr-only">View user</span></th></tr></thead><tbody>{data.recentUsers.map(user=><tr key={user.id}><td><Link href={`/admin/users?search=${encodeURIComponent(user.email)}`} className="admin-user-link"><span className="admin-user-avatar">{(user.name||user.email).slice(0,1).toUpperCase()}</span><span><b>{user.name||'Unnamed user'}</b><small>{user.email}</small></span></Link></td><td><span className={`admin-mode-tag ${user.accountMode.toLowerCase()}`}>{user.accountMode}</span></td><td><span className={`admin-kyc-tag ${user.kycStatus.toLowerCase()}`}>{user.kycStatus.replaceAll('_',' ')}</span></td><td>{new Date(user.createdAt).toLocaleDateString()}</td><td><Link href={`/admin/users?search=${encodeURIComponent(user.email)}`} className="admin-row-action">View <ArrowRight size={13}/></Link></td></tr>)}</tbody></table></div>
					{data.recentUsers.length===0&&<p className="admin-empty-state">No active users.</p>}
				</section>
				<section className="admin-panel admin-activity-panel" aria-labelledby="admin-activity-heading">
					<header className="admin-panel-heading"><div><p className="admin-eyebrow">ADMIN ACTIVITY · PAST 24 HOURS</p><h2 id="admin-activity-heading">Live activity</h2></div><Link href="/admin/audit-logs" className="admin-panel-link">Audit log <ArrowRight size={14}/></Link></header>
					{activityError&&<p className="admin-dashboard-error" role="alert">{activityError}</p>}
					{visibleLiveActivity.length?<ol className="admin-activity-list">{visibleLiveActivity.map(event=><ActivityRow key={event.id} event={event} reference={new Date(data.generatedAt).getTime()} hidden={false} busy={activityBusyId===event.id} onToggle={setActivityVisibility}/>)}</ol>:<p className="admin-empty-state">No audit activity in the past 24 hours.</p>}
					<details className="admin-activity-hidden">
						<summary>Archived activity · {archivedActivityDays.reduce((count,[,events])=>count+events.length,0)} records by date</summary>
						{archivedActivityDays.length?archivedActivityDays.map(([date,events])=><div className="admin-activity-day" key={date}><h3>{new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined,{dateStyle:'full',timeZone:'UTC'})} · {events.length}</h3><ol className="admin-activity-list">{events.map(event=><ActivityRow key={event.id} event={event} reference={new Date(data.generatedAt).getTime()} hidden={false} busy={activityBusyId===event.id} onToggle={setActivityVisibility}/>)}</ol></div>):<p className="admin-empty-state">No archived activity.</p>}
					</details>
					{data.dismissedActivity.length>0&&<details className="admin-activity-hidden"><summary>Hidden from dashboard · {data.dismissedActivity.length} records</summary><ol className="admin-activity-list">{data.dismissedActivity.map(event=><ActivityRow key={event.id} event={event} reference={new Date(data.generatedAt).getTime()} hidden busy={activityBusyId===event.id} onToggle={setActivityVisibility}/>)}</ol></details>}
					<p className="admin-panel-note">Activity older than 24 hours is archived by date. Hiding an item removes it from this dashboard only; the audit log retains the original. This dashboard refreshes every minute.</p>
				</section>
			</div>
		</>}
		<footer className="admin-dashboard-footer"><span><i className={health?.ok?'is-online':'is-offline'}/>{health===null?'Checking system health…':health.ok&&health.database==='ok'?'System online · Database responding':'System health unavailable'}</span><span><ShieldCheck size={14}/>Authenticated admin workspace</span><span>{data?`Updated ${new Date(data.generatedAt).toLocaleTimeString()}`:'Live data'}</span></footer>
	</main>;
}

function QuickAction({href,label,icon:Icon}:{href:string;label:string;icon:typeof CheckCircle2}){
	return <Link href={href} className="admin-quick-action"><Icon size={16}/><span>{label}</span><ArrowRight size={13}/></Link>;
}
