CREATE TABLE "credential_leases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"credential_id" uuid NOT NULL,
	"held_by_runner_id" text NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credential_leases" ADD CONSTRAINT "credential_leases_credential_id_secrets_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."secrets"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "credential_leases_credential_id_uniq" ON "credential_leases" USING btree ("credential_id");
--> statement-breakpoint
CREATE INDEX "credential_leases_expires_at_idx" ON "credential_leases" USING btree ("expires_at");
