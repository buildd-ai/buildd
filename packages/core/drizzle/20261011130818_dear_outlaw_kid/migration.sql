CREATE TABLE "user_active_days" (
	"user_id" uuid NOT NULL,
	"day" date NOT NULL,
	"first_surface" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_active_days_user_id_day_pk" PRIMARY KEY("user_id","day")
);
--> statement-breakpoint
ALTER TABLE "user_active_days" ADD CONSTRAINT "user_active_days_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_active_days_day_idx" ON "user_active_days" USING btree ("day");