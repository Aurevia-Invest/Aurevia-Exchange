import InfoPage from '@/components/InfoPage';

export default function RiskDisclosure(){
  return <InfoPage eyebrow="Important information" title="Risk disclosure" lead="Understand the limits of this demo and the risks associated with investing and trading." updated="October 27, 2026" sections={[
    {title:'Investment risk',content:<p>Investing and trading involve risk. The value of investments can rise or fall, and you may lose some or all of the capital you invest. Leverage can magnify both gains and losses. Consider whether a product is appropriate for your circumstances and seek independent advice where needed.</p>},
    {title:'Market data and execution',content:<p>Some prices and order-book views are generated internally for DEMO practice; other market prices may be delayed. Neither source guarantees an executable price. DEMO orders are for practice only. When enabled, REAL-mode orders route to an Alpaca sandbox environment. Provider-confirmed fills update Aurevia ledger records; sandbox activity does not predict market outcomes.</p>},
    {title:'Wallet balances and order records',content:<p>Aurevia wallet balances, deposits, and withdrawals are records in the platform's internal ledger and may be subject to review. They do not represent money held in custody or confirmation that an external payment occurred. REAL-mode trade debits and credits are internal ledger entries based on provider-confirmed sandbox fills; they do not represent custody or external money movement.</p>},
    {title:'Information, not advice',content:<p>Platform content is general information for product exploration and education. It is not personalized investment, legal, tax, or financial advice, and it is not an offer or recommendation to buy or sell an instrument.</p>},
  ]}/>;
}