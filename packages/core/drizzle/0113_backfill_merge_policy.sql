-- Backfill mergePolicy for workspaces that still have legacy auto-merge fields.
-- Step 1: Synthesize mergePolicy from legacy fields for workspaces that lack one.
--> statement-breakpoint
UPDATE workspaces
SET git_config = jsonb_set(
  COALESCE(git_config, '{}'),
  '{mergePolicy}',
  CASE
    -- If autoMergeOnGreenCI is explicitly false, or autoMergePR is false (and
    -- autoMergeOnGreenCI is absent), synthesize a human-tier policy.
    WHEN (git_config->>'autoMergeOnGreenCI')::boolean = false
      OR (
        git_config->>'autoMergeOnGreenCI' IS NULL
        AND (git_config->>'autoMergePR')::boolean = false
      )
    THEN '{"tier":"human"}'::jsonb
    -- Otherwise synthesize auto-threshold with the existing limits.
    ELSE jsonb_build_object(
      'tier', 'auto-threshold',
      'threshold', jsonb_build_object(
        'maxLines', COALESCE((git_config->>'autoMergeMaxLines')::int, 800),
        'denyPaths', COALESCE(git_config->'autoMergeDenyPaths', '[]'::jsonb)
      )
    )
  END
)
WHERE git_config IS NOT NULL
  AND git_config->>'mergePolicy' IS NULL
  AND (
    git_config ? 'autoMergeOnGreenCI'
    OR git_config ? 'autoMergePR'
    OR git_config ? 'autoMergeMaxLines'
    OR git_config ? 'autoMergeDenyPaths'
  );
--> statement-breakpoint
-- Step 2: Strip legacy auto-merge fields from all workspaces (both those that
-- already had a mergePolicy and those just backfilled above).
UPDATE workspaces
SET git_config = git_config
  - 'autoMergePR'
  - 'autoMergeOnGreenCI'
  - 'autoMergeMaxLines'
  - 'autoMergeDenyPaths'
WHERE git_config IS NOT NULL
  AND (
    git_config ? 'autoMergePR'
    OR git_config ? 'autoMergeOnGreenCI'
    OR git_config ? 'autoMergeMaxLines'
    OR git_config ? 'autoMergeDenyPaths'
  );
