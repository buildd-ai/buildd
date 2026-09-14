/**
 * Tier-3 weekly cron template — Slice 7 (§14) of
 * docs/design/spec-conformance.md.
 *
 * Before this slice, the Tier-3 cron existed as one hand-created schedule
 * row (`ecc45c47`, name `weekly-spec-status-drift`) whose task template had
 * buildd's own `docs/design`/`docs/specs` layout written into its prompt
 * text. That made it a one-off: no code path let a second workspace get the
 * same cron without a human hand-authoring an equivalent row from scratch.
 *
 * This builds the same template as a function of a workspace's own
 * `specsRoot`/`designRoot` (see `WorkspaceGitConfig.specConformance` in
 * db/schema.ts), so `create_schedule` — already a generic MCP action — is
 * the onboarding step for every workspace, buildd included, instead of a
 * schedule ID referenced by name.
 */

export interface Tier3ScheduleOptions {
  specsRoot?: string;
  designRoot?: string;
  cronExpression?: string;
  timezone?: string;
}

// Matches the cadence of the original hand-created row — weekly, Monday
// morning UTC. Not load-bearing: any workspace opting in can override both.
export const TIER3_DEFAULT_CRON = '0 9 * * 1';
export const TIER3_DEFAULT_TIMEZONE = 'UTC';

/**
 * `create_schedule`-ready params (see the `create_schedule` MCP action's
 * flat `{ name, cronExpression, timezone, title, description }` shape in
 * mcp-tools.ts) for a workspace's Tier-3 cron.
 */
export function buildTier3ScheduleParams(opts: Tier3ScheduleOptions = {}) {
  const specsRoot = opts.specsRoot ?? 'docs/specs';
  const designRoot = opts.designRoot ?? 'docs/design';

  return {
    name: 'weekly-spec-status-drift',
    cronExpression: opts.cronExpression ?? TIER3_DEFAULT_CRON,
    timezone: opts.timezone ?? TIER3_DEFAULT_TIMEZONE,
    title: 'Weekly spec status drift check',
    description:
      `Scope: specs with zero assertions declared only (§14 Tier 3 of ` +
      `docs/design/spec-conformance.md). A spec with at least one assertion ` +
      `is already covered by CI (Tier 2) — do not re-check it here.\n\n` +
      `Scan \`${specsRoot}/**\` and \`${designRoot}/**\`. For each doc with no ` +
      `assertions frontmatter, read its Code surface section. Do the listed ` +
      `routes, symbols, and migrations exist in the current repo? Draft 2-4 ` +
      `YAML assertion stanzas for manual review and PR.\n\n` +
      `Do not special-case any single file as exempt — report every ` +
      `zero-assertion doc as unverified and move on. This does not block ` +
      `anything: a zero-assertion spec is not a failure state, it is ` +
      `uncovered. The goal is shrinking the unverified bucket toward zero ` +
      `over time as coverage grows.`,
  };
}
