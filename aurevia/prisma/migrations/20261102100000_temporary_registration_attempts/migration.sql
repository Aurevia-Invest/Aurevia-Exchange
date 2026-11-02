CREATE TABLE "RegistrationAttempt" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "phone" TEXT,
    "dateOfBirth" TIMESTAMP(3) NOT NULL,
    "accountMode" "AccountMode" NOT NULL,
    "termsAcceptedAt" TIMESTAMP(3) NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RegistrationAttempt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RegistrationVerification" (
    "id" TEXT NOT NULL,
    "registrationAttemptId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "channel" "VerificationChannel" NOT NULL,
    "providerReference" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "resendAfter" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RegistrationVerification_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RegistrationAttempt_email_key" ON "RegistrationAttempt"("email");
CREATE UNIQUE INDEX "RegistrationAttempt_tokenHash_key" ON "RegistrationAttempt"("tokenHash");
CREATE INDEX "RegistrationAttempt_expiresAt_idx" ON "RegistrationAttempt"("expiresAt");
CREATE UNIQUE INDEX "RegistrationVerification_registrationAttemptId_key" ON "RegistrationVerification"("registrationAttemptId");
CREATE INDEX "RegistrationVerification_expiresAt_idx" ON "RegistrationVerification"("expiresAt");
CREATE INDEX "RegistrationVerification_providerReference_idx" ON "RegistrationVerification"("providerReference");

ALTER TABLE "RegistrationVerification"
ADD CONSTRAINT "RegistrationVerification_registrationAttemptId_fkey"
FOREIGN KEY ("registrationAttemptId") REFERENCES "RegistrationAttempt"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
