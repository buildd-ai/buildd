CREATE TABLE "knowledge_namespaces" (
	"namespace" text PRIMARY KEY,
	"team_id" uuid,
	"corpus" text NOT NULL,
	"embedding_provider" text,
	"embedding_model" text NOT NULL,
	"dimensions" integer NOT NULL,
	"vector_column" text NOT NULL,
	"reembed_status" text DEFAULT 'none' NOT NULL,
	"reembed_total" integer DEFAULT 0 NOT NULL,
	"reembed_done" integer DEFAULT 0 NOT NULL,
	"reembed_started_at" timestamp with time zone,
	"reembed_finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_relay_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"team_id" uuid NOT NULL,
	"workspace_id" uuid,
	"runner_id" uuid,
	"kind" text NOT NULL,
	"surface" text NOT NULL,
	"namespace" text,
	"model" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"payload" jsonb NOT NULL,
	"result" jsonb,
	"error" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"not_before" timestamp with time zone DEFAULT now() NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"leased_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "model_relay_usage_daily" (
	"day" date,
	"team_id" uuid,
	"runner_id" uuid,
	"kind" text,
	"model" text,
	"jobs" bigint DEFAULT 0 NOT NULL,
	"errors" bigint DEFAULT 0 NOT NULL,
	"prompt_tokens" bigint DEFAULT 0 NOT NULL,
	"completion_tokens" bigint DEFAULT 0 NOT NULL,
	"duration_ms" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "model_relay_usage_daily_pkey" PRIMARY KEY("day","team_id","runner_id","kind","model")
);
--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD COLUMN "embedding_768" vector(768);--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD COLUMN "embedding_1536" vector(1536);--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "local_runner" jsonb;--> statement-breakpoint
ALTER TABLE "worker_heartbeats" ADD COLUMN "local_models" jsonb;--> statement-breakpoint
ALTER TABLE "worker_heartbeats" ADD COLUMN "local_models_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "knowledge_chunks_embedding_768_hnsw_idx" ON "knowledge_chunks" USING hnsw ("embedding_768" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "knowledge_chunks_embedding_1536_hnsw_idx" ON "knowledge_chunks" USING hnsw ("embedding_1536" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "knowledge_namespaces_team_idx" ON "knowledge_namespaces" ("team_id");--> statement-breakpoint
CREATE INDEX "knowledge_namespaces_reembed_idx" ON "knowledge_namespaces" ("reembed_status") WHERE "reembed_status" IN ('pending', 'running');--> statement-breakpoint
CREATE INDEX "model_relay_jobs_claim_idx" ON "model_relay_jobs" ("team_id","runner_id","status","not_before");--> statement-breakpoint
CREATE INDEX "model_relay_jobs_deadline_idx" ON "model_relay_jobs" ("deadline_at") WHERE "status" IN ('queued', 'leased');--> statement-breakpoint
CREATE INDEX "model_relay_jobs_finished_idx" ON "model_relay_jobs" ("finished_at");--> statement-breakpoint
ALTER TABLE "model_relay_jobs" ADD CONSTRAINT "model_relay_jobs_team_id_teams_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "model_relay_jobs" ADD CONSTRAINT "model_relay_jobs_runner_id_worker_heartbeats_id_fkey" FOREIGN KEY ("runner_id") REFERENCES "worker_heartbeats"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "model_relay_usage_daily" ADD CONSTRAINT "model_relay_usage_daily_team_id_teams_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_one_vector" CHECK (num_nonnulls("embedding", "embedding_768", "embedding_1536") <= 1);