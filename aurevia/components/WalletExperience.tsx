'use client';

import {FormEvent,useCallback,useEffect,useMemo,useRef,useState} from 'react';
import Link from 'next/link';
import {useSession} from 'next-auth/react';
import {ArrowDownLeft,ArrowRight,ArrowUpRight,Check,Copy,Eye,EyeOff,RefreshCw,ShieldCheck,WalletCards,X} from 'lucide-react';
import Nav from '@/components/Nav';
import ReceiptGenerator,{type ReceiptData} from '@/components/ReceiptGenerator';
import AureviaExchangeId from '@/components/AureviaExchangeId';
import WithdrawalDestinationPanel from '@/components/WithdrawalDestinationPanel';
import {useLocale} from '@/lib/i18n-context';
import {SUPPORTED_CURRENCIES} from '@/lib/config/simulation';
import {formatUsd} from '@/lib/currency-format';
import {calculateWithdrawalAmounts,getWithdrawalEligibilityIssue,MAX_REAL_WITHDRAWAL_USD,MIN_REAL_WITHDRAWAL_USD,REQUIRED_REAL_WITHDRAWAL_RESERVE_USD,WITHDRAWAL_COMMISSION_PERCENT} from '@/lib/withdrawal-fee';
import {useSearchParams} from 'next/navigation';

type PaymentMethod={id:string;name:string;currencies:string[];destination:string|null;instructions:string|null;minimumAmount:string|number;maximumAmount:string|number|null;depositEnabled:boolean;withdrawalEnabled:boolean;requiresNetwork:boolean;demoOnly:boolean};
type FundingRecord={id:string;type:'DEPOSIT'|'WITHDRAWAL';method:string;amount:number|string;creditedAmount?:number|string|null;creditedCurrency?:string|null;feeAmount?:number|string|null;feePercent?:number|string|null;currency:string;status:string;accountMode:'DEMO'|'REAL';createdAt:string;reviewedAt?:string|null;verifiedAt?:string|null;settledAt?:string|null;settlementReference?:string|null;processingReference?:string|null;processingConfirmedAt?:string|null;withdrawalDestinationId?:string|null;withdrawalDestination?:{nickname:string;countryCode:string;network:string|null;asset:string|null;maskedLabel:string}|null;reviewedBy?:{name:string|null;email:string}|null;transactionReference?:string|null;referenceInfo?:string|null;senderInfo?:string|null;destinationInfo?:string|null;beneficiaryInfo?:string|null;note?:string|null;adminNote?:string|null;previousBalance?:string|null;resultingBalance?:string|null;hasReceipt?:boolean;network?:string|null;user?:{name:string|null;email:string}};
type LedgerReceipt={id:string;reference:string;description:string;type:'CREDIT'|'DEBIT';amount:number|string;currency:string;createdAt:string};
type TradingTransaction={id:string;description:string;type:'CREDIT'|'DEBIT';amount:number|string;currency:string;createdAt:string};
type WalletData={accountMode:'DEMO'|'REAL';aureviaExchangeId:string|null;balance:number|string|null;withdrawableBalance?:number|string|null;balances:Array<{currency:string;balance:number|string}>;transactions:FundingRecord[];adminLedgerReceipts:LedgerReceipt[];tradingTransactions:TradingTransaction[]};
type CurrencyRate={rate:number|string|null;source:string|null;observedAt:string|null;status:'CURRENT'|'STALE'|'INTERNAL'|'UNAVAILABLE'};
type PaymentMethodsResponse={methods:PaymentMethod[];fundingStatus:'SIMULATED'|'DEMO'|'AVAILABLE'|'MANUAL_REVIEW'|'NOT_CONFIGURED'|'DISABLED'|'ERROR';simulationAvailable?:boolean;supportedCurrencies?:readonly string[];btcAddress?:string|null;realFundingAvailable:boolean;realWithdrawalAvailable:boolean;manualDepositReviewAvailable:boolean};
type KycData={kycStatus:string;documents:number;verificationProfileSubmitted:boolean;depositEnabled:boolean;withdrawalEnabled:boolean;accountRestricted:boolean;restrictionReason:string|null;canWithdraw?:boolean};
type WalletActivity={id:string;source:string;action:string;timestamp:string;asset:string;amount:string;status:string;link:string};

const money=(amount:number,currency='USD')=>currency==='USD'?formatUsd(amount):`${amount.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:8})} ${currency}`;
const statuses:Record<string,string>={PENDING:'Pending',PENDING_REVIEW:'Pending administrator review',PROCESSING:'External processing · not confirmed',APPROVED:'Approved · amount reserved',COMPLETED:'Completed · admin recorded payout',FAILED:'Failed · reservation released',REVERSED:'Reversed',REJECTED:'Rejected',CANCELLED:'Cancelled'};
const receiptStatus=(status:string):ReceiptData['status']=>{
	switch(status){
		case 'PENDING':case 'PENDING_REVIEW':case 'PROCESSING':case 'APPROVED':case 'COMPLETED':case 'REJECTED':case 'FAILED':case 'CANCELLED':case 'REVERSED':return status;
		default:return 'PENDING';
	}
};
const reserves=['PENDING','PENDING_REVIEW','APPROVED','PROCESSING'];
const formatFundingMethodLabel=(method:string)=>{
	const value=String(method||'');
	return value.replace(/^Internal\s+simulated\b/i,'Internal').replace(/^Admin configured\s+/i,'Administrator ').replace(/\s+REAL deposit$/i,' Real Account deposit').replace(/\bsimulated\b/gi,'').replace(/\s+/g,' ').trim();
};
const withdrawalEligibilityMessage=(issue:ReturnType<typeof getWithdrawalEligibilityIssue>)=>{
	if(issue==='BELOW_MINIMUM')return `The requested amount is below the ${money(MIN_REAL_WITHDRAWAL_USD,'USD')} minimum. You do not need to trade more or pay a separate fee to submit a valid request.`;
	if(issue==='ABOVE_MAXIMUM')return `The maximum REAL withdrawal request is ${money(MAX_REAL_WITHDRAWAL_USD,'USD')}.`;
	if(issue==='INSUFFICIENT_RESERVE')return `Your available balance cannot cover this request and retain ${money(REQUIRED_REAL_WITHDRAWAL_RESERVE_USD,'USD')}. You do not need to trade more or pay a separate fee to qualify.`;
	return '';
};
const fundingUnavailableMessage=(status:PaymentMethodsResponse['fundingStatus'])=>status==='DISABLED'?'Internal ledger requests are temporarily disabled for this account. No balance was changed.':'Internal ledger requests are temporarily unavailable. No balance was changed.';
const validateFundingAmount=(amountText:string,mode:'DEPOSIT'|'WITHDRAWAL',balance:number|null,minimum:number|undefined,maximum:number|undefined)=>{
	const numeric=Number(amountText);
	if(!amountText.trim()||!Number.isFinite(numeric)||numeric<=0)return 'Enter a positive amount.';
	if(mode==='WITHDRAWAL'){
		const issueMessage=withdrawalEligibilityMessage(getWithdrawalEligibilityIssue(numeric,balance));
		if(issueMessage)return issueMessage;
	}
	if(minimum!==undefined&&numeric<Number(minimum))return `Minimum allowed amount is ${money(Number(minimum), 'USD')}.`;
	if(maximum!==undefined&&numeric>Number(maximum))return `Maximum allowed amount is ${money(Number(maximum), 'USD')}.`;
	return '';
};

function isWalletData(value:unknown):value is WalletData{
	if(!value||typeof value!=='object')return false;
	const data=value as Partial<WalletData>;
	const validAmount=(amount:unknown)=>amount===null||(typeof amount==='number'&&Number.isFinite(amount))||(typeof amount==='string'&&amount.trim()!==''&&Number.isFinite(Number(amount)));
	return (data.accountMode==='DEMO'||data.accountMode==='REAL')&&validAmount(data.balance)&&(data.withdrawableBalance===undefined||validAmount(data.withdrawableBalance))&&Array.isArray(data.balances)&&data.balances.every(item=>!!item&&typeof item.currency==='string'&&validAmount(item.balance))&&Array.isArray(data.transactions)&&data.transactions.every(item=>!!item&&typeof item.id==='string'&&(item.type==='DEPOSIT'||item.type==='WITHDRAWAL')&&typeof item.status==='string'&&validAmount(item.amount))&&(data.adminLedgerReceipts===undefined||Array.isArray(data.adminLedgerReceipts))&&(data.tradingTransactions===undefined||Array.isArray(data.tradingTransactions));
}

function isPaymentMethodsResponse(value:unknown):value is PaymentMethodsResponse{
	if(!value||typeof value!=='object')return false;
	const data=value as Partial<PaymentMethodsResponse>;
	return Array.isArray(data.methods)&&data.methods.every(method=>!!method&&typeof method.id==='string'&&typeof method.name==='string'&&Array.isArray(method.currencies)&&method.currencies.every(currency=>typeof currency==='string')&&typeof method.depositEnabled==='boolean'&&typeof method.withdrawalEnabled==='boolean')&&(data.btcAddress===undefined||data.btcAddress===null||typeof data.btcAddress==='string')&&['SIMULATED','DEMO','AVAILABLE','MANUAL_REVIEW','NOT_CONFIGURED','DISABLED','ERROR'].includes(String(data.fundingStatus))&&typeof data.realFundingAvailable==='boolean'&&typeof data.realWithdrawalAvailable==='boolean'&&typeof data.manualDepositReviewAvailable==='boolean';
}

export default function WalletExperience(){
	const {data:session,status:sessionStatus}=useSession();
	const {translate}=useLocale();
	const searchParams=useSearchParams();
	const activeMode=session?.user?.accountMode;
	const [data,setData]=useState<WalletData>({accountMode:'DEMO',aureviaExchangeId:null,balance:0,balances:[],transactions:[],adminLedgerReceipts:[],tradingTransactions:[]});
	const [recentActivity,setRecentActivity]=useState<WalletActivity[]>([]);
	const [methods,setMethods]=useState<PaymentMethod[]>([]);
	const [fundingStatus,setFundingStatus]=useState<PaymentMethodsResponse['fundingStatus']>('NOT_CONFIGURED');
	const [realFundingAvailable,setRealFundingAvailable]=useState(false);
	const [realWithdrawalAvailable,setRealWithdrawalAvailable]=useState(false);
	const [manualDepositReviewAvailable,setManualDepositReviewAvailable]=useState(false);
	const [btcAddress,setBtcAddress]=useState<string|null>(null);
	const [btcAddressSkipped,setBtcAddressSkipped]=useState(false);
	const [btcAddressNotice,setBtcAddressNotice]=useState('');
	const [profile,setProfile]=useState<KycData|null>(null);
	const [methodLoadError,setMethodLoadError]=useState('');
	const [profileLoadError,setProfileLoadError]=useState('');
	const [type,setType]=useState<'DEPOSIT'|'WITHDRAWAL'>('DEPOSIT');
	const [withdrawalDestinationId,setWithdrawalDestinationId]=useState('');
	const [withdrawalDestinationLabel,setWithdrawalDestinationLabel]=useState('');
	const [withdrawalDestinationAsset,setWithdrawalDestinationAsset]=useState<string|null>(null);
	const [withdrawalDestinationNetwork,setWithdrawalDestinationNetwork]=useState<string|null>(null);
	const [destinationAccurate,setDestinationAccurate]=useState(false);
	const [methodId,setMethodId]=useState('');
	const [currency,setCurrency]=useState('USD');
	const [amount,setAmount]=useState('');
	const [transactionReference,setTransactionReference]=useState('');
		const [senderEmail,setSenderEmail]=useState('');
		const [senderWalletName,setSenderWalletName]=useState('');
		const [senderWalletAddress,setSenderWalletAddress]=useState('');
	const [transactionDateTime,setTransactionDateTime]=useState('');
	const [note,setNote]=useState('');
	const [confirming,setConfirming]=useState(false);
	const [message,setMessage]=useState('');
	const [error,setError]=useState('');
	const [loading,setLoading]=useState(true);
	const [hasWalletData,setHasWalletData]=useState(false);
	const [balanceVisible,setBalanceVisible]=useState(true);
	const [submitting,setSubmitting]=useState(false);
	const [reauthPassword,setReauthPassword]=useState('');
	const currencyPreferenceInitialized=useRef(false);
	const latestRequest=useRef(0);
	const [idempotencyKey,setIdempotencyKey]=useState('');
	const [keyFingerprint,setKeyFingerprint]=useState('');
	const [receiptFiles,setReceiptFiles]=useState<Record<string,File|undefined>>({});
	const [receiptBusy,setReceiptBusy]=useState('');
	const [submittedReceipt,setSubmittedReceipt]=useState<FundingRecord|null>(null);
	const [proofFile,setProofFile]=useState<File|null>(null);
	const [displayCurrency,setDisplayCurrency]=useState('USD');
	const [currencyRate,setCurrencyRate]=useState<CurrencyRate|null>(null);
	const [currencyError,setCurrencyError]=useState('');
	const [workflow,setWorkflow]=useState<'DEPOSIT'|'WITHDRAWAL'|null>(null);

	const availableMethods=useMemo(()=>methods.filter(method=>type==='DEPOSIT'?method.depositEnabled:method.withdrawalEnabled&&(data.accountMode==='DEMO'||realWithdrawalAvailable)),[methods,type,data.accountMode,realWithdrawalAvailable]);
	const selectedMethod=availableMethods.find(method=>method.id===methodId);
	const manualRealRequest=data.accountMode==='REAL';
	const manualRealDeposit=type==='DEPOSIT'&&manualRealRequest;
	const manualRealWithdrawal=type==='WITHDRAWAL'&&manualRealRequest;
	const manualRealFunding=manualRealDeposit||manualRealWithdrawal;
	const btcWithdrawalSubmissionEnabled=manualRealWithdrawal&&withdrawalDestinationAsset==='BTC'&&withdrawalDestinationNetwork==='BITCOIN_MAINNET';
	const currentBalanceRecord=data.balances.find(item=>item.currency===currency);
	const currentBalance=currentBalanceRecord?Number(currentBalanceRecord.balance):null;
	const pendingWithdrawal=useMemo(()=>data.transactions.filter(item=>item.type==='WITHDRAWAL'&&item.currency===currency&&reserves.includes(item.status)).reduce((sum,item)=>sum+Number(item.amount),0),[data.transactions,currency]);
	const ledgerAvailableBalance=currentBalance===null?null:currentBalance-pendingWithdrawal;
	const availableBalance=data.accountMode==='REAL'&&currency==='USD'
		?(data.withdrawableBalance===undefined||data.withdrawableBalance===null?null:Number(data.withdrawableBalance))
		:ledgerAvailableBalance;
	const withdrawalAmounts=calculateWithdrawalAmounts(amount);
	const currentDisplayRate=currencyRate?.rate!==null&&currencyRate?.rate!==undefined&&Number.isFinite(Number(currencyRate.rate))&&Number(currencyRate.rate)>0?Number(currencyRate.rate):null;
	const realKycApproved=profile?.kycStatus==='APPROVED'&&profile.documents>0&&profile.verificationProfileSubmitted;
	const realWithdrawalKycBlocked=data.accountMode==='REAL'&&!!profile&&!realKycApproved;
	const realWithdrawalBlocked=data.accountMode==='REAL'&&!!profile&&(!profile.withdrawalEnabled||profile.accountRestricted);
	const load=useCallback(async(showLoading=false)=>{
		const requestId=++latestRequest.current;
		if(showLoading)setLoading(true);
		setError('');
		const requests=await Promise.allSettled([
			fetch('/api/wallet',{cache:'no-store'}).then(async response=>({response,result:await response.json()})),
			fetch('/api/payment-methods',{cache:'no-store'}).then(async response=>({response,result:await response.json()})),
			fetch('/api/profile',{cache:'no-store'}).then(async response=>({response,result:await response.json()})),
			fetch('/api/currency-preference',{cache:'no-store'}).then(async response=>({response,result:await response.json()})),
			fetch('/api/activity?category=all&limit=5',{cache:'no-store'}).then(async response=>({response,result:await response.json()})),
		]);
		if(requestId!==latestRequest.current)return;
		const [walletRequest,methodsRequest,profileRequest,currencyPreferenceRequest,activityRequest]=requests;
		if(walletRequest.status==='fulfilled'&&walletRequest.value.response.ok&&isWalletData(walletRequest.value.result)){
			setData({...walletRequest.value.result,adminLedgerReceipts:walletRequest.value.result.adminLedgerReceipts||[],tradingTransactions:walletRequest.value.result.tradingTransactions||[]});setHasWalletData(true);
		}else{
			const result=walletRequest.status==='fulfilled'?walletRequest.value.result as {error?:string}:null;
			setData(current=>({...current,balance:null,balances:[],transactions:[]}));
			setHasWalletData(false);
			setError(result?.error||'Wallet data is temporarily unavailable. Please try again.');
		}
		if(methodsRequest.status==='fulfilled'&&methodsRequest.value.response.ok&&isPaymentMethodsResponse(methodsRequest.value.result)){
			setMethods(methodsRequest.value.result.methods);
			setFundingStatus(methodsRequest.value.result.fundingStatus);
			setRealFundingAvailable(methodsRequest.value.result.realFundingAvailable);
			setRealWithdrawalAvailable(methodsRequest.value.result.realWithdrawalAvailable);
			setManualDepositReviewAvailable(methodsRequest.value.result.manualDepositReviewAvailable);
			setBtcAddress(methodsRequest.value.result.btcAddress||null);
			setMethodLoadError('');
		}else{
			const result=methodsRequest.status==='fulfilled'?methodsRequest.value.result as {error?:string}:null;
			setMethods([]);setFundingStatus('ERROR');setRealFundingAvailable(false);setRealWithdrawalAvailable(false);setManualDepositReviewAvailable(false);
			setBtcAddress(null);
			setMethodLoadError(result?.error||'Funding options are temporarily unavailable. No funds were changed.');
		}
		if(profileRequest.status==='fulfilled'&&profileRequest.value.response.ok&&profileRequest.value.result&&typeof profileRequest.value.result==='object'){
			setProfile(profileRequest.value.result);setProfileLoadError('');
		}else{
			setProfile(null);setProfileLoadError('Account verification status is temporarily unavailable.');
		}
		if(activityRequest.status==='fulfilled'&&activityRequest.value.response.ok&&Array.isArray(activityRequest.value.result.data?.items)){
			setRecentActivity(activityRequest.value.result.data.items.filter((item:WalletActivity)=>['ledger','funding','order','position','notification'].includes(item.source)).slice(0,5));
		}else setRecentActivity([]);
		if(!currencyPreferenceInitialized.current&&currencyPreferenceRequest.status==='fulfilled'&&currencyPreferenceRequest.value.response.ok&&typeof currencyPreferenceRequest.value.result.currency==='string'){
			const preferred=currencyPreferenceRequest.value.result.currency;
			setDisplayCurrency(preferred);
			if(SUPPORTED_CURRENCIES.some(item=>item===preferred))setCurrency(preferred);
			currencyPreferenceInitialized.current=true;
		}
		setLoading(false);
	},[]);

	useEffect(()=>{
		if(displayCurrency==='USD'){setCurrencyRate(null);setCurrencyError('');return}
		let current=true;
		setCurrencyRate(null);setCurrencyError('');
		void fetch(`/api/currency-rates?to=${encodeURIComponent(displayCurrency)}`,{cache:'no-store'}).then(async response=>{
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Exchange rate unavailable.');
			if(current){setCurrencyRate(result);setCurrencyError('')}
		}).catch(()=>{if(current){setCurrencyRate({rate:null,source:null,observedAt:null,status:'UNAVAILABLE'});setCurrencyError('')}})
		return()=>{current=false};
	},[displayCurrency]);
	async function updateDisplayCurrency(value:string){
		setCurrencyError('');
		try{
			const response=await fetch('/api/currency-preference',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({currency:value})});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to save display currency.');
			setDisplayCurrency(result.currency);
		}catch(exception){setCurrencyError(exception instanceof Error?exception.message:'Unable to save display currency.')}
	}
	async function copyBtcAddress(){
		if(!btcAddress)return;
		try{
			await navigator.clipboard.writeText(btcAddress);
			setBtcAddressNotice('BTC address copied.');
		}catch{
			setBtcAddressNotice('Copy is unavailable in this browser. Select and copy the address manually.');
		}
	}

	useEffect(()=>{
		if(sessionStatus!=='authenticated')return;
		setData({accountMode:activeMode||'DEMO',aureviaExchangeId:null,balance:0,balances:[],transactions:[],adminLedgerReceipts:[],tradingTransactions:[]});
		setMethods([]);setMethodId('');setFundingStatus('NOT_CONFIGURED');setRealFundingAvailable(false);setRealWithdrawalAvailable(false);setManualDepositReviewAvailable(false);setBtcAddress(null);setBtcAddressSkipped(false);setBtcAddressNotice('');setProfile(null);setMethodLoadError('');setProfileLoadError('');setHasWalletData(false);setSubmittedReceipt(null);setAmount('');setTransactionReference('');setNote('');setProofFile(null);setIdempotencyKey('');setKeyFingerprint('');setConfirming(false);setMessage('');setReceiptFiles({});
		void load(true);
	},[sessionStatus,activeMode,load]);
		useEffect(()=>{setSenderEmail('');setSenderWalletName('');setSenderWalletAddress('');setTransactionDateTime('')},[activeMode,session?.user?.id,submittedReceipt?.id]);
	useEffect(()=>{
		const requested=searchParams.get('action')||searchParams.get('type');
		if(requested==='DEPOSIT'||requested==='WITHDRAWAL'){
			setType(requested);
			setWorkflow(requested);
		}else setWorkflow(null);
	},[searchParams]);
	useEffect(()=>{
		if(sessionStatus!=='authenticated')return;
		const timer=window.setInterval(()=>void load(),15000);
		const refreshWhenActive=()=>{if(document.visibilityState==='visible')void load()};
		window.addEventListener('focus',refreshWhenActive);
		document.addEventListener('visibilitychange',refreshWhenActive);
		return ()=>{window.clearInterval(timer);window.removeEventListener('focus',refreshWhenActive);document.removeEventListener('visibilitychange',refreshWhenActive)};
	},[sessionStatus,load]);
	useEffect(()=>{
		if(methodId!=='SIMULATED_REAL'&&!availableMethods.some(method=>method.id===methodId))setMethodId(availableMethods[0]?.id||'');
	},[availableMethods,methodId]);
	useEffect(()=>{if(currency!=='USD')setCurrency('USD')},[currency]);

	async function submit(event:FormEvent<HTMLFormElement>){
		event.preventDefault();
		if(!selectedMethod&&!manualRealFunding)return;
		const minimumAmount=selectedMethod&&selectedMethod.minimumAmount!==null&&selectedMethod.minimumAmount!==undefined?Number(selectedMethod.minimumAmount):0.01;
		const minAmount=type==='DEPOSIT'?minimumAmount:undefined;
		const maxAmount=type==='WITHDRAWAL'?(selectedMethod&&selectedMethod.maximumAmount!==null&&selectedMethod.maximumAmount!==undefined?Number(selectedMethod.maximumAmount):undefined):undefined;
		const validationMessage=validateFundingAmount(amount,type,availableBalance,minAmount,maxAmount);
		if(validationMessage){setError(validationMessage);setConfirming(false);return;}
		if(type==='WITHDRAWAL'&&manualRealWithdrawal&&!withdrawalDestinationId){setError('Choose or save a withdrawal destination.');setConfirming(false);return;}
		if(type==='WITHDRAWAL'&&manualRealWithdrawal&&!destinationAccurate){setError('Confirm that the selected destination is accurate and belongs to the intended beneficiary.');setConfirming(false);return;}
		setConfirming(true);setMessage('');setError('');
	}

	async function confirmSubmit(){
		if((!selectedMethod&&!manualRealFunding)||submitting)return;
		setSubmitting(true);setError('');
		const payload={type,amount:Number(amount),currency:'USD',transactionReference:transactionReference||undefined,note:note||undefined,...(btcWithdrawalSubmissionEnabled?{network:'BITCOIN_MAINNET',senderEmail:senderEmail||undefined,senderWalletName:senderWalletName||undefined,senderWalletAddress:senderWalletAddress||undefined,transactionDateTime:transactionDateTime?new Date(transactionDateTime).toISOString():undefined}:{}),...(type==='WITHDRAWAL'?{withdrawalDestinationId,destinationConfirmed:true as const}:{})};
		const fingerprint=JSON.stringify(payload);
		const key=idempotencyKey&&keyFingerprint===fingerprint?idempotencyKey:window.crypto.randomUUID();setIdempotencyKey(key);setKeyFingerprint(fingerprint);
		try{
			if(type==='WITHDRAWAL'){
				const reauthResponse=await fetch('/api/security/reauth',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:reauthPassword})});
				const reauthResult=await reauthResponse.json();
				if(!reauthResponse.ok)throw new Error(reauthResult.error||'Verify your identity before requesting a withdrawal.');
			}
			const headers:HeadersInit={'Idempotency-Key':key};
			let body:BodyInit;
			if(type==='DEPOSIT'&&proofFile){
				const form=new FormData();
				form.append('payload',JSON.stringify(payload));
				form.append('evidence',proofFile);
				body=form;
			}else{
				headers['content-type']='application/json';
				body=JSON.stringify(payload);
			}
			const response=await fetch('/api/wallet',{method:'POST',headers,body});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to submit this request.');
			setSubmittedReceipt(result as FundingRecord);
			setMessage(response.status===200?`Request ${result.id} already exists with status ${String(result.status).replaceAll('_',' ')}. No new request was created.`:`Request ${result.id} submitted for administrator review. The ledger has not been posted.`);
			setAmount('');setTransactionReference('');setNote('');setProofFile(null);setIdempotencyKey('');setKeyFingerprint('');setConfirming(false);setReauthPassword('');
			await load();
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to submit this request.');}
		finally{setSubmitting(false);}
	}

	async function uploadReceipt(request:FundingRecord){
		const file=receiptFiles[request.id];if(!file||receiptBusy)return;
		setReceiptBusy(request.id);setError('');setMessage('');
		try{
			const body=new FormData();body.append('file',file);
			const response=await fetch(`/api/wallet/${encodeURIComponent(request.id)}/receipt`,{method:'POST',body});
			const result=await response.json();if(!response.ok)throw new Error(result.error||'Receipt upload failed.');
			const delivery=result.emailDelivery==='sent'?'Support email sent.':result.emailDelivery==='failed'?'Support email failed; admin notification is recorded.':'Email is not configured; admin notification is recorded.';
			setMessage(`Receipt stored privately. Funds were not credited. ${delivery}`);setReceiptFiles(current=>({...current,[request.id]:undefined}));await load();
		}catch(exception){setError(exception instanceof Error?exception.message:'Receipt upload failed.')}
		finally{setReceiptBusy('')}
	}

	async function openReceipt(requestId:string){
		try{
			const response=await fetch(`/api/wallet/${encodeURIComponent(requestId)}/receipt`,{cache:'no-store'});
			const result=await response.json();if(!response.ok)throw new Error(result.error||'Receipt unavailable.');
			window.open(result.url,'_blank','noopener,noreferrer');
		}catch(exception){setError(exception instanceof Error?exception.message:'Receipt unavailable.')}
	}

	async function cancelWithdrawal(request:FundingRecord){
		if(submitting)return;
		setSubmitting(true);setError('');setMessage('');
		try{
			const response=await fetch(`/api/funding/${encodeURIComponent(request.id)}/cancel`,{method:'POST',headers:{'content-type':'application/json','Idempotency-Key':window.crypto.randomUUID()},body:JSON.stringify({})});
			const result=await response.json();if(!response.ok)throw new Error(result.error||'Unable to cancel withdrawal.');
			setMessage('Withdrawal request cancelled. The reservation was released; no payout or ledger debit occurred.');
			await load();
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to cancel withdrawal.')}
		finally{setSubmitting(false)}
	}

	return <><Nav/><main className="account-page wallet-premium-page" data-wallet-view={workflow?'workflow':'overview'}>
		<header className="wallet-page-heading"><div><span className="wallet-eyebrow">{data.accountMode} ACCOUNT · PRIVATE WALLET</span><h1>{workflow?`${type==='DEPOSIT'?'Deposit':'Withdraw'} funds`:'Wallet'}</h1><p>{data.accountMode==='DEMO'?'A separate virtual USD wallet for practice activity.':'Your Aurevia REAL account ledger, requests and reservations.'}</p></div><div className="wallet-heading-actions"><span className={`status-pill ${data.accountMode==='DEMO'?'mode-demo':'mode-real'}`}>{data.accountMode==='DEMO'?'DEMO · VIRTUAL':'REAL · LEDGER'}</span><button type="button" className="wallet-refresh" aria-label="Refresh wallet" title="Refresh wallet" onClick={()=>void load(true)} disabled={loading}><RefreshCw size={16}/></button></div></header>
		{!workflow&&<>
			{error&&<p className="wallet-feedback is-error" role="alert">{error}</p>}
			<section className="wallet-balance-panel wallet-signature-card">
				<div className="wallet-signature-brand">
					<span className="wallet-brand-mark" aria-hidden="true">A</span>
					<span className="wallet-brand-copy"><strong>AUREVIA</strong><small>INVEST</small></span>
					<span className="wallet-secure-label"><ShieldCheck size={14} aria-hidden="true"/> ACCOUNT WALLET</span>
				</div>
				<div className="wallet-card-art" aria-hidden="true">
					<div className="wallet-art-plate wallet-art-plate-back"><span/></div>
					<div className="wallet-art-plate wallet-art-plate-front"><span className="wallet-art-chip"/><span className="wallet-art-mark">A</span><i/><i/></div>
					<div className="wallet-art-pocket"><span>AUREVIA · INVEST</span></div>
				</div>
				<div className="wallet-balance-heading"><span className="wallet-eyebrow">{data.accountMode==='DEMO'?'VIRTUAL USD BALANCE':'AUREVIA USD LEDGER'}</span><button type="button" className="wallet-balance-toggle" aria-label={balanceVisible?'Hide balance':'Show balance'} aria-pressed={!balanceVisible} onClick={()=>setBalanceVisible(value=>!value)}>{balanceVisible?<EyeOff size={16}/>:<Eye size={16}/>}<span>{balanceVisible?'Hide':'Show'}</span></button></div>
				<div className="wallet-balance-caption">Available balance</div>
				<div className="wallet-balance-value" aria-live="polite">{loading?translate('loading'):!hasWalletData||availableBalance===null?'Unavailable':balanceVisible?money(availableBalance,'USD'):'•••••• USD'}</div>
				<div className="wallet-balance-foot"><span>{data.accountMode==='DEMO'?'Practice account · no real funds':'Available after pending withdrawal reservations'}</span><span className="wallet-currency-mark">USD</span></div>
				<div className="wallet-reservation-row"><span>Pending / reserved</span><strong>{loading||!hasWalletData?'—':balanceVisible?money(pendingWithdrawal,'USD'):'•••••• USD'}</strong><span>{hasWalletData?data.transactions.filter(item=>reserves.includes(item.status)).length:0} pending requests</span></div>
			</section>
			<AureviaExchangeId id={data.aureviaExchangeId} className="mt-4"/>
			{!hasWalletData&&<p className="wallet-feedback is-error" role="status">{loading?'Loading your authenticated wallet…':'Balance could not be retrieved. No balance is assumed.'}</p>}
			{data.accountMode==='REAL'?<nav className="wallet-quick-actions" aria-label="Wallet actions">
				<Link href="/wallet?action=DEPOSIT" className="wallet-quick-action"><span className="wallet-action-icon"><ArrowDownLeft size={19}/></span><span>Deposit</span></Link>
				<Link href="/wallet?action=WITHDRAWAL" className="wallet-quick-action"><span className="wallet-action-icon"><ArrowUpRight size={19}/></span><span>Withdraw</span></Link>
				<Link href="/wallet/transactions" className="wallet-quick-action"><span className="wallet-action-icon"><WalletCards size={19}/></span><span>Transactions</span></Link>
			</nav>:<nav className="wallet-quick-actions wallet-quick-actions-demo" aria-label="Wallet actions"><Link href="/wallet/transactions" className="wallet-quick-action"><span className="wallet-action-icon"><WalletCards size={19}/></span><span>Transactions</span></Link><Link href="/trade" className="wallet-quick-action"><span className="wallet-action-icon"><ArrowUpRight size={19}/></span><span>Practice trade</span></Link><Link href="/activity" className="wallet-quick-action"><span className="wallet-action-icon"><ArrowRight size={19}/></span><span>Activity</span></Link></nav>}
			<section className="wallet-activity-panel">
				<div className="wallet-section-heading"><div><span className="wallet-eyebrow">ACCOUNT RECORD</span><h2>Recent activity</h2></div><Link href="/wallet/transactions">View all <ArrowRight size={14}/></Link></div>
				{loading?<p className="wallet-empty" role="status">Loading recent activity…</p>:recentActivity.length?recentActivity.map(item=><Link className="wallet-activity-row" href={item.link||'/activity'} key={`${item.source}:${item.id}`}><span className={`wallet-activity-icon ${item.source==='ledger'?'is-ledger':''}`}>{item.source==='funding'?<WalletCards size={16}/>:item.source==='ledger'&&!item.action.toLowerCase().includes('debit')?<ArrowDownLeft size={16}/>:<ArrowUpRight size={16}/>}</span><span className="wallet-activity-copy"><strong>{item.action}</strong><small>{item.asset} · {new Date(item.timestamp).toLocaleDateString()} · {item.status}</small></span><span className="wallet-activity-amount">{balanceVisible?item.amount||'Details':'••••••'}<small>{item.source==='funding'?'Request':item.source==='ledger'?'Ledger':'Activity'}</small></span></Link>):<p className="wallet-empty">No recent wallet activity is recorded for this account mode.</p>}
			</section>
			{data.accountMode==='REAL'&&<details className="wallet-settings">
				<summary><span><span className="wallet-eyebrow">PREFERENCES</span><strong>Display settings</strong></span><span className="wallet-settings-current">{displayCurrency} <span aria-hidden="true">⌄</span></span></summary>
				<div className="wallet-settings-content"><label>Preferred display currency<select className="input" value={displayCurrency} onChange={event=>void updateDisplayCurrency(event.target.value)}>{SUPPORTED_CURRENCIES.map(code=><option key={code}>{code}</option>)}</select></label><div className="wallet-rate-copy" aria-live="polite">{displayCurrency==='USD'?<p>Original ledger amounts remain in USD. This preference never exchanges funds.</p>:currentDisplayRate!==null?<><p>Reference rate: 1 USD = {currentDisplayRate.toLocaleString(undefined,{maximumSignificantDigits:10})} {displayCurrency}</p>{data.balance!==null&&<p>Approximate display: {balanceVisible?new Intl.NumberFormat(undefined,{style:'currency',currency:displayCurrency}).format(Number(data.balance)*currentDisplayRate):`•••••• ${displayCurrency}`} · Ledger balance: {balanceVisible?money(Number(data.balance),'USD'):'•••••• USD'}</p>}<small>{currencyRate?.status==='INTERNAL'?'Indicative rate · ':currencyRate?.status==='STALE'?'Last known rate · may be outdated · ':''}{currencyRate?.observedAt?`Updated ${new Date(currencyRate.observedAt).toLocaleString()}`:'Rate update time unavailable'}. Display only; no ledger conversion.</small></>:<p className="wallet-rate-error">{currencyError||'A reference exchange rate is unavailable.'}</p>}{currencyError&&displayCurrency!=='USD'&&<p className="wallet-rate-error" role="alert">{currencyError}</p>}</div></div>
			</details>}
			{data.accountMode==='REAL'&&(data.transactions.length>0||data.adminLedgerReceipts.length>0||data.tradingTransactions.length>0)&&<details className="wallet-ledger-records">
				<summary>Wallet transactions and receipts <span>{data.transactions.length+data.adminLedgerReceipts.length+data.tradingTransactions.length} records</span></summary>
				{data.transactions.length>0&&<div className="wallet-receipt-list">{data.transactions.slice(0,10).map(transaction=>{
					const name=transaction.user?.name||session?.user?.name||'';
					const email=transaction.user?.email||session?.user?.email||'';
					const common={id:transaction.id,accountMode:transaction.accountMode,aureviaExchangeId:data.aureviaExchangeId,accountReference:`USER:${session?.user?.id||'account'}:${transaction.accountMode}:${transaction.currency}`,createdAt:transaction.createdAt,name,email,amount:transaction.amount,currency:transaction.currency,creditedAmount:transaction.creditedAmount??undefined,creditedCurrency:transaction.creditedCurrency,fee:transaction.feeAmount??undefined,feeTreatment:transaction.type==='DEPOSIT'&&transaction.feeAmount!==null?'DEDUCTED' as const:undefined,method:formatFundingMethodLabel(transaction.method),externalReference:transaction.type==='WITHDRAWAL'?transaction.processingReference:transaction.transactionReference,processingReference:transaction.processingReference,recipientName:transaction.withdrawalDestination?.nickname,recipientNumber:transaction.withdrawalDestination?.maskedLabel,purpose:transaction.note,simulated:transaction.type==='DEPOSIT'||transaction.accountMode==='DEMO',previousBalance:transaction.previousBalance,resultingBalance:transaction.resultingBalance,adminNote:transaction.adminNote};
					return <details key={transaction.id} className="wallet-receipt-item"><summary>{transaction.type} · {money(Number(transaction.amount),transaction.currency)} · {statuses[transaction.status]||transaction.status}</summary><div className="wallet-receipt-content"><ReceiptGenerator receipt={{...common,reference:transaction.settlementReference||transaction.id,status:receiptStatus(transaction.status),type:transaction.type,completedAt:transaction.settledAt,reviewedAt:transaction.reviewedAt,reviewedBy:transaction.reviewedBy}}/></div></details>;
				})}</div>}
				{data.tradingTransactions.length>0&&<div className="wallet-receipt-list">{data.tradingTransactions.map(transaction=><details key={transaction.id} className="wallet-receipt-item"><summary>{transaction.description} · {transaction.type==='DEBIT'?'−':'+'}{money(Number(transaction.amount),transaction.currency)}</summary><div className="wallet-receipt-content"><p>Confirmed trade fill recorded in your Aurevia wallet ledger on {new Date(transaction.createdAt).toLocaleString()}.</p><Link className="text-link" href="/orders">View order history</Link></div></details>)}</div>}
				{data.adminLedgerReceipts.length>0&&<div className="wallet-receipt-list">{data.adminLedgerReceipts.map(transaction=><details key={transaction.id} className="wallet-receipt-item"><summary>Administrator {transaction.type.toLowerCase()} · {money(Number(transaction.amount),transaction.currency)} · {new Date(transaction.createdAt).toLocaleString()}</summary><div className="wallet-receipt-content"><ReceiptGenerator receipt={{id:transaction.id,reference:transaction.reference,status:'COMPLETED',type:transaction.type==='CREDIT'?'CREDIT':'DEBIT',accountMode:data.accountMode,aureviaExchangeId:data.aureviaExchangeId,simulated:false,createdAt:transaction.createdAt,name:session?.user?.name||'',email:session?.user?.email||'',amount:transaction.amount,currency:transaction.currency,method:transaction.description}}/></div></details>)}</div>}
			</details>}
		</>}
		{workflow&&<Link className="wallet-back-link" href="/wallet"><ArrowRight size={15}/> Back to wallet overview</Link>}
		{workflow&&<>
		{data.accountMode==='REAL'&&type==='DEPOSIT'&&<div className="account-callout account-mode-notice"><span>REAL trading and deposits are available before KYC. Withdrawals require approved KYC.</span></div>}
		{realWithdrawalBlocked&&<div className="account-callout account-mode-notice"><span>{profile?.accountRestricted?translate('accountRestrictedNotice'):translate('withdrawalDisabled')}{profile?.restrictionReason?` ${profile.restrictionReason}`:''}</span><Link className="text-link" href="/support">{translate('contactSupportAction')}</Link></div>}
		{type==='WITHDRAWAL'&&realWithdrawalKycBlocked&&!realWithdrawalBlocked&&<div className="account-callout account-mode-notice"><span>REAL withdrawals require approved KYC.</span><Link className="text-link" href="/kyc">{translate('openVerification')}</Link></div>}
		{type==='DEPOSIT'&&profile?.depositEnabled===false&&<div className="account-callout account-mode-notice" role="status"><span>Deposits are disabled for your account. Contact an administrator for assistance.</span></div>}
		{type==='WITHDRAWAL'&&profile&&!profile.withdrawalEnabled&&!realWithdrawalBlocked&&<div className="account-callout account-mode-notice" role="status"><span>Withdrawals are disabled for your account by an administrator.</span></div>}
		{type==='WITHDRAWAL'&&profile?.canWithdraw===false&&!realWithdrawalBlocked&&profile.withdrawalEnabled&&<div className="account-callout account-mode-notice" role="status"><span>Withdrawals are available only after the first completed investment trade.</span></div>}
		{type==='WITHDRAWAL'&&data.accountMode==='REAL'&&<div className="account-callout account-mode-notice" role="status"><span>Withdrawal requests are checked against your REAL available ledger balance, including pending reservations. Approval reserves the amount; the internal ledger is debited once only after an administrator records the actual external processing outcome.</span></div>}
		{data.accountMode==='REAL'&&((type==='DEPOSIT'&&!realFundingAvailable&&!manualDepositReviewAvailable)||(type==='WITHDRAWAL'&&!realWithdrawalAvailable))&&<div className="account-callout account-mode-notice" role="status"><span>{fundingUnavailableMessage(fundingStatus)}</span></div>}
		{data.accountMode==='REAL'&&profileLoadError&&<div className="account-callout account-mode-notice" role="status"><span>{profileLoadError} REAL funding requests remain disabled until this status can be verified.</span></div>}
		<section className="wallet-balance-panel">
			<div className="wallet-balance-heading"><div className="account-kicker">{translate('availableBalances',{mode:data.accountMode.toLowerCase()})}</div><button type="button" className="wallet-balance-toggle" aria-label={balanceVisible?'Hide balances':'Show balances'} aria-pressed={!balanceVisible} onClick={()=>setBalanceVisible(value=>!value)}>{balanceVisible?<EyeOff size={16}/>:<Eye size={16}/>}<span>{balanceVisible?'Hide':'Show'}</span></button></div>
			<div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-4">
				<div className="text-xs uppercase tracking-[0.18em] text-emerald-200/80">{data.accountMode==='DEMO'?'Internal virtual DEMO balance':'Aurevia REAL available ledger balance'}</div>
				<div className="wallet-balance-value mt-2 text-3xl font-semibold text-white">{loading?translate('loading'):!hasWalletData||data.balance===null?'Unavailable':balanceVisible?money(Number(data.balance),'USD'):'•••••• USD'}</div>
				<div className="mt-1 text-sm text-slate-300">USD account balance and pending review totals</div>
				{data.accountMode==='REAL'&&<div className="mt-3 border-t border-white/10 pt-3 text-sm text-slate-300">Available for withdrawal after pending reservations: <b className="text-white">{loading||!hasWalletData||data.withdrawableBalance===null||data.withdrawableBalance===undefined?'Unavailable':balanceVisible?money(Number(data.withdrawableBalance),'USD'):'•••••• USD'}</b><p className="mt-1 text-xs muted">Approval reserves the amount. The ledger debit is posted once only after an administrator records the actual external processing outcome.</p></div>}
			</div>
			<p className="wallet-demo-note">{hasWalletData?translate('walletDemoNote'):'Balance could not be retrieved. No balance is assumed.'}</p>
			<div className="wallet-currency-list">{data.balances.filter(item=>item.currency!=='BTC').map(item=><span key={item.currency}>{balanceVisible?money(Number(item.balance),item.currency):`${item.currency} ••••••`}</span>)}</div>
			<div className="mt-4 grid gap-2 border-t border-white/10 pt-4 sm:grid-cols-[minmax(170px,220px)_1fr] sm:items-end">
				<label className="block text-xs muted">Preferred display currency<select className="input mt-1 min-h-11" value={displayCurrency} onChange={event=>void updateDisplayCurrency(event.target.value)}>{['USD','EUR','GBP','NGN','CAD','AUD','CHF','JPY'].map(code=><option key={code}>{code}</option>)}</select></label>
				<div className="text-sm" aria-live="polite">
					{displayCurrency==='USD'?<p>Original ledger amounts shown in their account currencies. Changing this preference never exchanges funds.</p>:currentDisplayRate!==null?<><p>Exchange rate: 1 USD = {currentDisplayRate.toLocaleString(undefined,{maximumSignificantDigits:10})} {displayCurrency}</p>{data.balance!==null&&<p>Approximate display: {balanceVisible?new Intl.NumberFormat(undefined,{style:'currency',currency:displayCurrency}).format(Number(data.balance)*currentDisplayRate):`•••••• ${displayCurrency}`} · Original ledger balance: {balanceVisible?money(Number(data.balance),'USD'):'•••••• USD'}</p>}<p className="mt-1 text-xs muted">{currencyRate?.status==='INTERNAL'?'Internal reference rate · ':currencyRate?.status==='STALE'?'Last known rate · may be outdated · ':''}Rate source: {currencyRate?.source} · {currencyRate?.observedAt?`Updated ${new Date(currencyRate.observedAt).toLocaleString()}`:'no provider timestamp'}. Display only; no ledger conversion.</p></>:<p className="text-xs text-amber-200">{currencyError||'A reference exchange rate is unavailable.'}</p>}
					{currencyError&&displayCurrency!=='USD'&&<p className="mt-1 text-xs text-loss" role="alert">{currencyError}</p>}
				</div>
			</div>
		</section>
		{error&&<p className="mt-3 text-sm text-loss" role="alert">{error}</p>}
		{message&&<p className="mt-3 text-sm text-profit" role="status">{message}</p>}
		<div className="account-metrics mt-3"><div className="account-metric"><span>{translate('pendingReview')}</span><b>{hasWalletData?data.transactions.filter(item=>reserves.includes(item.status)).length:'—'}</b><small>{translate('noLedgerPosting')}</small></div><div className="account-metric"><span>{translate('withdrawalReservations')}</span><b>{hasWalletData?availableBalance===null?'Unavailable':money(pendingWithdrawal,currency):'—'}</b><small>{translate('requestsAwaitingReview',{currency})}</small></div><div className="account-metric"><span>{translate('enabledPaymentMethods')}</span><b>{methodLoadError?'—':methods.length}</b><small>{translate('configuredByAdministrator')}</small></div><div className="account-metric"><span>{translate('recentRequests')}</span><b>{hasWalletData?data.transactions.length:'—'}</b><small>{translate('latest100')}</small></div></div>
				{submittedReceipt&&<section className="account-panel card mt-4 p-5"><div className="account-panel-title"><div><h2>Withdrawal request confirmation</h2><p className="account-panel-subtitle">This receipt confirms the request only. It is not proof of payment.</p></div></div><ReceiptGenerator receipt={{...submittedReceipt,id:submittedReceipt.id,reference:submittedReceipt.id,status:receiptStatus(submittedReceipt.status),type:submittedReceipt.type,accountMode:submittedReceipt.accountMode,aureviaExchangeId:data.aureviaExchangeId,simulated:submittedReceipt.type==='DEPOSIT'||submittedReceipt.accountMode==='DEMO',createdAt:submittedReceipt.createdAt,reviewedAt:submittedReceipt.reviewedAt,completedAt:submittedReceipt.settledAt,adminNote:submittedReceipt.adminNote,name:session?.user?.name||'',email:session?.user?.email||'',amount:submittedReceipt.amount,currency:submittedReceipt.currency,fee:submittedReceipt.feeAmount??undefined,feeTreatment:submittedReceipt.feeAmount!==undefined&&submittedReceipt.feeAmount!==null?'DEDUCTED':undefined,creditedAmount:submittedReceipt.creditedAmount??undefined,creditedCurrency:submittedReceipt.creditedCurrency,method:submittedReceipt.method,accountReference:`USER:${session?.user?.id||'account'}:${submittedReceipt.accountMode}:${submittedReceipt.currency}`,externalReference:submittedReceipt.type==='WITHDRAWAL'?submittedReceipt.processingReference:submittedReceipt.transactionReference,processingReference:submittedReceipt.processingReference,recipientName:submittedReceipt.withdrawalDestination?.nickname,recipientNumber:submittedReceipt.withdrawalDestination?.maskedLabel,purpose:submittedReceipt.note}}/></section>}
		{data.transactions.length>0&&<section className="account-panel card mt-4 p-5"><div className="account-panel-title"><div><h2>Funding receipts</h2><p className="account-panel-subtitle">Download request and approval receipts for deposits and withdrawals recorded in this account.</p></div></div><div className="mt-4 grid gap-3">{data.transactions.slice(0,10).map(transaction=>{
			const name=transaction.user?.name||session?.user?.name||'';
			const email=transaction.user?.email||session?.user?.email||'';
			const common={...transaction,id:transaction.id,accountMode:transaction.accountMode,aureviaExchangeId:data.aureviaExchangeId,accountReference:`USER:${session?.user?.id||'account'}:${transaction.accountMode}:${transaction.currency}`,createdAt:transaction.createdAt,name,email,amount:transaction.amount,currency:transaction.currency,creditedAmount:transaction.creditedAmount??undefined,creditedCurrency:transaction.creditedCurrency,fee:transaction.feeAmount??undefined,feeTreatment:transaction.type==='DEPOSIT'&&transaction.feeAmount!==null?'DEDUCTED' as const:undefined,method:formatFundingMethodLabel(transaction.method),externalReference:transaction.type==='WITHDRAWAL'?transaction.processingReference:transaction.transactionReference,processingReference:transaction.processingReference,recipientName:transaction.withdrawalDestination?.nickname,recipientNumber:transaction.withdrawalDestination?.maskedLabel,purpose:transaction.note,simulated:transaction.type==='DEPOSIT'||transaction.accountMode==='DEMO',previousBalance:transaction.previousBalance,resultingBalance:transaction.resultingBalance,adminNote:transaction.adminNote};
			return <details key={transaction.id} className="border-t border-white/10 pt-3"><summary className="min-h-11 cursor-pointer py-2 text-sm">{transaction.accountMode} {transaction.withdrawalDestination?`${transaction.method} · ${transaction.withdrawalDestination.maskedLabel}`:`internal ${transaction.type.toLowerCase()} request`} · {money(Number(transaction.amount),transaction.currency)} · {statuses[transaction.status]||transaction.status}</summary><div className="grid min-w-0 gap-4 pt-3 xl:grid-cols-2"><ReceiptGenerator receipt={{...common,reference:transaction.settlementReference||transaction.id,status:receiptStatus(transaction.status),type:transaction.type,completedAt:transaction.settledAt,reviewedAt:transaction.reviewedAt,reviewedBy:transaction.reviewedBy}}/></div></details>;
		})}</div></section>}
		{data.adminLedgerReceipts.length>0&&<section className="account-panel card mt-4 p-5"><div className="account-panel-title"><div><h2>Administrator ledger receipts</h2><p className="account-panel-subtitle">Administrator credits are recorded in this account’s ledger and included in the account balance.</p></div></div><div className="mt-4 grid gap-3">{data.adminLedgerReceipts.map(transaction=><details key={transaction.id} className="border-t border-white/10 pt-3"><summary className="min-h-11 cursor-pointer py-2 text-sm">{transaction.type==='CREDIT'?'Administrator credit':'Administrator debit'} · {money(Number(transaction.amount),transaction.currency)} · {new Date(transaction.createdAt).toLocaleString()}</summary><div className="pt-3"><ReceiptGenerator receipt={{id:transaction.id,reference:transaction.reference,status:'COMPLETED',type:transaction.type==='CREDIT'?'CREDIT':'DEBIT',accountMode:data.accountMode,aureviaExchangeId:data.aureviaExchangeId,simulated:data.accountMode==='REAL',createdAt:transaction.createdAt,name:session?.user?.name||'',email:session?.user?.email||'',amount:transaction.amount,currency:transaction.currency,method:transaction.description}}/></div></details>)}</div></section>}
		<div className="account-content-grid">
			<section className="account-panel card p-5"><div className="account-panel-title"><div><h2>{translate('fundingRequest')}</h2><p className="account-panel-subtitle">{translate('fundingRequestSubtitle')}</p></div><WalletCards size={18} className="gold" aria-hidden="true"/></div>
				{data.accountMode==='DEMO'?<div className="account-callout account-mode-notice mt-4" role="status">Deposits and withdrawals are available in REAL Mode only.</div>:<>
				<div className="account-callout account-mode-notice mt-4" role="status"><span><strong>{type==='DEPOSIT'?'Internal REAL ledger credit request':'REAL withdrawal request'}</strong><br/>{type==='DEPOSIT'?'This records a request in Aurevia’s ledger; no external payment is processed.':'Withdrawals stay reserved during review. Approval does not initiate or confirm payment; the ledger is debited only after an administrator records the processing reference.'} References and attachments are user-submitted and unverified.</span></div>
				<div className="wallet-type-switch" role="group" aria-label={translate('fundingRequestType')}><button type="button" aria-pressed={type==='DEPOSIT'} onClick={()=>{setType('DEPOSIT');setConfirming(false);setTransactionReference('');setSenderEmail('');setSenderWalletName('');setSenderWalletAddress('');setTransactionDateTime('');setBtcAddressNotice('');setWithdrawalDestinationId('');setWithdrawalDestinationLabel('');setWithdrawalDestinationAsset(null);setWithdrawalDestinationNetwork(null);setDestinationAccurate(false)}}><ArrowDownLeft size={15}/> {translate('deposit')}</button><button type="button" aria-pressed={type==='WITHDRAWAL'} onClick={()=>{setType('WITHDRAWAL');setConfirming(false);setTransactionReference('');setSenderEmail('');setSenderWalletName('');setSenderWalletAddress('');setTransactionDateTime('');setBtcAddressNotice('')}}><ArrowUpRight size={15}/> {translate('withdrawal')}</button></div>
				{manualRealDeposit&&btcAddress&&<section className="btc-address-panel" aria-label="Optional BTC address">
					{btcAddressSkipped?<button type="button" className="btc-address-show" onClick={()=>setBtcAddressSkipped(false)}>Show optional BTC address</button>:<>
						<div className="btc-address-heading"><div><h3>BTC address <span>BITCOIN MAINNET</span></h3><p>Administrator-configured display address only. Skip it to continue with a plain internal USD request.</p></div><button type="button" className="btc-address-skip" onClick={()=>{setBtcAddressSkipped(true);setBtcAddressNotice('')}} aria-label="Skip BTC address"><X size={15}/> Skip</button></div>
						<div className="btc-address-copy-row"><input className="input" aria-label="BTC address" value={btcAddress} readOnly onFocus={event=>event.currentTarget.select()}/><button type="button" className="btn bg-white/5" onClick={()=>void copyBtcAddress()}><Copy size={14}/> Copy address</button></div>
						<p className="btc-address-disclaimer">Display only. This Bitcoin mainnet address is not connected to deposit processing or blockchain verification. Requests stay pending for administrator review; no BTC is sent or credited automatically.</p>
						{btcAddressNotice&&<p className="btc-address-feedback" role="status">{btcAddressNotice.includes('copied')?<Check size={13}/>:null}{btcAddressNotice}</p>}
					</>}
				</section>}
				{manualRealWithdrawal&&<div className="mt-4"><WithdrawalDestinationPanel selectedId={withdrawalDestinationId} onSelect={(id,label,asset,network)=>{setWithdrawalDestinationId(id);setWithdrawalDestinationLabel(label||'');setWithdrawalDestinationAsset(asset||null);setWithdrawalDestinationNetwork(network||null);setDestinationAccurate(false)}} disabled={submitting||loading}/><label className="mt-3 flex items-start gap-2 text-xs leading-5"><input type="checkbox" className="mt-1" checked={destinationAccurate} onChange={event=>setDestinationAccurate(event.target.checked)} disabled={!withdrawalDestinationId||submitting}/><span>I confirm the destination details are accurate and belong to the intended beneficiary. This is not account-ownership verification.</span></label></div>}
				<form onSubmit={submit} className="mt-4 space-y-4">
					{(selectedMethod||manualRealFunding)&&<>
						<label className="account-label">{translate('amount',{currency:'USD'})}<input className="input" type="number" min={type==='WITHDRAWAL'?MIN_REAL_WITHDRAWAL_USD:'0.01'} max={type==='WITHDRAWAL'?MAX_REAL_WITHDRAWAL_USD:100000000} step="0.01" inputMode="decimal" required value={amount} onChange={event=>setAmount(event.target.value)} placeholder="0.00"/></label>
						{type==='DEPOSIT'?<>
							{amount&&Number(amount)>0&&<div className="wallet-deposit-fee-preview" aria-live="polite"><span>Estimated credit after 10% fee</span><strong>{money(Math.max(0,Number(amount)-Math.round(Number(amount)*10)/100),'USD')}</strong><small>Gross request {money(Number(amount),'USD')} · fee {money(Math.round(Number(amount)*10)/100,'USD')} · final amounts are rounded to cents at approval.</small></div>}
							<label className="account-label">Request reference (optional)<input className="input" maxLength={180} value={transactionReference} onChange={event=>setTransactionReference(event.target.value)} placeholder="Internal reference or context"/></label>
							<label className="account-label">Optional attachment for administrator review<input className="input" type="file" accept="image/jpeg,image/png,image/webp" aria-label="Optional supporting attachment" onChange={event=>setProofFile(event.target.files?.[0]||null)}/><small className="muted">An attachment is user-submitted information only. It is not independently verified evidence of an external payment.</small></label>
						</>:<>
							{btcWithdrawalSubmissionEnabled&&<div className="grid gap-3 sm:grid-cols-2" aria-label="Bitcoin withdrawal information">
								<label className="account-label">BTC network<input className="input" value="Bitcoin mainnet (BTC)" readOnly/></label>
								<label className="account-label">Sender email (optional)<input className="input" type="email" autoComplete="email" maxLength={254} value={senderEmail} onChange={event=>setSenderEmail(event.target.value)}/></label>
								<label className="account-label">Sender wallet name / provider (optional)<input className="input" maxLength={100} value={senderWalletName} onChange={event=>setSenderWalletName(event.target.value)}/></label>
								<label className="account-label">Sender wallet address (optional)<input className="input" maxLength={90} value={senderWalletAddress} onChange={event=>setSenderWalletAddress(event.target.value)}/></label>
								<label className="account-label sm:col-span-2">Transaction hash (TXID) (optional)<input className="input" maxLength={180} value={transactionReference} onChange={event=>setTransactionReference(event.target.value)} placeholder="64-character Bitcoin transaction ID"/></label>
								<label className="account-label sm:col-span-2">Transaction date and time (optional, device local)<input className="input" type="datetime-local" value={transactionDateTime} onChange={event=>setTransactionDateTime(event.target.value)}/><small className="muted">Submitted as a UTC timestamp supplied by you; it is not independently verified.</small></label>
								<p className="text-xs leading-5 muted sm:col-span-2">These details are user-submitted and do not prove that a BTC withdrawal was sent. The saved BTC destination is used for administrator review. The administrator records the outbound transaction hash only after confirming the actual external payout.</p>
							</div>}
						</>}
						<label className="account-label">{translate('note')}<textarea className="input min-h-20" maxLength={500} value={note} onChange={event=>setNote(event.target.value)}/></label>
					</>}
					{!availableMethods.length&&!manualRealFunding&&<div className="account-empty" role="status">{methodLoadError||translate('noDepositMethods',{type:type.toLowerCase()})}</div>}
					{type==='DEPOSIT'&&<section className="account-callout account-mode-notice" aria-label="Administrator review information"><div><h3 className="font-semibold">Administrator Review</h3><p className="mt-1">Status: Pending Administrator Review. If approved, a 10% fee is deducted from the requested amount and the remaining 90% is credited to the internal USD ledger. Aurevia does not receive, process, or independently verify external funds.</p></div></section>}
					{confirming&&(selectedMethod||manualRealFunding)&&<div className="account-confirm-panel" role="alert"><h3>{translate('confirmRequest',{type:type.toLowerCase()})}</h3><p>{money(Number(amount||0),'USD')} from the REAL account. {type==='WITHDRAWAL'?`Selected destination: ${withdrawalDestinationLabel||'saved destination'}. Gross withdrawal: ${money(withdrawalAmounts.grossCents/100,'USD')}. Estimated net payout: ${money(withdrawalAmounts.netCents/100,'USD')} after the ${WITHDRAWAL_COMMISSION_PERCENT}% commission of ${money(withdrawalAmounts.feeCents/100,'USD')}. Eligible requests are ${money(MIN_REAL_WITHDRAWAL_USD,'USD')}–${money(MAX_REAL_WITHDRAWAL_USD,'USD')} and must leave ${money(REQUIRED_REAL_WITHDRAWAL_RESERVE_USD,'USD')} available after other reservations. The amount is reserved for review; the commission is recorded only after an administrator confirms the actual payout. No separate BTC payment is required.`:`If approved, the 10% fee is ${money(Math.round(Number(amount||0)*10)/100,'USD')} and the estimated net ledger credit is ${money(Math.max(0,Number(amount||0)-Math.round(Number(amount||0)*10)/100),'USD')}. This is an internal ledger request only; no external payment occurs.`} <Link className="text-link" href="/about-me">View withdrawal policy</Link></p>
						{type==='WITHDRAWAL'&&<div className="mt-3 grid max-w-xl gap-3"><p className="text-xs leading-5 muted">For your protection, verify your current password before submitting each withdrawal request.</p><label className="account-label">Current password<input className="input" type="password" autoComplete="current-password" maxLength={128} value={reauthPassword} onChange={event=>setReauthPassword(event.target.value)} required/></label></div>}
						<div className="mt-3 flex flex-wrap gap-2"><button type="button" className="btn bg-gold text-black" disabled={submitting||(type==='WITHDRAWAL'&&!reauthPassword)} onClick={()=>void confirmSubmit()}>{submitting?translate('submitRequestStatus'):translate('confirmRequestButton')}</button><button type="button" className="btn bg-white/5" disabled={submitting} onClick={()=>setConfirming(false)}>{translate('cancelRequestButton')}</button></div></div>}
					{!confirming&&<button className="btn w-full bg-gold text-black" type="submit" disabled={loading||!hasWalletData||(type==='DEPOSIT'&&(!profile?.depositEnabled||!!profileLoadError))||(type==='WITHDRAWAL'&&(realWithdrawalKycBlocked||realWithdrawalBlocked||!profile?.withdrawalEnabled||profile.accountRestricted||availableBalance===null||availableBalance<=0))}>{type==='DEPOSIT'?'Submit internal credit request':'Submit internal withdrawal request'}</button>}
				</form>
				</>}
			</section>
			<section className="account-panel card p-5"><div className="account-panel-title"><div><h2>{translate('transactionHistory')}</h2><p className="account-panel-subtitle">{translate('transactionHistorySubtitle')}</p></div><div className="flex items-center gap-2"><Link className="text-link" href="/wallet/transactions">{translate('fullHistory')}</Link><button type="button" className="icon-action" aria-label={translate('refreshWalletHistory')} onClick={()=>void load(true)}><RefreshCw size={15}/></button></div></div>
				{data.accountMode==='REAL'&&data.tradingTransactions.length>0&&<p className="mb-4 text-xs leading-5 muted">Confirmed provider fills are recorded in this Aurevia wallet and linked order history.</p>}
				{loading?<div className="account-empty" role="status">{translate('loadingWallet')}</div>:!hasWalletData?<div className="account-empty transaction-history-error" role="status">Transaction history is unavailable until wallet data can be loaded.</div>:data.transactions.length||data.tradingTransactions.length?<div className="account-table-wrap"><table className="account-table"><thead><tr><th>{translate('request')}</th><th>{translate('amount')}</th><th>{translate('status')}</th><th>{translate('receipt')}</th></tr></thead><tbody>{data.tradingTransactions.map(transaction=><tr key={transaction.id}><td><Link className="transaction-kind" href="/orders">{transaction.type==='DEBIT'?<ArrowUpRight size={13}/>:<ArrowDownLeft size={13}/>} {transaction.description}<small className="transaction-method">Trade record · {transaction.id}</small></Link></td><td>{transaction.type==='DEBIT'?'−':'+'}{money(Number(transaction.amount),transaction.currency)}</td><td><span className="status-pill">Confirmed fill</span></td><td><Link className="text-link" href="/orders">View order</Link></td></tr>)}{data.transactions.map(transaction=><tr key={transaction.id}><td><Link className="transaction-kind" href={`/wallet/transactions/${encodeURIComponent(transaction.id)}`}>{transaction.type==='DEPOSIT'?<ArrowDownLeft size={13}/>:<ArrowUpRight size={13}/>} {transaction.type}<small className="transaction-method">{formatFundingMethodLabel(transaction.method)}{transaction.withdrawalDestination?` · ${transaction.withdrawalDestination.maskedLabel}`:''}</small><small className="transaction-method">{transaction.id}</small></Link></td><td>{money(Number(transaction.amount),transaction.currency)}{transaction.type==='DEPOSIT'&&transaction.feeAmount!==undefined&&transaction.feeAmount!==null&&<small className="transaction-method">Fee {transaction.feePercent??10}% · {money(Number(transaction.feeAmount),transaction.currency)}</small>}{transaction.type==='DEPOSIT'&&transaction.creditedAmount!==undefined&&transaction.creditedAmount!==null&&<small className="transaction-method">Net credit · {money(Number(transaction.creditedAmount),transaction.creditedCurrency||transaction.currency)}</small>}</td><td><span className="status-pill">{statuses[transaction.status]||transaction.status}</span>{transaction.type==='WITHDRAWAL'&&['PENDING','PENDING_REVIEW','APPROVED'].includes(transaction.status)&&<button type="button" className="text-link" disabled={submitting} onClick={()=>void cancelWithdrawal(transaction)}>Cancel request</button>}</td><td>{data.accountMode==='DEMO'?'Deposits and withdrawals are available in REAL Mode only.':transaction.type==='DEPOSIT'&&reserves.includes(transaction.status)?<div className="grid min-w-40 gap-1"><input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" aria-label={translate('chooseReceipt',{id:transaction.id})} onChange={event=>setReceiptFiles(current=>({...current,[transaction.id]:event.target.files?.[0]}))}/><button type="button" className="btn min-h-11 bg-white/5" disabled={!receiptFiles[transaction.id]||receiptBusy===transaction.id} onClick={()=>void uploadReceipt(transaction)}>{receiptBusy===transaction.id?translate('uploading'):translate('uploadReceipt')}</button>{transaction.hasReceipt&&<button type="button" className="text-link" onClick={()=>void openReceipt(transaction.id)}>{translate('viewPrivateReceipt')}</button>}</div>:transaction.hasReceipt?<button type="button" className="text-link" onClick={()=>void openReceipt(transaction.id)}>{translate('viewPrivateReceipt')}</button>:'Not available'}</td></tr>)}</tbody></table></div>:<div className="account-empty" role="status">No wallet transactions have been recorded yet.</div>}
			</section>
		</div>
		</>}
	</main></>;
}
