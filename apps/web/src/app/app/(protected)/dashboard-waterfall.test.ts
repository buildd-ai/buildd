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
  // navigation and live refresh: user -> the shell's one cached read
  // (lib/app-chrome.ts: teams + workspaces, two statements in one round).
  // Chat availability is read from its cache, never awaited (spec 3ef37387 R-17).
  'layout.tsx': 2,
  'missions/page.tsx': 11,
  // 17: the live-region wrapper awaits its params and the body once each (not reads).
  'missions/[id]/page.tsx': 17,
  // Task page no longer loads sibling navigation or execution-plan chains.
  'tasks/[id]/page.tsx': 14,
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

describe('the shell takes the team timezone from the scope, not a chained lookup', () => {
  it('layout.tsx does not call getTeamTimezoneSetting after resolving the team', () => {
    // Chaining it off the resolved scope put a third serial round trip on
    // every /app request; resolveActiveTeamScope already fetches it in
    // parallel with the workspace query.
    expect(sources.get('layout.tsx')!).not.toContain('getTeamTimezoneSetting(');
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
    expect(source).toContain('<PrDetailsCard workspaceId={task.workspaceId} headSha={prWorker?.lastCommitSha ?? null} {...storedPrFacts} />');
  });
});

describe('every dashboard surface has loading UI', () => {
  // There were none in this tree, so a navigation painted nothing at all until
  // the slowest query in the page resolved. `loading.tsx` is what gives Next a
  // Suspense boundary around the segment's children, so the shell streams and
  // the frame paints while the reads are still in flight.
  const SEGMENTS = ['.', './missions', './missions/[id]', './tasks/[id]'];

  for (const segment of SEGMENTS) {
    it(`${segment} defines loading.tsx`, async () => {
      const file = Bun.file(new URL(`${segment}/loading.tsx`, import.meta.url));
      expect(await file.exists()).toBe(true);
      const source = await file.text();
      // Announce the loading state once for the route, not once per placeholder.
      expect(source).toContain('SkeletonRoute');
    });
  }
});

describe('protected layout: shared chrome is one cached read (spec 3ef37387 R-17)', () => {
  const layout = () => sources.get('layout.tsx')!;

  it('reads teams, workspaces and the active team through loadAppChrome, and still renders when it fails', () => {
    const source = layout();
    expect(source).toContain('loadAppChrome(user.id,');
    // A failure renders the shell with no teams, not an error page.
    expect(source).toMatch(/loadAppChrome\(user\.id, [^\n]*\n\s*\.catch\(\(\) => null\)/);
    for (const old of ['getUserTeamsWithDetails(', 'getUserWorkspaceIds(', 'resolveActiveTeamScope(']) {
      expect(source).not.toContain(old);
    }
  });

  it('never waits on chat availability: it peeks the cached answer', () => {
    const source = layout();
    expect(source).toContain('peekChatAvailability(user.id, currentTeamId)');
    expect(source).not.toContain('getChatAvailability(');
  });
});
