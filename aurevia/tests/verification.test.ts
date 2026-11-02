import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {availableVerificationChannel,deliverVerificationCode,generateVerificationCode,hashVerificationCode,hasConfiguredTermii,registrationVerificationChannel,sendTermiiVerificationToken,verificationCodeMatches,verifyTermiiVerificationToken} from '../lib/verification-delivery';

describe('account verification codes',()=>{
 const previousSecret=process.env.VERIFICATION_CODE_SECRET;
 const deliveryKeys=['VERIFICATION_EMAIL_API_URL','VERIFICATION_EMAIL_API_KEY','VERIFICATION_SMS_API_URL','VERIFICATION_SMS_API_KEY','REGISTRATION_VERIFICATION_ENABLED','AUREVIA_E2E_ALLOW_HTTP_PROVIDER','RESEND_API_KEY','VERIFICATION_EMAIL_FROM','TERMII_API_KEY','TERMII_SENDER_ID','NEXT_PUBLIC_APP_URL'];
 const previousDeliveryValues=Object.fromEntries(deliveryKeys.map(key=>[key,process.env[key]]));
 beforeEach(()=>{
  delete process.env.VERIFICATION_CODE_SECRET;
  for(const key of deliveryKeys)delete process.env[key];
 });
 afterEach(()=>{
  vi.unstubAllGlobals();
  if(previousSecret===undefined)delete process.env.VERIFICATION_CODE_SECRET;
  else process.env.VERIFICATION_CODE_SECRET=previousSecret;
  for(const key of deliveryKeys){const value=previousDeliveryValues[key];if(value===undefined)delete process.env[key];else process.env[key]=value}
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

 it('requires HTTPS except for an explicitly enabled loopback E2E provider',()=>{
  process.env.VERIFICATION_EMAIL_API_KEY='test-only-key';
  process.env.VERIFICATION_EMAIL_API_URL='http://mail.example.invalid/send';
  expect(availableVerificationChannel(null)).toBeNull();
  process.env.VERIFICATION_EMAIL_API_URL='https://mail.example.invalid/send';
  expect(availableVerificationChannel(null)).toBe('EMAIL');
  process.env.VERIFICATION_EMAIL_API_URL='http://127.0.0.1:4311/email';
  expect(availableVerificationChannel(null)).toBeNull();
  process.env.AUREVIA_E2E_ALLOW_HTTP_PROVIDER='1';
  expect(availableVerificationChannel(null)).toBe('EMAIL');
  process.env.VERIFICATION_EMAIL_API_URL='https://user:password@mail.example.invalid/send';
  expect(availableVerificationChannel(null)).toBeNull();
 });

    it('always selects email for registration and never phone verification',()=>{
        process.env.REGISTRATION_VERIFICATION_ENABLED='false';
        process.env.VERIFICATION_SMS_API_KEY='test-only-key';
        process.env.VERIFICATION_SMS_API_URL='https://sms.example.invalid/send';
        expect(registrationVerificationChannel()).toBeNull();
        process.env.VERIFICATION_EMAIL_API_KEY='test-only-key';
        process.env.VERIFICATION_EMAIL_API_URL='https://mail.example.invalid/send';
        expect(registrationVerificationChannel()).toBe('EMAIL');
    });

 it('sends registration email through Resend with the configured sender and verification domain',async()=>{
  process.env.RESEND_API_KEY='test-resend-key';
  process.env.VERIFICATION_EMAIL_FROM='verify@example.invalid';
  process.env.NEXT_PUBLIC_APP_URL='https://aureviaexchanged.dpdns.org';
  const fetchMock=vi.fn().mockResolvedValue(new Response('{}',{status:200}));
  vi.stubGlobal('fetch',fetchMock);

  expect(await deliverVerificationCode('EMAIL',{email:'person@example.invalid',phone:null,name:'Aurevia User'},'123456')).toBe(true);
  expect(fetchMock).toHaveBeenCalledWith('https://api.resend.com/emails',expect.objectContaining({
   method:'POST',
   headers:{authorization:'Bearer test-resend-key','content-type':'application/json'},
  }));
  const payload=JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(payload).toMatchObject({from:'verify@example.invalid',to:['person@example.invalid'],subject:'Verify your Aurevia Exchange account'});
  expect(payload.text).toContain('code is 123456');
  expect(payload.text).toContain('https://aureviaexchanged.dpdns.org/verify-email?email=person%40example.invalid');
 });

 it('uses Termii send-token and verify-token APIs for phone verification',async()=>{
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
