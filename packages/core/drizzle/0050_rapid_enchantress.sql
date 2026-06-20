-- Enable pgvector extension (required for vector similarity search)
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "knowledge_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" text NOT NULL,
	"namespace" text NOT NULL,
	"corpus" text NOT NULL,
	"source_type" text NOT NULL,
	"source_path" text,
	"source_url" text,
	"content" text NOT NULL,
	"lexical_text" text,
	"embedding" vector(1024),
	"embedding_model" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"content_hash" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_chunks_namespace_idx" ON "knowledge_chunks" ("namespace");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_chunks_source_idx" ON "knowledge_chunks" ("namespace","source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_chunks_content_hash_idx" ON "knowledge_chunks" ("namespace","content_hash");--> statement-breakpoint
-- HNSW index for approximate nearest-neighbor vector search (cosine distance)
CREATE INDEX IF NOT EXISTS "knowledge_chunks_embedding_hnsw_idx" ON "knowledge_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
-- GIN index on tsvector for full-text search (functional index, no extra column)
CREATE INDEX IF NOT EXISTS "knowledge_chunks_fts_gin_idx" ON "knowledge_chunks" USING gin (to_tsvector('english', coalesce("lexical_text", "content")));
