/**
 * I-6 (docs/specs/failure-incident-recovery.md §10): Home, the badge, the push
 * and the incident page show the same owner and the same sentence for an
 * incident at a given version. Each case runs the real gate once, reads the
 * verdict back the way Home does, and compares every surface.
 */
import { describe, it, expect } from 'bun:test';
import type { FailureIncidentRecovery } from '@buildd/shared';
import { verdictFromCode } from '@buildd/core/escalation-gate';
import { createGatedIncidentSender, incidentNeedsYouItems, verdictGeneration, type IncidentGateDeps } from './failure-incident-escalation';
import type { IncidentAlert } from './failure-incident-actions';
import type { StoredIncident } from './failure-incident-store';
import { projectIncident } from './incident-view';
import { buildActionQueue } from './action-queue';
import { deriveHomeAttention, homeAttentionCopy } from './home-attention';

const NOW = new Date().toISOString();
const soon = new Date(Date.now() + 20 * 60_000).toISOString();

function recovery(over: Partial<FailureIncidentRecovery>): FailureIncidentRecovery {
  return {
    v: 1, generation: 3,
    cause: { reasonCode: 'path_overlap.blocker_open', rule: 'path_overlap_stall', ownership: 'workflow' },
    subjects: [{ kind: 'task', id: '1a2b3c4d-0000' }], blockers: [{ kind: 'pr', id: '77', state: 'open', observedAt: NOW }],
    overlappingPaths: [], observation: { observedAt: NOW, source: 'sweep', evidenceRevision: 'rev' },
    firstSeenAt: NOW, lastSeenAt: NOW, lastProgressAt: null, owner: 'buildd', state: 'waiting',
    nextAction: { kind: 'wait', label: 'Waiting for PR #77 to land.', key: 'k' }, nextCheckAt: soon,
    verification: { predicate: 'p', params: {} }, budget: { spent: 0, limit: 3, deadlineAt: NOW, spentKeys: [] }, attempts: [],
    ...over,
  };
}

const base = {
  id: 'i1', workspaceId: 'w1', title: 'Tasks deferred on path overlap', severity: 'high', status: 'open', rule: 'path_overlap_stall',
  recurrenceCount: 0, occurrenceCount: 3, linkedFixTaskId: null, affectedRefs: { taskIds: ['1a2b3c4d-0000'], workerIds: [], prNumbers: [77] },
  impact: {}, firstSeenAt: NOW, lastSeenAt: NOW, resolvedAt: null,
};

const CASES: Array<{ name: string; incident: Record<string, unknown>; expectNeedsYou: boolean }> = [
  { name: 'waiting', incident: { recovery: recovery({}) }, expectNeedsYou: false },
  { name: 'repairing', incident: { recovery: recovery({ state: 'recovering', nextAction: { kind: 'release_blocker', label: 'PR #77 landed; Buildd is releasing its files.', key: 'recovery:i1:task:t:c:release_blocker:g3:a1' } }) }, expectNeedsYou: false },
  { name: 'retry exhausted (operator)', incident: { recovery: recovery({ state: 'needs_operator', owner: 'operator', capabilityGap: { capability: 'repair_infrastructure:visual_qa.scrub', reason: 'the QA scrub fails' }, nextAction: { kind: 'operator', label: 'An operator repairs the scrub.', key: 'k' } }) }, expectNeedsYou: false },
  { name: 'inconclusive', incident: { recovery: recovery({ state: 'inconclusive', nextAction: { kind: 'recheck', label: 'The facts could not be read.', key: 'k' } }) }, expectNeedsYou: false },
  { name: 'genuine decision', incident: { recovery: recovery({ state: 'needs_decision', owner: 'person', nextCheckAt: null, decision: { question: 'Task 1a2b3c4d and PR #77\'s fix are waiting on each other. Choose one to stop.', options: [{ capability: 'dismiss', label: 'Leave both waiting', effect: 'Nothing changes.' }], recommended: 'dismiss' } }) }, expectNeedsYou: true },
  { name: 'recovered', incident: { status: 'resolved', resolvedAt: NOW, recovery: recovery({ state: 'recovered', nextAction: null, nextCheckAt: null }) }, expectNeedsYou: false },
  { name: 'unassessed, no recovery policy', incident: { rule: 'retry_fork', recovery: null }, expectNeedsYou: true },
  { name: 'critical', incident: { severity: 'critical', recovery: recovery({}) }, expectNeedsYou: true },
];

describe('one verdict on every surface (I-6)', () => {
  for (const c of CASES) {
    it(`${c.name}: page, Home, badge and push agree on owner, sentence and whether it is yours`, async () => {
      const inc = { ...base, ...c.incident } as unknown as StoredIncident;
      const records: Array<{ appliedAnswer?: string | null; reason?: string | null }> = [];
      const pushes: Array<{ message: string }> = [];
      const deps: IncidentGateDeps = {
        loadTeamId: async () => 't1', loadFixTask: async () => null, loadStored: async () => null,
        record: async r => { records.push(r); return 'r'; },
        notify: async (_t, p) => { pushes.push(p); },
      };
      const alert: IncidentAlert = { incidentId: inc.id, severity: inc.severity, priority: 0, reason: 'opened', title: 't', message: 'm', dedupeKey: 'd', incident: inc };
      const paged = await createGatedIncidentSender(deps)(alert);

      // Home reads the stored row back.
      const stored = records.length ? { ...verdictFromCode(records[0].appliedAnswer)!, generation: verdictGeneration(records[0].reason) } : null;
      const page = projectIncident(inc, stored);
      const home = incidentNeedsYouItems([inc], new Map(stored ? [[inc.id, stored]] : []));
      const queue = buildActionQueue(home, []);
      const cards = deriveHomeAttention({ queue, missions: [], questions: [], held: [], isActionable: () => true });
      const badge = homeAttentionCopy(cards).count;

      expect(page.needsYou).toBe(c.expectNeedsYou);
      expect(paged).toBe(c.expectNeedsYou);
      expect(home.length).toBe(c.expectNeedsYou ? 1 : 0);
      expect(badge).toBe(c.expectNeedsYou ? 1 : 0);
      if (c.expectNeedsYou) {
        expect(home[0].failureMessage).toBe(page.sentence);
        expect(cards[0].sentence).toBe(page.sentence);
        expect(pushes[0].message.split('\n')[0]).toBe(`${page.stateWord}: ${page.sentence}`);
      } else {
        expect(pushes).toHaveLength(0);
      }
      if (inc.status !== 'resolved') expect(`${page.stateWord} ${page.sentence}`).not.toMatch(/Nothing is fixing|\bfixed\b|\bresolved\b/i);
    });
  }
});
