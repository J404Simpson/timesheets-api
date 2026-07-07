-- Add qualifying_percentage to department and enforce valid range [0, 1]
ALTER TABLE "department"
ADD COLUMN "qualifying_percentage" DECIMAL(5,4);

UPDATE "department"
SET "qualifying_percentage" = 1.0
WHERE "qualifying_percentage" IS NULL;

ALTER TABLE "department"
ALTER COLUMN "qualifying_percentage" SET DEFAULT 1.0;

ALTER TABLE "department"
ALTER COLUMN "qualifying_percentage" SET NOT NULL;

ALTER TABLE "department"
ADD CONSTRAINT "department_qualifying_percentage_check"
CHECK ("qualifying_percentage" >= 0 AND "qualifying_percentage" <= 1);
