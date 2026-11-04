import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {generateVerificationCode,hashVerificationCode,hasConfiguredTermii,sendTermiiVerificationToken,verificationCodeMatches,verifyTermiiVerificationToken} from '../lib/verification-delivery';

describe('Tier 3 phone verification codes',()=>{
	const previousSecret=process.env.VERIFICATION_CODE_SECRET;
	const deliveryKeys=['TERMII_API_KEY','TERMII_SENDER_ID'];
	const previousDeliveryValues=Object.fromEntries(deliveryKeys.map(key=>[key,process.env[key]]));

	beforeEach(()=>{
		delete process.env.VERIFICATION_CODE_SECRET;
		for(const key of deliveryKeys)delete process.env[key];
	});

	afterEach(()=>{
		vi.unstubAllGlobals();
		if(previousSecret===undefined)delete process.env.VERIFICATION_CODE_SECRET;
		else process.env.VERIFICATION_CODE_SECRET=previousSecret;
		for(const key of deliveryKeys){
			const value=previousDeliveryValues[key];
			if(value===undefined)delete process.env[key];
			else process.env[key]=value;
		}
	});

	it('generates six-digit codes and verifies only the matching account-bound code',()=>{
		process.env.VERIFICATION_CODE_SECRET='unit-test-only-secret';
		const userId='verification-test-user';
		const code=generateVerificationCode();
		const hash=hashVerificationCode(userId,code);

		expect(code).toMatch(/^\d{6}$/);
		expect(hash).not.toContain(code);
		expect(verificationCodeMatches(userId,code,hash)).toBe(true);
		expect(verificationCodeMatches('another-user',code,hash)).toBe(false);
		expect(verificationCodeMatches(userId,'000000',hash)).toBe(code==='000000');
	});

	it('uses Termii send-token and verify-token APIs for Tier 3 phone verification',async()=>{
		process.env.TERMII_API_KEY='test-termii-key';
		process.env.TERMII_SENDER_ID='AUREVIA';
		const fetchMock=vi.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify({pin_id:'termii-pin-1'}),{status:200}))
			.mockResolvedValueOnce(new Response(JSON.stringify({verified:'True'}),{status:200}));
		vi.stubGlobal('fetch',fetchMock);

		expect(hasConfiguredTermii()).toBe(true);
		expect(await sendTermiiVerificationToken('+12125550123')).toBe('termii-pin-1');
		expect(await verifyTermiiVerificationToken('termii-pin-1','123456')).toBe(true);
		expect(fetchMock.mock.calls.map(([url])=>url)).toEqual([
			'https://api.ng.termii.com/api/sms/otp/send',
			'https://api.ng.termii.com/api/sms/otp/verify',
		]);
		expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({api_key:'test-termii-key',to:'+12125550123',from:'AUREVIA',pin_length:6,pin_attempts:5});
		expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({api_key:'test-termii-key',pin_id:'termii-pin-1',pin:'123456'});
	});
});
