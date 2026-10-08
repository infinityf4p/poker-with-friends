ALTER TABLE "user_accounts" ADD COLUMN "deleted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "admins" ADD COLUMN "password_changed_at" timestamp with time zone;
