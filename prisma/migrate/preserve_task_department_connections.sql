-- Migration script to preserve existing task-department connections
-- 1. Create the join table if it doesn't exist (should be handled by Prisma migration, but safe to include)
CREATE TABLE IF NOT EXISTS department_task (
  department_id INTEGER NOT NULL,
  task_id INTEGER NOT NULL,
  PRIMARY KEY (department_id, task_id)
);

-- 2. Copy existing connections from task.department_id to department_task
INSERT INTO department_task (department_id, task_id)
SELECT department_id, id FROM task WHERE department_id IS NOT NULL;

-- 3. (Optional) You can drop the department_id column from task after verifying the data is migrated.
-- ALTER TABLE task DROP COLUMN department_id;
