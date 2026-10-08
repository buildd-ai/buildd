import { describe, expect, it } from 'bun:test';
import { deriveHomeAttention as derive, homeAttentionCopy, homeQuestionView } from './home-attention';
import { isActionableChip } from './action-queue';
import { deriveHomeNeedsYou } from './home-needs-you';
const deriveHomeAttention = (input: Omit<Parameters<typeof derive>[0], 'isActionable'>) => derive({ ...input, isActionable: isActionableChip });
import type { ActionQueueItem } from './action-queue';
const pr = (key: string, workspaceId = 'workspace-a', chip: ActionQueueItem['chip'] = 'MERGE'): ActionQueueItem => ({ subjectKey: key, chip, workspaceId, prNumber: 42, taskTitle: 'Improve navigation', prUrl: 'https://example.test/o/r/pull/42', taskId: 'task-a' });
const one = (q: Partial<ActionQueueItem>) => deriveHomeAttention({ queue: [{ subjectKey: 's', chip: 'MERGE', taskTitle: 'Improve navigation', taskId: 'task-a', ...q } as ActionQueueItem], missions: [], questions: [], held: [] });
const FORBIDDEN = ['Work needs a decision', 'Open decision', 'The checks are clear. Nothing else is blocking it.', '/app/health'];
describe('phone Home attention', () => {
  it('deduplicates the same PR across queue subjects without joining different workspaces', () => {
    const items = deriveHomeAttention({ queue: [pr('mission'), pr('task'), pr('other', 'workspace-b')], missions: [], questions: [], held: [] });
    expect(items).toHaveLength(2);
    expect(homeAttentionCopy(items).count).toBe(items.length);
    expect(homeAttentionCopy(items).headline).toBe('2 things need you.');
  });
  it('does not turn machine-owned waits or resolved PRs into human asks', () => {
    const items = deriveHomeAttention({ queue: [pr('fix', undefined, 'FIXING_CI'), pr('checks', undefined, 'CI_RUNNING'), { ...pr('done'), prLifecycleStatus: 'merged' }], missions: [], questions: [], held: [] });
    expect(items).toEqual([]);
    expect(homeAttentionCopy(items)).toEqual({ count: 0, headline: 'Nothing needs you.', subline: 'The fleet is working without you.' });
  });
  it('suppresses an older merge ask when a fix owns the same PR, in either order', () => {
    for (const queue of [[pr('ready'), pr('fix', undefined, 'FIXING_CI')], [pr('fix', undefined, 'FIXING_CI'), pr('ready')]]) {
      expect(deriveHomeAttention({ queue, missions: [], questions: [], held: [] })).toEqual([]);
    }
  });
  it('keeps the safer stale reading when two sources describe one PR', () => {
    const items = deriveHomeAttention({ queue: [pr('ready'), pr('stale', undefined, 'STALE')], missions: [], questions: [], held: [] });
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe('check needed');
    expect(items[0].primary?.label).toBe('Check PR');
  });
  it('shows a parked question once and counts stranded missions once', () => {
    const q = { workerId: 'worker-a', taskId: 'task-a', href: '/app/tasks/task-a', label: 'Builder', runnerName: null, askedAt: null, question: { headline: 'Which direction?', body: null, options: [], noteId: null } };
    const strand = { missionId: 'mission-a', quietMs: 7200000, taskId: 'task-b', claimable: 1, blockedReason: null, order: 'runner-first' as const };
    const mission = { view: { id: 'mission-a', title: 'Navigation', href: '/app/missions/mission-a' }, model: { strand } } as any;
    const items = deriveHomeAttention({ queue: [{ subjectKey: 'q', chip: 'QUESTION', taskId: 'task-a' }], questions: [q, q], missions: [mission, mission], held: [] });
    expect(items.map(i => i.kind)).toEqual(['question', 'stranded']);
    expect(homeAttentionCopy(items).count).toBe(items.length);
    expect(homeAttentionCopy(items).subline).toBe('1 question · 1 stranded mission');
  });
  it('includes an open doc-fix PR as one merge decision', () => {
    const items = deriveHomeAttention({ queue: [{ ...pr('doc'), docFixTaskId: 'doc-task' }], missions: [], questions: [], held: [] });
    expect(items[0].sentence).toContain('doc back in line');
    expect(homeAttentionCopy(items).headline).toBe('1 thing needs you.');
  });
});

describe('Home question cards are never context-free', () => {
  // The exact regression: the agent's explanation lived in the brief (or only in its
  // needs_input error) and Home rendered "How should I proceed?" with a generic line.
  const ERROR = 'needs_input: Visual QA cannot boot the app: the mission migration is below the migration high-water mark. How should I proceed?';
  const card = (question: NonNullable<ReturnType<typeof homeQuestionView>>) => deriveHomeAttention({
    queue: [], missions: [], held: [],
    questions: [{ workerId: 'w', taskId: 't', href: '/app/tasks/t', label: 'Surface audit', runnerName: null, askedAt: null, question }],
  })[0];

  it('keeps the brief context, structured options and recommendation', () => {
    const view = homeQuestionView({
      waitingFor: { type: 'question', prompt: 'How should I proceed?', context: 'Visual QA cannot boot: a migration is below the high-water mark.', options: [{ label: 'Skip visual QA', description: 'Ships without screenshots', recommended: true }, 'Wait'] },
      error: ERROR, taskTitle: 'Surface audit',
    })!;
    expect(view.options.map(o => o.label)).toEqual(['Skip visual QA', 'Wait']);
    const item = card(view);
    expect(item.title).toBe('How should I proceed?');
    expect(item.sentence).toContain('high-water mark');
    expect(item.sentence).not.toBe('An agent needs your answer to continue.');
  });

  it('fails open to the worker error when the stored question lost its brief', () => {
    const view = homeQuestionView({ waitingFor: { type: 'question', prompt: 'How should I proceed?' }, error: ERROR, taskTitle: 'Surface audit' })!;
    expect(card(view).sentence).toContain('high-water mark');
  });

  it('with nothing else, still says which task asked', () => {
    const view = homeQuestionView({ waitingFor: { type: 'question', prompt: 'How should I proceed?' }, error: null, taskTitle: 'Surface audit' })!;
    expect(card(view).sentence).toBe('Asked while working on "Surface audit".');
  });

  it('a row with no question is not a card', () => {
    expect(homeQuestionView({ waitingFor: null, error: ERROR, taskTitle: 'x' })).toBeNull();
  });
});

 describe('shared Home needs-you snapshot', () => {
  it('takes its items and all copy counts from the injected actionable predicate', () => {
    const snapshot = deriveHomeNeedsYou({ queue: [pr('ready')], missions: [], questions: [], held: [], isActionable: () => false });
    expect(snapshot.items).toEqual([]);
    expect(snapshot.count).toBe(snapshot.items.length);
    expect(snapshot.headline).toBe('Nothing needs you.');
    expect(snapshot.subline).toBe('The fleet is working without you.');
  });
  it('shares the deduplicated singular and plural headline', () => {
    for (const queue of [[pr('ready'), pr('duplicate')], [pr('ready'), pr('other', 'workspace-b')]]) {
      const snapshot = deriveHomeNeedsYou({ queue, missions: [], questions: [], held: [], isActionable: isActionableChip });
      expect(snapshot.count).toBe(snapshot.items.length);
      expect(snapshot.headline).toBe(snapshot.count === 1 ? '1 thing needs you.' : '2 things need you.');
    }
  });
});


describe('Needs You card contract', () => {
  it('gives every actionable chip a concrete title, reason, named action and destination', () => {
    const cases: [Partial<ActionQueueItem>, string, string][] = [
      [{ chip: 'MERGE', prUrl: 'https://example.test/pull/1', prNumber: 1 }, 'Merge', 'merge'],
      [{ chip: 'REVIEW', prUrl: 'https://example.test/pull/1', verdictSummary: 'Protected migration paths changed.' }, 'Review PR', 'review'],
      [{ chip: 'QUESTION', question: 'Which direction?' }, 'Answer', 'answer'],
      [{ chip: 'DECIDE', missionId: 'm1', escalationReason: 'Pick a rollout order' }, 'Choose…', 'decide'],
      [{ chip: 'APPROVE' }, 'Approve…', 'approve'],
      [{ chip: 'RECONNECT', connectorName: 'Source host', fixHref: '/app/settings/connectors' }, 'Reconnect', 'reconnect'],
      [{ chip: 'DISCREPANCY', direction: 'spec_ahead', specPath: 'docs/specs/a.md' }, 'Resolve…', 'resolve'],
      [{ chip: 'BLOCKED', escalationReason: 'Needs a rollout choice' }, 'Resolve…', 'resolve'],
      [{ chip: 'STALE', prUrl: 'https://example.test/pull/1' }, 'Check PR', 'check'],
      [{ chip: 'FAILED', failureMessage: 'Build crashed' }, 'View task', 'view'],
    ];
    for (const [input, cta, type] of cases) {
      const [item] = one(input);
      expect(item, String(input.chip)).toBeDefined();
      expect(item.primary?.label).toBe(cta);
      expect(item.actionType).toBe(type);
      expect(item.title.length).toBeGreaterThan(0);
      expect(item.sentence.length).toBeGreaterThan(0);
      expect(item.primary?.href.startsWith('/') || item.primary?.href.startsWith('http')).toBe(true);
      for (const bad of FORBIDDEN) expect(JSON.stringify(item)).not.toContain(bad);
    }
  });
  it('uses the real decision and question as the title', () => {
    expect(one({ chip: 'DECIDE', missionId: 'm1', escalationReason: 'Pick a rollout order' })[0].title).toBe('Pick a rollout order');
    expect(one({ chip: 'QUESTION', question: 'Which direction?' })[0].title).toBe('Which direction?');
  });
  it('keeps unresolvable items out of Needs You instead of routing to Health', () => {
    expect(one({ chip: 'DECIDE', missionId: 'm1' })).toEqual([]);
    expect(one({ chip: 'MERGE', taskId: undefined, taskTitle: undefined })).toEqual([]);
    expect(one({ chip: 'RECONNECT', connectorName: 'Source host' })).toEqual([]);
    expect(one({ chip: 'FAILED', failureMessage: 'x', taskId: undefined })).toEqual([]);
  });
  it('replays a queued fix with pending CI as zero cards, whatever the order', () => {
    for (const queue of [[pr('old'), pr('fix', undefined, 'FIXING_CI'), pr('ci', undefined, 'CI_RUNNING')], [pr('ci', undefined, 'CI_RUNNING'), pr('fix', undefined, 'RESOLVING'), pr('old')]]) {
      expect(deriveHomeAttention({ queue, missions: [], questions: [], held: [] })).toEqual([]);
    }
  });
  it('replays a real human decision as exactly one concrete card', () => {
    const items = deriveHomeAttention({ queue: [pr('a', undefined, 'REVIEW'), { ...pr('b', undefined, 'REVIEW'), prNumber: 43, prUrl: 'https://example.test/pull/43' }].map(i => ({ ...i, humanReview: { reason: 'Review required · protected migration paths', label: 'Review PR' } as any })), missions: [], questions: [], held: [] });
    expect(items).toHaveLength(2);
    expect(items[0].sentence).toBe('Review required · protected migration paths');
    expect(items[0].primary?.href).toBe('https://example.test/o/r/pull/42/files');
  });
  it('summarises mixed action types instead of calling everything a merge', () => {
    const items = deriveHomeAttention({ queue: [pr('a', undefined, 'REVIEW'), { ...pr('b'), prNumber: 2 }, { ...pr('c'), prNumber: 3 }].map(i => i.chip === 'REVIEW' ? { ...i, verdictSummary: 'Protected paths changed.' } : i), missions: [], questions: [], held: [] });
    expect(homeAttentionCopy(items).subline).toBe('1 review · 2 merges');
  });
});
