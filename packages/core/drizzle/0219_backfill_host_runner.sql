-- Keep existing long-lived runners working: a key that has run as a long-lived
-- runner is a host runner today. One-task `--once` runs (localUiUrl ends in
-- /once/<taskId>) are not.
--
-- Two sources, because heartbeat rows alone miss runners: the stale-runner
-- sweep deletes a heartbeat row soon after its runner goes quiet, so a runner
-- offline at deploy has none. Its workers keep the localUiUrl the runner
-- registered, so recent workers catch it. MCP sessions register none.
UPDATE "accounts" SET "host_runner" = true
WHERE "id" IN (
  SELECT "account_id" FROM "worker_heartbeats"
  WHERE "local_ui_url" NOT LIKE '%/once/%'
  UNION
  SELECT "account_id" FROM "workers"
  WHERE "account_id" IS NOT NULL
    AND "local_ui_url" IS NOT NULL
    AND "local_ui_url" NOT LIKE '%/once/%'
    AND "created_at" > now() - interval '90 days'
);
