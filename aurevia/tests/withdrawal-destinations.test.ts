import {afterEach,describe,expect,it} from 'vitest';
import {decryptWithdrawalDestination,encryptWithdrawalDestination,maskedDestination,parseWithdrawalDestination} from '@/lib/withdrawal-destinations';

const originalKey=process.env.WITHDRAWAL_DESTINATION_ENCRYPTION_KEY;
const validBank={
	type:'BANK_TRANSFER',nickname:'Primary checking',countryCode:'US',bankName:'Example Bank',
	beneficiaryName:'Aurevia User',routingNumber:'021000021',accountNumber:'0000123400',accountType:'CHECKING',
};

function validDestination(){
	const parsed=parseWithdrawalDestination(validBank);
	if(!parsed.success)throw parsed.error;
	return parsed.data;
}

afterEach(()=>{
	if(originalKey===undefined)delete process.env.WITHDRAWAL_DESTINATION_ENCRYPTION_KEY;
	else process.env.WITHDRAWAL_DESTINATION_ENCRYPTION_KEY=originalKey;
});

describe('withdrawal destination validation and encryption',()=>{
	it('validates country-specific details while preserving leading zeroes',()=>{
		const parsed=parseWithdrawalDestination(validBank);
		expect(parsed.success).toBe(true);
		if(parsed.success){
			expect(parsed.data.accountNumber).toBe('0000123400');
			expect(parsed.data.routingNumber).toBe('021000021');
		}
		expect(parseWithdrawalDestination({...validBank,routingNumber:'123'}).success).toBe(false);
		expect(parseWithdrawalDestination({...validBank,accountNumber:'123'}).success).toBe(false);
	});

	it('validates UK, Nigeria and IBAN formats',()=>{
		expect(parseWithdrawalDestination({...validBank,countryCode:'GB',sortCode:'001234',accountNumber:'00001234'}).success).toBe(true);
		expect(parseWithdrawalDestination({...validBank,countryCode:'GB',sortCode:'123',accountNumber:'00001234'}).success).toBe(false);
		expect(parseWithdrawalDestination({...validBank,countryCode:'NG',bankCode:'011',accountNumber:'0000123456'}).success).toBe(true);
		expect(parseWithdrawalDestination({...validBank,countryCode:'NG',bankCode:'11',accountNumber:'0000123456'}).success).toBe(false);
		expect(parseWithdrawalDestination({...validBank,countryCode:'DE',iban:'DE89370400440532013000',bic:'DEUTDEFF'}).success).toBe(true);
		expect(parseWithdrawalDestination({...validBank,countryCode:'DE',iban:'DE00370400440532013000',bic:'DEUTDEFF'}).success).toBe(false);
	});

	it('validates cryptocurrency addresses only on supported matching mainnets',()=>{
		const bitcoin={type:'CRYPTOCURRENCY',nickname:'BTC wallet',countryCode:'US',asset:'BTC',network:'BITCOIN_MAINNET',walletAddress:'1BoatSLRHtKNngkdXEeobR76b53LETtpyT'};
		expect(parseWithdrawalDestination(bitcoin).success).toBe(true);
		const withEmail=parseWithdrawalDestination({...bitcoin,email:' Wallet@Example.com '});
		expect(withEmail.success&&withEmail.data.email).toBe('wallet@example.com');
		expect(parseWithdrawalDestination({...bitcoin,email:'not-an-email'}).success).toBe(false);
		expect(parseWithdrawalDestination({...validBank,email:'wallet@example.com'}).success).toBe(false);
		expect(parseWithdrawalDestination({...bitcoin,network:'ETHEREUM_MAINNET'}).success).toBe(false);
		expect(parseWithdrawalDestination({...bitcoin,walletAddress:'not-a-wallet'}).success).toBe(false);
		const ethereum={type:'CRYPTOCURRENCY',nickname:'ETH wallet',countryCode:'US',asset:'ETH',network:'ETHEREUM_MAINNET',walletAddress:'0x0000000000000000000000000000000000000000'};
		expect(parseWithdrawalDestination(ethereum).success).toBe(true);
	});

	it('encrypts the optional cryptocurrency destination email with the wallet details',()=>{
		process.env.WITHDRAWAL_DESTINATION_ENCRYPTION_KEY=Buffer.alloc(32,7).toString('base64');
		const parsed=parseWithdrawalDestination({
			type:'CRYPTOCURRENCY',nickname:'BTC wallet',countryCode:'US',asset:'BTC',
			network:'BITCOIN_MAINNET',walletAddress:'1BoatSLRHtKNngkdXEeobR76b53LETtpyT',
			email:'wallet@example.com',
		});
		if(!parsed.success)throw parsed.error;
		const encrypted=encryptWithdrawalDestination(parsed.data);
		expect(encrypted.ciphertext).not.toContain('wallet@example.com');
		expect(decryptWithdrawalDestination(encrypted)).toMatchObject({email:'wallet@example.com'});
	});

	it('encrypts destination data with authenticated encryption and never returns full values in the list label',()=>{
		const key=Buffer.alloc(32,7).toString('base64');
		process.env.WITHDRAWAL_DESTINATION_ENCRYPTION_KEY=key;
		const parsed=validDestination();
		const encrypted=encryptWithdrawalDestination(parsed);
		expect(encrypted.ciphertext).not.toContain('0000123400');
		expect(decryptWithdrawalDestination(encrypted)).toEqual(parsed);
		expect(maskedDestination(parsed)).toContain('3400');
		expect(maskedDestination(parsed)).not.toContain('0000123400');
		expect(()=>decryptWithdrawalDestination({...encrypted,authTag:Buffer.alloc(16).toString('base64')})).toThrow('WITHDRAWAL_DESTINATION_DECRYPTION_FAILED');
	});

	it('fails closed when the stable server encryption key is missing or malformed',()=>{
		delete process.env.WITHDRAWAL_DESTINATION_ENCRYPTION_KEY;
		expect(()=>encryptWithdrawalDestination(validDestination())).toThrow('WITHDRAWAL_DESTINATION_ENCRYPTION_KEY_REQUIRED');
		process.env.WITHDRAWAL_DESTINATION_ENCRYPTION_KEY='not-a-32-byte-key';
		expect(()=>encryptWithdrawalDestination(validDestination())).toThrow('WITHDRAWAL_DESTINATION_ENCRYPTION_KEY_REQUIRED');
	});
});
