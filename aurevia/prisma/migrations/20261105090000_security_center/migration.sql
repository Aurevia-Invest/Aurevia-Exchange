ALTER TABLE "User"
ADD COLUMN "totpSecretEncrypted" TEXT,
ADD COLUMN "lastTotpCounter" BIGINT;

-- The legacy flag was never backed by a second-factor challenge. Clear it rather
-- than accidentally presenting an unprotected account as MFA-enabled.
UPDATE "User" SET "twoFactorEnabled" = false WHERE "twoFactorEnabled" = true;

CREATE TABLE "SecuritySession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionHash" TEXT NOT NULL,
    "deviceLabel" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "reauthenticatedAt" TIMESTAMP(3),
    "rotationRequired" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "SecuritySession_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SecuritySession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SecuritySession_sessionHash_key" ON "SecuritySession"("sessionHash");
CREATE INDEX "SecuritySession_userId_revokedAt_expiresAt_idx" ON "SecuritySession"("userId", "revokedAt", "expiresAt");

CREATE TABLE "TwoFactorEnrollment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "secretEncrypted" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TwoFactorEnrollment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TwoFactorEnrollment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "TwoFactorEnrollment_userId_key" ON "TwoFactorEnrollment"("userId");

CREATE TABLE "SecurityRecoveryCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SecurityRecoveryCode_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SecurityRecoveryCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "SecurityRecoveryCode_userId_usedAt_idx" ON "SecurityRecoveryCode"("userId", "usedAt");

CREATE TABLE "SecurityRateLimit" (
    "id" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "resetAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SecurityRateLimit_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SecurityRateLimit_keyHash_key" ON "SecurityRateLimit"("keyHash");
CREATE INDEX "SecurityRateLimit_resetAt_idx" ON "SecurityRateLimit"("resetAt");
