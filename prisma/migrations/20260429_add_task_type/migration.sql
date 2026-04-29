-- Create TaskType enum
CREATE TYPE "TaskType" AS ENUM ('LEAVE', 'PROJECT', 'SUSTAINING');

-- Add task_type column to task table, defaulting existing rows to SUSTAINING
ALTER TABLE "task" ADD COLUMN "task_type" "TaskType" NOT NULL DEFAULT 'SUSTAINING'; -- temporary default for backfill, dropped below

-- Backfill: tasks linked to a default phase are PROJECT
UPDATE "task"
SET "task_type" = 'PROJECT'
WHERE "id" IN (
  SELECT DISTINCT pt.task_id
  FROM "phase_task" pt
  INNER JOIN "phase" p ON p.id = pt.phase_id
  WHERE p.is_default = true
);

-- Backfill: task id 1 ("null") is a leave task
UPDATE "task" SET "task_type" = 'LEAVE' WHERE "id" = 1;

-- Drop the temporary default so task_type must be set explicitly on new tasks
ALTER TABLE "task" ALTER COLUMN "task_type" DROP DEFAULT;
