import InfoPage from '@/components/InfoPage';
import InvestmentEducationAssistant from '@/components/InvestmentEducationAssistant';

export default function Education(){
  return <InfoPage eyebrow="Learning center" title="Build market understanding" lead="Explore investing concepts alongside the Aurevia DEMO workspace and, when available, Alpaca Paper Trading." updated="October 27, 2026" sections={[
    {title:'Start with the basics',content:<p>Learn common terms for asset prices, order types, and portfolio allocations. This application is a learning aid, not a substitute for independent research or professional advice.</p>},
    {title:'Understand risk',content:<p>Market prices can move unpredictably, and losses can exceed expectations. Consider time horizon, diversification, and your own financial circumstances before making real investment decisions.</p>},
    {title:'Practice with DEMO',content:<p>Explore the dashboard, wallet, and trading screens in DEMO mode. When enabled, REAL-mode orders use Alpaca Paper Trading only. DEMO and paper trading do not use your Aurevia wallet balance as brokerage cash or predict live-market results.</p>},
    {title:'AI learning assistant',content:<InvestmentEducationAssistant/>},
  ]}/>;
}