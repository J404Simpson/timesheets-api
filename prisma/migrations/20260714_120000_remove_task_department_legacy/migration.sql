-- Backfill any legacy single-department task assignments into the join table.
INSERT INTO "department_task" ("department_id", "task_id", "created_at")
SELECT
  t."department_id",
  t."id",
  COALESCE(t."created_at", NOW())
FROM "task" t
WHERE t."department_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "department_task" dt
    WHERE dt."department_id" = t."department_id"
      AND dt."task_id" = t."id"
  );

-- Remove legacy single-department relation from task.
ALTER TABLE "task" DROP CONSTRAINT IF EXISTS "fk_task_department";
ALTER TABLE "task" DROP COLUMN IF EXISTS "department_id";
