-- @buildd-ai/knowledge-store — canonical schema for consumers (buildd, memory service, cue).
-- Idempotent. Statements are delimited by the drizzle statement-breakpoint marker
-- (see drizzle migrations) so HTTP drivers can split multi-command SQL.
-- NOTE: keep that marker token out of comments — drizzle splits the file on it.
-- namespace convention: scopeId:corpus (scopeId is tenant/workspace/team).

CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint

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
	"source_ts" timestamp with time zone,
	"is_current" boolean DEFAULT true NOT NULL,
	"superseded_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_chunks_namespace_idx" ON "knowledge_chunks" ("namespace");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_chunks_source_idx" ON "knowledge_chunks" ("namespace","source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_chunks_content_hash_idx" ON "knowledge_chunks" ("namespace","content_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_chunks_entity_recency_idx" ON "knowledge_chunks" USING btree ("namespace","is_current","source_ts");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_chunks_embedding_hnsw_idx" ON "knowledge_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_chunks_fts_gin_idx" ON "knowledge_chunks" USING gin (to_tsvector('english', coalesce("lexical_text", "content")));--> statement-breakpoint

-- Entity graph (optional; required only if you pass entities/relations or use useGraph queries).
CREATE TABLE IF NOT EXISTS "knowledge_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"canonical_name" text NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_entities_workspace_kind_idx" ON "knowledge_entities" ("workspace_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_entities_workspace_key_idx" ON "knowledge_entities" ("workspace_id","kind","key");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "entity_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"alias" text NOT NULL,
	"source" text DEFAULT 'system' NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "entity_aliases_entity_alias_idx" ON "entity_aliases" ("entity_id","alias");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "chunk_entities" (
	"chunk_source_id" text NOT NULL,
	"namespace" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"role" text DEFAULT 'mentions' NOT NULL,
	CONSTRAINT "chunk_entities_chunk_source_id_namespace_entity_id_role_pk" PRIMARY KEY("chunk_source_id","namespace","entity_id","role")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chunk_entities_entity_idx" ON "chunk_entities" ("entity_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "pending_entity_refs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"raw_ref" text NOT NULL,
	"kind_hint" text,
	"source_chunk_id" text,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_entity_id" uuid
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pending_entity_refs_workspace_idx" ON "pending_entity_refs" ("workspace_id","resolved_at");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "knowledge_edges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"from_entity_id" uuid NOT NULL,
	"to_entity_id" uuid NOT NULL,
	"type" text NOT NULL,
	"weight" numeric(5, 4) DEFAULT '1.0' NOT NULL,
	"source_chunk_id" text,
	"rule" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_edges_from_idx" ON "knowledge_edges" ("workspace_id","from_entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_edges_to_idx" ON "knowledge_edges" ("workspace_id","to_entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_edges_unique_idx" ON "knowledge_edges" ("workspace_id","from_entity_id","to_entity_id","type");
