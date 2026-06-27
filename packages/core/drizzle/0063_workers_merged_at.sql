-- Track when a worker's PR was merged (set by GitHub webhook on pull_request:closed+merged).
-- Used by the dependsOn gate at claim time to distinguish "task completed before PR merged"
-- from "PR actually landed" — prevents downstream tasks from branching off an unmerged PR.
ALTER TABLE "workers" ADD COLUMN "merged_at" timestamp with time zone;
