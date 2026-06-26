-- Phase 1: add recency-awareness columns to knowledge_chunks
-- source_ts: when the source event occurred (not when the chunk was indexed)
-- is_current: false for superseded chunks; normal queries filter this out
-- superseded_by: source_id of the chunk that replaced this one
ALTER TABLE "knowledge_chunks" ADD COLUMN "source_ts" timestamp with time zone;
ALTER TABLE "knowledge_chunks" ADD COLUMN "is_current" boolean DEFAULT true NOT NULL;
ALTER TABLE "knowledge_chunks" ADD COLUMN "superseded_by" text;

-- Index for efficient supersession queries and is_current filtering
CREATE INDEX "knowledge_chunks_entity_recency_idx" ON "knowledge_chunks" ("namespace","is_current","source_ts");
