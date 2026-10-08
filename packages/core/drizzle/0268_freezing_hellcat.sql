CREATE TABLE "sibling_probes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"pair_key" text NOT NULL,
	"worker_a_id" uuid NOT NULL,
	"worker_b_id" uuid NOT NULL,
	"prober_worker_id" uuid NOT NULL,
	"shared_files" jsonb NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone,
	"probed_at" timestamp with time zone,
	"outcome" text,
	"conflict_files" jsonb,
	"notified_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "sibling_probes" ADD CONSTRAINT "sibling_probes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sibling_probes" ADD CONSTRAINT "sibling_probes_worker_a_id_workers_id_fk" FOREIGN KEY ("worker_a_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sibling_probes" ADD CONSTRAINT "sibling_probes_worker_b_id_workers_id_fk" FOREIGN KEY ("worker_b_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sibling_probes" ADD CONSTRAINT "sibling_probes_prober_worker_id_workers_id_fk" FOREIGN KEY ("prober_worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sibling_probes_pair_idx" ON "sibling_probes" USING btree ("workspace_id","pair_key");--> statement-breakpoint
CREATE INDEX "sibling_probes_prober_status_idx" ON "sibling_probes" USING btree ("prober_worker_id","status");