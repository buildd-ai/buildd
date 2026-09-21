import { describe, it, expect } from 'bun:test';

/**
 * A ratchet on how much of each dashboard surface is a *serial* wait.
 *
 * neon-http opens one HTTP request per statement and does not pool, so the
 * cost of these render paths is dominated by how many waits happen one after
 * another rather than by how much work Postgres does — the heaviest plan across
 * all three surfaces executes in tens of milliseconds, and most in under one.
 * A page that resolves eight independent reads in sequence pays eight round
 * trips for one round trip's worth of latency.
 *
 * `await` count is the proxy, and it is the right one: an `await Promise.all([
 * ... ])` counts once no matter how many statements it holds, while a serial
 * chain counts once per statement. So the number only goes up when someone adds
 * a new wait that nothing else is waiting alongside.
 *
 * These are ceilings, not targets. Raising one is allowed — but it should be a
 * deliberate edit with a reason, not something that drifts upward unnoticed,
 * which is exactly what happened before this ratchet existed.
 */
const CEILINGS: Record<string, number> = {
  // Shared shell for every /app route. force-dynamic, so it re-runs on every
  // navigation: user -> { teams, workspace scope, cookies } -> team workspaces.
  'layout.tsx': 3,
  'missions/page.tsx': 11,
  'missions/[id]/page.tsx': 15,
  'tasks/[id]/page.tsx': 19,
};

/**
 * Strips comments before counting, so prose that happens to contain the word
 * cannot inflate or deflate the measurement.
 */
function countSerialWaits(source: string): number {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/[ \t]+\/\/.*$/gm, '');
  return (code.match(/\bawait\s/g) ?? []).length;
}

const sources = new Map<string, string>();
for (const rel of Object.keys(CEILINGS)) {
  sources.set(rel, await Bun.file(new URL(`./${rel}`, import.meta.url)).text());
}

describe('dashboard render waterfalls stay collapsed', () => {
  for (const [rel, ceiling] of Object.entries(CEILINGS)) {
    it(`${rel} holds at or below ${ceiling} serial waits`, () => {
      const count = countSerialWaits(sources.get(rel)!);
      expect(count).toBeLessThanOrEqual(ceiling);
    });
  }

  it('counts a Promise.all group as one wait and a serial chain as many', () => {
    // Guards the measurement itself — a counter that cannot tell the two apart
    // would ratchet nothing.
    expect(countSerialWaits('const [a, b] = await Promise.all([f(), g()]);')).toBe(1);
    expect(countSerialWaits('const a = await f(); const b = await g();')).toBe(2);
    expect(countSerialWaits('// await f()\n/* await g() */')).toBe(0);
  });
});

describe('task detail keeps GitHub off the critical path', () => {
  const page = () => sources.get('tasks/[id]/page.tsx')!;

  it('does not call the GitHub REST client from the page body', () => {
    // Up to three sequential REST calls with no latency ceiling, and unlike the
    // DB round trips on this page they do not shrink from running in-region.
    // They live in PrDetailsCard behind a Suspense boundary now.
    expect(page()).not.toContain('githubApi(');
  });

  it('streams the PR panel behind a boundary whose fallback is the stored card', () => {
    const source = page();
    expect(source).toContain('<Suspense fallback={<StoredPrCard {...storedPrFacts} />}>');
    expect(source).toContain('<PrDetailsCard workspaceId={task.workspaceId} {...storedPrFacts} />');
  });
});

describe('protected layout degrades per-surface, not all-or-nothing', () => {
  const layout = () => sources.get('layout.tsx')!;

  it('resolves teams, workspace scope and cookies as one group', () => {
    expect(layout()).toContain('await Promise.all([');
  });

  it('gives each loader its own catch, so one failure does not blank the shell', () => {
    // Before these ran concurrently each had its own try/catch: a teams failure
    // still rendered the page, a workspace-scope failure only cost
    // notifications. A bare Promise.all would reject the whole group on the
    // first error and lose that, so the isolation is per-entry .catch now.
    const source = layout();
    expect(source).toContain('getUserTeamsWithDetails(user.id).catch(');
    expect(source).toContain('getUserWorkspaceIds(user.id).catch(');
  });
});
