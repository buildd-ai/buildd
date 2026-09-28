CREATE TABLE "heartbeat_triage_looks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mission_id" uuid NOT NULL,
	"schedule_id" uuid,
	"task_id" uuid,
	"experiment_id" uuid,
	"policy_version" integer,
	"arm" text,
	"prompt_version" text NOT NULL,
	"model" text,
	"pick" text,
	"confidence" real,
	"skipped" boolean NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "heartbeat_triage_looks" ADD CONSTRAINT "heartbeat_triage_looks_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeat_triage_looks" ADD CONSTRAINT "heartbeat_triage_looks_schedule_id_task_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."task_schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeat_triage_looks" ADD CONSTRAINT "heartbeat_triage_looks_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeat_triage_looks" ADD CONSTRAINT "heartbeat_triage_looks_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "heartbeat_triage_looks_mission_created_idx" ON "heartbeat_triage_looks" USING btree ("mission_id","created_at");--> statement-breakpoint
CREATE INDEX "heartbeat_triage_looks_experiment_arm_idx" ON "heartbeat_triage_looks" USING btree ("experiment_id","policy_version","arm");--> statement-breakpoint
CREATE INDEX "heartbeat_triage_looks_task_idx" ON "heartbeat_triage_looks" USING btree ("task_id");