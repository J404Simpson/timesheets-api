-- Backfill holiday and leave entries: change all 7-hour entries to 8 hours
-- This applies to both Holiday (project_id=1) and Leave (project_id=2) projects
UPDATE "entry"
SET hours = 8
WHERE hours = 7 AND project_id IN (1, 2);
