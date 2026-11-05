import InfoPage from '@/components/InfoPage';
import InvestmentEducationAssistant from '@/components/InvestmentEducationAssistant';

export default function Education(){
  return <InfoPage eyebrow="Learning center" title="Build market understanding" lead="Explore investing concepts alongside the Aurevia DEMO workspace." updated="October 27, 2026" sections={[
    {title:'Start with the basics',content:<p>Learn common terms for asset prices, order types, and portfolio allocations. This application is a learning aid, not a substitute for independent research or professional advice.</p>},
    {title:'Understand risk',content:<p>Market prices can move unpredictably, and losses can exceed expectations. Consider time horizon, diversification, and your own financial circumstances before making real investment decisions.</p>},
    {title:'Practice with DEMO',content:<p>Explore the dashboard, wallet, and trading screens in DEMO mode. When enabled, REAL orders route to an Alpaca sandbox environment. Provider-confirmed fills update Aurevia ledger records; sandbox activity does not predict market outcomes.</p>},
    {title:'AI learning assistant',content:<InvestmentEducationAssistant/>},
  ]}/>;
}