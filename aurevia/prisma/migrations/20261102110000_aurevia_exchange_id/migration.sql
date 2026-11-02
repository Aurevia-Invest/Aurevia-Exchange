ALTER TABLE "User"
ADD COLUMN "aureviaExchangeId" TEXT;

CREATE UNIQUE INDEX "User_aureviaExchangeId_key"
ON "User"("aureviaExchangeId");
