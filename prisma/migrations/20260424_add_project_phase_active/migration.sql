-- Add project-specific active toggle for phases linked to projects.
ALTER TABLE "project_phase"
ADD COLUMN IF NOT EXISTS "active" BOOLEAN NOT NULL DEFAULT true;

-- Ensure all existing rows are active.
UPDATE "project_phase"
SET "active" = true
WHERE "active" IS DISTINCT FROM true;
