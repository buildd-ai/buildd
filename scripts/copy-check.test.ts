import { describe, expect, it } from 'bun:test';
import { COPY_RULES, copyViolations } from '../packages/core/copy-rules';
import { extractCopy, findRegressions, inScope, parseBaseline, readSources, scanSources, serializeBaseline, updatedBaseline } from './copy-check';

const OLD = 'apps/web/src/app/app/(protected)/settings/old.tsx';
const NEW = 'apps/web/src/app/app/(protected)/settings/new.tsx';
const ids = (t: string) => copyViolations(t).map((r) => r.id);

describe('copy rules', () => {
  it('every rule flags its own bad example and passes its good one', () => {
    for (const rule of COPY_RULES) {
      expect(rule.test(rule.bad.replace(/\s+/g, ' '))).toBe(true);
      expect(rule.test(rule.good)).toBe(false);
    }
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
