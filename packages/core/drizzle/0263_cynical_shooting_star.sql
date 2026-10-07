CREATE TABLE "local_session_workers" (
	"worker_id" uuid PRIMARY KEY NOT NULL,
	"local_session_id" uuid NOT NULL,
	"bound_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "local_session_workers" ADD CONSTRAINT "local_session_workers_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_session_workers" ADD CONSTRAINT "local_session_workers_local_session_id_local_sessions_id_fk" FOREIGN KEY ("local_session_id") REFERENCES "public"."local_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "local_session_workers_session_idx" ON "local_session_workers" USING btree ("local_session_id");