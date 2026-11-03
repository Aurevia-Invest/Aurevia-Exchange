'use client';

export default function AureviaStartup({isExiting}:{isExiting:boolean}){
	return <div className={`startup-screen${isExiting?' is-exiting':''}`} role="status" aria-live="polite" aria-label="Loading Aurevia Exchange">
		<div className="startup-glow" aria-hidden="true"/>
		<div className="startup-card">
			<div className="startup-emblem" aria-hidden="true"><svg viewBox="0 0 72 72"><defs><linearGradient id="startup-gold" x1="0" x2="1" y1="0" y2="1"><stop stopColor="#f4dfa7"/><stop offset=".48" stopColor="#c5a46b"/><stop offset="1" stopColor="#82612b"/></linearGradient></defs><path d="M10 62 29 10h14l19 52H48l-5-15H29l-5 15z" fill="url(#startup-gold)" stroke="#f4dfa7" strokeLinejoin="round" strokeWidth="1.2"/><path d="m36 21 11 12h-7v11h-8V33h-7z" fill="#0b1b14"/></svg></div>
			<div className="startup-brand">AUREVIA <span>INVEST</span></div>
			<p>Restoring your workspace</p>
			<div className="startup-track" aria-hidden="true"><div className="startup-progress"/></div>
		</div>
	</div>;
}
