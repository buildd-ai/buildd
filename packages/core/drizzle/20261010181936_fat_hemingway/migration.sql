CREATE TABLE "landing_lanes" (
	"repo_full_name" text NOT NULL,
	"base_ref" text NOT NULL,
	"delivery_id" uuid NOT NULL,
	"head_sha" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "landing_lanes_repo_full_name_base_ref_pk" PRIMARY KEY("repo_full_name","base_ref")
);
--> statement-breakpoint
ALTER TABLE "landing_lanes" ADD CONSTRAINT "landing_lanes_delivery_id_workflow_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."workflow_deliveries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "landing_lanes_delivery_idx" ON "landing_lanes" USING btree ("delivery_id");