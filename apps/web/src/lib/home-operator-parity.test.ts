import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { buildActionQueue, type WaitingOnYouRawItem } from './action-queue';
import { deriveHomeAttention, homeAttentionCopy } from './home-attention';

/**
 * team-service-status §7, AC-8: Home and the Needs You badge are team
 * surfaces. A platform operator who is a team admin gets the same items, and
 * the same count, as a non-operator team admin of that team. The badge is
 * Home's own count (useHomeAttentionCount, published by HomeBody), so Home's
 * reads decide both.
 */
const SRC = resolve(import.meta.dir, '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

function sources(dir: string): string[] {
  return readdirSync(join(SRC, dir)).flatMap(name => {
    const rel = join(dir, name);
    if (statSync(join(SRC, rel)).isDirectory()) return sources(rel);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [rel] : [];
  });
}

describe('Home is the same for a platform operator', () => {
  it('reads nothing on the operator role', () => {
    for (const rel of sources('app/app/(protected)/home')) {
      expect({ rel, operator: /isPlatformOperator|platform-operator|lib\/admin\//.test(read(rel)) }).toEqual({ rel, operator: false });
    }
  });

  it('has no composition-root slot for operator machinery', () => {
    const modules = read('modules.ts');
    expect(modules).not.toMatch(/INCIDENT_NEEDS_YOU|INCIDENT_VERDICTS|DECISION_COLLECTION_NEEDS_YOU|DECISION_HEALTH_NEEDS_YOU/);
    expect(modules).not.toMatch(/decision-collection-needs-you|decision-health-needs-you|failure-incident-escalation/);
  });

  it('takes the badge from Home and nothing operator-specific', () => {
    for (const rel of ['components/MissionsBottomNav.tsx', 'components/MissionsSidebar.tsx']) {
      const src = read(rel);
      expect(src).toContain('useHomeAttentionCount');
      expect(src).not.toMatch(/isPlatformOperator|platform-operator/);
    }
  });

  it('an item about buildd\'s own machinery adds no row and nothing to the count', () => {
    const failed: WaitingOnYouRawItem = { kind: 'failed', taskId: 't1', taskTitle: 'Ship the change', workspaceId: 'ws', failureMessage: 'It failed.' } as WaitingOnYouRawItem;
    // The shapes Home used to carry for an operator: an owner-verdict card and a decision feature that is not deciding.
    const machinery = [
      { kind: 'incident', incidentId: 'i1', incidentTitle: 'Retry forks', failureMessage: 'why', fixHref: '#', fixLabel: 'Open' },
      { kind: 'incident', incidentId: 'decisions:team', incidentTitle: 'Decisions are failing', failureMessage: 'why', fixHref: '#' },
    ] as unknown as WaitingOnYouRawItem[];
    const home = (raw: WaitingOnYouRawItem[]) => deriveHomeAttention({ queue: buildActionQueue(raw, []), missions: [], questions: [], held: [], isActionable: () => true });
    const admin = home([failed]);
    const operator = home([failed, ...machinery]);
    expect(admin).toHaveLength(1);
    expect(operator).toEqual(admin);
    expect(homeAttentionCopy(operator)).toEqual(homeAttentionCopy(admin));
  });
});
