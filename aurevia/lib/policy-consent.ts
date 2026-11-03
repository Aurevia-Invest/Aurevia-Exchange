export const POLICY_CONSENT_KEY='aurevia-policy-consent-v1';
export const POLICY_CONSENT_VERSION=1;

export type PolicyConsentChoice='accepted'|'rejected';
export type PolicyConsentRecord={version:number;choice:PolicyConsentChoice;updatedAt:string};

export function readPolicyConsent(value:string|null):PolicyConsentRecord|null{
	if(!value)return null;
	try{
		const parsed:unknown=JSON.parse(value);
		if(!parsed||typeof parsed!=='object')return null;
		const record=parsed as Partial<PolicyConsentRecord>;
		if(record.version!==POLICY_CONSENT_VERSION||(record.choice!=='accepted'&&record.choice!=='rejected')||typeof record.updatedAt!=='string')return null;
		return {version:record.version,choice:record.choice,updatedAt:record.updatedAt};
	}catch{
		return null;
	}
}

export function createPolicyConsent(choice:PolicyConsentChoice,updatedAt=new Date().toISOString()):PolicyConsentRecord{
	return {version:POLICY_CONSENT_VERSION,choice,updatedAt};
}
