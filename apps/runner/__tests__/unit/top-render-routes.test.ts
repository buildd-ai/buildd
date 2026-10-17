/**
 * `buildd top` and which login each run uses (R-39 to R-42, AC-23 to AC-25):
 * the "Runs on" and "Today" header lines, the route words on running rows,
 * billed vs estimated dollars, the detail's plan line, and the column drop
 * order (cost, then route words, then role) at 80x24 and 120x40.
 */
import { describe, expect, test } from 'bun:test';
import { createPalette, stripAnsi } from '../../src/terminal-palette';
import { renderFrame, textWidth } from '../../src/top/render';
import { reduce, runsOn, spendToday, taskRows, type TopState, type TopWorker } from '../../src/top/state';
import { toTopWorkerSummaries } from '../../src/top-worker-summary';
import type { RunRoute } from '../../src/run-route';
import { NOW, WORKERS, fixtureState } from './top-fixture';

const plain = createPalette('night', 'none');
const frame = (s: TopState, cols: number, rows: number) => renderFrame(s, { cols, rows, now: NOW, palette: plain });
const text = (lines: string[]) => lines.map(l => stripAnsi(l)).join('\n');
const min = 60_000;
const SONNET = 'claude-sonnet-4-5';

const PLAN: RunRoute = { backend: 'claude', bucket: 'plan', provider: 'anthropic', owner: 'machine' };
const TEAM_KEY: RunRoute = { backend: 'claude', bucket: 'api_key', provider: 'anthropic', owner: 'team' };
const TEAM_OPENROUTER: RunRoute = { backend: 'codex', bucket: 'gateway', provider: 'openrouter', owner: 'team' };

/** The fixture's three live workers, each on its own route, plus a finished billed run. */
function routedWorkers(): TopWorker[] {
  const [name, single, hint] = WORKERS;
  return [
    // A plan run: its tokens are worth list price, covered by the plan.
    { ...name, route: PLAN, costBasis: 'virtual', sessionModel: SONNET, resultMeta: { totalCostUsd: 0, actualModel: SONNET, totalUsage: { inputTokens: 100_000, outputTokens: 10_000 } } },
    // The team's API key: billed.
    { ...single, route: TEAM_KEY, costBasis: 'real', sessionModel: SONNET, resultMeta: { totalCostUsd: 0.08, actualModel: SONNET } },
    // The team's OpenRouter endpoint on Codex: estimated, since OpenRouter's charge never reaches the runner.
    { ...hint, status: 'working', waitingFor: undefined, currentAction: 'Read run.ts', taskBackend: 'codex', route: TEAM_OPENROUTER, costBasis: 'real', sessionModel: 'gpt-5.5', resultMeta: { totalCostUsd: 0.02, actualModel: 'gpt-5.5' } },
    // Finished earlier today on the team key.
    { id: 'w-done', taskId: 't-draft', taskTitle: 'spec draft', status: 'done', startedAt: NOW - 100 * min, completedAt: NOW - 90 * min, route: TEAM_KEY, costBasis: 'real', resultMeta: { totalCostUsd: 2.02, actualModel: SONNET } },
  ];
}

function routedState(extra: { routes?: RunRoute[]; problems?: Array<{ backend: 'claude' | 'codex'; text: string }> } = {}): TopState {
  let s = fixtureState();
  s = reduce(s, { type: 'workers', workers: routedWorkers() });
  s = reduce(s, {
    type: 'config', maxConcurrent: 3,
    routes: extra.routes ?? [PLAN, { backend: 'codex', bucket: 'plan', provider: 'openai', owner: 'machine' }],
    routeProblems: extra.problems ?? [],
  });
  return s;
}

function expectExactSize(lines: string[], cols: number, rows: number) {
  expect(lines.length).toBe(rows);
  for (const l of lines) expect(textWidth(stripAnsi(l))).toBe(cols);
}

describe('routes and dollars in the list view', () => {
  test('120x40: every column, with billed and estimated dollars apart', () => {
    const lines = frame(routedState(), 120, 40);
    expectExactSize(lines, 120, 40);
    const t = text(lines);
    expect(t).toMatchSnapshot();
    expect(t).toContain('Runs on: plan Claude, Codex · API key Anthropic (team) · gateway OpenRouter (team)');
    expect(t).toContain('Today: $2.10 billed, ~$0.02 estimated · plans covered about $0.45 at list price');
    expect(t).toContain('Claude · plan');
    expect(t).toContain('Claude · API key (team)');
    expect(t).toContain('Codex · OpenRouter (team)');
    expect(t).toMatch(/single instance.*\$0\.08/);
    expect(t).toMatch(/installer hint.*~\$0\.02/);
  });

  test('a plan row shows no dollar figure (AC-23)', () => {
    const row = text(frame(routedState(), 120, 40)).split('\n').find(l => l.includes('name override'))!;
    expect(row).toContain('Claude · plan');
    expect(row).not.toContain('$');
  });

  test('80x24: cost goes first, then the route words; role stays', () => {
    const lines = frame(routedState(), 80, 24);
    expectExactSize(lines, 80, 24);
    const t = text(lines);
    expect(t).toMatchSnapshot();
    const rows = t.split('\n').filter(l => l.includes('single instance') || l.includes('name override'));
    for (const r of rows) {
      expect(r).not.toContain('$');
      expect(r).not.toContain('API key');
      expect(r).toContain('Builder');
    }
  });

  test('between the two, the route words stay and the cost goes', () => {
    // 100 columns: a right pane 75 wide.
    const lines = frame(routedState(), 100, 30);
    expectExactSize(lines, 100, 30);
    const row = text(lines).split('\n').find(l => l.includes('single instance'))!;
    expect(row).toContain('Claude · API key (team)');
    expect(row).not.toContain('$0.08');
  });

  test('a running row with no route and an unknown basis keeps its tokens, never "~$" (and stays out of Today)', () => {
    let s = fixtureState();
    const w = { ...WORKERS[0], costBasis: 'unknown', sessionModel: SONNET, resultMeta: { totalCostUsd: 0.5, actualModel: SONNET } };
    s = reduce(s, { type: 'worker_update', worker: w });
    const t = text(frame(s, 120, 40));
    const row = t.split('\n').find(l => l.includes('name override'))!;
    expect(row).toContain('41k tok');
    expect(row).not.toContain('$');
    expect(t).not.toContain('Today:');
    expect(spendToday(s, NOW)).toEqual({ billed: 0, estimated: 0, plan: 0 });
  });

  test('rows without a recorded route keep the old columns', () => {
    expect(text(frame(fixtureState(), 120, 40))).not.toContain('Runs on');
    expect(taskRows(fixtureState(), NOW).every(r => r.route === undefined)).toBe(true);
  });
});

describe('the header (R-39, AC-24)', () => {
  test('an expired Codex login says so and where to reconnect; no Codex plan reads as available', () => {
    const s = routedState({
      routes: [PLAN],
      problems: [{ backend: 'codex', text: 'Codex plan: login expired, run codex login on this machine' }],
    });
    // A Codex plan run earlier today does not bring the plan back into "Runs on".
    const withOldRun = reduce(s, { type: 'worker_update', worker: { id: 'w-old-codex', taskId: 't-gone', taskTitle: 'x', status: 'error', startedAt: NOW - 50 * min, completedAt: NOW - 40 * min, route: { backend: 'codex', bucket: 'plan', provider: 'openai', owner: 'machine' } } });
    const line = runsOn(withOldRun, NOW)!;
    expect(line).toBe('Runs on: plan Claude · API key Anthropic (team) · gateway OpenRouter (team)');
    const lines = frame(withOldRun, 80, 24);
    expectExactSize(lines, 80, 24);
    // Its own line, whole at 80 columns.
    expect(text(lines).split('\n')[2]).toBe(' Codex plan: login expired, run codex login on this machine'.padEnd(80));
    expect(text(lines)).toMatchSnapshot();
  });
});

describe('totals never mix buckets (R-42, AC-25)', () => {
  test('the OpenRouter run counts as estimated, the key as billed, the plan as covered', () => {
    const t = spendToday(routedState(), NOW);
    expect(t.billed).toBeCloseTo(2.1, 10);
    expect(t.estimated).toBeCloseTo(0.02, 10);
    expect(t.plan).toBeCloseTo(0.45, 5);
  });

  test("yesterday's runs are not today's", () => {
    let s = routedState();
    s = reduce(s, { type: 'worker_update', worker: { id: 'w-y', taskId: 't-old', taskTitle: 'y', status: 'done', startedAt: NOW - 30 * 60 * min, completedAt: NOW - 29 * 60 * min, route: TEAM_KEY, resultMeta: { totalCostUsd: 50, actualModel: SONNET } } });
    expect(spendToday(s, NOW).billed).toBeCloseTo(2.1, 10);
  });
});

describe('the detail (R-40, R-41)', () => {
  test('a plan run: its usage and what the plan covered', () => {
    const t = text(frame({ ...routedState(), mode: { kind: 'detail', taskId: 't-name' } }, 100, 24));
    expect(t).toContain('Claude · plan · about $0.45 at list price, covered by the plan');
  });

  test('a run whose route served another model names it', () => {
    let s = routedState();
    const w = s.workers['w-single'];
    s = reduce(s, { type: 'worker_update', worker: { ...w, sessionModel: 'claude-opus-4-5', resultMeta: { totalCostUsd: 0.08, actualModel: SONNET } } });
    const t = text(frame({ ...s, mode: { kind: 'detail', taskId: 't-single' } }, 120, 24));
    expect(t).toContain(`Claude · API key (team) · served ${SONNET} (asked for claude-opus-4-5) · $0.08 billed`);
  });

  test('a gateway run reads as estimated', () => {
    const t = text(frame({ ...routedState(), mode: { kind: 'detail', taskId: 't-hint' } }, 120, 24));
    // The catalog is cold here, so the Codex model reads as priced by the fallback.
    expect(t).toContain('Codex · OpenRouter (team) · ~$0.02 estimated, gpt-5.5 is not on the price list');
  });
});

describe('the socket summary carries the route and the dollars', () => {
  test('route and spend, no per-model usage', () => {
    const [s] = toTopWorkerSummaries([{
      id: 'a', taskId: 't', taskTitle: 'T', status: 'working', startedAt: NOW, branch: 'b', output: [], milestones: [], toolCalls: [], commits: [],
      lastActivity: NOW, hasNewActivity: false, route: TEAM_KEY, costBasis: 'real', sessionModel: SONNET,
      resultMeta: { stopReason: null, durationMs: 0, durationApiMs: 0, numTurns: 1, modelUsage: { [SONNET]: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.08 } }, totalCostUsd: 0.08, actualModel: SONNET },
    } as any]) as any[];
    expect(s.route).toEqual(TEAM_KEY);
    expect(s.spend).toEqual({ usd: 0.08, kind: 'billed' });
    expect(s.resultMeta).toEqual({ actualModel: SONNET });
  });
});
