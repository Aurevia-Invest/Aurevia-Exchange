'use client';

import Link from 'next/link';
import Image from 'next/image';
import dynamic from 'next/dynamic';
import {Activity,ArrowUpRight,BookOpen,Check,ChevronDown,CircleHelp,Globe2,Landmark,LockKeyhole,ShieldCheck,WalletCards} from 'lucide-react';
import Nav from '@/components/Nav';
import HomeAccountActions from '@/components/HomeAccountActions';
import HomeMarketPreview from '@/components/HomeMarketPreview';
import HomeMarketTicker from '@/components/HomeMarketTicker';
import PublicResourceLinks from '@/components/PublicResourceLinks';
import NewsFeedPanel from '@/components/NewsFeedPanel';
import {useLocale} from '@/lib/i18n-context';

const MarketDepthScene=dynamic(()=>import('@/components/MarketDepthScene'),{ssr:false});

export default function Home(){
	const {translate}=useLocale();
	const principles=[
		{icon:LockKeyhole,title:translate('accountAccessPrinciple'),copy:translate('accountAccessDescription')},
		{icon:WalletCards,title:translate('portfolioVisibilityPrinciple'),copy:translate('portfolioVisibilityDescription')},
		{icon:Activity,title:translate('marketInformationPrincipleLabel'),copy:translate('marketInformationDescription')},
		{icon:ShieldCheck,title:translate('accountControlsPrinciple'),copy:translate('accountControlsDescription')},
		{icon:Landmark,title:translate('clearAccountRecordsPrinciple'),copy:translate('clearAccountRecordsDescription')},
		{icon:Globe2,title:translate('builtForEveryScreen'),copy:translate('builtForEveryScreenDescription')},
	];
	const steps=[
		['01',translate('createYourAccount'),translate('createYourAccount')],
		['02',translate('completeVerification'),translate('completeVerification')],
		['03',translate('requestFunding'),translate('requestFunding')],
		['04',translate('exploreMarkets'),translate('exploreMarkets')],
		['05',translate('monitorPortfolio'),translate('monitorPortfolio')],
		['06',translate('managePositions'),translate('managePositions')],
	];
	const assetClasses=[
		{name:'Forex',status:translate('availableInDemo'),copy:translate('forexDescription'),icon:Globe2,available:true},
		{name:'Crypto',status:translate('availableInDemo'),copy:translate('cryptoDescription'),icon:Activity,available:true},
		{name:'Stocks',status:translate('availableInDemo'),copy:translate('stocksDescription'),icon:Landmark,available:true},
		{name:'ETFs',status:translate('comingSoon'),copy:translate('etfsDescription'),icon:WalletCards},
		{name:'Indices',status:translate('comingSoon'),copy:translate('indicesDescription'),icon:ArrowUpRight},
		{name:'Commodities',status:translate('comingSoon'),copy:translate('commoditiesDescription'),icon:CircleHelp},
	];
	const questions=[
		[translate('whatCanIUse'),translate('whatCanIUseDescription')],
		[translate('howVerificationWorks'),translate('howVerificationWorksDescription')],
		[translate('fundingMethodsConnected'),translate('fundingMethodsConnectedDescription')],
		[translate('marketFeedLive'),translate('marketFeedLiveDescription')],
		[translate('tradingFeesShown'),translate('tradingFeesShownDescription')],
		[translate('financialAdvice'),translate('financialAdviceDescription')],
	];
	return <>
		<Nav/>
		<main className="home-root">
			<section className="home-hero">
				<div className="home-hero-grid" aria-hidden="true"/>
				<div className="home-hero-copy">
					<div className="home-kicker"><span/> {translate('homeHeroKicker')}</div>
					<div className="home-brand-lockup"><Image className="brand-logo-image" src="/aurevia-logo.png" alt="" width={46} height={46} priority/><span className="brand-copy"><strong>Aurevia</strong><small>EXCHANGE</small></span></div>
					<h1>{translate('homeHeroTitle')}<br/><em>{translate('homeHeroAccent')}</em></h1>
					<p className="home-hero-lede">{translate('homeHeroDescription')}</p>
					<div className="home-hero-actions"><HomeAccountActions variant="hero"/></div>
				</div>
				<div className="home-hero-visual"><div className="home-market-depth" aria-hidden="true"><MarketDepthScene className="market-depth-canvas--hero"/></div><HomeMarketPreview/><div className="hero-caption"><span>{translate('marketView')}</span></div></div>
				<a className="home-scroll-cue" href="#platform"><span>{translate('scrollToExplore')}</span><ChevronDown size={15}/></a>
			</section>

			<section className="market-ribbon" aria-label={translate('marketDataNotice')}><div className="ribbon-label"><span className="source-dot"/>{translate('demoMarketWatch')}</div><HomeMarketTicker/></section>
			<section className="home-section platform-section" id="platform">
				<div className="section-heading"><div><p className="eyebrow">{translate('aureviaExperience')}</p><h2>{translate('usefulToolsClearInformation')}</h2></div><p className="section-intro">{translate('focusedEnvironment')}</p></div>
				<div className="principle-grid">{principles.map((item,index)=>{const Icon=item.icon;return <article className="principle-item" key={item.title}><span className="principle-index">0{index+1}</span><Icon size={21} strokeWidth={1.5}/><h3>{item.title}</h3><p>{item.copy}</p></article>})}</div>
			</section>

			<section className="experience-section" id="how-it-works">
				<div className="home-section experience-inner"><div className="section-heading"><div><p className="eyebrow">{translate('simpleRoute')}</p><h2>{translate('yourInvestmentExperience')}</h2></div><p className="section-intro">{translate('moveAtYourOwnPace')}</p></div>
					<ol className="experience-steps">{steps.map(([number,title,copy])=><li key={number}><span className="step-number">{number}</span><span className="step-rule"/><div><h3>{title}</h3><p>{copy}</p></div></li>)}</ol>
				</div>
			</section>

			<section className="home-section markets-section" id="markets">
				<div className="section-heading"><div><p className="eyebrow">{translate('markets')}</p><h2>{translate('exploreAvailable')}</h2></div><p className="section-intro">{translate('availabilityDescription')}</p></div>
				<div className="asset-grid">{assetClasses.map(item=>{const Icon=item.icon;return <article className={`asset-item ${item.available?'asset-available':'asset-coming'}`} key={item.name}><div className="asset-top"><span className="asset-icon"><Icon size={20} strokeWidth={1.6}/></span><span className="asset-state">{item.status}</span></div><h3>{item.name}</h3><p>{item.copy}</p>{item.available?<HomeAccountActions variant="market"/>:<span className="asset-link asset-link-muted">{translate('comingSoon')}</span>}</article>})}</div>
			</section>

			<section className="preview-section" id="portfolio">
				<div className="home-section preview-inner"><div className="section-heading"><div><p className="eyebrow">PORTFOLIO WORKSPACE</p><h2>Everything in view.<br/><em>Nothing assumed.</em></h2></div><p className="section-intro">The signed-in workspace brings balances, positions, and market context together. Your account values come from your account, not a marketing preview.</p></div>
					<div className="dashboard-preview"><div className="preview-window"><div className="preview-window-bar"><span className="window-brand"><Image className="brand-logo-image" src="/aurevia-logo.png" alt="" width={25} height={25}/> Aurevia <b>Exchange</b></span><span className="preview-example">EXAMPLE LAYOUT</span><span className="preview-window-dots"><i/><i/><i/></span></div><div className="preview-body"><aside className="preview-rail"><span className="rail-logo">A</span><span className="rail-active"><Activity size={16}/></span><span><WalletCards size={16}/></span><span><ShieldCheck size={16}/></span></aside><div className="preview-main"><div className="preview-greeting"><div><small>PORTFOLIO OVERVIEW</small><h3>Account snapshot</h3></div><span>Example</span></div><div className="preview-metrics"><div><small>Portfolio value</small><b>Example</b><span>Actual account data appears after sign in</span></div><div><small>Available balance</small><b>—</b><span>From your account ledger</span></div><div><small>Open positions</small><b>—</b><span>Updated from your positions</span></div></div><div className="preview-chart"><div className="preview-chart-head"><span>Portfolio activity</span><span>EXAMPLE VIEW</span></div><div className="preview-chart-lines"><span/><span/><span/><div className="preview-chart-path" aria-hidden="true"><i/><i/><i/><i/><i/><i/><i/><i/></div></div><div className="preview-chart-axis"><span>Activity</span><span>Account values are not shown in this preview</span></div></div></div></div></div><div className="preview-side-note"><span className="note-mark"><Check size={14}/></span><div><b>Account-specific by design</b><p>Balances and performance are only shown inside your authenticated workspace.</p></div></div></div>
				</div>
			</section>

			<section className="home-section trading-section" id="trading">
				<div className="trading-copy"><p className="eyebrow">TRADING WORKSPACE</p><h2>Plan the order.<br/><em>Understand the details.</em></h2><p>Review instrument pricing, order type, estimated fees, and available ledger balance before submitting supported demo trades.</p><HomeAccountActions variant="trade"/></div>
				<div className="trade-steps"><div><span>01</span><b>Choose an instrument</b><small>Review the current market price.</small></div><div><span>02</span><b>Set order details</b><small>Select a supported side and order type.</small></div><div><span>03</span><b>Review before submit</b><small>Check estimated fees and available balance.</small></div></div>
			</section>

			<section className="home-section trust-section" id="security"><div className="trust-emblem"><ShieldCheck size={34} strokeWidth={1.2}/><span>ACCOUNT<br/>CONTROLS</span></div><div><p className="eyebrow">ACCOUNT & SECURITY</p><h2>Designed for<br/><em>account clarity.</em></h2><p className="section-intro">Aurevia uses authenticated account areas, role checks for administration, and auditable records for account activity. Review the account status and verification state shown in your workspace.</p><div className="trust-points"><span><Check size={15}/> Protected account routes</span><span><Check size={15}/> Server-validated actions</span><span><Check size={15}/> Clear verification states</span></div></div><div className="risk-note" id="risk"><span className="eyebrow">RISK NOTE</span><p>Investing and trading involve risk. Practice prices do not represent live markets or predict future outcomes. You may lose some or all of your invested capital.</p></div></section>

			<section className="education-section" id="education"><div className="home-section"><div className="section-heading"><div><p className="eyebrow">LEARN AT YOUR PACE</p><h2>Market knowledge,<br/><em>without the noise.</em></h2></div><p className="section-intro">Explore general educational topics. Content is informational and is not personal investment advice.</p></div><div className="education-grid">{[['Investing basics','Build familiarity with common investment terms.'],['Market fundamentals','Understand what market prices and instruments represent.'],['Risk management','Learn about exposure, volatility, and position sizing.'],['Trading concepts','Review order types and execution basics.'],['Portfolio management','Explore diversification and portfolio monitoring.']].map(([title,copy],index)=><article key={title}><BookOpen size={18}/><span>0{index+1}</span><h3>{title}</h3><p>{copy}</p></article>)}</div></div></section>

			<section className="home-section news-section" id="news"><NewsFeedPanel compact/><PublicResourceLinks placement="NEWS_UPDATES"/></section>

			<PublicResourceLinks/>

			<section className="home-section faq-section" id="faq"><div className="section-heading"><div><p className="eyebrow">GOOD TO KNOW</p><h2>Questions,<br/><em>answered clearly.</em></h2></div><p className="section-intro">A quick guide to the current Aurevia demo environment.</p></div><div className="faq-list">{questions.map(([question,answer])=><details key={question}><summary>{question}<ChevronDown size={18}/></summary><p>{answer}</p></details>)}</div></section>

			<section className="home-cta" id="support"><div><p className="eyebrow">AUREVIA EXCHANGE</p><h2>Explore the platform<br/><em>at your own pace.</em></h2><p>Choose your account type and access clearly labeled account tools.</p></div><div className="home-cta-actions"><HomeAccountActions variant="cta"/></div></section>
		</main>
		<Footer/>
	</>;
}

function Footer(){
	return <footer className="home-footer"><div className="footer-main"><div className="footer-brand"><Link href="/" className="footer-logo"><Image className="brand-logo-image" src="/aurevia-logo.png" alt="" width={42} height={42}/><span className="brand-copy"><strong>Aurevia</strong><small>EXCHANGE</small></span></Link><p>A considered workspace for exploring markets and understanding your account.</p></div><div className="footer-column"><b>Platform</b><Link href="/dashboard">Dashboard</Link><Link href="/trade">Trading</Link><Link href="/wallet">Wallet</Link><Link href="/kyc">Verification</Link></div><div className="footer-column"><b>Explore</b><a href="#markets">Markets</a><Link href="/stories">Stories</Link><Link href="/client-stories">Client stories</Link><a href="#education">Education</a><a href="#news">Market information</a><a href="#faq">FAQs</a></div><div className="footer-column"><b>Information</b><Link href="/risk-disclosure">Risk disclosure</Link><a href="#security">Security</a><Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link><Link href="/support">Support</Link></div></div><div className="footer-bottom"><span>© {new Date().getFullYear()} Aurevia Exchange</span><span>Aurevia Exchange</span></div></footer>;
}
