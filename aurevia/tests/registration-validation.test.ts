import {describe,expect,it} from 'vitest';
import {supportedCountries,countrySearchMatches,findCountry} from '../lib/countries';
import {isValidE164,normalizePhoneE164,parseDateOfBirth} from '../lib/registration-validation';

describe('registration country and phone validation',()=>{
	it('puts the United States first and sorts the rest alphabetically',()=>{
		expect(supportedCountries[0]).toMatchObject({code:'US',name:'United States',dialCode:'+1'});
		expect(supportedCountries.slice(1).map(country=>country.name)).toEqual([...supportedCountries.slice(1).map(country=>country.name)].sort((a,b)=>a.localeCompare(b,'en')));
		expect(supportedCountries.length).toBeGreaterThan(200);
	});

	it('searches by country name, ISO code, and calling code',()=>{
		expect(countrySearchMatches(findCountry('NG')!,'Nigeria')).toBe(true);
		expect(countrySearchMatches(findCountry('NG')!,'ng')).toBe(true);
		expect(countrySearchMatches(findCountry('NG')!,'+234')).toBe(true);
		expect(findCountry('GB')).toMatchObject({name:'United Kingdom',dialCode:'+44'});
	});

	it.each([
		['US','United States','+1','+12025550123'],
		['NG','Nigeria','+234','+2348031234567'],
		['GB','United Kingdom','+44','+447400123456'],
		['CA','Canada','+1','+14165550123'],
		['IN','India','+91','+919876543210'],
		['DE','Germany','+49','+4915112345678'],
		['ZA','South Africa','+27','+27821234567'],
	] as const)('supports explicit country selection and E.164 for %s', (code,name,dialCode,e164)=>{
		const country=findCountry(code);
		expect(country).toMatchObject({name,dialCode});
		expect(countrySearchMatches(country!,name)).toBe(true);
		expect(normalizePhoneE164(e164,code)).toBe(e164);
		expect(isValidE164(e164)).toBe(true);
	});

	it('normalizes national numbers to valid E.164 values',()=>{
		expect(normalizePhoneE164('(202) 555-0123','US')).toBe('+12025550123');
		expect(normalizePhoneE164('+1 202 555 0123','US')).toBe('+12025550123');
		expect(normalizePhoneE164('07400 123456','GB')).toBe('+447400123456');
		expect(normalizePhoneE164('+44 7400 123456','GB')).toBe('+447400123456');
		expect(normalizePhoneE164('0803 123 4567','NG')).toBe('+2348031234567');
		expect(normalizePhoneE164('+234 803 123 4567','NG')).toBe('+2348031234567');
		expect(normalizePhoneE164('+234 803 123 4567','US')).toBeNull();
		expect(isValidE164('+2348031234567')).toBe(true);
		expect(isValidE164('0803 123 4567')).toBe(false);
		expect(normalizePhoneE164('123','US')).toBeNull();
	});
});

describe('registration date of birth validation',()=>{
	const now=new Date('2026-10-04T12:00:00Z');
	it('accepts exact calendar dates and rejects future or impossible dates',()=>{
		expect(parseDateOfBirth('2000-02-29',now)?.toISOString()).toBe('2000-02-29T00:00:00.000Z');
		expect(parseDateOfBirth('2026-10-05',now)).toBeNull();
		expect(parseDateOfBirth('2026-02-29',now)).toBeNull();
		expect(parseDateOfBirth('10/04/2000',now)).toBeNull();
	});
});