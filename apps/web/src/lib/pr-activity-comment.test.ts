import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ── GitHub API mock ───────────────────────────────────────────────────────────

type Call = { path: string; options: RequestInit };
const calls: Call[] = [];
let listResponse: unknown = [];
let shouldThrow = false;

const mockGithubApi = mock(async (_installationId: number, path: string, options: RequestInit = {}) => {
  calls.push({ path, options });
  if (shouldThrow) throw new Error('GitHub API error: 403 forbidden');
  if (options.method === undefined || options.method === 'GET') return listResponse;
  return { id: 999 };
});

mock.module('@/lib/github', () => ({ githubApi: mockGithubApi }));

const {
  ACTIVITY_COMMENT_MARKER,
  SPINNER_PATH,
  appendPrActivity,
  parsePrActivityState,
  renderPrActivityComment,
  MAX_ACTIVITY_ENTRIES,
} = await import('./pr-activity-comment');

function bodyOf(call: Call): string {
  return JSON.parse(call.options.body as string).body as string;
}

beforeEach(() => {
  calls.length = 0;
  listResponse = [];
  shouldThrow = false;
  mockGithubApi.mockClear();
});

describe('renderPrActivityComment', () => {
  it('leads with the latest entry as the headline status', () => {
    const body = renderPrActivityComment([
      { kind: 'reviewing', at: '2026-08-29T14:03:00.000Z' },
      { kind: 'ci_fixing', detail: 'attempt 1 of 3', at: '2026-08-29T14:31:00.000Z' },
    ]);

    expect(body).toStartWith(ACTIVITY_COMMENT_MARKER);
    // Headline reflects the most recent entry, not the first.
    const headlineIdx = body.indexOf('CI failed — fixing');
    const logIdx = body.indexOf('Aug 29, 14:03 UTC');
    expect(headlineIdx).toBeGreaterThan(-1);
    expect(headlineIdx).toBeLessThan(logIdx);
  });

  it('renders every entry in the activity log with UTC timestamps', () => {
    const body = renderPrActivityComment([
      { kind: 'reviewing', detail: 'role `builder`', at: '2026-08-29T14:03:00.000Z' },
      { kind: 'changes_pushed', url: 'https://github.com/o/r/pull/7/commits/abc', at: '2026-08-29T15:00:00.000Z' },
    ]);

    expect(body).toContain('Aug 29, 14:03 UTC');
    expect(body).toContain('Reviewing changes');
    expect(body).toContain('role `builder`');
    expect(body).toContain('Aug 29, 15:00 UTC');
    expect(body).toContain('https://github.com/o/r/pull/7/commits/abc');
  });

  it('round-trips its entries through the embedded state block', () => {
    const entries = [
      { kind: 'reviewing' as const, detail: null, url: null, at: '2026-08-29T14:03:00.000Z' },
      { kind: 'review_changes_requested' as const, detail: 'iteration 1/3', url: null, at: '2026-08-29T14:40:00.000Z' },
    ];
    const parsed = parsePrActivityState(renderPrActivityComment(entries));
    expect(parsed).toEqual(entries);
  });

  it('keeps only the most recent entries when the log grows past the cap', () => {
    const entries = Array.from({ length: MAX_ACTIVITY_ENTRIES + 5 }, (_, i) => ({
      kind: 'changes_pushed' as const,
      detail: `push ${i}`,
      at: new Date(Date.UTC(2026, 7, 29, 12, i)).toISOString(),
    }));
    const body = renderPrActivityComment(entries);
    const parsed = parsePrActivityState(body);

    expect(parsed).toHaveLength(MAX_ACTIVITY_ENTRIES);
    expect(parsed[parsed.length - 1]!.detail).toBe(`push ${MAX_ACTIVITY_ENTRIES + 4}`);
    expect(body).not.toContain('push 0');
  });
});

describe('the header spinner', () => {
  it('animates while buildd still has work in hand', () => {
    for (const kind of ['reviewing', 'ci_fixing', 'review_changes_requested', 'changes_pushed'] as const) {
      const body = renderPrActivityComment([{ kind, at: '2026-08-29T14:03:00.000Z' }]);
      expect(body).toContain(`<img src="https://buildd.dev${SPINNER_PATH}"`);
      expect(body).toContain('width="14" height="14"');
    }
  });

  it('falls back to a static icon once the state is terminal', () => {
    for (const kind of ['ci_exhausted', 'review_escalated', 'human_review_required', 'review_approved_awaiting_human'] as const) {
      const body = renderPrActivityComment([{ kind, at: '2026-08-29T14:03:00.000Z' }]);
      // A finished PR must never keep spinning — movement means "on it right now".
      expect(body).not.toContain(SPINNER_PATH);
    }
  });

  it('points the spinner at a camo-reachable origin, never at localhost', () => {
    const original = process.env.NEXT_PUBLIC_APP_URL;
    try {
      process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3001';
      expect(renderPrActivityComment([{ kind: 'reviewing' }])).toContain(`https://buildd.dev${SPINNER_PATH}`);

      process.env.NEXT_PUBLIC_APP_URL = 'https://buildd-preview.vercel.app/';
      expect(renderPrActivityComment([{ kind: 'reviewing' }])).toContain(
        `https://buildd-preview.vercel.app${SPINNER_PATH}`,
      );
    } finally {
      if (original === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
      else process.env.NEXT_PUBLIC_APP_URL = original;
    }
  });

  it('stamps when the current state started so an edit visibly moves forward', () => {
    const body = renderPrActivityComment([
      { kind: 'reviewing', at: '2026-08-29T14:03:00.000Z' },
      { kind: 'ci_fixing', at: '2026-08-29T15:20:00.000Z' },
    ]);
    expect(body).toContain('since Aug 29, 15:20 UTC');
  });
});

describe('the spinner asset', () => {
  it('exists in public/ so the comment never renders a broken image', async () => {
    // Generated by scripts/generate-pr-spinner-gif.ts and committed; a missing
    // file would show up as a broken image on every buildd PR comment.
    const path = `${import.meta.dir}/../../public${SPINNER_PATH}`;
    const file = Bun.file(path);
    expect(await file.exists()).toBe(true);
    const header = new Uint8Array(await file.slice(0, 6).arrayBuffer());
    expect(new TextDecoder().decode(header)).toBe('GIF89a');
    // GIF89a alone isn't enough — it must be animated (>1 image descriptor).
    const bytes = new Uint8Array(await file.arrayBuffer());
    let frames = 0;
    for (let i = 0; i < bytes.length - 3; i++) {
      if (bytes[i] === 0x21 && bytes[i + 1] === 0xf9 && bytes[i + 2] === 0x04) frames++;
    }
    expect(frames).toBeGreaterThan(1);
  });
});

describe('parsePrActivityState', () => {
  it('returns an empty list for a body with no state block', () => {
    expect(parsePrActivityState('just a human comment')).toEqual([]);
  });

  it('returns an empty list when the state block is corrupt', () => {
    expect(parsePrActivityState(`${ACTIVITY_COMMENT_MARKER}\n<!-- buildd-activity-state:{oops -->`)).toEqual([]);
  });
});

describe('appendPrActivity', () => {
  it('creates the sticky comment when the PR has none', async () => {
    listResponse = [{ id: 1, body: 'a human comment' }];

    const result = await appendPrActivity({
      installationId: 42,
      repoFullName: 'buildd-ai/buildd',
      prNumber: 7,
      entry: { kind: 'reviewing', at: '2026-08-29T14:03:00.000Z' },
    });

    expect(result).toEqual({ action: 'created', commentId: 999 });
    const post = calls.find((c) => c.options.method === 'POST')!;
    expect(post.path).toBe('/repos/buildd-ai/buildd/issues/7/comments');
    expect(bodyOf(post)).toContain('Reviewing changes');
  });

  it('edits the existing sticky comment and preserves earlier entries', async () => {
    const existing = renderPrActivityComment([{ kind: 'reviewing', at: '2026-08-29T14:03:00.000Z' }]);
    listResponse = [
      { id: 1, body: 'unrelated' },
      { id: 55, body: existing },
    ];

    const result = await appendPrActivity({
      installationId: 42,
      repoFullName: 'buildd-ai/buildd',
      prNumber: 7,
      entry: { kind: 'ci_fixing', detail: 'attempt 1 of 3', at: '2026-08-29T14:31:00.000Z' },
    });

    expect(result).toEqual({ action: 'updated', commentId: 55 });
    const patch = calls.find((c) => c.options.method === 'PATCH')!;
    expect(patch.path).toBe('/repos/buildd-ai/buildd/issues/comments/55');
    const parsed = parsePrActivityState(bodyOf(patch));
    expect(parsed.map((e) => e.kind)).toEqual(['reviewing', 'ci_fixing']);
    expect(calls.some((c) => c.options.method === 'POST')).toBe(false);
  });

  it('collapses a repeat of the latest entry instead of appending a duplicate', async () => {
    const existing = renderPrActivityComment([
      { kind: 'reviewing', detail: 'role `builder`', at: '2026-08-29T14:03:00.000Z' },
    ]);
    listResponse = [{ id: 55, body: existing }];

    const result = await appendPrActivity({
      installationId: 42,
      repoFullName: 'buildd-ai/buildd',
      prNumber: 7,
      entry: { kind: 'reviewing', detail: 'role `builder`', at: '2026-08-29T14:09:00.000Z' },
    });

    expect(result).toEqual({ action: 'unchanged', commentId: 55 });
    expect(calls.some((c) => c.options.method === 'PATCH')).toBe(false);
  });

  it('does not create a comment for onlyIfPresent entries when none exists', async () => {
    listResponse = [{ id: 1, body: 'a human comment' }];

    const result = await appendPrActivity({
      installationId: 42,
      repoFullName: 'buildd-ai/buildd',
      prNumber: 7,
      entry: { kind: 'changes_pushed' },
      onlyIfPresent: true,
    });

    expect(result).toEqual({ action: 'unchanged', commentId: 0 });
    expect(calls.some((c) => c.options.method === 'POST')).toBe(false);
  });

  it('never throws when GitHub rejects the call', async () => {
    shouldThrow = true;

    const result = await appendPrActivity({
      installationId: 42,
      repoFullName: 'buildd-ai/buildd',
      prNumber: 7,
      entry: { kind: 'reviewing' },
    });

    expect(result).toEqual({ action: 'failed' });
  });
});
