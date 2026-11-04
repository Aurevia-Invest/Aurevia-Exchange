import {describe,expect,it} from 'vitest';
import {AccountMode,KycStatus} from '@prisma/client';
import {DEMO_STARTING_BALANCE,REAL_STARTING_BALANCE} from '../lib/ledger';
import {assertKycSubmissionAllowed,getAccountTier,getTierProfileRequirements,isTierThreePhoneVerificationEligible,validateDepositApproval,validateTierThreeApproval,validateTierUpgradeApproval,validateWithdrawal,verifyKycState} from '../lib/production-policy';

describe('production account policy',()=>{
  it('starts DEMO accounts with 5,000 virtual USD and REAL accounts with zero USD',()=>{
    expect(DEMO_STARTING_BALANCE.toFixed(2)).toBe('5000.00');
    expect(REAL_STARTING_BALANCE.toFixed(2)).toBe('0.00');
  });

  it('keeps demo and real account states isolated',()=>{
    expect(getAccountTier({accountMode:AccountMode.DEMO,kycStatus:KycStatus.APPROVED,verificationDocuments:0,verificationSubmitted:false,phoneVerified:false,profileComplete:true}).label).toBe('TIER 2');
    expect(getAccountTier({accountMode:AccountMode.REAL,kycStatus:KycStatus.PENDING,verificationDocuments:0,verificationSubmitted:true,phoneVerified:false,profileComplete:true}).label).toBe('TIER 2');
    const verified=getAccountTier({accountMode:AccountMode.REAL,kycStatus:KycStatus.APPROVED,verificationDocuments:1,verificationSubmitted:true,phoneVerified:true,profileComplete:true,approvedTier:3});
    expect(verified.label).toBe('TIER 3');
    expect(verified.eligibleForRealTrading).toBe(true);
    expect(getAccountTier({accountMode:AccountMode.REAL,kycStatus:KycStatus.APPROVED,verificationDocuments:1,verificationSubmitted:false,phoneVerified:true,profileComplete:true}).label).toBe('TIER 2');
    expect(getAccountTier({accountMode:AccountMode.REAL,kycStatus:KycStatus.APPROVED,verificationDocuments:1,verificationSubmitted:true,phoneVerified:false,profileComplete:true}).label).toBe('TIER 2');
    expect(getAccountTier({accountMode:AccountMode.REAL,kycStatus:KycStatus.APPROVED,verificationDocuments:1,verificationSubmitted:true,phoneVerified:true,profileComplete:false,approvedTier:3}).label).toBe('TIER 1');
  });

  it('automatically assigns Tier 2 to complete profiles and keeps REAL trading available before KYC',()=>{
    const approved=getAccountTier({accountMode:AccountMode.DEMO,kycStatus:KycStatus.PENDING,verificationDocuments:0,verificationSubmitted:false,phoneVerified:false,profileComplete:true});
    expect(approved.label).toBe('TIER 2');
    expect(approved.eligibleForRealTrading).toBe(false);
    expect(approved.verified).toBe(false);
    expect(getAccountTier({accountMode:AccountMode.REAL,kycStatus:KycStatus.PENDING,verificationDocuments:0,verificationSubmitted:false,phoneVerified:false,profileComplete:false}).eligibleForRealTrading).toBe(true);
    expect(getAccountTier({accountMode:AccountMode.DEMO,kycStatus:KycStatus.PENDING,verificationDocuments:0,verificationSubmitted:false,phoneVerified:false,profileComplete:false}).label).toBe('TIER 1');
  });

  it('requires only name and country for Tier 2 while tracking phone separately for Tier 3',()=>{
    expect(getTierProfileRequirements({name:'Ada User',country:'US',phone:'+14155552671'})).toMatchObject({profileComplete:true});
    expect(getTierProfileRequirements({name:'Ada User',country:'US',phone:'+14155552671'})).not.toHaveProperty('emailVerified');
    expect(getTierProfileRequirements({name:'Ada User',country:'US',phone:null})).toMatchObject({profileComplete:true,phoneComplete:false});
    expect(getTierProfileRequirements({name:'A',country:'',phone:'555'}).profileComplete).toBe(false);
  });

  it('allows phone OTP after profile completion and before KYC submission or document review',()=>{
    const eligible={accountMode:AccountMode.REAL,accountStatus:'ACTIVE',approvedTier:2,profileComplete:true};
    expect(isTierThreePhoneVerificationEligible(eligible)).toBe(true);
    expect(isTierThreePhoneVerificationEligible({...eligible,approvedTier:1})).toBe(false);
    expect(isTierThreePhoneVerificationEligible({...eligible,accountMode:AccountMode.DEMO})).toBe(false);
    expect(isTierThreePhoneVerificationEligible({...eligible,accountStatus:'FROZEN'})).toBe(false);
    expect(isTierThreePhoneVerificationEligible({...eligible,profileComplete:false})).toBe(false);
  });

  it('rejects stale tier reviews and requires approved identity evidence for Tier 3',()=>{
    expect(()=>validateTierUpgradeApproval({requestCurrentTier:2,requestedTier:3,currentTier:2})).not.toThrow();
    expect(()=>validateTierUpgradeApproval({requestCurrentTier:2,requestedTier:3,currentTier:3})).toThrow('TIER_REQUEST_STALE');
    const completeTierThree={profileComplete:true,phoneVerified:true,kycStatus:KycStatus.APPROVED,verificationSubmitted:true,approvedIdentityDocuments:1,approvedSelfies:1,approvedProofOfAddress:1,addressProvided:true};
    expect(()=>validateTierThreeApproval(completeTierThree)).not.toThrow();
    expect(()=>validateTierThreeApproval({...completeTierThree,approvedProofOfAddress:0})).toThrow('TIER_3_REQUIREMENTS_NOT_MET');
    expect(()=>validateTierThreeApproval({ ...completeTierThree,profileComplete:false,phoneVerified:false,kycStatus:KycStatus.PENDING,approvedIdentityDocuments:0})).toThrow('TIER_3_REQUIREMENTS_NOT_MET');
  });

  it('rejects withdrawal when disabled, restricted, or before the first completed investment',()=>{
    expect(()=>validateWithdrawal({balance:'100',pending:'10',amount:'101',withdrawalEnabled:true,kycStatus:KycStatus.APPROVED,hasCompletedInvestment:true})).toThrow('INSUFFICIENT_BALANCE');
    expect(()=>validateWithdrawal({balance:'100',pending:'0',amount:'20',withdrawalEnabled:false,kycStatus:KycStatus.APPROVED,hasCompletedInvestment:true})).toThrow('WITHDRAWAL_DISABLED');
    expect(()=>validateWithdrawal({balance:'100',pending:'0',amount:'20',withdrawalEnabled:true,accountRestricted:true,kycStatus:KycStatus.APPROVED,hasCompletedInvestment:true})).toThrow('ACCOUNT_RESTRICTED');
    expect(()=>validateWithdrawal({balance:'100',pending:'0',amount:'20',withdrawalEnabled:true,kycStatus:KycStatus.APPROVED,hasCompletedInvestment:false})).toThrow('FIRST_TRADE_REQUIRED');
  });

  it('requires approved KYC before withdrawals while retaining account and balance controls',()=>{
    expect(()=>validateWithdrawal({balance:'100',pending:'10',amount:'20',withdrawalEnabled:true,kycStatus:KycStatus.PENDING,hasCompletedInvestment:true})).toThrow('REAL_KYC_REQUIRED');
    expect(()=>validateWithdrawal({balance:'100',pending:'0',amount:'20',withdrawalEnabled:false,kycStatus:KycStatus.APPROVED})).toThrow('WITHDRAWAL_DISABLED');
    expect(()=>validateWithdrawal({balance:'100',pending:'0',amount:'20',withdrawalEnabled:true,accountRestricted:true,kycStatus:KycStatus.APPROVED})).toThrow('ACCOUNT_RESTRICTED');
    expect(()=>validateWithdrawal({balance:'100',pending:'10',amount:'91',withdrawalEnabled:true,kycStatus:KycStatus.APPROVED})).toThrow('INSUFFICIENT_BALANCE');
    expect(()=>validateWithdrawal({balance:'100',pending:'10',amount:'20',withdrawalEnabled:true,kycStatus:KycStatus.APPROVED})).not.toThrow();
  });

  it('requires net credited amount and fee to equal the gross deposit',()=>{
    expect(()=>validateDepositApproval('100.00','90.00')).toThrow('DEPOSIT_AMOUNT_MISMATCH');
    expect(()=>validateDepositApproval('100.00','100.00')).not.toThrow();
    expect(validateDepositApproval('100.00','90.00','10.00')).toMatchObject({requestedAmount:'100',creditedAmount:'90',feeAmount:'10'});
    expect(()=>validateDepositApproval('100.00','89.99','10.00')).toThrow('DEPOSIT_AMOUNT_MISMATCH');
  });

  it('only treats an approved real-account KYC state as verified',()=>{
    expect(verifyKycState(KycStatus.APPROVED)).toBe(true);
    expect(verifyKycState(KycStatus.PENDING)).toBe(false);
    expect(verifyKycState(KycStatus.REJECTED)).toBe(false);
  });

  it('prevents approved users from resubmitting KYC unless an administrator requests changes',()=>{
    expect(()=>assertKycSubmissionAllowed(KycStatus.APPROVED)).toThrow('KYC_ALREADY_APPROVED');
    expect(()=>assertKycSubmissionAllowed(KycStatus.NEEDS_CHANGES)).not.toThrow();
    expect(()=>assertKycSubmissionAllowed(KycStatus.PENDING)).not.toThrow();
  });
});
