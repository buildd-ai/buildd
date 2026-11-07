/**
 * Skill-to-spec links (finding on skill retirement, sections 3(c)-(e)).
 *
 * Suggestions are computed on read and never stored. A similarity or path score
 * never drives retirement: only a link a person explicitly confirmed is stored,
 * and a confirmed link to a retired/superseded spec yields a *proposal* event
 * for human approval, never a disable. Pure; routes and the cron feed it rows.
 */
import type { LifecycleEvent } from './skill-lifecycle-events';

export type SuggestionBasis = 'observed_path_overlap' | 'similarity';

export interface SkillSpecSuggestion {
  specId: string;
  basis: SuggestionBasis;
  /** Raw score for a similarity hit; for observed overlap, the count of shared paths. */
  score: number;
  /** The text the suggestion rests on: matched spec text, or the shared paths. */
  matchedText: string;
}

export function rankSkillSpecSuggestions(input: {
  similar: ReadonlyArray<{ specId: string; score: number; matchedText: string }>;
  pathOverlap: ReadonlyArray<{ specId: string; sharedPaths: readonly string[]; taskCount: number }>;
}): SkillSpecSuggestion[] {
  const observed: SkillSpecSuggestion[] = input.pathOverlap
    .filter(o => o.sharedPaths.length > 0)
    .map(o => ({
      specId: o.specId, basis: 'observed_path_overlap' as const,
      score: o.sharedPaths.length, matchedText: o.sharedPaths.slice(0, 5).join(', '),
    }))
    .sort((a, b) => b.score - a.score);
  const seen = new Set(observed.map(o => o.specId));
  const embedded: SkillSpecSuggestion[] = input.similar
    .filter(s => !seen.has(s.specId))
    .map(s => ({ specId: s.specId, basis: 'similarity' as const, score: s.score, matchedText: s.matchedText }))
    .sort((a, b) => b.score - a.score);
  return [...observed, ...embedded];
}

export interface ConfirmedLink { skillId: string; specId: string }

/**
 * Proposal events for enabled skills with a *confirmed* link to a retired or
 * superseded spec. The event is a recording; it changes nothing.
 */
export function proposeLinkRetirements(input: {
  links: readonly ConfirmedLink[];
  specs: ReadonlyArray<{ id: string; status: string }>;
  skills: ReadonlyArray<{ id: string; teamId: string; enabled: boolean; contentHash: string }>;
  now: Date;
}): LifecycleEvent[] {
  const dead = new Map(input.specs.filter(s => s.status === 'retired' || s.status === 'superseded').map(s => [s.id, s.status]));
  const skills = new Map(input.skills.map(s => [s.id, s]));
  const out: LifecycleEvent[] = [];
  const done = new Set<string>();
  for (const l of input.links) {
    const status = dead.get(l.specId);
    const skill = skills.get(l.skillId);
    if (!status || !skill || !skill.enabled || done.has(skill.id)) continue;
    done.add(skill.id);
    out.push({
      skillId: skill.id, teamId: skill.teamId, action: 'retirement_proposed', mode: 'recording',
      reason: `confirmed link to a ${status} spec (${l.specId})`,
      previousEnabled: true, previousContentHash: skill.contentHash, createdAt: input.now,
    });
  }
  return out;
}

export class SkillSpecLinkRefusedError extends Error {
  constructor() {
    super('Confirming a skill-spec link is a person-only action');
    this.name = 'SkillSpecLinkRefusedError';
  }
}

/** Only a signed-in person confirms a link; API keys, workers and agents are refused. */
export function assertPersonCaller(authType: 'session' | 'api' | 'dev' | 'denied'): void {
  if (authType !== 'session') throw new SkillSpecLinkRefusedError();
}
