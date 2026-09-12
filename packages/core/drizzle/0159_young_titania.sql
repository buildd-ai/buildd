CREATE TABLE "action_queue_snoozes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"subject_key" text NOT NULL,
	"snoozed_until" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "action_queue_snoozes" ADD CONSTRAINT "action_queue_snoozes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_queue_snoozes" ADD CONSTRAINT "action_queue_snoozes_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "action_queue_snoozes_user_subject_idx" ON "action_queue_snoozes" USING btree ("user_id","subject_key");--> statement-breakpoint
CREATE INDEX "action_queue_snoozes_team_idx" ON "action_queue_snoozes" USING btree ("team_id");