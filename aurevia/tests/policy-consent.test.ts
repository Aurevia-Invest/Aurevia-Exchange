import {describe,expect,it} from 'vitest';
import {createPolicyConsent,POLICY_CONSENT_VERSION,readPolicyConsent} from '@/lib/policy-consent';

describe('device policy consent record',()=>{
	it('records acceptance explicitly with a timestamp and current version',()=>{
		const record=createPolicyConsent('accepted','2026-11-03T10:00:00.000Z');
		expect(record).toEqual({version:POLICY_CONSENT_VERSION,choice:'accepted',updatedAt:'2026-11-03T10:00:00.000Z'});
		expect(readPolicyConsent(JSON.stringify(record))).toEqual(record);
	});

	it('keeps rejection separate from acceptance',()=>{
		const rejected=createPolicyConsent('rejected','2026-11-03T10:00:00.000Z');
		expect(readPolicyConsent(JSON.stringify(rejected))?.choice).toBe('rejected');
	});

	it('requires a new choice for malformed or outdated records',()=>{
		expect(readPolicyConsent(null)).toBeNull();
		expect(readPolicyConsent('{broken')).toBeNull();
		expect(readPolicyConsent(JSON.stringify({version:POLICY_CONSENT_VERSION-1,choice:'accepted',updatedAt:'2026-11-03'}))).toBeNull();
		expect(readPolicyConsent(JSON.stringify({version:POLICY_CONSENT_VERSION,choice:'deferred',updatedAt:'2026-11-03'}))).toBeNull();
	});
});
