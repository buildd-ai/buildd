import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import TaskEvidenceCard from './TaskEvidenceCard';

const evidence = {
  errorClass: 'test_failure',
  keyLines: ['(fail) billing > rounds up', 'error: expected 1 received 2'],
  lastFailingCommand: { command: 'bun run test', exitCode: 1 },
  ciChecks: [{ name: 'unit', state: 'failed', url: 'https://example.test/job/1' }],
  diff: { files: 0, added: 0, removed: 0 },
  links: { prUrl: 'https://example.test/pull/7' },
  keyLinesSource: 'traces',
  capturedAt: '2026-01-01T00:00:00.000Z',
};

describe('TaskEvidenceCard', () => {
  it('shows the error class, key lines, last command and failing check', () => {
    const html = renderToStaticMarkup(<TaskEvidenceCard status="failed" result={{ evidence }} />);
    expect(html).toContain('data-testid="task-evidence"');
    expect(html).toContain('test failure');
    expect(html).toContain('(fail) billing');
    expect(html).toContain('bun run test');
    expect(html).toContain('[exit 1]');
    expect(html).toContain('href="https://example.test/job/1"');
    expect(html).not.toContain('task-mismatch');
  });

  it('shows a mismatch banner', () => {
    const html = renderToStaticMarkup(
      <TaskEvidenceCard status="completed" result={{ mismatch: [{ kind: 'pushed_without_diff', detail: 'Summary says pushed, 0 files changed' }] }} />,
    );
    expect(html).toContain('data-testid="task-mismatch"');
    expect(html).toContain('Summary says pushed, 0 files changed');
  });

  it('an agent sign-in failure is named as such, raw stderr collapsed', () => {
    const auth = {
      ...evidence,
      errorClass: 'auth',
      // Something curated besides the sign-in noise, so the card still has a job.
      lastFailingCommand: { command: 'bun run build', exitCode: 1 },
      ciChecks: [],
      links: {},
      keyLines: ["[mcp-sdk] SEP-2352: stored OAuth credential has no 'issuer' stamp", 'Not logged in · Please run /login'],
    };
    const html = renderToStaticMarkup(<TaskEvidenceCard status="failed" result={{ evidence: auth }} />);
    expect(html).toContain('agent sign-in');
    expect(html).toContain('Show raw output');
    expect(html).not.toContain('SEP-2352');
    expect(html).not.toContain('Please run /login');
  });

  it('unclassified stderr is collapsed by default too', () => {
    const noise = { ...evidence, errorClass: 'unknown', keyLines: ['[mcp-sdk] some warning'] };
    const html = renderToStaticMarkup(<TaskEvidenceCard status="failed" result={{ evidence: noise }} />);
    expect(html).toContain('Show raw output');
    expect(html).not.toContain('[mcp-sdk] some warning');
  });

  it('a sign-in failure with nothing else recorded leaves the explaining to the action zone', () => {
    // The fresh-user walkthrough: "Evidence · Unknown" over two raw lines and
    // "0 files", under a zone that already said what to do.
    const bare = { ...evidence, errorClass: 'unknown', lastFailingCommand: undefined, ciChecks: [], links: {}, keyLines: ['[mcp] server buildd connected', 'session ended'] };
    const html = renderToStaticMarkup(
      <TaskEvidenceCard status="failed" result={{ evidence: bare }} workerError="Not logged in · Please run /login" backend="claude" />,
    );
    expect(html).toBe('');
    // A mismatch still shows: that is a different claim.
    const withMismatch = renderToStaticMarkup(
      <TaskEvidenceCard status="failed" result={{ evidence: bare, mismatch: [{ kind: 'pushed_without_diff', detail: 'Summary says pushed' }] }} workerError="Not logged in · Please run /login" backend="claude" />,
    );
    expect(withMismatch).toContain('Summary says pushed');
    expect(withMismatch).not.toContain('Evidence');
  });

  it('never labels the card "unknown"', () => {
    const noise = { ...evidence, errorClass: 'unknown', keyLines: ['[mcp-sdk] some warning'] };
    const html = renderToStaticMarkup(<TaskEvidenceCard status="failed" result={{ evidence: noise }} />);
    expect(html).toContain('Evidence');
    expect(html.toLowerCase()).not.toContain('unknown');
  });

  it('renders nothing for a clean task', () => {
    expect(renderToStaticMarkup(<TaskEvidenceCard status="completed" result={{ summary: 'ok' }} />)).toBe('');
    expect(renderToStaticMarkup(<TaskEvidenceCard status="completed" result={null} />)).toBe('');
  });
});

describe('TaskEvidenceCard: a red-check mismatch', () => {
  // The shape a run left before exploration noise was filtered at the source:
  // an exploratory grep as the "last failing command", its output as key lines.
  const stale = {
    errorClass: 'test_failure',
    keyLines: ['grep: apps/web/tests: No such file or directory', '(fail) not really'],
    lastFailingCommand: { command: 'grep -rn "expect(" apps/web/tests 2>/dev/null', exitCode: 2 },
    ciChecks: [{ name: 'check', state: 'failed', url: 'https://example.test/job/9' }, { name: 'build', state: 'passed', url: null }],
    diff: { files: 3, added: 10, removed: 2 },
    links: {},
    keyLinesSource: 'traces',
    capturedAt: '2026-01-01T00:00:00.000Z',
  };
  const mismatch = [{ kind: 'success_with_red_check', detail: 'Reported success while a check was failing: check.' }];

  it('shows the check row and its key line, never the bash trace, and is labelled by what it shows', () => {
    const html = renderToStaticMarkup(
      <TaskEvidenceCard
        status="completed"
        result={{ evidence: stale, mismatch }}
        failingChecks={[{ name: 'check', state: 'failed', url: 'https://example.test/job/9', line: 'PR body lint: body contains a full UUID' }]}
      />,
    );
    expect(html).toContain('data-testid="task-evidence-checks"');
    expect(html).toContain('✗ check');
    expect(html).toContain('PR body lint: body contains a full UUID');
    expect(html).toContain('Evidence · failing check');
    expect(html).not.toContain('test failure');
    expect(html).not.toContain('grep -rn');
    expect(html).not.toContain('No such file or directory');
    // Only red checks, not the whole list.
    expect(html).not.toContain('✓ build');
  });
});
