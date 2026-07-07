-- AddColumn
ALTER TABLE "employee" ADD COLUMN "hours_monday" DECIMAL(5,2) NOT NULL DEFAULT 8;
ALTER TABLE "employee" ADD COLUMN "hours_tuesday" DECIMAL(5,2) NOT NULL DEFAULT 8;
ALTER TABLE "employee" ADD COLUMN "hours_wednesday" DECIMAL(5,2) NOT NULL DEFAULT 8;
ALTER TABLE "employee" ADD COLUMN "hours_thursday" DECIMAL(5,2) NOT NULL DEFAULT 8;
ALTER TABLE "employee" ADD COLUMN "hours_friday" DECIMAL(5,2) NOT NULL DEFAULT 7;
ALTER TABLE "employee" ADD COLUMN "hours_saturday" DECIMAL(5,2) NOT NULL DEFAULT 0;
ALTER TABLE "employee" ADD COLUMN "hours_sunday" DECIMAL(5,2) NOT NULL DEFAULT 0;

-- Update existing records with hours = 39 to use the new weekly breakdown
UPDATE "employee" SET
  hours_monday = 8,
  hours_tuesday = 8,
  hours_wednesday = 8,
  hours_thursday = 8,
  hours_friday = 7,
  hours_saturday = 0,
  hours_sunday = 0
WHERE hours = 39;
