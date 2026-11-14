/**
 * Skill retirement rule (spec "Skill candidates, usage telemetry and
 * retirement", R-14..R-16). Pure: the cron route feeds it rows and acts on the
 * verdict. Archive means disabled plus an audit row, never a delete.
 */
const DAY_MS = 86_400_000;

/** Narrowest stale/archive window the rule accepts. */
export const MIN_RETIREMENT_WINDOW_DAYS = 7;
export const DEFAULT_STALE_DAYS = 30;
export const DEFAULT_ARCHIVE_DAYS = 60;

export const RETIREMENT_MODES = ['off', 'recording', 'acting'] as const;
export type RetirementMode = (typeof RETIREMENT_MODES)[number];

/** `WorkspaceGitConfig.skillRetirement`: the owner's request. `acting` is only a request; see `gateRetirementMode`. */
export interface SkillRetirementConfig {
  mode?: RetirementMode;
}

export class RetirementWindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetirementWindowError';
  }
}

/**
 * The one place a workspace's requested retirement mode is read (spec R-16, like
 * resolvePostSessionQualityMode). Absent or unrecognised resolves to `recording`:
 * a typo must neither switch retirement off nor start archiving.
 */
export function resolveRetirementMode(
  gitConfig: { skillRetirement?: SkillRetirementConfig | null } | null | undefined,
): RetirementMode {
  const cfg = gitConfig?.skillRetirement;
  const mode = cfg && typeof cfg === 'object' ? cfg.mode : undefined;
  return mode === 'off' || mode === 'acting' ? mode : 'recording';
}

export interface ActingGateInput {
  requested: RetirementMode;
  /** The platform owner has allowed this workspace to act (never workspace-writable config). */
  platformApproved: boolean;
  /** Earliest recording-mode lifecycle event for the workspace, or null if the report never ran. */
  recordingSince: Date | null;
  /** Enabled skills the recording report covered / enabled skills in the workspace. */
  covered: number;
  total: number;
  now: Date;
  archiveDays?: number;
}

export interface ActingGateResult {
  mode: RetirementMode;
  /** Set when `acting` was requested and refused. */
  refused: string | null;
  /** Coverage stated for the report, e.g. "3/4 skills". */
  coverage: string;
}

/**
 * `acting` is granted only when the platform owner approved it and the recording
 * report has run for the full archive window. Otherwise the effective mode is
 * `recording` and the refusal says why. `off` and `recording` pass through.
 */
export function gateRetirementMode(i: ActingGateInput): ActingGateResult {
  const coverage = `${i.covered}/${i.total} skills`;
  if (i.requested !== 'acting') return { mode: i.requested, refused: null, coverage };
  const archiveDays = i.archiveDays ?? DEFAULT_ARCHIVE_DAYS;
  const refuse = (why: string): ActingGateResult => ({ mode: 'recording', refused: why, coverage });
  if (!i.platformApproved) return refuse('acting is not approved by the platform owner');
  if (!i.recordingSince) return refuse('the recording report has not run');
  const days = (i.now.getTime() - i.recordingSince.getTime()) / DAY_MS;
  if (days < archiveDays) {
    return refuse(`the recording report has run ${Math.floor(days)}d of the ${archiveDays}d archive window (coverage ${coverage})`);
  }
  if (i.total > 0 && i.covered === 0) return refuse('the recording report covered no skills');
  return { mode: 'acting', refused: null, coverage };
}

export interface RetirementSkill {
  id: string;
  slug: string;
  enabled: boolean;
  isRole: boolean;
  pinned: boolean;
  createdAt: Date;
  lastClaimedAt: Date | null;
  lastRestoredAt: Date | null;
}

/** The last moment the skill counted as live: newest of create, claim, restore and telemetry start. */
export function retirementAnchor(a: {
  createdAt: Date;
  lastClaimedAt: Date | null;
  lastRestoredAt: Date | null;
  telemetryStartedAt: Date;
}): Date {
  const times = [a.createdAt, a.lastClaimedAt, a.lastRestoredAt, a.telemetryStartedAt]
    .filter((d): d is Date => d != null)
    .map(d => d.getTime());
  return new Date(Math.max(...times));
}

export interface RetirementInput {
  skills: readonly RetirementSkill[];
  now: Date;
  telemetryStartedAt: Date;
  mode: RetirementMode;
  defaultRoleSlugs: readonly string[];
  /** Slugs named by any schedule template (enabled or not). */
  scheduleSkillSlugs: readonly string[];
  /** Slugs named by the context of a task that is running or queued. */
  activeTaskSkillSlugs: readonly string[];
  staleDays?: number;
  archiveDays?: number;
}

export interface RetirementVerdict {
  stale: RetirementSkill[];
  archivable: RetirementSkill[];
  exempt: Array<{ skill: RetirementSkill; why: 'role' | 'pinned' | 'schedule' | 'active_task' }>;
  report: string;
}

export function evaluateRetirement(input: RetirementInput): RetirementVerdict {
  const staleDays = input.staleDays ?? DEFAULT_STALE_DAYS;
  const archiveDays = input.archiveDays ?? DEFAULT_ARCHIVE_DAYS;
  if (staleDays < MIN_RETIREMENT_WINDOW_DAYS || archiveDays < MIN_RETIREMENT_WINDOW_DAYS) {
    throw new RetirementWindowError(`retirement windows must be at least ${MIN_RETIREMENT_WINDOW_DAYS} days`);
  }
  if (archiveDays < staleDays) throw new RetirementWindowError('archive window must not be shorter than the stale window');

  const roles = new Set(input.defaultRoleSlugs);
  const scheduled = new Set(input.scheduleSkillSlugs);
  const active = new Set(input.activeTaskSkillSlugs);
  const nowMs = input.now.getTime();
  const telemetryDays = (nowMs - input.telemetryStartedAt.getTime()) / DAY_MS;
  const telemetryReady = telemetryDays >= archiveDays;

  const stale: RetirementSkill[] = [];
  const archivable: RetirementSkill[] = [];
  const exempt: RetirementVerdict['exempt'] = [];

  for (const skill of input.skills) {
    if (!skill.enabled) continue;
    const why = skill.isRole || roles.has(skill.slug) ? 'role'
      : skill.pinned ? 'pinned'
      : scheduled.has(skill.slug) ? 'schedule'
      : active.has(skill.slug) ? 'active_task'
      : null;
    if (why) { exempt.push({ skill, why }); continue; }
    const idleDays = (nowMs - retirementAnchor({ ...skill, telemetryStartedAt: input.telemetryStartedAt }).getTime()) / DAY_MS;
    if (idleDays >= staleDays) stale.push(skill);
    if (telemetryReady && idleDays >= archiveDays) archivable.push(skill);
  }

  const report = telemetryReady
    ? `${stale.length} stale, ${archivable.length} past ${archiveDays}d (${input.mode})`
    : `telemetry has run ${Math.floor(telemetryDays)}d of the ${archiveDays}d needed: nothing archivable yet; ${stale.length} stale (${input.mode})`;
  return { stale, archivable, exempt, report };
}
