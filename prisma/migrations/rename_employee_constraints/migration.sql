DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'User_pkey'
  ) THEN
    ALTER TABLE "employee" RENAME CONSTRAINT "User_pkey" TO "employee_pkey";
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'User_object_id_key'
  ) THEN
    ALTER TABLE "employee" RENAME CONSTRAINT "User_object_id_key" TO "employee_object_id_key";
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'User_email_key'
  ) THEN
    ALTER TABLE "employee" RENAME CONSTRAINT "User_email_key" TO "employee_email_key";
  END IF;
END $$;
