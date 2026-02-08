CREATE TABLE IF NOT EXISTS "device_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_code" text NOT NULL,
	"device_token" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"user_id" uuid,
	"api_key" text,
	"client_name" text DEFAULT 'CLI' NOT NULL,
	"level" text DEFAULT 'admin' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_codes_user_code_unique" UNIQUE("user_code"),
	CONSTRAINT "device_codes_device_token_unique" UNIQUE("device_token")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "device_codes_user_code_idx" ON "device_codes" ("user_code");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "device_codes_device_token_idx" ON "device_codes" ("device_token");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_codes_status_idx" ON "device_codes" ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_codes_expires_at_idx" ON "device_codes" ("expires_at");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "device_codes" ADD CONSTRAINT "device_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
