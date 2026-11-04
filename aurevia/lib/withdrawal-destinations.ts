import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {address,networks} from 'bitcoinjs-lib';
import {isAddress} from 'ethers';
import {z} from 'zod';
import {ibanCountryCodes,supportedCountries} from '@/lib/countries';
const countryCodes=new Set<string>(supportedCountries.map(country=>country.code));

const destinationSchema=z.object({
	type:z.enum(['BANK_TRANSFER','CRYPTOCURRENCY']),
	nickname:z.string().trim().min(1).max(80),
	countryCode:z.string().length(2).transform(value=>value.toUpperCase()),
	bankName:z.string().trim().max(120).optional(),
	bankIdentifier:z.string().trim().max(40).optional(),
	beneficiaryName:z.string().trim().max(120).optional(),
	accountNumber:z.string().trim().max(34).optional(),
	accountType:z.enum(['CHECKING','SAVINGS','BUSINESS']).optional(),
	routingNumber:z.string().trim().max(20).optional(),
	sortCode:z.string().trim().max(20).optional(),
	bankCode:z.string().trim().max(20).optional(),
	iban:z.string().trim().max(40).optional(),
	bic:z.string().trim().max(20).optional(),
	bankAddress:z.string().trim().max(240).optional(),
	beneficiaryAddress:z.string().trim().max(240).optional(),
	asset:z.enum(['BTC','ETH']).optional(),
	network:z.enum(['BITCOIN_MAINNET','ETHEREUM_MAINNET']).optional(),
	walletAddress:z.string().trim().max(160).optional(),
	email:z.string().trim().email().max(254).optional(),
}).strict().superRefine((value,context)=>{
	if(!countryCodes.has(value.countryCode))context.addIssue({code:'custom',path:['countryCode'],message:'Choose a supported country or territory.'});
	if(value.type==='BANK_TRANSFER'){
		if(!value.bankName)context.addIssue({code:'custom',path:['bankName'],message:'Enter the bank name. Aurevia does not maintain a verified bank directory.'});
		if(!value.beneficiaryName)context.addIssue({code:'custom',path:['beneficiaryName'],message:'Enter the beneficiary’s legal name.'});
		if(value.countryCode==='US'){
			if(!value.routingNumber||!/^\d{9}$/.test(value.routingNumber))context.addIssue({code:'custom',path:['routingNumber'],message:'US routing numbers must contain 9 digits.'});
			if(!value.accountNumber||!/^\d{4,17}$/.test(value.accountNumber))context.addIssue({code:'custom',path:['accountNumber'],message:'Enter a US account number using 4–17 digits.'});
			if(!value.accountType)context.addIssue({code:'custom',path:['accountType'],message:'Select an account type.'});
		}else if(value.countryCode==='GB'){
			if(!value.sortCode||!/^\d{6}$/.test(value.sortCode.replaceAll('-','')))context.addIssue({code:'custom',path:['sortCode'],message:'Enter a 6-digit UK sort code.'});
			if(!value.accountNumber||!/^\d{8}$/.test(value.accountNumber))context.addIssue({code:'custom',path:['accountNumber'],message:'UK account numbers must contain 8 digits.'});
		}else if(ibanCountryCodes.has(value.countryCode)){
			const iban=(value.iban||'').replaceAll(/\s/g,'').toUpperCase();
			if(!isValidIban(iban)||iban.slice(0,2)!==value.countryCode)context.addIssue({code:'custom',path:['iban'],message:'Enter a valid IBAN for the selected country.'});
			if(value.bic&&!/^[A-Z0-9]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/i.test(value.bic))context.addIssue({code:'custom',path:['bic'],message:'Enter a valid 8- or 11-character BIC/SWIFT code.'});
		}else if(value.countryCode==='NG'){
			if(!value.bankCode||!/^\d{3}$/.test(value.bankCode))context.addIssue({code:'custom',path:['bankCode'],message:'Nigerian bank codes must contain 3 digits.'});
			if(!value.accountNumber||!/^\d{10}$/.test(value.accountNumber))context.addIssue({code:'custom',path:['accountNumber'],message:'Nigerian account numbers must contain 10 digits.'});
		}else{
			if(!value.accountNumber||!/^[A-Z0-9][A-Z0-9 -]{3,33}$/i.test(value.accountNumber))context.addIssue({code:'custom',path:['accountNumber'],message:'Enter the local account identifier without losing leading zeros.'});
			if(value.bic&&!/^[A-Z0-9]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/i.test(value.bic))context.addIssue({code:'custom',path:['bic'],message:'Enter a valid 8- or 11-character BIC/SWIFT code.'});
		}
		if(value.bic&&!(ibanCountryCodes.has(value.countryCode)||value.countryCode==='US'||value.countryCode==='GB'||value.countryCode==='NG')&&!value.beneficiaryAddress)context.addIssue({code:'custom',path:['beneficiaryAddress'],message:'Beneficiary address is required for this international transfer.'});
		if(value.bic&&!/^[A-Z0-9]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/i.test(value.bic))context.addIssue({code:'custom',path:['bic'],message:'Enter a valid 8- or 11-character BIC/SWIFT code.'});
	}else{
		if(value.email)value.email=value.email.toLowerCase();
		if(value.asset==='BTC'&&value.network==='BITCOIN_MAINNET'&&value.walletAddress){
			try{address.toOutputScript(value.walletAddress,networks.bitcoin)}catch{context.addIssue({code:'custom',path:['walletAddress'],message:'Enter a valid Bitcoin mainnet address.'})}
		}else if(value.asset==='ETH'&&value.network==='ETHEREUM_MAINNET'&&value.walletAddress){
			if(!isAddress(value.walletAddress))context.addIssue({code:'custom',path:['walletAddress'],message:'Enter a valid Ethereum mainnet address.'});
		}else context.addIssue({code:'custom',path:['network'],message:'Choose a supported asset and its exact mainnet network.'});
		if(!value.walletAddress)context.addIssue({code:'custom',path:['walletAddress'],message:'Enter the destination wallet address.'});
	}
	if(value.type==='BANK_TRANSFER'&&value.email)context.addIssue({code:'custom',path:['email'],message:'Email is only available for cryptocurrency destinations.'});
});

export type WithdrawalDestinationInput=z.infer<typeof destinationSchema>;

function isValidIban(value:string){
	if(!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(value))return false;
	const rearranged=value.slice(4)+value.slice(0,4);
	let remainder=0;
	for(const character of rearranged){
		const digits=character>='A'&&character<='Z'?String(character.charCodeAt(0)-55):character;
		for(const digit of digits)remainder=(remainder*10+Number(digit))%97;
	}
	return remainder===1;
}

export function parseWithdrawalDestination(input:unknown){
	const result=destinationSchema.safeParse(input);
	if(!result.success)return result;
	const value=result.data;
	if(value.type==='BANK_TRANSFER'){
		value.accountNumber=value.accountNumber?.replaceAll(/\s/g,'');
		value.iban=value.iban?.replaceAll(/\s/g,'').toUpperCase();
		value.bic=value.bic?.toUpperCase();
		value.sortCode=value.sortCode?.replaceAll('-','');
		value.routingNumber=value.routingNumber?.replaceAll(/\s/g,'');
		value.bankCode=value.bankCode?.replaceAll(/\s/g,'');
		value.bankIdentifier=value.bankIdentifier?.trim();
	}
	return {success:true as const,data:value};
}

function encryptionKey(){
	const encoded=process.env.WITHDRAWAL_DESTINATION_ENCRYPTION_KEY?.trim()||'';
	const key=Buffer.from(encoded,'base64');
	if(key.length!==32||key.toString('base64')!==encoded)throw new Error('WITHDRAWAL_DESTINATION_ENCRYPTION_KEY_REQUIRED');
	return key;
}

export function encryptWithdrawalDestination(value:WithdrawalDestinationInput){
	const iv=randomBytes(12);
	const cipher=createCipheriv('aes-256-gcm',encryptionKey(),iv);
	const ciphertext=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
	return {ciphertext:ciphertext.toString('base64'),iv:iv.toString('base64'),authTag:cipher.getAuthTag().toString('base64')};
}

export function decryptWithdrawalDestination(record:{ciphertext:string;iv:string;authTag:string}):WithdrawalDestinationInput{
	try{
		const decipher=createDecipheriv('aes-256-gcm',encryptionKey(),Buffer.from(record.iv,'base64'));
		decipher.setAuthTag(Buffer.from(record.authTag,'base64'));
		const plaintext=Buffer.concat([decipher.update(Buffer.from(record.ciphertext,'base64')),decipher.final()]).toString('utf8');
		const parsed=parseWithdrawalDestination(JSON.parse(plaintext));
		if(!parsed.success)throw new Error('DESTINATION_PAYLOAD_INVALID');
		return parsed.data;
	}catch(error){
		if(error instanceof Error&&error.message==='WITHDRAWAL_DESTINATION_ENCRYPTION_KEY_REQUIRED')throw error;
		throw new Error('WITHDRAWAL_DESTINATION_DECRYPTION_FAILED');
	}
}

export function maskedDestination(value:WithdrawalDestinationInput){
	const identifier=value.type==='BANK_TRANSFER'?value.iban||value.accountNumber||'':value.walletAddress||'';
	const last=identifier.replaceAll(/\s/g,'').slice(-4);
	return value.type==='BANK_TRANSFER'
		?`${value.bankName||'Bank transfer'} · account ending ${last||'----'}`
		:`${value.asset} · ${value.network?.replaceAll('_',' ')} · ${identifier.slice(0,6)}…${last}`;
}
