import InfoPage from '@/components/InfoPage';

export default function About(){
  return <InfoPage eyebrow="About the platform" title="A considered space to explore markets" lead="Aurevia Exchange brings account, market, and trading workflows together, distinguishing internal records, DEMO practice, and sandbox order routing." updated="October 27, 2026" sections={[
    {title:'Platform overview',content:<p>Market views, trading, wallet activity, and account settings share one interface. DEMO is for practice. When enabled and configured, eligible REAL orders route to the Alpaca sandbox environment.</p>},
    {title:'Designed for clarity',content:<p>Portfolio and activity views show the selected account’s state. Market data sources are labeled where available. Internal ledger balances remain separate from provider-reported sandbox values.</p>},
    {title:'Execution environment',content:<p>Aurevia Exchange is not a bank, custodian, live exchange, or investment adviser. It does not provide personalized financial advice. Sandbox order activity is not a live investment or withdrawable cash.</p>},
  ]}/>;
}