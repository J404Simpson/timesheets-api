-- Add active flag to task and ensure all existing records are active
ALTER TABLE "task"
ADD COLUMN "active" BOOLEAN;

UPDATE "task"
SET "active" = TRUE
WHERE "active" IS NULL;

ALTER TABLE "task"
ALTER COLUMN "active" SET DEFAULT TRUE;

ALTER TABLE "task"
ALTER COLUMN "active" SET NOT NULL;
