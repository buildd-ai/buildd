CREATE TABLE "initiative_progress_seen" (
	"user_id" uuid NOT NULL,
	"initiative_id" uuid NOT NULL,
	"last_progress" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "initiative_progress_seen_user_id_initiative_id_pk" PRIMARY KEY("user_id","initiative_id")
);
--> statement-breakpoint
ALTER TABLE "initiative_progress_seen" ADD CONSTRAINT "initiative_progress_seen_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "initiative_progress_seen" ADD CONSTRAINT "initiative_progress_seen_initiative_id_initiatives_id_fk" FOREIGN KEY ("initiative_id") REFERENCES "public"."initiatives"("id") ON DELETE cascade ON UPDATE no action;