import Link from 'next/link';
import {ArrowRight,Palette,ShieldCheck,WalletCards} from 'lucide-react';
import Nav from '@/components/Nav';
import ThemeToggle from '@/components/ThemeToggle';

export default function AboutMe(){
	return <><Nav/><main className="account-page mx-auto max-w-5xl">
		<header className="account-heading"><div><span className="account-kicker">ACCOUNT · INFORMATION</span><h1>About me</h1><p>Review your account policies and appearance preferences.</p></div></header>
		<div className="grid gap-4">
			<section className="account-panel card p-5" aria-labelledby="withdrawal-policy-title">
				<div className="account-panel-title"><div><h2 id="withdrawal-policy-title">REAL withdrawal policy</h2><p className="account-panel-subtitle">These limits apply to all REAL account withdrawals.</p></div><WalletCards size={18} className="gold" aria-hidden="true"/></div>
				<dl className="mt-4 grid gap-3 sm:grid-cols-3">
					<div className="account-metric"><dt>Minimum request</dt><dd className="mt-1 font-semibold">$30,000 USD</dd></div>
					<div className="account-metric"><dt>Maximum request</dt><dd className="mt-1 font-semibold">$300,000 USD</dd></div>
					<div className="account-metric"><dt>Required remaining availability</dt><dd className="mt-1 font-semibold">$300 USD</dd></div>
				</dl>
				<div className="mt-4 space-y-3 text-sm leading-6 muted">
					<p>At least $300 must remain after the requested withdrawal, pending withdrawal reservations, and paper-trading collateral. The wallet shows your eligible balance before submission.</p>
					<p>A 10% commission is deducted from the gross request; the estimated net payout appears before confirmation. The commission is recorded only after an administrator confirms the external payout was processed. Approval alone does not release funds or charge the fee.</p>
					<p>No separate BTC or other advance payment is required to request or receive a withdrawal. Rejected, cancelled, or failed requests incur no commission. Withdrawals remain subject to account eligibility and administrator review.</p>
				</div>
				<Link className="text-link mt-4 inline-flex items-center gap-2" href="/wallet?action=WITHDRAWAL">Open withdrawal workflow <ArrowRight size={14}/></Link>
			</section>
			<section className="account-panel card p-5" aria-labelledby="theme-policy-title">
				<div className="account-panel-title"><div><h2 id="theme-policy-title">Theme</h2><p className="account-panel-subtitle">Choose the appearance used across the platform.</p></div><Palette size={18} className="gold" aria-hidden="true"/></div>
				<div className="mt-4 flex flex-wrap items-center justify-between gap-4"><p className="text-sm leading-6 muted">Your light or dark theme is saved in this browser and applied across Aurevia Exchange.</p><ThemeToggle/></div>
			</section>
			<section className="account-panel card p-5" aria-labelledby="platform-policy-title">
				<div className="account-panel-title"><div><h2 id="platform-policy-title">Platform policies</h2><p className="account-panel-subtitle">Read the broader platform terms and account information.</p></div><ShieldCheck size={18} className="gold" aria-hidden="true"/></div>
				<div className="mt-4 flex flex-wrap gap-3"><Link className="text-link" href="/terms">Terms of use</Link><Link className="text-link" href="/privacy">Privacy overview</Link><Link className="text-link" href="/risk-disclosure">Risk disclosure</Link></div>
			</section>
		</div>
	</main></>;
}
