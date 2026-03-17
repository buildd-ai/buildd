-- Data fix: migration 0018 UPDATE never ran in prod (tracking table was reseeded).
-- Set is_role = true for the 5 consolidated roles.
UPDATE "workspace_skills" SET "is_role" = true WHERE "slug" IN ('builder', 'researcher', 'ops', 'finance', 'comms') AND "enabled" = true;