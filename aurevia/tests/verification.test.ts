import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {generateVerificationCode,hashVerificationCode,hasConfiguredTermii,hasConfiguredTwilio,sendTermiiVerificationToken,sendTwilioVerificationCode,verificationCodeMatches,verifyTermiiVerificationToken,verifyTwilioVerificationCode} from '../lib/verification-delivery';

describe('Tier 3 phone verification codes',()=>{
	const previousSecret=process.env.VERIFICATION_CODE_SECRET;
	const deliveryKeys=['TERMII_API_KEY','TERMII_SENDER_ID','TERMII_BASE_URL','TWILIO_ACCOUNT_SID','TWILIO_AUTH_TOKEN','TWILIO_VERIFY_SERVICE_SID'];
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

	it('uses the account-specific official Termii base URL when configured',async()=>{
		process.env.TERMII_API_KEY='test-termii-key';
		process.env.TERMII_SENDER_ID='AUREVIA';
		process.env.TERMII_BASE_URL='https://api.eu.termii.com';
		const fetchMock=vi.fn().mockResolvedValue(new Response(JSON.stringify({pin_id:'termii-pin-2'}),{status:200}));
		vi.stubGlobal('fetch',fetchMock);

		await sendTermiiVerificationToken('+12125550123');

		expect(fetchMock.mock.calls[0][0]).toBe('https://api.eu.termii.com/api/sms/otp/send');
	});

	it('does not send credentials to an invalid Termii base URL',async()=>{
		process.env.TERMII_API_KEY='test-termii-key';
		process.env.TERMII_SENDER_ID='AUREVIA';
		process.env.TERMII_BASE_URL='https://example.invalid';
		const fetchMock=vi.fn();
		vi.stubGlobal('fetch',fetchMock);

		expect(hasConfiguredTermii()).toBe(false);
		await expect(sendTermiiVerificationToken('+12125550123')).rejects.toThrow('PHONE_VERIFICATION_DELIVERY_UNAVAILABLE');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('uses Twilio Verify with E.164 form data and only approves a confirmed verification',async()=>{
		process.env.TWILIO_ACCOUNT_SID=`AC${'1'.repeat(32)}`;
		process.env.TWILIO_AUTH_TOKEN='test-twilio-auth-token';
		process.env.TWILIO_VERIFY_SERVICE_SID=`VA${'2'.repeat(32)}`;
		const fetchMock=vi.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify({sid:`VE${'3'.repeat(32)}`,status:'pending'}),{status:201}))
			.mockResolvedValueOnce(new Response(JSON.stringify({status:'approved'}),{status:200}))
			.mockResolvedValueOnce(new Response(JSON.stringify({status:'pending'}),{status:200}));
		vi.stubGlobal('fetch',fetchMock);

		expect(hasConfiguredTwilio()).toBe(true);
		expect(await sendTwilioVerificationCode('+12125550123')).toBe('TWILIO');
		expect(await verifyTwilioVerificationCode('+12125550123','123456')).toBe(true);
		expect(await verifyTwilioVerificationCode('+12125550123','123456')).toBe(false);
		expect(fetchMock.mock.calls.map(([url])=>url)).toEqual([
			`https://verify.twilio.com/v2/Services/VA${'2'.repeat(32)}/Verifications`,
			`https://verify.twilio.com/v2/Services/VA${'2'.repeat(32)}/VerificationCheck`,
			`https://verify.twilio.com/v2/Services/VA${'2'.repeat(32)}/VerificationCheck`,
		]);
		expect(fetchMock.mock.calls.map(([,init])=>new URLSearchParams(init.body))).toEqual([
			new URLSearchParams({To:'+12125550123',Channel:'sms'}),
			new URLSearchParams({To:'+12125550123',Code:'123456'}),
			new URLSearchParams({To:'+12125550123',Code:'123456'}),
		]);
		expect(fetchMock.mock.calls[0][1].headers.authorization).toBe(`Basic ${Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:test-twilio-auth-token`).toString('base64')}`);
	});

	it('does not mistake Twilio configuration for Termii credentials',async()=>{
		process.env.TWILIO_ACCOUNT_SID=`AC${'1'.repeat(32)}`;
		process.env.TWILIO_AUTH_TOKEN='test-twilio-auth-token';
		process.env.TWILIO_VERIFY_SERVICE_SID=`VA${'2'.repeat(32)}`;
		const fetchMock=vi.fn();
		vi.stubGlobal('fetch',fetchMock);

		await expect(sendTermiiVerificationToken('+12125550123')).rejects.toThrow('PHONE_VERIFICATION_DELIVERY_UNAVAILABLE');
		await expect(verifyTermiiVerificationToken('pin-id','123456')).rejects.toThrow('PHONE_VERIFICATION_DELIVERY_UNAVAILABLE');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('preserves provider HTTP status without exposing the response body',async()=>{
		process.env.TERMII_API_KEY='test-termii-key';
		process.env.TERMII_SENDER_ID='AUREVIA';
		const fetchMock=vi.fn().mockResolvedValue(new Response(JSON.stringify({message:'private provider details'}),{status:401}));
		vi.stubGlobal('fetch',fetchMock);

		await expect(sendTermiiVerificationToken('+12125550123')).rejects.toMatchObject({
			failureStage:'provider_response',
			httpStatus:401,
		});
	});
});
