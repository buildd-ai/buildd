-- Backend-auth credentials are singletons per scope. Before enforcing that with a
-- unique index, collapse any pre-existing duplicates (keep the newest per scope) so
-- this migration cannot fail-and-freeze prod on a leftover duplicate row.
-- NULL-aware scope match via IS NOT DISTINCT FROM (team-wide rows have NULL
-- account/workspace/label). Prod was already deduped out-of-band, so this is a
-- no-op there; it self-heals preview/dev environments.
DELETE FROM "secrets" a
USING "secrets" b
WHERE a."purpose" IN ('oauth_token','anthropic_api_key','codex_credential','claude_credential')
  AND a."purpose" = b."purpose"
  AND a."team_id" = b."team_id"
  AND a."account_id" IS NOT DISTINCT FROM b."account_id"
  AND a."workspace_id" IS NOT DISTINCT FROM b."workspace_id"
  AND a."label" IS NOT DISTINCT FROM b."label"
  AND (a."updated_at" < b."updated_at" OR (a."updated_at" = b."updated_at" AND a."id" < b."id"));
--> statement-breakpoint
-- NULLS NOT DISTINCT (hand-added; drizzle-kit 0.45.2 can't emit it) so team-wide
-- rows with NULL account/workspace/label collide instead of piling up.
CREATE UNIQUE INDEX "secrets_scoped_auth_credential_idx" ON "secrets" USING btree ("team_id","account_id","workspace_id","purpose","label") NULLS NOT DISTINCT WHERE "secrets"."purpose" in ('oauth_token','anthropic_api_key','codex_credential','claude_credential');
