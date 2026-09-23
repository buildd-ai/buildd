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

// ── Team timezone mock ────────────────────────────────────────────────────────

let workspaceTimezone = 'UTC';
const workspaceTimezoneCalls: Array<string | null | undefined> = [];
mock.module('@/lib/team-timezone', () => ({
  getWorkspaceTimezone: async (workspaceId?: string | null) => {
    workspaceTimezoneCalls.push(workspaceId);
    return workspaceTimezone;
  },
}));

const {
  ACTIVITY_COMMENT_MARKER,
  SPINNER_PATH,
  appendPrActivity,
  parsePrActivityState,
  renderPrActivityComment,
  formatOffset,
  GLYPH,
  MAX_ACTIVITY_ENTRIES,
  MAX_NOTE_CHARS,
} = await import('./pr-activity-comment');

function bodyOf(call: Call): string {
  return JSON.parse(call.options.body as string).body as string;
}

beforeEach(() => {
  calls.length = 0;
  listResponse = [];
  shouldThrow = false;
  workspaceTimezone = 'UTC';
  workspaceTimezoneCalls.length = 0;
  mockGithubApi.mockClear();
});

// The #2658 scenario, one fix iteration end to end. Timestamps are spaced so
// the offsets are easy to read in assertions.
const T0 = '2026-09-23T11:31:00.000Z';
const at = (mins: number) => new Date(Date.parse(T0) + mins * 60_000).toISOString();
const TASK = 'https://buildd.dev/app/tasks/fix-1';
const FEEDBACK =
  'In apps/web/src/lib/foo.ts:120 the retry path swallows the error.\nPlease surface it and add a regression test.';

const reviewing = { kind: 'reviewing' as const, at: at(0) };
const queued = {
  kind: 'review_changes_requested' as const,
  iteration: 1, maxIterations: 3, note: FEEDBACK, taskUrl: TASK, at: at(9),
};
const fixing = { kind: 'fix_started' as const, iteration: 1, maxIterations: 3, taskUrl: TASK, at: at(14) };
const pushed = { kind: 'changes_pushed' as const, sha: 'abc1234', at: at(26) };
const rereview = { kind: 'reviewing' as const, at: at(27) };
const approved = { kind: 'review_approved' as const, note: 'Error now surfaces; test covers it.', at: at(35) };

function headerOf(body: string): string {
  return body.split('\n')[1];
}

describe('status derivation — queued is never shown as working', () => {
  it('a request-changes review reads as a queued fix, with a task link and no spinner', () => {
    const body = renderPrActivityComment([reviewing, queued]);
    const header = headerOf(body);
    expect(header).toContain('**Fix 1 of 3 queued**');
    expect(header).toContain('waiting for a worker');
    expect(header).toContain(`[task](${TASK})`);
    expect(header).toContain(GLYPH.waiting);
    // The bug: "buildd is pushing fixes" while the fix task had no worker.
    expect(body).not.toContain(SPINNER_PATH);
    expect(body.toLowerCase()).not.toContain('pushing');
  });

  it('links the fix task once in the timeline, not on every row', () => {
    const body = renderPrActivityComment([reviewing, queued, fixing]);
    const rows = body.split('\n').filter((l) => l.startsWith('- '));
    expect(rows.filter((r) => r.includes(TASK))).toHaveLength(1);
  });

  it('only a claimed fix animates and says Fixing', () => {
    const header = headerOf(renderPrActivityComment([reviewing, queued, fixing]));
    expect(header).toContain(SPINNER_PATH);
    expect(header).toContain('**Fixing · fix 1 of 3**');
  });

  it('a push waits on checks, naming the short sha', () => {
    const header = headerOf(renderPrActivityComment([reviewing, queued, fixing, pushed]));
    expect(header).toContain('**Pushed `abc1234`**');
    expect(header).toContain('waiting on checks');
    expect(header).not.toContain(SPINNER_PATH);
  });

  it('a review after a fix is a re-review, and says which fix', () => {
    const header = headerOf(renderPrActivityComment([reviewing, queued, fixing, pushed, rereview]));
    expect(header).toContain('**Re-reviewing · after fix 1 of 3**');
    expect(header).toContain(SPINNER_PATH);
  });

  it('approval is an outcome, not motion', () => {
    const header = headerOf(renderPrActivityComment([reviewing, queued, fixing, pushed, rereview, approved]));
    expect(header).toContain(`${GLYPH.done} **Approved**`);
    expect(header).toContain('merging once checks pass');
    expect(header).not.toContain(SPINNER_PATH);
  });

  it('a CI failure is also queued until claimed', () => {
    const body = renderPrActivityComment([
      { kind: 'ci_fixing', iteration: 2, maxIterations: 3, url: 'https://ci/run/1', at: at(0) },
    ]);
    expect(headerOf(body)).toContain('**CI fix 2 of 3 queued**');
    expect(body).toContain('- `0m` CI failed · fix 2 of 3 queued');
    expect(body).toContain('[CI run](https://ci/run/1)');
    expect(body).not.toContain(SPINNER_PATH);
  });

  it('fix_started without its own iteration inherits the queued one', () => {
    const header = headerOf(renderPrActivityComment([queued, { kind: 'fix_started', at: at(12) }]));
    expect(header).toContain('**Fixing · fix 1 of 3**');
  });

  for (const kind of ['review_escalated', 'review_failed', 'human_review_required', 'ci_exhausted'] as const) {
    it(`${kind} flags a human and stops moving`, () => {
      const body = renderPrActivityComment([reviewing, { kind, at: at(5) }]);
      expect(headerOf(body)).toContain(GLYPH.human);
      expect(body).not.toContain(SPINNER_PATH);
    });
  }

  it('the PR closing is always the last word', () => {
    const merged = renderPrActivityComment([reviewing, fixing, { kind: 'merged', detail: 'into `dev`', at: at(40) }]);
    expect(headerOf(merged)).toContain(`${GLYPH.done} **Merged**`);
    expect(merged).not.toContain(SPINNER_PATH);
    const closed = renderPrActivityComment([reviewing, fixing, { kind: 'closed_unmerged', at: at(40) }]);
    expect(headerOf(closed)).toContain(`${GLYPH.ended} **Closed without merging**`);
    expect(closed).not.toContain(SPINNER_PATH);
  });

  it('a lede correction is a timeline row, never the header', () => {
    const body = renderPrActivityComment([
      reviewing,
      { kind: 'lede_corrected', note: 'Rewrote the whole auth layer', at: at(3) },
    ]);
    expect(headerOf(body)).toContain('**Reviewing**');
    expect(body).toContain('Opening line corrected');
    expect(body).toContain('<details><summary>Original</summary>');
    expect(body).toContain('Rewrote the whole auth layer');
  });
});

describe('length and layout', () => {
  it('collapses reviewer feedback instead of pasting it into the row', () => {
    const body = renderPrActivityComment([reviewing, queued]);
    const row = body.split('\n').find((l) => l.startsWith('- ') && l.includes('Changes requested'))!;
    expect(row.startsWith('- `+9m`')).toBe(true);
    expect(row).not.toContain('swallows the error');
    expect(body).toContain('<details><summary>Reviewer feedback</summary>');
    expect(body).toContain('  In apps/web/src/lib/foo.ts:120 the retry path swallows the error.');
  });

  it('moves a legacy long detail into a note', () => {
    const long = 'iteration 1 of 3 — ' + 'the reviewer wrote a very long paragraph about this change. '.repeat(3);
    const body = renderPrActivityComment([{ kind: 'review_changes_requested', detail: long, at: at(0) }]);
    const row = body.split('\n').find((l) => l.startsWith('- '))!;
    expect(row.length).toBeLessThan(80);
    expect(body).toContain('<details>');
  });

  it('keeps every timeline row short enough for a phone', () => {
    const body = renderPrActivityComment([reviewing, queued, fixing, pushed, rereview, approved]);
    const rows = body.split('\n').filter((l) => l.startsWith('- '));
    expect(rows).toHaveLength(6);
    for (const r of rows) {
      // Row text minus markdown link targets: what a reader actually sees.
      const visible = r.replace(/\]\([^)]*\)/g, ']');
      expect(visible.length).toBeLessThanOrEqual(64);
    }
  });

  it('carries one absolute timestamp; rows are offsets from the start', () => {
    const body = renderPrActivityComment([reviewing, queued, fixing, pushed], 'America/New_York');
    expect(body.match(/EDT/g)).toHaveLength(1);
    expect(body).toContain('Started Sep 23, 07:31 EDT');
    expect(body).toContain('- `0m` Reviewing');
    expect(body).toContain('- `+14m` Fixing · fix 1 of 3');
    expect(body).toContain('- `+26m` Pushed `abc1234`');
  });

  it('marks only outcome rows with a glyph', () => {
    const body = renderPrActivityComment([reviewing, queued, fixing, pushed, rereview, approved]);
    const rows = body.split('\n').filter((l) => l.startsWith('- '));
    expect(rows.filter((r) => /[○✓⚑✕]/.test(r))).toEqual([rows[5]]);
    expect(rows[5]).toContain(`${GLYPH.done} Approved`);
  });

  it('cannot be broken out of by a note', () => {
    const body = renderPrActivityComment([
      { kind: 'review_escalated', note: 'bad </details> and --> and <summary>x', at: at(0) },
    ]);
    expect(body.match(/<\/details>/g)).toHaveLength(1);
    const parsed = parsePrActivityState(body);
    expect(parsed[0].note).toBe('bad </details> and --> and <summary>x');
  });

  it('clips a very long note', () => {
    const body = renderPrActivityComment([{ kind: 'review_escalated', note: 'x'.repeat(5000), at: at(0) }]);
    expect(parsePrActivityState(body)[0].note!.length).toBe(MAX_NOTE_CHARS);
  });
});

describe('formatOffset', () => {
  it.each([
    [0, '0m'], [0.5, '0m'], [9, '+9m'], [60, '+1h'], [64, '+1h 4m'], [60 * 24, '+1d'], [60 * 27, '+1d 3h'],
  ])('%p minutes → %p', (mins, out) => {
    expect(formatOffset(T0, at(mins as number))).toBe(out as string);
  });
});

describe('renderPrActivityComment — state block', () => {
  it('round-trips its entries, including the new fields', () => {
    const entries = [reviewing, queued, fixing, pushed];
    expect(parsePrActivityState(renderPrActivityComment(entries))).toEqual(entries);
  });

  it('still reads a comment written by the previous renderer', () => {
    const legacy = [
      ACTIVITY_COMMENT_MARKER,
      '<!-- buildd-activity-state:{"v":1,"entries":[{"kind":"reviewing","detail":"reviewer role `builder`","url":null,"at":"2026-08-29T14:03:00.000Z"}]} -->',
    ].join('\n');
    const parsed = parsePrActivityState(legacy);
    expect(parsed).toHaveLength(1);
    expect(headerOf(renderPrActivityComment(parsed))).toContain('**Reviewing**');
  });

  it('keeps only the most recent entries when the log grows past the cap', () => {
    const entries = Array.from({ length: MAX_ACTIVITY_ENTRIES + 5 }, (_, i) => ({
      kind: 'changes_pushed' as const,
      sha: `sha${i}`,
      at: at(i),
    }));
    const body = renderPrActivityComment(entries);
    const parsed = parsePrActivityState(body);
    expect(parsed).toHaveLength(MAX_ACTIVITY_ENTRIES);
    expect(parsed[parsed.length - 1]!.sha).toBe(`sha${MAX_ACTIVITY_ENTRIES + 4}`);
    expect(body).not.toContain('`sha0`');
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
});

describe('the #2658 walkthrough (snapshot for the PR body)', () => {
  it('renders each phase', () => {
    const phases = {
      queued: [reviewing, queued],
      fixing: [reviewing, queued, fixing],
      pushed: [reviewing, queued, fixing, pushed],
      rereview: [reviewing, queued, fixing, pushed, rereview],
      approved: [reviewing, queued, fixing, pushed, rereview, approved],
    };
    for (const [name, entries] of Object.entries(phases)) {
      const body = renderPrActivityComment(entries, 'America/New_York');
      if (process.env.PRINT_PR_ACTIVITY) console.log(`\n===== ${name} =====\n${body}`);
      expect(body).toStartWith(ACTIVITY_COMMENT_MARKER);
    }
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
    expect(bodyOf(post)).toContain('**Reviewing**');
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
      entry: { kind: 'ci_fixing', iteration: 1, maxIterations: 3, at: '2026-08-29T14:31:00.000Z' },
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

describe('timezone rendering', () => {
  const entries = [
    { kind: 'reviewing' as const, at: '2026-08-29T14:03:00.000Z' },
    { kind: 'ci_fixing' as const, iteration: 1, maxIterations: 3, at: '2026-08-29T15:20:00.000Z' },
  ];

  it('stamps in UTC when no zone is given (unchanged default)', () => {
    expect(renderPrActivityComment(entries)).toContain('Started Aug 29, 14:03 UTC');
  });

  it('stamps the start in the requested zone', () => {
    const body = renderPrActivityComment(entries, 'America/New_York');
    expect(body).toContain('Started Aug 29, 10:03 EDT');
    expect(body).not.toContain('UTC');
  });

  it('falls back to UTC for a zone this runtime does not know', () => {
    expect(renderPrActivityComment(entries, 'Mars/Olympus')).toContain('Started Aug 29, 14:03 UTC');
  });

  it('does not persist the zone in the state block — it is applied at render time', () => {
    const body = renderPrActivityComment(entries, 'America/New_York');
    const recovered = parsePrActivityState(body);
    expect(recovered).toHaveLength(2);
    expect(JSON.stringify(recovered)).not.toContain('New_York');
    expect(renderPrActivityComment(recovered, 'Europe/Berlin')).toContain('Started Aug 29, 16:03 ');
  });

  it('appendPrActivity stamps a new comment in the owning team zone', async () => {
    workspaceTimezone = 'America/New_York';

    await appendPrActivity({
      installationId: 42,
      repoFullName: 'buildd-ai/buildd',
      prNumber: 7,
      entry: { kind: 'reviewing', at: '2026-08-29T14:03:00.000Z' },
      workspaceId: 'ws-1',
    });

    expect(workspaceTimezoneCalls).toEqual(['ws-1']);
    const post = calls.find((c) => c.options.method === 'POST')!;
    expect(bodyOf(post)).toContain('Aug 29, 10:03 EDT');
  });

  it('appendPrActivity re-stamps in the team zone when editing', async () => {
    workspaceTimezone = 'Europe/Berlin';
    listResponse = [
      {
        id: 55,
        body: renderPrActivityComment([{ kind: 'reviewing', at: '2026-08-29T14:03:00.000Z' }], 'UTC'),
      },
    ];

    await appendPrActivity({
      installationId: 42,
      repoFullName: 'buildd-ai/buildd',
      prNumber: 7,
      entry: { kind: 'ci_fixing', iteration: 1, maxIterations: 3, at: '2026-08-29T15:20:00.000Z' },
      workspaceId: 'ws-1',
    });

    const body = bodyOf(calls.find((c) => c.options.method === 'PATCH')!);
    expect(body).toContain('Started Aug 29, 16:03 ');
    expect(body).toContain('- `+1h 17m` CI failed · fix 1 of 3 queued');
    expect(body).not.toContain('UTC');
  });

  it('stamps in UTC when no workspace is supplied, without a lookup', async () => {
    await appendPrActivity({
      installationId: 42,
      repoFullName: 'buildd-ai/buildd',
      prNumber: 7,
      entry: { kind: 'reviewing', at: '2026-08-29T14:03:00.000Z' },
    });

    expect(workspaceTimezoneCalls).toEqual([]);
    const post = calls.find((c) => c.options.method === 'POST')!;
    expect(bodyOf(post)).toContain('Aug 29, 14:03 UTC');
  });
});

describe('appendPrActivity — redelivery', () => {
  it('treats a new fix iteration as a new entry, not a duplicate', async () => {
    listResponse = [{
      id: 55,
      body: renderPrActivityComment([{ kind: 'review_changes_requested', iteration: 1, maxIterations: 3, at: '2026-08-29T14:03:00.000Z' }]),
    }];
    const result = await appendPrActivity({
      installationId: 42,
      repoFullName: 'buildd-ai/buildd',
      prNumber: 7,
      entry: { kind: 'review_changes_requested', iteration: 2, maxIterations: 3, at: '2026-08-29T15:03:00.000Z' },
    });
    expect(result).toEqual({ action: 'updated', commentId: 55 });
  });
});
