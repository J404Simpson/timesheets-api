-- Alter existing weekly total hours column to support decimal totals
ALTER TABLE "employee"
ALTER COLUMN "hours" TYPE DECIMAL(5,2)
USING "hours"::DECIMAL(5,2);

ALTER TABLE "employee"
ALTER COLUMN "hours" SET DEFAULT 39;
