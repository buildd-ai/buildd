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
      lastFailingCommand: undefined,
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

  it('renders nothing for a clean task', () => {
    expect(renderToStaticMarkup(<TaskEvidenceCard status="completed" result={{ summary: 'ok' }} />)).toBe('');
    expect(renderToStaticMarkup(<TaskEvidenceCard status="completed" result={null} />)).toBe('');
  });
});
