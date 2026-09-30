-- Keep existing long-lived runners working: a key that has already heartbeated
-- as a long-lived runner (any heartbeat that is not a one-task `--once` run,
-- whose localUiUrl ends in /once/<taskId>) is a host runner today.
UPDATE "accounts" SET "host_runner" = true
WHERE "id" IN (
  SELECT DISTINCT "account_id" FROM "worker_heartbeats"
  WHERE "local_ui_url" NOT LIKE '%/once/%'
);
