/**
 * `buildd top` and the runner's login mode (spec c7410e76 R-60, AC-43, AC-44;
 * spec 34a48877 R-14): a header line saying what each login does now and the
 * mode, and `b` cycling the mode.
 */
import { describe, expect, test } from 'bun:test';
import { createPalette, stripAnsi } from '../../src/terminal-palette';
import { renderFrame } from '../../src/top/render';
import { handleKey } from '../../src/top/keys';
import { loginsLine, reduce, type TopState, type TopWorker } from '../../src/top/state';
import type { RunRoute } from '../../src/run-route';
import { NOW, fixtureState } from './top-fixture';

const plain = createPalette('night', 'none');
const text = (s: TopState, cols = 160, rows = 30) => renderFrame(s, { cols, rows, now: NOW, palette: plain }).map(l => stripAnsi(l)).join('\n');

const CLAUDE_PLAN: RunRoute = { backend: 'claude', bucket: 'plan', provider: 'anthropic', owner: 'machine' };
const CODEX_PLAN: RunRoute = { backend: 'codex', bucket: 'plan', provider: 'openai', owner: 'machine' };

const agent = (id: string, backend: 'claude' | 'codex'): TopWorker => ({
  id, taskId: `t-${id}`, taskTitle: id, status: 'working', startedAt: NOW - 60_000, taskBackend: backend,
  route: backend === 'codex' ? CODEX_PLAN : CLAUDE_PLAN,
} as TopWorker);

function withLogins(mode: string | undefined, agents: TopWorker[], slots = 9): TopState {
  let s = reduce(fixtureState(), { type: 'workers', workers: agents });
  s = reduce(s, { type: 'config', maxConcurrent: slots, routes: [CLAUDE_PLAN, CODEX_PLAN], routeProblems: [], ...(mode ? { loginMode: mode } : {}) } as any);
  return s;
}

describe('the logins line (R-60)', () => {
  test('AC-43: claude-first with 6 on Claude: Codex is idle and says when it takes work', () => {
    const s = withLogins('claude-first', ['a', 'b', 'c', 'd', 'e', 'f'].map(id => agent(id, 'claude')));
    expect(loginsLine(s, NOW)).toBe('Logins: Claude plan · 6 running · Codex plan · idle · takes work when Claude is at its limit · claude-first (b to change)');
    expect(text(s)).toContain('Claude plan · 6 running · Codex plan · idle · takes work when Claude is at its limit');
  });

  test('AC-43: a login at its limit says until when', () => {
    let s = withLogins('claude-first', [agent('a', 'claude')]);
    const at = new Date(NOW);
    at.setHours(2, 46, 0, 0);
    if (at.getTime() <= NOW) at.setDate(at.getDate() + 1);
    s = reduce(s, { type: 'claim_outcome', outcome: { at: NOW, reason: 'budget_exhausted_partial', walls: [{ kind: 'provider_pause', backend: 'codex', resetsAt: at.toISOString() }] } } as any);
    expect(loginsLine(s, NOW)).toMatch(/Codex plan · at its limit until (\w{3} )?02:46/);
  });

  test('balanced counts each login against its share', () => {
    const s = withLogins('balanced', [agent('a', 'claude'), agent('b', 'claude'), agent('c', 'codex')]);
    expect(loginsLine(s, NOW)).toBe('Logins: Claude plan · 2 of 6 running · Codex plan · 1 of 3 running · balanced (b to change)');
  });

  test('an older runner that reports no mode shows no logins line', () => {
    const s = withLogins(undefined, [agent('a', 'claude')]);
    expect(loginsLine(s, NOW)).toBeNull();
    expect(text(s)).not.toContain('b to change');
  });

  test('a runner with one login has nothing to share: no line', () => {
    let s = reduce(fixtureState(), { type: 'config', maxConcurrent: 3, routes: [CLAUDE_PLAN], routeProblems: [], loginMode: 'balanced' } as any);
    s = reduce(s, { type: 'workers', workers: [] });
    expect(loginsLine(s, NOW)).toBeNull();
  });
});

describe('the detail says why a run is on its backend (R-40)', () => {
  test("a run the runner's mode moved to Codex says so", () => {
    const w = { ...agent('a', 'codex'), routedWhy: "routed to Codex by this runner's balanced mode" };
    let s = withLogins('balanced', [w]);
    s = { ...s, mode: { kind: 'detail', taskId: w.taskId } } as TopState;
    expect(text(s)).toContain("Routed to Codex by this runner's balanced mode.");
  });
});

describe('b (AC-44)', () => {
  test('b cycles the mode, shows it at once, says so, and asks the runner to set it', () => {
    const s = withLogins('balanced', []);
    const r = handleKey(s, { name: 'char', ch: 'b' }, NOW);
    expect(r.effects).toEqual([{ type: 'logins', mode: 'claude-first' }]);
    expect(r.state.runner.loginMode).toBe('claude-first');
    expect(r.state.status?.text).toBe('Login mode now claude-first. Running agents keep their login; the next claim follows it.');
    expect(loginsLine(r.state, NOW)).toContain('claude-first (b to change)');
  });

  test('the runner pushing a new mode (buildd logins from a shell) updates the header', () => {
    const s = reduce(withLogins('balanced', []), { type: 'logins', loginMode: 'codex-first' } as any);
    expect(s.runner.loginMode).toBe('codex-first');
  });

  test('on an older runner b says to update it and asks nothing', () => {
    const r = handleKey(withLogins(undefined, []), { name: 'char', ch: 'b' }, NOW);
    expect(r.effects).toEqual([]);
    expect(r.state.status?.text).toContain('update it');
  });

  test('help names b', () => {
    const s = { ...withLogins('balanced', []), mode: { kind: 'help' as const } };
    expect(text(s, 160, 40)).toMatch(/b +switch which login takes new work/);
  });
});
