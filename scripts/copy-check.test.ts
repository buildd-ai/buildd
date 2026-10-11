import { describe, expect, it } from 'bun:test';
import { COPY_RULES, copyViolations } from '../packages/core/copy-rules';
import { extractCopy, findRegressions, inScope, parseBaseline, readSources, scanSources, serializeBaseline, updatedBaseline } from './copy-check';

const OLD = 'apps/web/src/app/app/(protected)/settings/old.tsx';
const NEW = 'apps/web/src/app/app/(protected)/settings/new.tsx';
const ids = (t: string) => copyViolations(t).map((r) => r.id);

describe('copy rules', () => {
  it('every rule flags its own bad example and passes its good one', () => {
    for (const rule of COPY_RULES) {
      if (rule.fileLevel) continue;
      expect(rule.test(rule.bad.replace(/\s+/g, ' '))).toBe(true);
      expect(rule.test(rule.good)).toBe(false);
    }
  });

  it('flags "not this, it\'s that": the owner\'s Models card, verbatim', () => {
    // Settings > Models, Claude subscription card (owner, 2026-10-09: "ai slopfest").
    expect(ids("Not chat: A subscription seat signs in a runner; buildd’s server never spends a seat.")).toContain('not-this-its-that');
    expect(ids('Not codex runs: A Claude subscription signs in Claude Code; the Codex CLI cannot use it.')).toContain('not-this-its-that');
    expect(ids('Not cloud runs: Cloud containers never receive a seat; only an owner seat set on your own Cloudflare Worker can.')).toContain('not-this-its-that');
    expect(ids('Not codex runs: The Codex CLI speaks the OpenAI wire; this provider does not serve it.')).toContain('not-this-its-that');
    // The contrast form of the same habit.
    expect(ids('Endpoint runs are metered on its key, not a Claude seat.')).toContain('not-this-its-that');
  });

  it('flags internal words in end-user copy', () => {
    expect(ids('Not codex runs: The Codex CLI speaks the OpenAI wire; this provider does not serve it.')).toContain('internal-jargon');
    expect(ids('Serves Chat · claude runs · cloud runs')).toContain('internal-jargon');
    expect(ids('Cloud containers never receive a seat.')).toContain('internal-jargon');
  });

  it('flags a warning shown where a default would do', () => {
    expect(ids('No policy chosen: agents use team keys.')).toContain('warning-instead-of-default');
    expect(ids('Pick one to apply it to agent runs.')).toContain('warning-instead-of-default');
  });

  it('leaves the rewritten Models copy alone', () => {
    for (const t of ['Keys and subscriptions your agents and chat use.', 'Who pays', 'Team key', "Everyone uses the team's key.", "Mine, then the team's", "Uses your key when you've added one.", 'Mine only', 'You need your own key to start work.', 'Used for chat and Claude agents.', 'Used by Claude agents on your runners.', 'Not set', 'Working', 'Not used by anything']) {
      expect(ids(t)).toEqual([]);
    }
  });

  it('counts an explanation rendered twice in one file', () => {
    const tsx = `export const A = () => <div><p>Uses your team key for every agent you start.</p><details><p>Uses your team key for every agent you start.</p></details></div>;`;
    const { counts } = scanSources([{ path: NEW, content: tsx }]);
    expect(counts['duplicate-explanation'][NEW]).toBe(1);
    const once = `export const A = () => <p>Uses your team key for every agent you start.</p>;`;
    expect(scanSources([{ path: NEW, content: once }]).counts['duplicate-explanation'][NEW]).toBeUndefined();
  });

  it('flags the copy that started this: storage explaining itself', () => {
    expect(ids('No bucket of your own yet. Evidence goes to buildd\'s managed bucket and is kept 30 days.')).toEqual(['empty-yet', 'of-your-own']);
    expect(ids('Where run evidence is kept: failing command output, test reports, CI logs and transcripts.')).toEqual(['self-description']);
    expect(ids('Recommended. Nothing to paste, nothing to go stale.')).toEqual(['reassurance']);
    expect(ids('Codex disabled. Those jobs now run on Claude. Re-enable any time; per-workspace settings are unchanged.')).toEqual(['reassurance']);
    expect(ids('Stored encrypted. Nobody can read it back.')).toEqual(['reassurance']);
  });

  it('leaves plain labels, facts and errors alone', () => {
    for (const t of ['Where it runs', 'This page failed to render', 'No workspaces.', 'Encrypted, never sent to runners.', 'Approve in the browser, then paste the code.']) {
      expect(ids(t)).toEqual([]);
    }
  });
});

describe('extractCopy', () => {
  it('reads a JSX sentence whole, nested markup and expressions included', () => {
    const src = 'export const A = () => <p>No bucket <strong>of your own</strong> for {name} yet.</p>;';
    expect(extractCopy(NEW, src).map((s) => s.text)).toEqual(['No bucket of your own for N yet.']);
  });

  it('reads string and template literals in props and toasts', () => {
    const src = [
      'const a = <Field hint="Nothing to configure here." />;',
      'setMsg({ text: `Saved for ${n} teams. Nobody can read it back.` });',
    ].join('\n');
    expect(extractCopy(NEW, src)).toEqual([
      { line: 1, text: 'Nothing to configure here.' },
      { line: 2, text: 'Saved for N teams. Nobody can read it back.' },
    ]);
  });

  it('never reads comments, imports, class lists, hrefs or console output', () => {
    const src = [
      "import x from 'no bucket of your own yet';",
      '// No bucket of your own yet.',
      'const c = <div className="px-4 py-2 text-text-muted" href="/app/settings/storage" />;',
      "console.error('No bucket of your own yet.');",
    ].join('\n');
    expect(extractCopy(NEW, src)).toEqual([]);
  });

  it('scopes to rendered app code: no API routes, tests or dev fixtures', () => {
    expect(inScope('apps/web/src/components/settings/ProviderKeyCard.tsx')).toBe(true);
    expect(inScope('apps/web/src/app/api/workers/route.ts')).toBe(false);
    expect(inScope('apps/web/src/app/app/(protected)/settings/Foo.dom.test.tsx')).toBe(false);
    expect(inScope('apps/web/src/app/app/dev/chat/chat-fixtures.ts')).toBe(false);
  });
});

describe('ratchet', () => {
  const bad = 'export const A = () => <p>No rules yet.</p>;';

  it('reports a regression by the file that introduced it, not pre-existing debt', () => {
    const before = scanSources([{ path: OLD, content: bad }]);
    const after = scanSources([{ path: OLD, content: bad }, { path: NEW, content: bad }]);
    const r = findRegressions(before.counts, after.counts, after.violations);
    expect(r.map((x) => x.rule)).toEqual(['empty-yet']);
    expect(r[0].offenders.map((v) => v.file)).toEqual([NEW]);
  });

  it('--update locks in paid-down debt and refuses new debt', () => {
    const before = scanSources([{ path: OLD, content: bad }]).counts;
    const fixed = scanSources([{ path: OLD, content: 'export const A = () => <p>No rules.</p>;' }]).counts;
    expect(updatedBaseline(before, fixed, false).next['empty-yet']).toEqual({});
    const worse = scanSources([{ path: OLD, content: bad }, { path: NEW, content: bad }]).counts;
    expect(updatedBaseline(before, worse, false).refused).toEqual(['empty-yet']);
  });

  it('round-trips the baseline and rejects a malformed one', () => {
    const { counts } = scanSources([{ path: OLD, content: bad }]);
    expect(parseBaseline(serializeBaseline(counts))).toEqual(counts);
    expect(() => parseBaseline('{}')).toThrow(/missing rule/);
  });

  it('the committed baseline holds against the tree (guard the guard: the scan finds files)', async () => {
    const sources = readSources();
    expect(sources.length).toBeGreaterThan(300);
    const { readFileSync } = await import('fs');
    const { counts, violations } = scanSources(sources);
    const baseline = parseBaseline(readFileSync('scripts/copy-check.baseline.json', 'utf8'));
    expect(findRegressions(baseline, counts, violations)).toEqual([]);
  });
});
