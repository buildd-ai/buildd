-- Reconciliation migration for the Schema Drift / check-prod gate (found while
-- investigating the tasks_source_external_idx incident, 2026-07-19).
--
-- Four tables were intentionally dropped by early migrations but the DROPs
-- never actually landed on at least one live database (confirmed by direct
-- `bun run scripts/check-schema-drift.ts` output showing all four as
-- "EXTRA TABLE ... untracked manual DDL", with full original column sets
-- still intact — i.e. untouched, not partially migrated):
--
--   - "skills"  and "sources"  — DROP TABLE issued by 0002_flimsy_namora.sql,
--     superseded by the "workspace_skills" table.
--   - "observations" — DROP TABLE issued by 0003_clean_la_nuit.sql,
--     superseded by the external memory service (see schema.ts comment
--     "observations table removed — memory is now stored in external memory
--     service").
--   - "secret_refs" — DROP TABLE issued by 0021_faithful_warbound.sql and
--     re-issued idempotently by 0074_reconcile_missions_secret_refs_drift.sql,
--     superseded by the "secrets" table. Still showing as drift after TWO
--     prior drop attempts — whatever database this was checked against never
--     ran either one.
--
-- Exact mechanism unconfirmed — candidates include a journal `when`-ordering
-- skip (same class as 0074/0067), an interrupted migrate.ts run leaving DDL
-- applied but untracked (see packages/core/db/migrate-plan.ts), or a
-- `db:push` run against this DB from an older schema.ts checkout bypassing
-- migration tracking entirely (CLAUDE.md warns against this in prod for
-- exactly this reason). Not worth root-causing further — the fix is the same
-- either way. None of these four tables are referenced anywhere in current application
-- code (grepped apps/ and packages/ — the only hits are unrelated JS
-- property names in integration tests and the removal comment in schema.ts
-- itself), so dropping them is safe from a functionality standpoint.
--
-- Row-count / data-loss check: NOT independently re-verified against a live
-- database as part of authoring this migration (no DB credentials available
-- in that session). 0074's 2026-07-12 introspection found "secret_refs" at 0
-- rows. Before running this against any environment that still matters,
-- confirm row counts are 0 (or contain nothing worth preserving) for all
-- four tables — e.g.:
--   SELECT 'skills', count(*) FROM skills
--   UNION ALL SELECT 'sources', count(*) FROM sources
--   UNION ALL SELECT 'observations', count(*) FROM observations
--   UNION ALL SELECT 'secret_refs', count(*) FROM secret_refs;
--
-- schema.ts is NOT changed by this migration — it already correctly omits
-- all four tables; the database is what needs to catch up.

DROP TABLE IF EXISTS "skills";--> statement-breakpoint
DROP TABLE IF EXISTS "sources";--> statement-breakpoint
DROP TABLE IF EXISTS "observations";--> statement-breakpoint
DROP TABLE IF EXISTS "secret_refs";
