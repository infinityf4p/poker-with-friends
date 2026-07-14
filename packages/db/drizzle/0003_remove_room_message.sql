UPDATE "rooms"
SET "public_snapshot" = "public_snapshot" - 'message'
WHERE "public_snapshot" ? 'message';
