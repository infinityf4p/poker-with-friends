ALTER TABLE "user_accounts" ADD COLUMN "chip_balance" bigint DEFAULT 50000 NOT NULL;
ALTER TABLE "rooms" ALTER COLUMN "created_by_admin_id" DROP NOT NULL;
ALTER TABLE "rooms" ADD COLUMN "created_by_user_id" uuid;
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_created_by_user_id_user_accounts_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user_accounts"("id") ON DELETE set null ON UPDATE no action;
CREATE TABLE "account_ledger_entries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "room_id" uuid,
  "player_id" uuid,
  "kind" text NOT NULL,
  "delta" bigint NOT NULL,
  "balance_after" bigint NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "account_ledger_entries" ADD CONSTRAINT "account_ledger_entries_user_id_user_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_accounts"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "account_ledger_entries" ADD CONSTRAINT "account_ledger_entries_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "account_ledger_entries" ADD CONSTRAINT "account_ledger_entries_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;
CREATE INDEX "account_ledger_user_created_idx" ON "account_ledger_entries" USING btree ("user_id","created_at");
CREATE INDEX "account_ledger_room_created_idx" ON "account_ledger_entries" USING btree ("room_id","created_at");
CREATE TABLE "registration_invites" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "token_hash" text NOT NULL,
  "created_by_admin_id" uuid,
  "created_by_user_id" uuid,
  "used_at" timestamp with time zone,
  "used_by_user_id" uuid,
  "expires_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "registration_invites" ADD CONSTRAINT "registration_invites_created_by_admin_id_admins_id_fk" FOREIGN KEY ("created_by_admin_id") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "registration_invites" ADD CONSTRAINT "registration_invites_created_by_user_id_user_accounts_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user_accounts"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "registration_invites" ADD CONSTRAINT "registration_invites_used_by_user_id_user_accounts_id_fk" FOREIGN KEY ("used_by_user_id") REFERENCES "public"."user_accounts"("id") ON DELETE set null ON UPDATE no action;
CREATE UNIQUE INDEX "registration_invites_token_hash_idx" ON "registration_invites" USING btree ("token_hash");
INSERT INTO "account_ledger_entries" ("user_id", "kind", "delta", "balance_after", "metadata")
SELECT "id", 'ACCOUNT_INITIAL_GRANT', "chip_balance", "chip_balance", '{"source":"MIGRATION"}'::jsonb
FROM "user_accounts";
