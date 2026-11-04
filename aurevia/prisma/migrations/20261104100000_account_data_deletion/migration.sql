ALTER TABLE "WaitlistEntry" DROP CONSTRAINT "WaitlistEntry_userId_fkey";
ALTER TABLE "WaitlistEntry" ADD CONSTRAINT "WaitlistEntry_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ClientStory" DROP CONSTRAINT "ClientStory_userId_fkey";
ALTER TABLE "ClientStory" ADD CONSTRAINT "ClientStory_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SupportMessage" DROP CONSTRAINT "SupportMessage_authorId_fkey";
ALTER TABLE "SupportMessage" ADD CONSTRAINT "SupportMessage_authorId_fkey"
  FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CommunityCampaign" DROP CONSTRAINT "CommunityCampaign_createdById_fkey";
ALTER TABLE "CommunityCampaign" ALTER COLUMN "createdById" DROP NOT NULL;
ALTER TABLE "CommunityCampaign" ADD CONSTRAINT "CommunityCampaign_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CommunityDonation" DROP CONSTRAINT "CommunityDonation_userId_fkey";
ALTER TABLE "CommunityDonation" ADD CONSTRAINT "CommunityDonation_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CommunityLoan" DROP CONSTRAINT "CommunityLoan_userId_fkey";
ALTER TABLE "CommunityLoan" ADD CONSTRAINT "CommunityLoan_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommunityLoan" DROP CONSTRAINT "CommunityLoan_reviewedById_fkey";
ALTER TABLE "CommunityLoan" ADD CONSTRAINT "CommunityLoan_reviewedById_fkey"
  FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CommunityLoan" DROP CONSTRAINT "CommunityLoan_disbursedById_fkey";
ALTER TABLE "CommunityLoan" ADD CONSTRAINT "CommunityLoan_disbursedById_fkey"
  FOREIGN KEY ("disbursedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CommunityLoanInstallment" DROP CONSTRAINT "CommunityLoanInstallment_loanId_fkey";
ALTER TABLE "CommunityLoanInstallment" ADD CONSTRAINT "CommunityLoanInstallment_loanId_fkey"
  FOREIGN KEY ("loanId") REFERENCES "CommunityLoan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommunityLoanPayment" DROP CONSTRAINT "CommunityLoanPayment_loanId_fkey";
ALTER TABLE "CommunityLoanPayment" ADD CONSTRAINT "CommunityLoanPayment_loanId_fkey"
  FOREIGN KEY ("loanId") REFERENCES "CommunityLoan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommunityLoanPayment" DROP CONSTRAINT "CommunityLoanPayment_installmentId_fkey";
ALTER TABLE "CommunityLoanPayment" ADD CONSTRAINT "CommunityLoanPayment_installmentId_fkey"
  FOREIGN KEY ("installmentId") REFERENCES "CommunityLoanInstallment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommunityLoanPayment" DROP CONSTRAINT "CommunityLoanPayment_recordedById_fkey";
ALTER TABLE "CommunityLoanPayment" ALTER COLUMN "recordedById" DROP NOT NULL;
ALTER TABLE "CommunityLoanPayment" ADD CONSTRAINT "CommunityLoanPayment_recordedById_fkey"
  FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Broadcast" DROP CONSTRAINT "Broadcast_createdById_fkey";
ALTER TABLE "Broadcast" ALTER COLUMN "createdById" DROP NOT NULL;
ALTER TABLE "Broadcast" ADD CONSTRAINT "Broadcast_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Story" DROP CONSTRAINT "Story_createdById_fkey";
ALTER TABLE "Story" ALTER COLUMN "createdById" DROP NOT NULL;
ALTER TABLE "Story" ADD CONSTRAINT "Story_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "InvestmentOpportunity" DROP CONSTRAINT "InvestmentOpportunity_createdById_fkey";
ALTER TABLE "InvestmentOpportunity" ALTER COLUMN "createdById" DROP NOT NULL;
ALTER TABLE "InvestmentOpportunity" ADD CONSTRAINT "InvestmentOpportunity_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "LedgerEntry" DROP CONSTRAINT "LedgerEntry_accountId_fkey";
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "LedgerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
