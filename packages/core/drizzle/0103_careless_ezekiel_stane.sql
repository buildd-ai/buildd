ALTER TABLE "initiatives" ADD COLUMN "kpis" jsonb;--> statement-breakpoint
ALTER TABLE "initiatives" ADD COLUMN "kpi_state" jsonb;--> statement-breakpoint
ALTER TABLE "initiatives" ADD COLUMN "auto_verify" boolean;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "goal_criteria" jsonb;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "goal_criteria_state" jsonb;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "auto_verify" boolean;