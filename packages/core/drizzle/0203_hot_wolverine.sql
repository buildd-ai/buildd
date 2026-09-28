ALTER TABLE "knowledge_chunks" ADD COLUMN "lexical_tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(lexical_text, content))) STORED;--> statement-breakpoint
CREATE INDEX "knowledge_chunks_lexical_tsv_gin_idx" ON "knowledge_chunks" USING gin ("lexical_tsv");--> statement-breakpoint
-- Replaced by the GIN index on the stored lexical_tsv column above. This
-- functional index was hand-written in 0050 (not in schema.ts), so drizzle
-- cannot emit its drop.
DROP INDEX IF EXISTS "knowledge_chunks_fts_gin_idx";
