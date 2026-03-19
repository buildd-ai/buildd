-- Rename objectives table to missions and update related columns/indexes
--> statement-breakpoint
ALTER TABLE "objectives" RENAME TO "missions";
--> statement-breakpoint
ALTER TABLE "missions" RENAME COLUMN "parent_objective_id" TO "parent_mission_id";
--> statement-breakpoint
ALTER TABLE "tasks" RENAME COLUMN "objective_id" TO "mission_id";
--> statement-breakpoint
ALTER INDEX "objectives_team_idx" RENAME TO "missions_team_idx";
--> statement-breakpoint
ALTER INDEX "objectives_workspace_idx" RENAME TO "missions_workspace_idx";
--> statement-breakpoint
ALTER INDEX "objectives_status_idx" RENAME TO "missions_status_idx";
--> statement-breakpoint
ALTER INDEX "objectives_parent_idx" RENAME TO "missions_parent_idx";
--> statement-breakpoint
ALTER INDEX "tasks_objective_idx" RENAME TO "tasks_mission_idx";
