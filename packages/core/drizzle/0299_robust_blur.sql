CREATE TABLE "capability_grant_reservations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"grant_id" uuid NOT NULL,
	"usd_micros" bigint NOT NULL,
	"tokens" bigint NOT NULL,
	"reserved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	"debit_usd_micros" bigint,
	"debit_tokens" bigint,
	"cost_source" text,
	"outcome" text
);
--> statement-breakpoint
CREATE TABLE "capability_grant_usage" (
	"grant_id" uuid PRIMARY KEY NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"tokens" bigint DEFAULT 0 NOT NULL,
	"usd_micros" bigint DEFAULT 0 NOT NULL,
	"in_flight" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "capability_grant_reservations" ADD CONSTRAINT "capability_grant_reservations_grant_id_capability_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."capability_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_grant_usage" ADD CONSTRAINT "capability_grant_usage_grant_id_capability_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."capability_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "capability_grant_reservations_open_idx" ON "capability_grant_reservations" USING btree ("grant_id","reserved_at") WHERE "capability_grant_reservations"."settled_at" IS NULL;