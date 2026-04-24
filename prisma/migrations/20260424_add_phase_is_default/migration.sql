-- Add is_default flag to phase table
ALTER TABLE "phase"
ADD COLUMN "is_default" BOOLEAN NOT NULL DEFAULT TRUE;
