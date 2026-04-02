CREATE TABLE IF NOT EXISTS "region" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(100) NOT NULL UNIQUE
);

INSERT INTO "region" ("id", "name")
VALUES (1, 'Default')
ON CONFLICT ("id") DO NOTHING;

CREATE TABLE IF NOT EXISTS "region_year" (
  "id" SERIAL PRIMARY KEY,
  "region_id" INTEGER NOT NULL,
  "year" INTEGER NOT NULL,
  CONSTRAINT "fk_region_year_region"
    FOREIGN KEY ("region_id")
    REFERENCES "region"("id")
    ON DELETE CASCADE
    ON UPDATE NO ACTION,
  CONSTRAINT "region_year_region_id_year_key" UNIQUE ("region_id", "year")
);

CREATE TABLE IF NOT EXISTS "public_holiday" (
  "id" SERIAL PRIMARY KEY,
  "region_year_id" INTEGER NOT NULL,
  "month" INTEGER NOT NULL,
  "day" INTEGER NOT NULL,
  "name" VARCHAR(255),
  "created_at" TIMESTAMP(6) DEFAULT NOW(),
  CONSTRAINT "fk_public_holiday_region_year"
    FOREIGN KEY ("region_year_id")
    REFERENCES "region_year"("id")
    ON DELETE CASCADE
    ON UPDATE NO ACTION,
  CONSTRAINT "public_holiday_region_year_id_month_day_key"
    UNIQUE ("region_year_id", "month", "day"),
  CONSTRAINT "public_holiday_month_check" CHECK ("month" BETWEEN 1 AND 12),
  CONSTRAINT "public_holiday_day_check" CHECK ("day" BETWEEN 1 AND 31)
);

ALTER TABLE "employee"
ADD COLUMN IF NOT EXISTS "region_id" INTEGER;

UPDATE "employee"
SET "region_id" = 1
WHERE "region_id" IS NULL;

ALTER TABLE "employee"
ALTER COLUMN "region_id" SET DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_employee_region'
  ) THEN
    ALTER TABLE "employee"
    ADD CONSTRAINT "fk_employee_region"
      FOREIGN KEY ("region_id")
      REFERENCES "region"("id")
      ON DELETE NO ACTION
      ON UPDATE NO ACTION;
  END IF;
END $$;
