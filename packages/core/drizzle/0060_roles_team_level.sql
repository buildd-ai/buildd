-- Roles: generalize from per-workspace to team-level with optional workspace overrides.
-- Mirrors the secrets/missions scoping model. See docs/design/unified-app-ia.md §C.
--
-- DIVERGENCE DETECTOR: run before any dedup. Roles with the same slug but different
-- content/model/allowedTools/mcpServers across workspaces become workspace overrides;
-- identical definitions are promoted to a single team-level row.

-- Step 1: Add team_id (nullable initially to allow backfill)
ALTER TABLE "workspace_skills" ADD COLUMN "team_id" uuid;--> statement-breakpoint

-- Step 2: Backfill team_id from workspace's team
UPDATE "workspace_skills" ws
   SET team_id = w.team_id
  FROM "workspaces" w
 WHERE w.id = ws.workspace_id;--> statement-breakpoint

-- Step 3: Make team_id NOT NULL (all rows now have a value from backfill)
ALTER TABLE "workspace_skills" ALTER COLUMN "team_id" SET NOT NULL;--> statement-breakpoint

-- Step 4: Add FK constraint
DO $$ BEGIN
 ALTER TABLE "workspace_skills" ADD CONSTRAINT "workspace_skills_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- Step 5: Make workspace_id nullable (was NOT NULL)
ALTER TABLE "workspace_skills" ALTER COLUMN "workspace_id" DROP NOT NULL;--> statement-breakpoint

-- Step 6: Divergence detection query (logged for visibility — does not abort migration)
-- Roles that diverge across workspaces become per-workspace overrides (Step 8 skips them).
-- SELECT team_id, slug,
--        COUNT(DISTINCT md5(COALESCE(content,'') || COALESCE(model,'') || COALESCE(allowed_tools::text,'[]') || COALESCE(mcp_servers::text,'{}'))) AS distinct_configs,
--        array_agg(workspace_id) AS workspace_ids
--   FROM workspace_skills WHERE is_role = true
--  GROUP BY team_id, slug
-- HAVING COUNT(DISTINCT md5(COALESCE(content,'') || COALESCE(model,'') || COALESCE(allowed_tools::text,'[]') || COALESCE(mcp_servers::text,'{}'))) > 1;

-- Step 7: Promote single-workspace roles to team-level
-- For each (team_id, slug) with exactly ONE per-workspace row, convert it to team-level.
UPDATE "workspace_skills"
   SET workspace_id = NULL
 WHERE is_role = true
   AND workspace_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM "workspace_skills" other
      WHERE other.team_id = "workspace_skills".team_id
        AND other.slug = "workspace_skills".slug
        AND other.workspace_id IS NOT NULL
        AND other.id != "workspace_skills".id
   )
   AND NOT EXISTS (
     SELECT 1 FROM "workspace_skills" team_row
      WHERE team_row.team_id = "workspace_skills".team_id
        AND team_row.slug = "workspace_skills".slug
        AND team_row.workspace_id IS NULL
   );
--> statement-breakpoint

-- Step 8: Promote convergent multi-workspace roles to a single team-level row.
-- Insert one team-level row for groups where all per-workspace definitions are identical,
-- then delete the per-workspace copies. Divergent groups are left as workspace overrides.
WITH identical_groups AS (
  SELECT team_id, slug
    FROM "workspace_skills"
   WHERE is_role = true AND workspace_id IS NOT NULL
   GROUP BY team_id, slug
  HAVING COUNT(DISTINCT md5(
    COALESCE(content,'') || COALESCE(model,'') ||
    COALESCE(allowed_tools::text,'[]') ||
    COALESCE(mcp_servers::text,'{}')
  )) = 1
),
representative AS (
  SELECT DISTINCT ON (ws.team_id, ws.slug) ws.*
    FROM "workspace_skills" ws
   INNER JOIN identical_groups ig ON ws.team_id = ig.team_id AND ws.slug = ig.slug
   ORDER BY ws.team_id, ws.slug, ws.created_at
)
INSERT INTO "workspace_skills" (
  id, team_id, workspace_id, account_id, slug, name, description,
  content, content_hash, source, enabled, origin, metadata, model,
  default_backend, allowed_tools, can_delegate_to, background, max_turns,
  color, mcp_servers, required_env_vars, is_role, config_hash,
  config_storage_key, repo_url, created_at, updated_at
)
SELECT
  gen_random_uuid(), team_id, NULL, account_id, slug, name, description,
  content, content_hash, source, enabled, origin, metadata, model,
  default_backend, allowed_tools, can_delegate_to, background, max_turns,
  color, mcp_servers, required_env_vars, is_role, config_hash,
  config_storage_key, repo_url, NOW(), NOW()
FROM representative
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- Delete the per-workspace copies that were promoted to team-level
DELETE FROM "workspace_skills" ws
 WHERE is_role = true
   AND workspace_id IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM "workspace_skills" team_row
      WHERE team_row.team_id = ws.team_id
        AND team_row.slug = ws.slug
        AND team_row.workspace_id IS NULL
   );
--> statement-breakpoint

-- Step 9: Drop old unique index (no WHERE clause)
DROP INDEX IF EXISTS "workspace_skills_workspace_slug_idx";--> statement-breakpoint

-- Step 10: Add partial unique index for team-level roles
CREATE UNIQUE INDEX IF NOT EXISTS "ws_skills_team_slug_idx" ON "workspace_skills" ("team_id","slug") WHERE workspace_id IS NULL;--> statement-breakpoint

-- Step 11: Add partial unique index for workspace overrides
CREATE UNIQUE INDEX IF NOT EXISTS "ws_skills_workspace_slug_idx" ON "workspace_skills" ("workspace_id","slug") WHERE workspace_id IS NOT NULL;--> statement-breakpoint

-- Step 12: Add team index for fast lookup
CREATE INDEX IF NOT EXISTS "workspace_skills_team_idx" ON "workspace_skills" ("team_id");
