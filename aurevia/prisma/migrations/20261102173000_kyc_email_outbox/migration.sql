CREATE TYPE "KycEmailOutboxStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

CREATE TABLE "KycEmailOutbox" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "event" VARCHAR(32) NOT NULL,
  "dedupeKey" VARCHAR(200) NOT NULL,
  "status" "KycEmailOutboxStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMP(3),
  "sentAt" TIMESTAMP(3),
  "lastErrorCode" VARCHAR(32),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "KycEmailOutbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "KycEmailOutbox_dedupeKey_key" ON "KycEmailOutbox"("dedupeKey");
CREATE INDEX "KycEmailOutbox_status_nextAttemptAt_createdAt_idx"
  ON "KycEmailOutbox"("status", "nextAttemptAt", "createdAt");

ALTER TABLE "KycEmailOutbox"
  ADD CONSTRAINT "KycEmailOutbox_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
