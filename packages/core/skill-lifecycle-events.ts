/**
 * Skill lifecycle events: pure builders for the audit rows (archive disables,
 * never deletes; restore re-enables and leaves content alone) plus the
 * restore-on-update helper the skill update paths share.
 */
export interface LifecycleSkillRow {
  id: string;
  teamId: string;
  enabled: boolean;
  content: string;
  contentHash: string;
}

export interface LifecycleEvent {
  skillId: string;
  teamId: string;
  action: 'stale' | 'would_archive' | 'archived' | 'restored';
  mode: 'recording' | 'acting' | 'manual';
  reason: string | null;
  previousEnabled: boolean;
  previousContentHash: string;
  createdAt: Date;
}

function event<T extends LifecycleSkillRow>(
  skill: T, action: LifecycleEvent['action'], mode: LifecycleEvent['mode'], reason: string | null, now: Date,
): LifecycleEvent {
  return {
    skillId: skill.id, teamId: skill.teamId, action, mode, reason,
    previousEnabled: skill.enabled, previousContentHash: skill.contentHash, createdAt: now,
  };
}

export function archiveSkill<T extends LifecycleSkillRow>(
  skill: T, opts: { mode: 'recording' | 'acting'; reason: string; now: Date },
): { skill: T; event: LifecycleEvent } {
  // Recording mode only describes what acting mode would do: the row is untouched.
  if (opts.mode === 'recording') {
    return { skill, event: event(skill, 'would_archive', 'recording', opts.reason, opts.now) };
  }
  return { skill: { ...skill, enabled: false }, event: event(skill, 'archived', 'acting', opts.reason, opts.now) };
}

export function restoreSkill<T extends LifecycleSkillRow>(
  skill: T, opts: { now: Date },
): { skill: T; event: LifecycleEvent } {
  return { skill: { ...skill, enabled: true }, event: event(skill, 'restored', 'manual', null, opts.now) };
}

/** True when an update flips a skill from disabled to enabled. */
export function isRestoration(previousEnabled: boolean, nextEnabled: boolean | undefined): boolean {
  return previousEnabled === false && nextEnabled === true;
}

/** Best-effort audit write for a manual re-enable; never fails the update. */
export async function recordRestored(
  skill: { id: string; teamId: string; contentHash: string },
  now: Date = new Date(),
): Promise<void> {
  try {
    const { db } = await import('./db');
    const { skillLifecycleEvents } = await import('./db/schema');
    await db.insert(skillLifecycleEvents).values({
      skillId: skill.id, teamId: skill.teamId, action: 'restored', mode: 'manual',
      previousEnabled: false, previousContentHash: skill.contentHash, createdAt: now,
    });
  } catch (err) {
    console.warn('[skill-lifecycle] restored event failed:', err instanceof Error ? err.message : err);
  }
}
