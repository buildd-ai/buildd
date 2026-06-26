-- Knowledge Graph: Phase 1 (recency), Phase 2 (entities), Phase 3 (edges)
-- Phase 1 -- add source_ts / is_current / superseded_by to knowledge_chunks
ALTER TABLE "knowledge_chunks" ADD COLUMN "source_ts" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD COLUMN "is_current" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD COLUMN "superseded_by" text;--> statement-breakpoint
CREATE INDEX "knowledge_chunks_entity_recency_idx" ON "knowledge_chunks" USING btree ("namespace","is_current","source_ts");--> statement-breakpoint

-- Phase 2 -- entity tables
CREATE TABLE IF NOT EXISTS "knowledge_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"canonical_name" text NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "entity_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"alias" text NOT NULL,
	"source" text DEFAULT 'system' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chunk_entities" (
	"chunk_source_id" text NOT NULL,
	"namespace" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"role" text DEFAULT 'mentions' NOT NULL,
	CONSTRAINT "chunk_entities_chunk_source_id_namespace_entity_id_role_pk" PRIMARY KEY("chunk_source_id","namespace","entity_id","role")
);
--> statement-breakpoint
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
);
--> statement-breakpoint

-- Phase 3 -- edges table
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
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "entity_aliases" ADD CONSTRAINT "entity_aliases_entity_id_knowledge_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "knowledge_entities"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chunk_entities" ADD CONSTRAINT "chunk_entities_entity_id_knowledge_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "knowledge_entities"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pending_entity_refs" ADD CONSTRAINT "pending_entity_refs_resolved_entity_id_knowledge_entities_id_fk" FOREIGN KEY ("resolved_entity_id") REFERENCES "knowledge_entities"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "knowledge_edges" ADD CONSTRAINT "knowledge_edges_from_entity_id_knowledge_entities_id_fk" FOREIGN KEY ("from_entity_id") REFERENCES "knowledge_entities"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "knowledge_edges" ADD CONSTRAINT "knowledge_edges_to_entity_id_knowledge_entities_id_fk" FOREIGN KEY ("to_entity_id") REFERENCES "knowledge_entities"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_entities_workspace_key_idx" ON "knowledge_entities" USING btree ("workspace_id","kind","key");--> statement-breakpoint
CREATE INDEX "knowledge_entities_workspace_kind_idx" ON "knowledge_entities" USING btree ("workspace_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "entity_aliases_entity_alias_idx" ON "entity_aliases" USING btree ("entity_id","alias");--> statement-breakpoint
CREATE INDEX "chunk_entities_entity_idx" ON "chunk_entities" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "pending_entity_refs_workspace_idx" ON "pending_entity_refs" USING btree ("workspace_id","resolved_at");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_edges_unique_idx" ON "knowledge_edges" USING btree ("workspace_id","from_entity_id","to_entity_id","type");--> statement-breakpoint
CREATE INDEX "knowledge_edges_from_idx" ON "knowledge_edges" USING btree ("workspace_id","from_entity_id");--> statement-breakpoint
CREATE INDEX "knowledge_edges_to_idx" ON "knowledge_edges" USING btree ("workspace_id","to_entity_id");
