ALTER TABLE "User"
ADD COLUMN "emailVerifiedAt" TIMESTAMP(3);

UPDATE "User"
SET "emailVerifiedAt" = "verifiedAt"
WHERE "verifiedChannel" = 'EMAIL'
  AND "verifiedAt" IS NOT NULL;
