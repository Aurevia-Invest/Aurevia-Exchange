export function requiresRegistrationVerification(
  role:'USER'|'ADMIN',
  verificationEnabled:boolean,
  userRequiresVerification:boolean,
  emailVerifiedAt:Date|null,
){
  return role==='USER'&&verificationEnabled&&userRequiresVerification&&!emailVerifiedAt;
}
