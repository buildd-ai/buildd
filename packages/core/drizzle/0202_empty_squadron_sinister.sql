ALTER TABLE "knowledge_chunks" ADD COLUMN "lexical_tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(lexical_text, content))) STORED;
--> statement-breakpoint
-- GIN index on the stored generated column — replaces the functional index below,
-- which recomputed to_tsvector(...) for every row on every lexical query.
CREATE INDEX IF NOT EXISTS "knowledge_chunks_lexical_tsv_gin_idx" ON "knowledge_chunks" USING gin ("lexical_tsv");
--> statement-breakpoint
DROP INDEX IF EXISTS "knowledge_chunks_fts_gin_idx";