-- Fix end_time for holiday and leave entries that were backfilled from 7hrs to 8hrs
-- These entries still have end_time at 16:00 (09:00 + 7hrs) instead of 17:00 (09:00 + 8hrs)
UPDATE "entry"
SET end_time = '17:00:00'
WHERE hours = 8
  AND project_id IN (1, 2)
  AND start_time = '09:00:00'
  AND end_time = '16:00:00';
