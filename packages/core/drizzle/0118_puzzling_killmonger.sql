CREATE TABLE "backend_pauses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"workspace_id" uuid,
	"backend" "agent_backend" NOT NULL,
	"reason" text DEFAULT 'budget' NOT NULL,
	"paused_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resets_at" timestamp with time zone NOT NULL,
	"source_worker_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "backend_pauses" ADD CONSTRAINT "backend_pauses_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backend_pauses" ADD CONSTRAINT "backend_pauses_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backend_pauses" ADD CONSTRAINT "backend_pauses_source_worker_id_workers_id_fk" FOREIGN KEY ("source_worker_id") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "backend_pauses_team_backend_resets_idx" ON "backend_pauses" USING btree ("team_id","backend","resets_at");