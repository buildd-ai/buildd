-- Hold the per-person standing-rule cap (MAX_DIRECTIVES_PER_USER in
-- packages/core/chat-directives.ts) under concurrent saves.
--
-- createDirective inserts with `WHERE (select count(*) ...) < cap`, but that
-- count reads the statement's snapshot: under READ COMMITTED two saves racing
-- at the last free slot each see the other's row as absent and both land.
-- neon-http has no interactive transactions, so the serialization lives here:
-- each insert takes a transaction-scoped advisory lock keyed by the person,
-- then counts. In PL/pgSQL every statement takes a fresh snapshot, so the
-- count runs after the lock and sees any rule the previous holder committed.
-- The lock is released when the insert's own transaction ends.
--
-- The refusal is a check_violation naming the cap, which createDirective
-- reads as "limit". The cap below must equal MAX_DIRECTIVES_PER_USER;
-- apps/web/src/lib/chat/directives-store.test.ts checks that it does.
CREATE OR REPLACE FUNCTION chat_directives_enforce_cap()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  held integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('chat_directives_per_user_cap'), hashtext(NEW.user_id::text));
  SELECT count(*) INTO held FROM chat_directives WHERE user_id = NEW.user_id;
  IF held >= 50 THEN
    RAISE EXCEPTION 'standing rule limit reached'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'chat_directives_per_user_cap';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS chat_directives_per_user_cap ON chat_directives;
--> statement-breakpoint
CREATE TRIGGER chat_directives_per_user_cap
  BEFORE INSERT ON chat_directives
  FOR EACH ROW EXECUTE FUNCTION chat_directives_enforce_cap();
