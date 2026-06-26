-- Phase 2: Entity extraction tables for KnowledgeStore retrieval v2.
-- Implements §4 (Layer 1 recency columns), §5 (Layer 2 entity tables), and
-- §6 (Layer 3 edge table) from docs/design/knowledge-graph-retrieval.md.
-- All changes are additive — no existing columns are dropped or renamed.

-- Require pg_trgm for fuzzy alias resolution (already available on Neon)
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint

-- ── Layer 1: Recency + supersession columns on knowledge_chunks ──────────────

ALTER TABLE "knowledge_chunks"
  ADD COLUMN IF NOT EXISTS "source_ts" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "is_current" boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "superseded_by" text;--> statement-breakpoint

-- Index for supersession queries: current chunks sorted by recency per namespace
CREATE INDEX IF NOT EXISTS "knowledge_chunks_entity_recency_idx"
  ON "knowledge_chunks" ("namespace", "is_current", "source_ts" DESC NULLS LAST);--> statement-breakpoint

-- ── Layer 2: Entity tables ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "knowledge_entities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" text NOT NULL,
  "kind" text NOT NULL,
  "key" text NOT NULL,
  "canonical_name" text NOT NULL,
  "attributes" jsonb NOT NULL DEFAULT '{}',
  "first_seen_at" timestamp with time zone NOT NULL DEFAULT now(),
  "last_seen_at" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "knowledge_entities_workspace_kind_idx"
  ON "knowledge_entities" ("workspace_id", "kind");--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_entities_unique_idx"
  ON "knowledge_entities" ("workspace_id", "kind", "key");--> statement-breakpoint

-- pg_trgm GIN index for fuzzy key lookup
CREATE INDEX IF NOT EXISTS "knowledge_entities_key_trgm_idx"
  ON "knowledge_entities" USING gin ("key" gin_trgm_ops);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "entity_aliases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "entity_id" uuid NOT NULL,
  "alias" text NOT NULL,
  "source" text NOT NULL DEFAULT 'system'
);--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "entity_aliases"
    ADD CONSTRAINT "entity_aliases_entity_id_knowledge_entities_id_fk"
    FOREIGN KEY ("entity_id") REFERENCES "knowledge_entities"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "entity_aliases_unique_idx"
  ON "entity_aliases" ("entity_id", "alias");--> statement-breakpoint

-- pg_trgm GIN index for fuzzy alias lookup
CREATE INDEX IF NOT EXISTS "entity_aliases_alias_trgm_idx"
  ON "entity_aliases" USING gin ("alias" gin_trgm_ops);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "chunk_entities" (
  "chunk_source_id" text NOT NULL,
  "namespace" text NOT NULL,
  "entity_id" uuid NOT NULL,
  "role" text NOT NULL DEFAULT 'mentions',
  CONSTRAINT "chunk_entities_pkey" PRIMARY KEY ("chunk_source_id", "namespace", "entity_id", "role")
);--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "chunk_entities"
    ADD CONSTRAINT "chunk_entities_entity_id_knowledge_entities_id_fk"
    FOREIGN KEY ("entity_id") REFERENCES "knowledge_entities"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "chunk_entities_entity_idx"
  ON "chunk_entities" ("entity_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "pending_entity_refs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" text NOT NULL,
  "raw_ref" text NOT NULL,
  "kind_hint" text,
  "source_chunk_id" text,
  "source" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "resolved_at" timestamp with time zone,
  "resolved_entity_id" uuid
);--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "pending_entity_refs"
    ADD CONSTRAINT "pending_entity_refs_resolved_entity_id_knowledge_entities_id_fk"
    FOREIGN KEY ("resolved_entity_id") REFERENCES "knowledge_entities"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "pending_entity_refs_workspace_idx"
  ON "pending_entity_refs" ("workspace_id", "resolved_at");--> statement-breakpoint

-- ── Layer 3: Graph edges ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "knowledge_edges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" text NOT NULL,
  "from_entity_id" uuid NOT NULL,
  "to_entity_id" uuid NOT NULL,
  "type" text NOT NULL,
  "weight" real NOT NULL DEFAULT 1,
  "source_chunk_id" text,
  "rule" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "knowledge_edges"
    ADD CONSTRAINT "knowledge_edges_from_entity_id_knowledge_entities_id_fk"
    FOREIGN KEY ("from_entity_id") REFERENCES "knowledge_entities"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "knowledge_edges"
    ADD CONSTRAINT "knowledge_edges_to_entity_id_knowledge_entities_id_fk"
    FOREIGN KEY ("to_entity_id") REFERENCES "knowledge_entities"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_edges_unique_idx"
  ON "knowledge_edges" ("workspace_id", "from_entity_id", "to_entity_id", "type");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "knowledge_edges_from_idx"
  ON "knowledge_edges" ("workspace_id", "from_entity_id");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "knowledge_edges_to_idx"
  ON "knowledge_edges" ("workspace_id", "to_entity_id");
