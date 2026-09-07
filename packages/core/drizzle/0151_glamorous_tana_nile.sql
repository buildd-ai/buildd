CREATE TABLE "worker_prompt_composition_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"worker_id" uuid NOT NULL,
	"task_id" uuid,
	"build_index" integer NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"policy_version" text NOT NULL,
	"arm" text NOT NULL,
	"propensity" numeric(5, 4) NOT NULL,
	"fraction" numeric(5, 4) NOT NULL,
	"digest_bytes" integer NOT NULL,
	"digest_bytes_available" integer NOT NULL,
	"digest_truncated" boolean NOT NULL,
	"task_match_bytes" integer NOT NULL,
	"task_match_count" integer NOT NULL,
	"memory_block_bytes" integer NOT NULL,
	"prompt_bytes" integer NOT NULL,
	"memory_share" numeric(5, 4) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "worker_prompt_composition_events" ADD CONSTRAINT "worker_prompt_composition_events_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_prompt_composition_events" ADD CONSTRAINT "worker_prompt_composition_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "worker_prompt_composition_events_worker_build_idx" ON "worker_prompt_composition_events" USING btree ("worker_id","build_index");--> statement-breakpoint
CREATE INDEX "worker_prompt_composition_events_task_ts_idx" ON "worker_prompt_composition_events" USING btree ("task_id","ts");--> statement-breakpoint
CREATE INDEX "worker_prompt_composition_events_policy_arm_idx" ON "worker_prompt_composition_events" USING btree ("policy_version","arm");