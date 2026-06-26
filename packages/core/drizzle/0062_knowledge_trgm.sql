-- Enable pg_trgm for fuzzy entity-resolver (tier-3 similarity search).
-- The two GIN indexes below are required before resolveFuzzy() can run.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_entities_key_trgm_idx" ON "knowledge_entities" USING gin ("key" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entity_aliases_alias_trgm_idx" ON "entity_aliases" USING gin ("alias" gin_trgm_ops);
