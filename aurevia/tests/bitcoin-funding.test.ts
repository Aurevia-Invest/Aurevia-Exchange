import {Prisma} from '@prisma/client';
import {describe,expect,it} from 'vitest';
import {assertPaperBuyCollateral,normalizeBitcoinTransactionId,paperOrderCollateral,validateBitcoinDepositAmount} from '@/lib/bitcoin-funding';
import {BITCOIN_MAINNET_NETWORK,normalizeBitcoinWithdrawalSubmission} from '@/lib/bitcoin-withdrawal-submission';

describe('REAL BTC withdrawal validation',()=>{
	it('stores user-submitted BTC withdrawal metadata without treating it as payout confirmation',()=>{
		const result=normalizeBitcoinWithdrawalSubmission({network:BITCOIN_MAINNET_NETWORK,transactionReference:'A'.repeat(64),senderEmail:'sender@example.com',senderWalletName:'Example Wallet',senderWalletAddress:'1BoatSLRHtKNngkdXEeobR76b53LETtpyT',transactionDateTime:'2026-03-08T08:30:00.000Z'},'1BoatSLRHtKNngkdXEeobR76b53LETtpyT');

		expect(result).toEqual({
			network:BITCOIN_MAINNET_NETWORK,
			transactionReference:'a'.repeat(64),
			referenceInfo:'2026-03-08T08:30:00.000Z',
			senderInfo:'Sender email: sender@example.com\nSender wallet/provider: Example Wallet\nSender wallet address: 1BoatSLRHtKNngkdXEeobR76b53LETtpyT',
			destinationInfo:null,
		});
	});

	it('rejects missing network or saved BTC destination and invalid Bitcoin references',()=>{
		expect(()=>normalizeBitcoinWithdrawalSubmission({senderEmail:'sender@example.com'},'1BoatSLRHtKNngkdXEeobR76b53LETtpyT')).toThrow('BITCOIN_NETWORK_REQUIRED');
		expect(()=>normalizeBitcoinWithdrawalSubmission({network:BITCOIN_MAINNET_NETWORK},null)).toThrow('BTC_WITHDRAWAL_DESTINATION_REQUIRED');
		expect(()=>normalizeBitcoinWithdrawalSubmission({network:BITCOIN_MAINNET_NETWORK,transactionReference:'invalid'},'1BoatSLRHtKNngkdXEeobR76b53LETtpyT')).toThrow('INVALID_BTC_TXID');
		expect(()=>normalizeBitcoinWithdrawalSubmission({network:BITCOIN_MAINNET_NETWORK,senderWalletAddress:'not-an-address'},'1BoatSLRHtKNngkdXEeobR76b53LETtpyT')).toThrow('INVALID_BTC_SENDER_ADDRESS');
	});

	it('normalizes only 64-character hexadecimal transaction IDs',()=>{
		expect(normalizeBitcoinTransactionId(`  ${'A'.repeat(64)} `)).toBe('a'.repeat(64));
		expect(normalizeBitcoinTransactionId('a'.repeat(63))).toBeNull();
		expect(normalizeBitcoinTransactionId('g'.repeat(64))).toBeNull();
	});

	it('accepts positive BTC values to eight decimals and rejects invalid precision or range',()=>{
		expect(validateBitcoinDepositAmount('0.00000001').toFixed(8)).toBe('0.00000001');
		expect(()=>validateBitcoinDepositAmount('0')).toThrow('INVALID_BTC_AMOUNT');
		expect(()=>validateBitcoinDepositAmount('0.000000001')).toThrow('INVALID_BTC_AMOUNT');
		expect(()=>validateBitcoinDepositAmount('100000001')).toThrow('INVALID_BTC_AMOUNT');
	});
});

describe('REAL wallet paper-buy collateral',()=>{
	it('reserves remaining open-buy cost without reserving wallet-debited position cost',()=>{
		const createdAt=new Date('2026-01-01T00:00:00Z');
		const takerFee=new Prisma.Decimal('0.01');
		const result=paperOrderCollateral([
			{instrumentId:'AAPL',side:'BUY',quantity:new Prisma.Decimal(2),filledQuantity:new Prisma.Decimal(2),averageFillPrice:new Prisma.Decimal(100),providerReservedAmount:null,status:'FILLED',createdAt,takerFee},
			{instrumentId:'AAPL',side:'SELL',quantity:new Prisma.Decimal(1),filledQuantity:new Prisma.Decimal(1),averageFillPrice:new Prisma.Decimal(120),providerReservedAmount:null,status:'FILLED',createdAt:new Date(createdAt.getTime()+1000),takerFee},
			{instrumentId:'MSFT',side:'BUY',quantity:new Prisma.Decimal(2),filledQuantity:new Prisma.Decimal(1),averageFillPrice:new Prisma.Decimal(50),providerReservedAmount:new Prisma.Decimal(101),status:'PARTIALLY_FILLED',createdAt:new Date(createdAt.getTime()+2000),takerFee},
		]);
		expect(result.heldCostBasis.toFixed(2)).toBe('151.50');
		expect(result.reservedBuys.toFixed(2)).toBe('50.50');
		expect(result.committed.toFixed(2)).toBe('50.50');
	});

	it('rejects buys that exceed the internal wallet after withdrawals and prior paper reservations',()=>{
		expect(()=>assertPaperBuyCollateral(new Prisma.Decimal(500),new Prisma.Decimal(100),new Prisma.Decimal(200),new Prisma.Decimal(201))).toThrow('INSUFFICIENT_REAL_WALLET_COLLATERAL');
		expect(()=>assertPaperBuyCollateral(new Prisma.Decimal(501),new Prisma.Decimal(100),new Prisma.Decimal(200),new Prisma.Decimal(201))).not.toThrow();
	});
});
