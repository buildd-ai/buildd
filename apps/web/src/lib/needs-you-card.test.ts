import { describe, expect, it } from 'bun:test';
import { approvalView, askedAgo, decisionFromQuestion, decisionOptions, isGenericPrompt, splitEffect } from './needs-you-card';
import { optionOutcomes, type QuestionWaits } from '@buildd/core/question-waits';

const T0 = Date.UTC(2026, 9, 22, 12, 0, 0);
const task = { id: 't1', title: 'Mirror the runner image to Docker Hub', href: '/app/tasks/t1' };

/** What the projection (lib/question-waits.ts) returns for the asking task. */
const waits = (over: Partial<QuestionWaits> = {}): QuestionWaits => {
  const base: QuestionWaits = {
    taskId: 't1', mission: null, hiddenCount: 0, beyondCount: 0, lanes: [], criteria: null,
    waiting: [
      { id: 'd1', title: 'The release publishes an image digest', depth: 1, missionId: null, missionTitle: null, workspaceName: null, after: null, alsoWaitsOnOther: false },
      { id: 'd2', title: 'A runner bundle on every release', depth: 1, missionId: null, missionTitle: null, workspaceName: null, after: null, alsoWaitsOnOther: false },
    ],
    askedAt: null, expiresAt: null, onExpiry: { action: 'restart', option: null }, options: [], ...over,
  };
  return { ...base, options: over.options ?? optionOutcomes([{ label: 'Provide a token', outcome: 'continues' }, "I'll set them myself"], base) };
};

describe('decisionFromQuestion (Navigation R-16, AC-10)', () => {
  it('names what waits on the decision after the why', () => {
    const answer = { kind: 'worker' as const, workerId: 'w', taskId: 't1', noteId: null };
    const q = { headline: 'Tabs or spaces?', body: null, context: 'CI needs one', noteId: null, options: [] };
    expect(decisionFromQuestion({ key: 'k', question: q, task, askedAt: null, dependents: ['Release'], answer }).summary).toBe('CI needs one. Release waits on this.');
    expect(decisionFromQuestion({ key: 'k', question: q, task, askedAt: null, dependents: ['A', 'B'], answer }).summary).toBe('CI needs one. A and B wait on this.');
  });

  const q = {
    headline: 'How should Docker Hub credentials be set up?',
    body: null,
    noteId: null,
    context: 'CI has no Docker Hub secrets, so every release skips the image mirror',
    options: [
      { label: "I'll set them myself", description: 'You add the two secrets in GitHub. Work resumes when CI sees them.', recommended: false },
      { label: 'Provide a token', description: 'Stored as a team secret, revocable', recommended: true },
      { label: 'Skip', description: 'Leave it', recommended: false },
    ],
  };
  const view = decisionFromQuestion({
    key: 'q:t1', question: q, task, askedAt: T0 - 60_000,
    waits: waits(),
    answer: { kind: 'worker', workerId: 'w1', taskId: 't1', noteId: null },
  });

  it('names the task and the question; the summary is the agent\'s why, the waiting work the projection\'s', () => {
    expect(view.task).toEqual(task);
    expect(view.question).toBe('How should Docker Hub credentials be set up?');
    expect(view.summary).toBe('CI has no Docker Hub secrets, so every release skips the image mirror.');
    expect(view.waits?.waiting.map(t => t.title)).toEqual(['The release publishes an image digest', 'A runner bundle on every release']);
  });

  it('each option carries its outcome effect from the projection (spec 1b257609 R-8)', () => {
    expect(view.options[0].downstream).toBe('Keeps working: The release publishes an image digest and A runner bundle on every release keep waiting');
    expect(view.options[1].downstream).toBeNull();
  });

  it('puts the recommended option first, each with a one-line effect, and never offers a skip', () => {
    expect(view.options.map(o => o.label)).toEqual(['Provide a token', "I'll set them myself"]);
    expect(view.options[0]).toMatchObject({ effect: 'Stored as a team secret, revocable', tip: null, recommended: true });
    expect(view.options[1].effect).toBe('You add the two secrets in GitHub. Work resumes when CI sees them.');
  });

  it('a decision takes the keyboard shortcut; an approval never does', () => {
    expect(view.shortcut).toBe(true);
    expect(approvalView({ key: 'a', task, askedAt: null, reason: null, diffHref: '#d', approveHref: '#a', changesHref: '#c' }).shortcut).toBe(false);
  });

  it('with no brief and no dependents the summary is null, never an empty string', () => {
    const bare = decisionFromQuestion({ key: 'k', question: { headline: 'Tabs or spaces?', body: null, noteId: null, options: [] }, task, askedAt: null, answer: { kind: 'worker', workerId: 'w', taskId: 't1', noteId: null } });
    expect(bare.summary).toBeNull();
    expect(bare.options).toEqual([]);
  });
  it('a lone option with no effect (a legacy note) is no structured option: the card asks the question with Answer differently', () => {
    const legacy = decisionFromQuestion({ key: 'k', question: { headline: 'Keep the legacy export?', body: null, noteId: 'n1', options: [{ label: 'Kept the export, it is cheap to carry and two teams still read it', recommended: true }] }, task, askedAt: null, answer: { kind: 'note', missionId: 'm', noteId: 'n1' } });
    expect(legacy.options).toEqual([]);
    const lone = decisionFromQuestion({ key: 'k', question: { headline: 'Ship it?', body: null, noteId: null, options: [{ label: 'Ship', description: 'Merges when green', recommended: true }] }, task, askedAt: null, answer: { kind: 'worker', workerId: 'w', taskId: 't1', noteId: null } });
    expect(lone.options.map(o => o.label)).toEqual(['Ship']);
  });
});

describe('decisionOptions', () => {
  it('keeps at most three, the primary first', () => {
    const opts = decisionOptions([
      { label: 'A', recommended: false }, { label: 'B', recommended: false }, { label: 'C', recommended: true }, { label: 'D', recommended: false },
    ]);
    expect(opts.map(o => o.label)).toEqual(['C', 'A', 'B']);
  });

  it('drops Not now, skip and later in any spelling', () => {
    expect(decisionOptions([{ label: 'Not now', recommended: false }, { label: 'skip it', recommended: false }, { label: 'Ask me later', recommended: false }, { label: 'Ship', recommended: false }]).map(o => o.label)).toEqual(['Ship']);
  });
});

describe('splitEffect', () => {
  it('a short line is the effect with no tip; a long one keeps its first clause and the whole as the tip', () => {
    expect(splitEffect('Merges when green')).toEqual({ effect: 'Merges when green', tip: null });
    const long = 'Recommended by the agent. You paste a Docker Hub access token next; buildd stores it as a team secret scoped to this repo.';
    const s = splitEffect(long);
    expect(s.effect).toBe('Recommended by the agent…');
    expect(s.tip).toBe(long);
  });
});

describe('approvalView', () => {
  const v = approvalView({
    key: 'a:t1', task: { id: 't1', title: 'Requester trigger and backfill', href: '/app/tasks/t1' }, askedAt: T0,
    reason: 'The migration replaces one function, no tables, reversible. Workspace policy needs a person',
    waits: waits({ waiting: [{ id: 'p', title: 'Prove checks on integrated UI', depth: 1, missionId: null, missionTitle: null, workspaceName: null, after: null, alsoWaitsOnOther: false }], options: [] }),
    diffHref: 'https://example.test/pull/5/files',
    approveHref: 'https://example.test/pull/5', changesHref: 'https://example.test/pull/5/files',
  });
  it('is Approve and Request changes with effects, the diff linked, the waiting work from the projection', () => {
    expect(v.kind).toBe('approval');
    expect(v.question).toBe('Approve Requester trigger and backfill?');
    expect(v.options.map(o => `${o.label}: ${o.effect}`)).toEqual(['Approve: Merges when green', 'Request changes: Builder revises it']);
    expect(v.summary).toBe('The migration replaces one function, no tables, reversible. Workspace policy needs a person.');
    expect(v.waits?.waiting[0].title).toBe('Prove checks on integrated UI');
    expect(v.diffHref).toContain('/files');
  });
});

describe('words', () => {
  it('askedAgo reads in minutes, hours and days', () => {
    expect(askedAgo(T0 - 10_000, T0)).toBe('asked just now');
    expect(askedAgo(T0 - 4 * 60_000, T0)).toBe('asked 4m ago');
    expect(askedAgo(T0 - 3 * 3_600_000, T0)).toBe('asked 3h ago');
    expect(askedAgo(T0 - 3 * 86_400_000, T0)).toBe('asked 3d ago');
    expect(askedAgo(null, T0)).toBeNull();
  });

  it('knows a prompt that names no decision', () => {
    expect(isGenericPrompt('How should I proceed?')).toBe(true);
    expect(isGenericPrompt('How should Docker Hub credentials be set up?')).toBe(false);
  });
});
