import {AccountMode,FundingStatus,FundingType,Prisma} from '@prisma/client';
import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	requireUser:vi.fn(),userFindUnique:vi.fn(),destinationFindFirst:vi.fn(),transaction:vi.fn(),
	ensureUserLedger:vi.fn(),balance:vi.fn(),roundUsdAmount:vi.fn(),getRealWithdrawableBalance:vi.fn(),
	validateWithdrawal:vi.fn(),decryptWithdrawalDestination:vi.fn(),createNotification:vi.fn(),
	notifyActiveAdmins:vi.fn(),sendSupportEmail:vi.fn(),rateLimit:vi.fn(),
}));

vi.mock('@/lib/auth',()=>({requireUser:mocks.requireUser}));
vi.mock('@/lib/db',()=>({db:{
	user:{findUnique:mocks.userFindUnique},
	withdrawalDestination:{findFirst:mocks.destinationFindFirst},
	$transaction:mocks.transaction,
}}));
vi.mock('@/lib/ledger',()=>({balance:mocks.balance,ensureUserLedger:mocks.ensureUserLedger,roundUsdAmount:mocks.roundUsdAmount}));
vi.mock('@/lib/notifications',()=>({createNotification:mocks.createNotification,notifyActiveAdmins:mocks.notifyActiveAdmins}));
vi.mock('@/lib/email',()=>({
	emailDeliveryStatus:(delivery:{sent:boolean;reason?:string})=>delivery.sent?'sent':delivery.reason==='not-configured'?'not-configured':'failed',
	sendSupportEmail:mocks.sendSupportEmail,
}));
vi.mock('@/lib/production-policy',()=>({validateWithdrawal:mocks.validateWithdrawal}));
vi.mock('@/lib/funding-evidence',()=>({FundingEvidenceError:class extends Error{},maxFundingEvidenceBytes:5_000_000,validateFundingEvidence:vi.fn()}));
vi.mock('@/lib/private-storage',()=>({createPrivateObjectKey:vi.fn(),deletePrivateObject:vi.fn(),PrivateStorageError:class extends Error{},uploadPrivateObject:vi.fn()}));
vi.mock('@/lib/real-withdrawals',()=>({getRealWithdrawableBalance:mocks.getRealWithdrawableBalance}));
vi.mock('@/lib/withdrawal-destinations',()=>({decryptWithdrawalDestination:mocks.decryptWithdrawalDestination}));
vi.mock('@/lib/rate-limit',()=>({rateLimit:mocks.rateLimit}));
vi.mock('@/lib/serializers',()=>({jsonSafe:(value:unknown)=>value}));

import {POST} from '@/app/api/wallet/route';

const destination={
	id:'destination-1',userId:'user-1',accountMode:AccountMode.REAL,type:'BANK_TRANSFER',nickname:'Primary checking',
	countryCode:'US',network:null,asset:null,maskedLabel:'Example Bank · account ending 3400',
	ciphertext:'opaque-ciphertext',iv:'opaque-iv',authTag:'opaque-auth-tag',
};
const bitcoinDestination={
	id:'bitcoin-destination-1',userId:'user-1',accountMode:AccountMode.REAL,type:'CRYPTOCURRENCY',nickname:'BTC wallet',
	countryCode:'US',network:'BITCOIN_MAINNET',asset:'BTC',maskedLabel:'BTC wallet · ending tpyT',
	ciphertext:'opaque-btc-ciphertext',iv:'opaque-btc-iv',authTag:'opaque-btc-auth-tag',
};
const key='dc34ab2c-2049-49bd-8a2c-6a88935552de';
let tx:Record<string,Record<string,ReturnType<typeof vi.fn>>>;
let storedRequest:Record<string,unknown>|null;

function request(idempotencyKey=key){
	return new Request('https://aurevia.test/api/wallet',{
		method:'POST',
		headers:{'content-type':'application/json','Idempotency-Key':idempotencyKey},
		body:JSON.stringify({type:FundingType.WITHDRAWAL,amount:30000,currency:'USD',withdrawalDestinationId:destination.id,destinationConfirmed:true}),
	});
}

function bitcoinWithdrawalRequest(network='BITCOIN_MAINNET'){
	return new Request('https://aurevia.test/api/wallet',{
		method:'POST',
		headers:{'content-type':'application/json','Idempotency-Key':'btc-withdrawal-request'},
		body:JSON.stringify({type:FundingType.WITHDRAWAL,amount:30000,currency:'USD',transactionReference:'A'.repeat(64),network,senderEmail:'sender@example.com',senderWalletName:'Example wallet',senderWalletAddress:'1BoatSLRHtKNngkdXEeobR76b53LETtpyT',transactionDateTime:'2026-03-08T08:30:00.000Z',withdrawalDestinationId:bitcoinDestination.id,destinationConfirmed:true}),
	});
}

beforeEach(()=>{
	vi.clearAllMocks();
	storedRequest=null;
	mocks.requireUser.mockResolvedValue({id:'user-1',sessionHash:'a'.repeat(64)});
	mocks.userFindUnique.mockResolvedValue({accountMode:AccountMode.REAL,status:'ACTIVE',depositEnabled:true,withdrawalEnabled:true,accountRestricted:false});
	mocks.destinationFindFirst.mockResolvedValue(destination);
	mocks.ensureUserLedger.mockResolvedValue({id:'user-ledger'});
	mocks.balance.mockResolvedValue(new Prisma.Decimal('100000'));
	mocks.roundUsdAmount.mockImplementation((value:number|string)=>new Prisma.Decimal(value));
	mocks.getRealWithdrawableBalance.mockResolvedValue(new Prisma.Decimal('100000'));
	mocks.validateWithdrawal.mockReturnValue(undefined);
	mocks.decryptWithdrawalDestination.mockReturnValue({type:'BANK_TRANSFER',nickname:'Primary checking'});
	mocks.createNotification.mockResolvedValue(undefined);
	mocks.notifyActiveAdmins.mockResolvedValue(undefined);
	mocks.sendSupportEmail.mockResolvedValue({sent:false,reason:'not-configured'});
	tx={
		user:{
			findUnique:vi.fn().mockResolvedValue({accountMode:AccountMode.REAL,status:'ACTIVE'}),
			findUniqueOrThrow:vi.fn().mockResolvedValue({kycStatus:'APPROVED',depositEnabled:true,withdrawalEnabled:true,accountRestricted:false,kyc:{submittedAt:new Date()},kycDocuments:[{id:'approved-id'}]}),
		},
		fundingRequest:{
			findUnique:vi.fn(async()=>null),
			aggregate:vi.fn().mockResolvedValue({_sum:{amount:new Prisma.Decimal(0)}}),
			create:vi.fn(async({data}:{data:Record<string,unknown>})=>{
				storedRequest={id:'withdrawal-1',...data,status:FundingStatus.PENDING_REVIEW,createdAt:new Date(),updatedAt:new Date()};
				return storedRequest;
			}),
		},
		withdrawalDestinationSnapshot:{create:vi.fn().mockResolvedValue({})},
		securitySession:{updateMany:vi.fn().mockResolvedValue({count:1})},
		auditLog:{create:vi.fn().mockResolvedValue({})},
	};
	mocks.transaction.mockImplementation(async(callback:(value:unknown)=>Promise<unknown>)=>callback(tx));
});

describe('wallet withdrawal destination snapshot',()=>{
	it('rejects a withdrawal when no fresh authentication marker exists',async()=>{
		tx.securitySession.updateMany.mockResolvedValueOnce({count:0});
		const response=await POST(request('missing-fresh-authentication'));

		expect(response.status).toBe(428);
		expect(tx.fundingRequest.create).not.toHaveBeenCalled();
	});

	it('rate-limits REAL deposit requests before starting database work',async()=>{
		mocks.rateLimit.mockImplementationOnce(()=>{throw new Error('RATE_LIMITED')});
		const response=await POST(new Request('https://aurevia.test/api/wallet',{
			method:'POST',
			headers:{'content-type':'application/json','Idempotency-Key':'deposit-rate-limited'},
			body:JSON.stringify({type:FundingType.DEPOSIT,amount:100,currency:'USD'}),
		}));

		expect(response.status).toBe(429);
		expect((await response.json()).error).toContain('Too many funding requests');
		expect(mocks.rateLimit).toHaveBeenCalledWith('real-deposit:user-1',20,60*60_000);
		expect(mocks.transaction).not.toHaveBeenCalled();
	});

	it('stores encrypted immutable destination details alongside the request without returning secrets',async()=>{
		const response=await POST(request());
		const body=await response.json();
		expect(response.status).toBe(201);
		expect(tx.withdrawalDestinationSnapshot.create).toHaveBeenCalledWith({data:expect.objectContaining({
			fundingRequestId:'withdrawal-1',type:'BANK_TRANSFER',nickname:'Primary checking',countryCode:'US',
			maskedLabel:destination.maskedLabel,ciphertext:destination.ciphertext,iv:destination.iv,authTag:destination.authTag,
		})});
		expect(body.withdrawalDestination).toMatchObject({maskedLabel:destination.maskedLabel});
		expect(JSON.stringify(body)).not.toContain(destination.ciphertext);
		expect(JSON.stringify(body)).not.toContain('0000123400');
	});

	it('returns an idempotent replay without creating a second request or destination snapshot',async()=>{
		const existing={id:'withdrawal-1',userId:'user-1',accountMode:AccountMode.REAL,type:FundingType.WITHDRAWAL,amount:new Prisma.Decimal(30000),currency:'USD',paymentMethodId:null,transactionReference:null,withdrawalDestinationId:destination.id,receiptKey:null};
		tx.fundingRequest.findUnique.mockResolvedValue(existing);
		const response=await POST(request());
		expect(response.status).toBe(200);
		expect((await response.json()).id).toBe(existing.id);
		expect(tx.fundingRequest.create).not.toHaveBeenCalled();
		expect(tx.withdrawalDestinationSnapshot.create).not.toHaveBeenCalled();
	});

	it('stores user-submitted BTC withdrawal metadata as a pending request without payout confirmation',async()=>{
		mocks.destinationFindFirst.mockResolvedValue(bitcoinDestination);
		mocks.decryptWithdrawalDestination.mockReturnValue({type:'CRYPTOCURRENCY',asset:'BTC',network:'BITCOIN_MAINNET',walletAddress:'1BoatSLRHtKNngkdXEeobR76b53LETtpyT'});
		const response=await POST(bitcoinWithdrawalRequest());
		const body=await response.json();

		expect(response.status).toBe(201);
		expect(body.status).toBe(FundingStatus.PENDING_REVIEW);
		expect((storedRequest?.feeAmount as Prisma.Decimal).toString()).toBe('3000');
		expect((storedRequest?.feePercent as Prisma.Decimal).toString()).toBe('10');
		expect((storedRequest?.creditedAmount as Prisma.Decimal).toString()).toBe('27000');
		expect(storedRequest?.creditedCurrency).toBe('USD');
		expect(storedRequest).toMatchObject({
			transactionReference:'a'.repeat(64),
			network:'BITCOIN_MAINNET',
			referenceInfo:'2026-03-08T08:30:00.000Z',
			senderInfo:'Sender email: sender@example.com\nSender wallet/provider: Example wallet\nSender wallet address: 1BoatSLRHtKNngkdXEeobR76b53LETtpyT',
			destinationInfo:null,
		});
		expect(body.withdrawalDestination).toMatchObject({type:'CRYPTOCURRENCY',asset:'BTC',network:'BITCOIN_MAINNET'});
		expect(tx.fundingRequest.create).toHaveBeenCalledTimes(1);
	});

	it('rejects BTC withdrawal details on a network other than mainnet',async()=>{
		mocks.destinationFindFirst.mockResolvedValue(bitcoinDestination);
		mocks.decryptWithdrawalDestination.mockReturnValue({type:'CRYPTOCURRENCY',asset:'BTC',network:'BITCOIN_MAINNET',walletAddress:'1BoatSLRHtKNngkdXEeobR76b53LETtpyT'});
		const response=await POST(bitcoinWithdrawalRequest('BITCOIN_TESTNET'));

		expect(response.status).toBe(400);
		expect(tx.fundingRequest.create).not.toHaveBeenCalled();
	});

	it('rejects BTC metadata when the selected withdrawal destination is not cryptocurrency',async()=>{
		mocks.decryptWithdrawalDestination.mockReturnValue({type:'BANK_TRANSFER',nickname:'Primary checking'});

		const response=await POST(bitcoinWithdrawalRequest());

		expect(response.status).toBe(400);
		expect(tx.fundingRequest.create).not.toHaveBeenCalled();
	});

	it('rejects Bitcoin withdrawal metadata on deposits',async()=>{
		const response=await POST(new Request('https://aurevia.test/api/wallet',{
			method:'POST',
			headers:{'content-type':'application/json','Idempotency-Key':'btc-deposit-rejected'},
			body:JSON.stringify({type:FundingType.DEPOSIT,amount:20,currency:'USD',network:'BITCOIN_MAINNET',senderEmail:'sender@example.com'}),
		}));

		expect(response.status).toBe(400);
		expect(tx.fundingRequest.create).not.toHaveBeenCalled();
	});

	it('rejects a withdrawal below the configured $30,000 minimum',async()=>{
		const response=await POST(new Request('https://aurevia.test/api/wallet',{
			method:'POST',
			headers:{'content-type':'application/json','Idempotency-Key':'small-withdrawal-rejected'},
			body:JSON.stringify({type:FundingType.WITHDRAWAL,amount:29999.99,currency:'USD',withdrawalDestinationId:destination.id,destinationConfirmed:true}),
		}));

		expect(response.status).toBe(400);
		expect((await response.json()).error).toContain('$30,000');
		expect(tx.fundingRequest.create).not.toHaveBeenCalled();
	});

	it('rejects a withdrawal above the configured $300,000 maximum',async()=>{
		const response=await POST(new Request('https://aurevia.test/api/wallet',{
			method:'POST',
			headers:{'content-type':'application/json','Idempotency-Key':'large-withdrawal-rejected'},
			body:JSON.stringify({type:FundingType.WITHDRAWAL,amount:300000.01,currency:'USD',withdrawalDestinationId:destination.id,destinationConfirmed:true}),
		}));

		expect(response.status).toBe(400);
		expect((await response.json()).error).toContain('$300,000');
		expect(tx.fundingRequest.create).not.toHaveBeenCalled();
	});

	it('requires the full withdrawal amount plus a $300 remaining balance',async()=>{
		mocks.getRealWithdrawableBalance.mockResolvedValue(new Prisma.Decimal('30299.99'));
		const response=await POST(request('reserve-not-met'));

		expect(response.status).toBe(409);
		expect((await response.json()).error).toContain('$300');
		expect(tx.fundingRequest.create).not.toHaveBeenCalled();
	});
});
