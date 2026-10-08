import { describe, expect, it } from 'bun:test';
import { filesOnFirstOccurrence, planProposals, proposalDescription, proposalTitle, rankClusters, RETRO_MAX_PROPOSALS_PER_TEAM_DAY, type Cluster, type PriorFiling } from './proposals';

const WS = '00000000-0000-4000-8000-00000000000a';
const cluster = (sig: string, over: Partial<Cluster> = {}): Cluster => ({
  signature: `chat-retro:over_fetch-tool_or_param-${sig}-abcdef`, primaryCause: 'over_fetch', fixClass: 'tool_or_param', toolName: sig,
  sessions: 4, days: 3, wastedTokens: 10000, satisfiedYes: 1, satisfiedPartly: 2, satisfiedNo: 1, highConfidence: 0,
  workspaceId: WS, lessonIds: ['00000000-0000-4000-8000-000000000001'], conversationIds: ['00000000-0000-4000-8000-000000000002'], ...over,
});

describe('rankClusters', () => {
  it('needs enough sessions on enough distinct days', () => {
    const r = rankClusters([cluster('a', { sessions: 2 }), cluster('b', { days: 1 }), cluster('c')]);
    expect(r.map(c => c.toolName)).toEqual(['c']);
  });
  it('ranks by waste weighted by dissatisfaction', () => {
    const r = rankClusters([
      cluster('low', { wastedTokens: 1000 }),
      cluster('happy', { wastedTokens: 5000, satisfiedYes: 4, satisfiedPartly: 0, satisfiedNo: 0 }),
      cluster('sad', { wastedTokens: 4000, satisfiedYes: 0, satisfiedPartly: 0, satisfiedNo: 4 }),
    ]);
    expect(r.map(c => c.toolName)).toEqual(['sad', 'happy', 'low']);
  });
});

describe('planProposals: cap and dedupe', () => {
  const none = new Map<string, PriorFiling | null>();

  it(`files at most ${RETRO_MAX_PROPOSALS_PER_TEAM_DAY} per team per day and defers the rest`, () => {
    const a = planProposals([cluster('a'), cluster('b'), cluster('c'), cluster('d')], none, { filedToday: 0 });
    expect(a.map(x => x.kind)).toEqual(['file', 'file', 'deferred', 'deferred']);
  });

  it('counts what was already filed today', () => {
    expect(planProposals([cluster('a'), cluster('b')], none, { filedToday: 1 }).map(x => x.kind)).toEqual(['file', 'deferred']);
    expect(planProposals([cluster('a')], none, { filedToday: 2 }).map(x => x.kind)).toEqual(['deferred']);
  });

  it('appends to an open proposal instead of filing a second, and only when evidence grew', () => {
    const c = cluster('a', { sessions: 6 });
    const open = new Map([[c.signature, { taskId: 't1', open: true, sessions: 4 }]]);
    expect(planProposals([c], open, { filedToday: 0 })).toEqual([{ kind: 'append', cluster: c, prior: { taskId: 't1', open: true, sessions: 4 } }]);
    const same = new Map([[c.signature, { taskId: 't1', open: true, sessions: 6 }]]);
    expect(planProposals([c], same, { filedToday: 0 })[0].kind).toBe('unchanged');
    // Appends never use the day's filing budget.
    expect(planProposals([c, cluster('b'), cluster('x')], open, { filedToday: 0 }).map(x => x.kind)).toEqual(['append', 'file', 'file']);
  });

  it('a closed proposal stays muted until its evidence doubles', () => {
    const closed = new Map([[cluster('a').signature, { taskId: 't1', open: false, sessions: 4 }]]);
    expect(planProposals([cluster('a', { sessions: 7 })], closed, { filedToday: 0 })[0].kind).toBe('muted');
    const refile = planProposals([cluster('a', { sessions: 8 })], closed, { filedToday: 0 })[0];
    expect(refile.kind).toBe('file');
  });

  it('a pattern from team-wide chats only has nowhere to file', () => {
    expect(planProposals([cluster('a', { workspaceId: null })], none, { filedToday: 0 })[0].kind).toBe('no_workspace');
  });
});

describe('proposal description', () => {
  it('carries labels, counts and refs only', () => {
    const d = proposalDescription(cluster('list_tasks'), 'https://example.test/lessons');
    expect(d).toContain('Sessions affected: 4');
    expect(d).toContain('00000000-0000-4000-8000-000000000002');
    expect(d).toContain('never message text');
  });
});

describe('visible-answer failures: dogfood files on first occurrence, everyone else waits for a pattern', () => {
  const once = (cause: 'no_answer' | 'render_gap' | 'blank_retry', over: Partial<Cluster> = {}) => cluster(cause, {
    signature: `chat-retro:${cause}-turn_pipeline-none-abcdef`, primaryCause: cause, fixClass: 'turn_pipeline', toolName: null,
    sessions: 1, days: 1, highConfidence: 1, ...over,
  });

  it('a dogfood team: one high-confidence no_answer or render_gap is enough', () => {
    expect(rankClusters([once('no_answer')], { dogfood: true })).toHaveLength(1);
    expect(rankClusters([once('render_gap')], { dogfood: true })).toHaveLength(1);
    const plan = planProposals(rankClusters([once('no_answer')], { dogfood: true }), new Map(), { filedToday: 0 });
    expect(plan.map(a => a.kind)).toEqual(['file']);
  });

  it('an ordinary opted-in team: the same single session is not a pattern', () => {
    expect(rankClusters([once('no_answer')])).toEqual([]);
    expect(rankClusters([once('render_gap')], { dogfood: false })).toEqual([]);
  });

  it('dogfood still needs high confidence, and a retry alone never files early', () => {
    expect(rankClusters([once('no_answer', { highConfidence: 0 })], { dogfood: true })).toEqual([]);
    expect(rankClusters([once('blank_retry')], { dogfood: true })).toEqual([]);
    expect(filesOnFirstOccurrence(cluster('x', { highConfidence: 5 }), { dogfood: true })).toBe(false);
  });

  it('dedupe and the daily cap still apply to dogfood filings', () => {
    const c = once('render_gap');
    const open = new Map([[c.signature, { taskId: 't1', open: true, sessions: 1 }]]);
    expect(planProposals(rankClusters([c], { dogfood: true }), open, { filedToday: 0 }).map(a => a.kind)).toEqual(['unchanged']);
    expect(planProposals(rankClusters([c], { dogfood: true }), new Map(), { filedToday: RETRO_MAX_PROPOSALS_PER_TEAM_DAY }).map(a => a.kind)).toEqual(['deferred']);
  });

  it('title and description say what happened, with labels and counts only', () => {
    const c = once('render_gap', { fixClass: 'ui' });
    expect(proposalTitle(c)).toBe('[chat-retro] a saved answer was never shown (render_gap): ui');
    expect(proposalDescription(c, 'https://x.test')).toContain('High-confidence sessions: 1');
  });
});
