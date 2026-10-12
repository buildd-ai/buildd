CREATE TABLE "release_flow_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"step" text NOT NULL,
	"outcome" text NOT NULL,
	"version" text,
	"candidate_sha" text,
	"pr_number" integer,
	"mission_id" uuid,
	"detail" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "release_flow_steps" ADD CONSTRAINT "release_flow_steps_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_flow_steps" ADD CONSTRAINT "release_flow_steps_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "release_flow_steps_workspace_occurred_idx" ON "release_flow_steps" USING btree ("workspace_id","occurred_at");