ALTER TABLE "admins" ADD COLUMN "display_name" text DEFAULT '' NOT NULL;
UPDATE "admins" SET "display_name" = "username" WHERE "display_name" = '';
UPDATE "players" AS p
SET "nickname" = a."display_name"
FROM "user_accounts" AS a
WHERE p."user_id" = a."id";
