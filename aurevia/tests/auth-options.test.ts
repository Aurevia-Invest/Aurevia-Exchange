import {describe,expect,it} from 'vitest';
import {matchesConfiguredAdminIdentity,matchesConfiguredAdminPassword,resolveCredentialLookup} from '../lib/credential-lookup';
import {AUTH_SESSION_MAX_AGE_SECONDS,isAuthSessionExpired} from '../lib/auth-session';

describe('auth session expiration',()=>{
  const now=Date.UTC(2026,0,1);

  it('allows a new sign-in after the JWT session lifetime expires',()=>{
    const expiredAt=new Date(now-AUTH_SESSION_MAX_AGE_SECONDS*1000);
    expect(isAuthSessionExpired(expiredAt,now)).toBe(true);
  });

  it('does not replace a live session before its JWT expires',()=>{
    const liveAt=new Date(now-AUTH_SESSION_MAX_AGE_SECONDS*1000+1);
    expect(isAuthSessionExpired(liveAt,now)).toBe(false);
  });

  it('treats a missing session timestamp as stale',()=>{
    expect(isAuthSessionExpired(null,now)).toBe(true);
  });
});

describe('resolveCredentialLookup',()=>{
  it('uses the configured admin email when the configured admin username is supplied',()=>{
    expect(resolveCredentialLookup('admin','admin@example.invalid','admin','admin-configured@example.invalid')).toEqual({
      isAdminUsername:true,
      lookupEmail:'admin-configured@example.invalid',
    });
  });

  it('falls back to the configured admin account when an admin username differs from Render config',()=>{
    expect(resolveCredentialLookup('administrator','administrator','configured-admin','admin-configured@example.invalid',true)).toEqual({
      isAdminUsername:true,
      lookupEmail:'admin-configured@example.invalid',
    });
  });

  it('uses the supplied email for administrator sign-in when an email is entered',()=>{
    expect(resolveCredentialLookup('other-admin@example.invalid','other-admin@example.invalid','admin','admin-configured@example.invalid',true)).toEqual({
      isAdminUsername:true,
      lookupEmail:'other-admin@example.invalid',
    });
  });

  it('normalizes the configured admin email before database lookup',()=>{
    expect(resolveCredentialLookup('admin','admin@example.invalid','admin',' ADMIN-CONFIGURED@EXAMPLE.INVALID ')).toEqual({
      isAdminUsername:true,
      lookupEmail:'admin-configured@example.invalid',
    });
  });

  describe('matchesConfiguredAdminPassword',()=>{
    it('accepts only the currently configured admin password',()=>{
      expect(matchesConfiguredAdminPassword('current-admin-password','current-admin-password')).toBe(true);
      expect(matchesConfiguredAdminPassword('previous-admin-password','current-admin-password')).toBe(false);
    });

    it('rejects sign-in when no admin password is configured',()=>{
      expect(matchesConfiguredAdminPassword('any-password','')).toBe(false);
    });
  });

  it('uses the configured admin email for the dedicated admin login form',()=>{
    expect(resolveCredentialLookup('admin-configured@example.invalid','admin-configured@example.invalid','admin','admin-configured@example.invalid',true)).toEqual({
      isAdminUsername:true,
      lookupEmail:'admin-configured@example.invalid',
    });
  });

  it('looks up the supplied email and requires an admin role on the dedicated admin login form',()=>{
    expect(resolveCredentialLookup('other-admin@example.invalid','other-admin@example.invalid','admin','admin-configured@example.invalid',true)).toEqual({
      isAdminUsername:true,
      lookupEmail:'other-admin@example.invalid',
    });
  });

  it('keeps normal users on their supplied email',()=>{
    expect(resolveCredentialLookup('customer@example.invalid','customer@example.invalid','admin','admin@example.invalid')).toEqual({
      isAdminUsername:false,
      lookupEmail:'customer@example.invalid',
    });
  });

  it('does not treat an unrelated username as the configured admin',()=>{
    expect(resolveCredentialLookup('other','other@example.invalid','admin','admin@example.invalid')).toEqual({
      isAdminUsername:false,
      lookupEmail:'other@example.invalid',
    });
  });
});

describe('matchesConfiguredAdminIdentity',()=>{
  it('accepts only the configured admin username or email',()=>{
    expect(matchesConfiguredAdminIdentity(' Admin ','other@example.invalid','admin','admin@example.invalid')).toBe(true);
    expect(matchesConfiguredAdminIdentity('other','ADMIN@example.invalid','admin','admin@example.invalid')).toBe(true);
    expect(matchesConfiguredAdminIdentity('other','other@example.invalid','admin','admin@example.invalid')).toBe(false);
    expect(matchesConfiguredAdminIdentity('admin','admin@example.invalid','admin',undefined)).toBe(false);
  });
});
