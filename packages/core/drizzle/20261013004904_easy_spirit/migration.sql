CREATE TABLE "spec_neighbors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"spec_id" uuid NOT NULL,
	"neighbor_spec_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"score" real NOT NULL,
	"source" text NOT NULL,
	"detail" jsonb,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "spec_neighbors_pair_kind_idx" ON "spec_neighbors" ("spec_id","neighbor_spec_id","kind");--> statement-breakpoint
CREATE INDEX "spec_neighbors_neighbor_idx" ON "spec_neighbors" ("neighbor_spec_id");--> statement-breakpoint
ALTER TABLE "spec_neighbors" ADD CONSTRAINT "spec_neighbors_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "spec_neighbors" ADD CONSTRAINT "spec_neighbors_spec_id_specs_id_fkey" FOREIGN KEY ("spec_id") REFERENCES "specs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "spec_neighbors" ADD CONSTRAINT "spec_neighbors_neighbor_spec_id_specs_id_fkey" FOREIGN KEY ("neighbor_spec_id") REFERENCES "specs"("id") ON DELETE CASCADE;