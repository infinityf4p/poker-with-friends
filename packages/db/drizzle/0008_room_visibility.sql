DO $$ BEGIN
 CREATE TYPE "room_visibility" AS ENUM ('PUBLIC', 'PRIVATE');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
ALTER TABLE "rooms" ADD COLUMN IF NOT EXISTS "visibility" "room_visibility" NOT NULL DEFAULT 'PUBLIC';
ALTER TABLE "rooms" ADD COLUMN IF NOT EXISTS "access_password_hash" text;
