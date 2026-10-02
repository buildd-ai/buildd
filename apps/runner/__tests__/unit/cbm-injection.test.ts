/**
 * CBM search injection (docs/design/cbm-search-injection.md): trigger detection,
 * hit parsing, the set diff, caps and dedupe, the decision fallback, uptake,
 * privacy of the persisted block, and that the CBM-17/18 counters never move.
 */
import { describe, expect, it } from 'bun:test';
import type { CbmInjectionDecisionReply, CbmInjectionFacts } from '@buildd/core/cbm-injection';
import {
  CbmInjector,
  createCbmInjectionHook,
  detectTrigger,
  diffGraphAgainstHits,
  formatInjection,
  inManifest,
  isCbmInjectionEnabled,
  parseSearchHits,
  pathsMatch,
  recordUnsupportedTrigger,
  CBM_INJECTION_MAX_CHARS,
} from '../../src/cbm-injection';
import type { CbmGraph, GraphAnswer, GraphLocation } from '../../src/cbm-graph-client';
import { buildCbmMetrics } from '../../src/cbm-enforcement';
import { emptyCbmInjectionMetrics } from '@buildd/core/cbm-injection';

const WT = '/work/tree';

const def = (path: string, start: number, end = start + 10, label = 'Function'): GraphLocation =>
  ({ path, startLine: start, endLine: end, relation: 'definition', name: 'parseConfig', label });
const caller = (path: string, start: number, end: number, name: string, hop = 1): GraphLocation =>
  ({ path, startLine: start, endLine: end, relation: 'caller', name, label: 'Function', hop });

function fakeGraph(answers: Record<string, GraphAnswer | null>, opts: { ready?: boolean; delayMs?: number; impact?: Record<string, GraphAnswer> } = {}) {
  const calls: Array<{ symbol: string; depth: number }> = [];
  const graph: CbmGraph = {
    isReady: async () => opts.ready ?? true,
    lookup: async (symbol, { depth }) => {
      calls.push({ symbol, depth });
      if (opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs));
      if (depth > 1 && opts.impact?.[symbol]) return opts.impact[symbol];
      return answers[symbol] ?? null;
    },
  };
  return { graph, calls };
}

function decider(reply: CbmInjectionDecisionReply | (() => Promise<CbmInjectionDecisionReply>)) {
  const facts: CbmInjectionFacts[] = [];
  return {
    facts,
    decide: async (f: CbmInjectionFacts) => {
      facts.push(f);
      return typeof reply === 'function' ? reply() : reply;
    },
  };
}

const applied = (action: 'inject_callers' | 'inject_impact' | 'skip', confidence = 0.9): CbmInjectionDecisionReply =>
  ({ ok: true, action, status: 'applied', label: action, confidence, latencyMs: 40, version: 'csi1|jev|engine-1' });

const PARSE_CONFIG: GraphAnswer = {
  definitions: [def('packages/core/config.ts', 88, 120)],
  callers: [
    caller('apps/api/src/server.ts', 30, 60, 'bootServer'),
    caller('packages/core/load.ts', 10, 25, 'loadAll'),
  ],
};

// ── Trigger ──────────────────────────────────────────────────────────────────

describe('detectTrigger', () => {
  it('fires on a Bash identifier search and returns the symbol', () => {
    expect(detectTrigger('Bash', { command: 'rg -n parseConfig src' })).toEqual({ trigger: 'bash', symbol: 'parseConfig' });
    expect(detectTrigger('Bash', { command: 'cd apps/api && grep -rn parseConfig .' })).toEqual({ trigger: 'bash', symbol: 'parseConfig' });
    expect(detectTrigger('Bash', { command: 'git grep -n parseConfig' })).toEqual({ trigger: 'bash', symbol: 'parseConfig' });
  });

  it('does not fire on regex, quoted phrase, path-glob or unknown shapes', () => {
    expect(detectTrigger('Bash', { command: 'rg "parse(Config|Env)"' })).toBeNull();
    expect(detectTrigger('Bash', { command: 'rg "parse config"' })).toBeNull();
    expect(detectTrigger('Bash', { command: 'rg apps/runner/src' })).toBeNull();
    expect(detectTrigger('Bash', { command: 'rg --help' })).toBeNull();
  });

  it('does not fire on non-search Bash or a stream filter', () => {
    expect(detectTrigger('Bash', { command: 'bun run test' })).toBeNull();
    expect(detectTrigger('Bash', { command: 'ps aux | grep bunServer' })).toBeNull();
  });

  it('fires on the Grep tool with an identifier pattern only', () => {
    expect(detectTrigger('Grep', { pattern: 'parseConfig', path: 'src' })).toEqual({ trigger: 'grep', symbol: 'parseConfig' });
    expect(detectTrigger('Grep', { pattern: 'parse.*Config' })).toBeNull();
    expect(detectTrigger('Grep', { pattern: '**/*.ts' })).toBeNull();
  });

  it('skips identifiers too short to mean anything, and other tools', () => {
    expect(detectTrigger('Bash', { command: 'rg -n id' })).toBeNull();
    expect(detectTrigger('Grep', { pattern: 'ok' })).toBeNull();
    expect(detectTrigger('Read', { file_path: 'parseConfig.ts' })).toBeNull();
    expect(detectTrigger('Glob', { pattern: 'parseConfig' })).toBeNull();
  });
});

describe('isCbmInjectionEnabled', () => {
  it('is on by default and off for the documented values', () => {
    expect(isCbmInjectionEnabled({})).toBe(true);
    expect(isCbmInjectionEnabled({ BUILDD_CBM_INJECTION: '1' })).toBe(true);
    for (const v of ['0', 'false', 'OFF', 'no']) expect(isCbmInjectionEnabled({ BUILDD_CBM_INJECTION: v })).toBe(false);
  });
});

// ── Hits and diff ────────────────────────────────────────────────────────────

describe('parseSearchHits', () => {
  it('reads path:line: matches, path:line- context, file-only lines and absolute paths', () => {
    const out = [
      'apps/api/src/server.ts:41:  const c = parseConfig(env);',
      'apps/api/src/server.ts:40-  // boot',
      'packages/core/config.ts',
      `${WT}/packages/core/load.ts:12:parseConfig()`,
      './scripts/x.ts:3:parseConfig',
      'not a hit at all',
      'http://example.com:80:x',
    ].join('\n');
    expect(parseSearchHits(out, WT)).toEqual([
      { path: 'apps/api/src/server.ts', line: 41 },
      { path: 'apps/api/src/server.ts', line: 40 },
      { path: 'packages/core/config.ts', line: null },
      { path: 'packages/core/load.ts', line: 12 },
      { path: 'scripts/x.ts', line: 3 },
    ]);
  });

  it('reads rg --heading groups', () => {
    const out = 'src/a.ts\n12:parseConfig()\n13-  x\n\nsrc/b.ts\n7:parseConfig';
    expect(parseSearchHits(out, WT)).toEqual([
      { path: 'src/a.ts', line: null },
      { path: 'src/a.ts', line: 12 },
      { path: 'src/a.ts', line: 13 },
      { path: 'src/b.ts', line: null },
      { path: 'src/b.ts', line: 7 },
    ]);
  });
});

describe('pathsMatch / diffGraphAgainstHits', () => {
  it('matches exact paths and path-segment suffixes only', () => {
    expect(pathsMatch('src/server.ts', 'apps/api/src/server.ts')).toBe(true);
    expect(pathsMatch('apps/api/src/server.ts', 'apps/api/src/server.ts')).toBe(true);
    expect(pathsMatch('rver.ts', 'apps/api/src/server.ts')).toBe(false);
  });

  it('a line hit covers only locations whose range contains it; a file hit covers the file', () => {
    const locs = [def('packages/core/config.ts', 88, 120), ...PARSE_CONFIG.callers];
    const missed = diffGraphAgainstHits(locs, [
      { path: 'apps/api/src/server.ts', line: 41 }, // inside bootServer
      { path: 'packages/core/load.ts', line: 99 }, // outside loadAll
      { path: 'packages/core/config.ts', line: null }, // whole file
    ]);
    expect(missed.map(l => l.path)).toEqual(['packages/core/load.ts']);
  });

  it('empty when the search saw everything', () => {
    expect(diffGraphAgainstHits(PARSE_CONFIG.callers, [
      { path: 'src/server.ts', line: 30 },
      { path: 'load.ts', line: 10 },
    ])).toEqual([]);
  });
});

describe('formatInjection', () => {
  it('lists definition first, then callers, within the caps', () => {
    const { text, injectedCount } = formatInjection('parseConfig', [...PARSE_CONFIG.callers, ...PARSE_CONFIG.definitions], 'callers');
    expect(injectedCount).toBe(3);
    const lines = text.split('\n');
    expect(lines[0]).toContain('3 locations for `parseConfig`');
    expect(lines[1]).toBe('- packages/core/config.ts:88 (definition, Function)');
    expect(lines[2]).toBe('- apps/api/src/server.ts:30 (caller: bootServer)');
  });

  it('turns the overflow into a count and stays under the character cap', () => {
    const many = Array.from({ length: 40 }, (_, i) => caller(`apps/very/long/path/to/module${i}/implementation-file-name.ts`, i + 1, i + 5, `someFairlyLongCallerName${i}`));
    const { text, injectedCount } = formatInjection('parseConfig', many, 'impact');
    expect(injectedCount).toBeLessThanOrEqual(8);
    expect(text).toContain(`… and ${40 - injectedCount} more`);
    expect(text.length).toBeLessThanOrEqual(CBM_INJECTION_MAX_CHARS);
  });

  it('shows hop distance only for impact', () => {
    const far = [caller('a/b.ts', 1, 2, 'outer', 2)];
    expect(formatInjection('x1234', far, 'impact').text).toContain('(caller: outer, 2 hops)');
    expect(formatInjection('x1234', far, 'callers').text).toContain('(caller: outer)');
  });
});

describe('inManifest', () => {
  it('matches exact files, directory prefixes and globs', () => {
    expect(inManifest('apps/api/src/server.ts', ['apps/api/src/server.ts'])).toBe(true);
    expect(inManifest('apps/api/src/server.ts', ['apps/api'])).toBe(true);
    expect(inManifest('apps/api/src/server.ts', ['apps/**/*.ts'])).toBe(true);
    expect(inManifest('apps/api/src/server.ts', ['apps/web/**'])).toBe(false);
    expect(inManifest('apps/api/src/server.ts', null)).toBe(false);
  });
});

// ── The injector ─────────────────────────────────────────────────────────────

function injector(graph: CbmGraph | null, decide: (f: CbmInjectionFacts) => Promise<CbmInjectionDecisionReply>, task = {}) {
  return new CbmInjector({ graph, decide, worktreePath: WT, task });
}

const rgOutput = (lines: string[]) => ({ stdout: lines.join('\n'), stderr: '', interrupted: false });

describe('CbmInjector', () => {
  it('no index → skip, nothing queried, nothing injected; the symbol stays evaluable', async () => {
    const { graph, calls } = fakeGraph({ parseConfig: PARSE_CONFIG }, { ready: false });
    const d = decider(applied('inject_callers'));
    const inj = injector(graph, d.decide);
    expect(await inj.handlePostToolUse('Bash', { command: 'rg -n parseConfig' }, rgOutput([]))).toBeNull();
    expect(await inj.handlePostToolUse('Bash', { command: 'rg -n parseConfig' }, rgOutput([]))).toBeNull();
    expect(calls).toEqual([]);
    expect(d.facts).toEqual([]);
    expect(inj.snapshot().byOutcome).toEqual({ no_index: 2 });
  });

  it('a null graph is no_index too', async () => {
    const inj = injector(null, decider(applied('skip')).decide);
    await inj.handlePostToolUse('Grep', { pattern: 'parseConfig' }, { filenames: [] });
    expect(inj.snapshot().byOutcome).toEqual({ no_index: 1 });
  });

  it('not in the graph → not_in_graph, no decision', async () => {
    const { graph } = fakeGraph({});
    const d = decider(applied('inject_callers'));
    const inj = injector(graph, d.decide);
    expect(await inj.handlePostToolUse('Bash', { command: 'rg parseConfig' }, rgOutput([]))).toBeNull();
    expect(inj.snapshot().byOutcome).toEqual({ not_in_graph: 1 });
    expect(d.facts).toEqual([]);
  });

  it('empty diff → no model call, nothing injected', async () => {
    const { graph } = fakeGraph({ parseConfig: PARSE_CONFIG });
    const d = decider(applied('inject_callers'));
    const inj = injector(graph, d.decide);
    const out = await inj.handlePostToolUse('Bash', { command: 'rg -n parseConfig' }, rgOutput([
      'packages/core/config.ts:90:export function parseConfig() {',
      'apps/api/src/server.ts:41:parseConfig(env)',
      'packages/core/load.ts:12:parseConfig()',
    ]));
    expect(out).toBeNull();
    expect(d.facts).toEqual([]);
    const snap = inj.snapshot();
    expect(snap.byOutcome).toEqual({ empty_diff: 1 });
    expect(snap.events[0]).toMatchObject({ hitCount: 3, hitFiles: 3, graphCount: 3, diffSize: 0, injectedCount: 0 });
  });

  it('Jev skip → nothing injected', async () => {
    const { graph } = fakeGraph({ parseConfig: PARSE_CONFIG });
    const inj = injector(graph, decider(applied('skip')).decide);
    expect(await inj.handlePostToolUse('Grep', { pattern: 'parseConfig' }, { mode: 'content', content: 'apps/api/src/server.ts:41:parseConfig()' })).toBeNull();
    expect(inj.snapshot().byOutcome).toEqual({ jev_skip: 1 });
    expect(inj.snapshot().events[0].jev).toMatchObject({ label: 'skip', status: 'applied', confidence: 0.9 });
  });

  it('Jev failure → injects callers anyway (jev_error_injected)', async () => {
    const { graph } = fakeGraph({ parseConfig: PARSE_CONFIG });
    const inj = injector(graph, decider({ ok: false, error: 'missing_key', latencyMs: 3, version: null }).decide);
    const out = await inj.handlePostToolUse('Bash', { command: 'rg -n parseConfig' }, rgOutput(['apps/api/src/server.ts:41:parseConfig(env)']));
    expect(out).toContain('packages/core/load.ts:10 (caller: loadAll)');
    expect(out).toContain('packages/core/config.ts:88 (definition, Function)');
    expect(out).not.toContain('server.ts');
    const snap = inj.snapshot();
    expect(snap.byOutcome).toEqual({ jev_error_injected: 1 });
    expect(snap.events[0].jev).toMatchObject({ status: 'error', label: null, error: 'missing_key' });
    expect(snap.injections).toBe(1);
  });

  it('a decide that throws is treated as a failure, not a crash', async () => {
    const { graph } = fakeGraph({ parseConfig: PARSE_CONFIG });
    const inj = injector(graph, async () => { throw new Error('boom'); });
    expect(await inj.handlePostToolUse('Bash', { command: 'rg parseConfig' }, rgOutput([]))).toContain('loadAll');
    expect(inj.snapshot().byOutcome).toEqual({ jev_error_injected: 1 });
  });

  it('below the gate → callers, recorded as a fallback with the model\'s pick kept', async () => {
    const { graph } = fakeGraph({ parseConfig: PARSE_CONFIG });
    const inj = injector(graph, decider({ ok: true, action: 'inject_callers', status: 'below_threshold', label: 'skip', confidence: 0.4, latencyMs: 30, version: 'v' }).decide);
    expect(await inj.handlePostToolUse('Bash', { command: 'rg parseConfig' }, rgOutput([]))).toContain('bootServer');
    expect(inj.snapshot().events[0]).toMatchObject({ outcome: 'jev_error_injected', jev: { label: 'skip', status: 'below_threshold' } });
  });

  it('inject_impact widens to the transitive callers', async () => {
    const wide: GraphAnswer = { definitions: PARSE_CONFIG.definitions, callers: [...PARSE_CONFIG.callers, caller('apps/cli/main.ts', 5, 9, 'main', 2)] };
    const { graph, calls } = fakeGraph({ parseConfig: PARSE_CONFIG }, { impact: { parseConfig: wide } });
    const inj = injector(graph, decider(applied('inject_impact')).decide);
    const out = await inj.handlePostToolUse('Bash', { command: 'rg parseConfig' }, rgOutput([]));
    expect(calls.map(c => c.depth)).toEqual([1, 3]);
    expect(out).toContain('apps/cli/main.ts:5 (caller: main, 2 hops)');
    expect(inj.snapshot().byOutcome).toEqual({ injected_impact: 1 });
  });

  it('sends facts only: counts, booleans and labels', async () => {
    const { graph } = fakeGraph({ parseConfig: PARSE_CONFIG });
    const d = decider(applied('inject_callers'));
    const inj = injector(graph, d.decide, { kind: 'engineering', category: 'bug', pathManifest: ['packages/core/**'] });
    inj.observeToolCall('Edit', { file_path: `${WT}/packages/core/load.ts` });
    await inj.handlePostToolUse('Bash', { command: 'rg -n parseConfig' }, rgOutput(['apps/api/src/server.ts:41:x']));
    expect(d.facts[0]).toEqual({
      trigger: 'bash', taskKind: 'engineering', taskCategory: 'bug',
      missedInManifest: true, missedAlreadyEdited: true,
      hitCount: 1, hitFiles: 1, definitionCount: 1, callerCount: 2, diffSize: 2,
      definitionMissed: true, symbolKind: 'Function',
    });
    expect(JSON.stringify(d.facts)).not.toMatch(/parseConfig|server\.ts|load\.ts/);
  });

  it('caps at three injections per session and never repeats a symbol', async () => {
    const answers = Object.fromEntries(['alphaOne', 'betaTwo', 'gammaThree', 'deltaFour'].map(s => [s, PARSE_CONFIG]));
    const { graph, calls } = fakeGraph(answers);
    const inj = injector(graph, decider(applied('inject_callers')).decide);
    expect(await inj.handlePostToolUse('Bash', { command: 'rg alphaOne' }, rgOutput([]))).not.toBeNull();
    expect(await inj.handlePostToolUse('Bash', { command: 'rg alphaOne' }, rgOutput([]))).toBeNull();
    expect(await inj.handlePostToolUse('Grep', { pattern: 'betaTwo' }, {})).not.toBeNull();
    expect(await inj.handlePostToolUse('Bash', { command: 'rg gammaThree' }, rgOutput([]))).not.toBeNull();
    expect(await inj.handlePostToolUse('Bash', { command: 'rg deltaFour' }, rgOutput([]))).toBeNull();
    expect(calls.map(c => c.symbol)).toEqual(['alphaOne', 'betaTwo', 'gammaThree']);
    const snap = inj.snapshot();
    expect(snap.byOutcome).toEqual({ injected_callers: 3, repeat_symbol: 1, cap_reached: 1 });
    expect(snap.triggers).toBe(5);
    expect(snap.injections).toBe(3);
  });

  it('parallel searches cannot exceed the per-session cap', async () => {
    const symbols = ['alphaOne', 'betaTwo', 'gammaThree', 'deltaFour', 'epsilonFive'];
    const { graph } = fakeGraph(Object.fromEntries(symbols.map(s => [s, PARSE_CONFIG])));
    const inj = injector(graph, async () => {
      await new Promise(r => setTimeout(r, 5));
      return applied('inject_callers');
    });
    const notes = await Promise.all(symbols.map(s => inj.handlePostToolUse('Bash', { command: `rg ${s}` }, rgOutput([]))));
    expect(notes.filter(n => n !== null)).toHaveLength(3);
    const snap = inj.snapshot();
    expect(snap.injections).toBe(3);
    expect(snap.byOutcome).toEqual({ injected_callers: 3, cap_reached: 2 });
  });

  it('a hung graph ends at the hook budget as deadline_exceeded', async () => {
    const { graph } = fakeGraph({ parseConfig: PARSE_CONFIG }, { delayMs: 5_000 });
    const inj = injector(graph, decider(applied('inject_callers')).decide);
    const started = Date.now();
    expect(await inj.handlePostToolUse('Bash', { command: 'rg parseConfig' }, rgOutput([]))).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(inj.snapshot().byOutcome).toEqual({ deadline_exceeded: 1 });
  });

  it('ignores tools that are not triggers without recording anything', async () => {
    const inj = injector(fakeGraph({}).graph, decider(applied('skip')).decide);
    expect(await inj.handlePostToolUse('Read', { file_path: 'x.ts' }, {})).toBeNull();
    expect(await inj.handlePostToolUse('Bash', { command: 'bun run test' }, rgOutput([]))).toBeNull();
    expect(inj.snapshot().triggers).toBe(0);
  });

  it('uptake: a Read of an injected location within the window counts once; after the window it does not', async () => {
    const { graph } = fakeGraph({ parseConfig: PARSE_CONFIG, otherSymbol: { definitions: [def('lib/other.ts', 1)], callers: [] } });
    const inj = injector(graph, decider(applied('inject_callers')).decide);
    await inj.handlePostToolUse('Bash', { command: 'rg parseConfig' }, rgOutput([]));
    inj.observeToolCall('Bash', { command: 'ls' });
    inj.observeToolCall('Read', { file_path: `${WT}/packages/core/load.ts` });
    inj.observeToolCall('Read', { file_path: `${WT}/packages/core/load.ts` });
    expect(inj.snapshot().uptake).toEqual({ window: 10, tracked: 1, taken: 1 });

    await inj.handlePostToolUse('Bash', { command: 'rg otherSymbol' }, rgOutput([]));
    for (let i = 0; i < 10; i++) inj.observeToolCall('Bash', { command: 'ls' });
    inj.observeToolCall('Read', { file_path: `${WT}/lib/other.ts` });
    expect(inj.snapshot().uptake).toEqual({ window: 10, tracked: 2, taken: 1 });
  });

  it('persists no command, pattern, symbol or path', async () => {
    const { graph } = fakeGraph({ parseConfig: PARSE_CONFIG });
    const inj = injector(graph, decider(applied('inject_callers')).decide);
    await inj.handlePostToolUse('Bash', { command: 'rg -n parseConfig apps/secret-dir' }, rgOutput(['apps/api/src/server.ts:41:token=abc']));
    inj.observeToolCall('Read', { file_path: `${WT}/packages/core/load.ts` });
    const json = JSON.stringify(inj.snapshot());
    for (const leak of ['parseConfig', 'secret-dir', 'server.ts', 'load.ts', 'config.ts', 'loadAll', 'bootServer', 'token=abc', 'rg ']) {
      expect(json).not.toContain(leak);
    }
  });
});

// ── Codex and the CBM counters ───────────────────────────────────────────────

describe('unsupported backend (Codex)', () => {
  it('counts identifier searches as unsupported_backend and nothing else', () => {
    const m = emptyCbmInjectionMetrics(false, 'unsupported_backend');
    recordUnsupportedTrigger(m, 'Bash', { command: 'rg -n parseConfig' });
    recordUnsupportedTrigger(m, 'Bash', { command: 'bun run build' });
    recordUnsupportedTrigger(m, 'Bash', { command: 'rg "a b"' });
    expect(m).toMatchObject({ enabled: false, disabledReason: 'unsupported_backend', triggers: 1, byOutcome: { unsupported_backend: 1 }, injections: 0 });
    expect(JSON.stringify(m)).not.toContain('parseConfig');
  });
});

describe('CBM-17/18 counters', () => {
  it('injection lands in its own block; toolCalls, totalCbmCalls and file-access counts are untouched', async () => {
    const { graph } = fakeGraph({ parseConfig: PARSE_CONFIG });
    const inj = injector(graph, decider(applied('inject_callers')).decide);
    await inj.handlePostToolUse('Bash', { command: 'rg parseConfig' }, rgOutput([]));
    await inj.handlePostToolUse('Grep', { pattern: 'parseConfigToo' }, {});
    const worker = {
      cbmOutcome: 'enforced' as const,
      cbmToolCounts: { search_graph: 2 },
      cbmFileAccessCounts: { read: 1, grep: 1, glob: 0 },
      cbmInjection: inj.snapshot(),
    };
    const m = buildCbmMetrics(worker)!;
    expect(m.toolCalls).toEqual({ search_graph: 2 });
    expect(m.totalCbmCalls).toBe(2);
    expect([m.readCount, m.grepCount, m.globCount]).toEqual([1, 1, 0]);
    expect(m.injection?.triggers).toBe(2);
    expect(buildCbmMetrics({ ...worker, cbmInjection: undefined })!.injection).toBeUndefined();
  });
});

// ── Contract: a replayed session ─────────────────────────────────────────────

describe('contract: fake session replays `rg someIdentifier` with one missed caller', () => {
  it('produces exactly one injection naming that location, through the PostToolUse hook', async () => {
    const answer: GraphAnswer = {
      definitions: [{ path: 'src/lib/thing.ts', startLine: 10, endLine: 20, relation: 'definition', name: 'someIdentifier', label: 'Function' }],
      callers: [
        { path: 'src/app/a.ts', startLine: 5, endLine: 15, relation: 'caller', name: 'useA', label: 'Function', hop: 1 },
        { path: 'src/app/missed.ts', startLine: 40, endLine: 60, relation: 'caller', name: 'hiddenCaller', label: 'Function', hop: 1 },
      ],
    };
    const { graph } = fakeGraph({ someIdentifier: answer });
    const inj = injector(graph, decider(applied('inject_callers')).decide);
    const hook = createCbmInjectionHook(inj);
    const signal = new AbortController().signal;

    const session: Array<{ tool_name: string; tool_input: unknown; tool_response: unknown }> = [
      { tool_name: 'Read', tool_input: { file_path: `${WT}/README.md` }, tool_response: {} },
      {
        tool_name: 'Bash',
        tool_input: { command: 'rg -n someIdentifier src' },
        tool_response: rgOutput([
          'src/lib/thing.ts:10:export function someIdentifier() {',
          'src/app/a.ts:7:  someIdentifier();',
        ]),
      },
      { tool_name: 'Bash', tool_input: { command: 'bun run test' }, tool_response: rgOutput(['ok']) },
    ];
    const contexts: string[] = [];
    for (const call of session) {
      const out = await hook({ hook_event_name: 'PostToolUse', tool_use_id: 't', session_id: 's', transcript_path: '', cwd: WT, ...call } as never, 't', { signal });
      const ctx = (out as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext;
      if (ctx) contexts.push(ctx);
    }
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toContain('1 location for `someIdentifier`');
    expect(contexts[0]).toContain('- src/app/missed.ts:40 (caller: hiddenCaller)');
    expect(contexts[0]).not.toContain('src/app/a.ts');
    expect(contexts[0]).not.toContain('thing.ts');
    expect(inj.snapshot()).toMatchObject({ triggers: 1, injections: 1, byOutcome: { injected_callers: 1 } });
  });

  it('a non-PostToolUse event or a throwing injector yields {}', async () => {
    const hook = createCbmInjectionHook({ handlePostToolUse: async () => { throw new Error('x'); } } as unknown as CbmInjector);
    const signal = new AbortController().signal;
    expect(await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash' } as never, 't', { signal })).toEqual({});
    expect(await hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {}, tool_response: {} } as never, 't', { signal })).toEqual({});
  });
});
