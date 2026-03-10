-- Update all existing employee records to set hours to 39
UPDATE employee SET hours = 39 WHERE hours IS NULL;
