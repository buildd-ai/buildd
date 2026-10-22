import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SpecSourceBlock } from './SpecSourceBlock';

describe('SpecSourceBlock', () => {
  it('renders the spec path and a link to the planning task when specSource is present', () => {
    const html = renderToStaticMarkup(
      <SpecSourceBlock specSource={{ specPath: 'docs/design/spec-to-build-pattern.md', planningTaskId: 'task-123' }} />
    );
    expect(html).toContain('docs/design/spec-to-build-pattern.md');
    expect(html).toContain('/app/tasks/task-123');
    expect(html).toContain('Planning task');
  });

  it('renders nothing when specSource is absent', () => {
    expect(renderToStaticMarkup(<SpecSourceBlock specSource={null} />)).toBe('');
    expect(renderToStaticMarkup(<SpecSourceBlock specSource={undefined} />)).toBe('');
  });

  it('renders nothing when specSource is missing required fields', () => {
    expect(
      renderToStaticMarkup(<SpecSourceBlock specSource={{ specPath: '', planningTaskId: 'task-123' }} />)
    ).toBe('');
    expect(
      renderToStaticMarkup(
        // A repo document without its planning task is not shown on its own.
        <SpecSourceBlock specSource={{ specPath: 'docs/design/spec-to-build-pattern.md' }} />
      )
    ).toBe('');
  });

  it('shows the Living Spec revision a task is pinned to, with its short hash', () => {
    const html = renderToStaticMarkup(
      <SpecSourceBlock specSource={{ specId: 's-1', revision: 3, contentHash: 'abcdef0123456789' }} />
    );
    expect(html).toContain('Pinned to revision 3');
    expect(html).toContain('abcdef012345');
    expect(html).not.toContain('Planning task');
  });

  const living = (over: Record<string, unknown> = {}) => ({
    title: 'Bug Intake and Quality', approvedRevision: 1, scoped: true,
    outcome: { outcome: 'unverified' as const, reason: 'AC-3 has no verdict', criteria: [
      { criterionId: 'R-1', text: 'One intake function.', verdict: 'pass' as const, stale: false },
      { criterionId: 'AC-3', text: 'A replay makes one row.', verdict: null, stale: false },
      { criterionId: 'AC-26', text: 'Intake survives a throw.', verdict: 'fail' as const, stale: false },
    ] },
    ...over,
  });

  it('names the spec, links its page, and shows each criterion the task answers for, failures first', () => {
    const html = renderToStaticMarkup(
      <SpecSourceBlock specSource={{ specId: 's-1', revision: 1, contentHash: 'abcdef0123456789' }} living={living()} />
    );
    expect(html).toContain('href="/app/specs/s-1"');
    expect(html).toContain('Bug Intake and Quality');
    expect(html).toContain('Not verified');
    expect(html).toContain('answers for R-1, AC-3, AC-26');
    expect(html).toContain('1 of 3 verified');
    expect(html.indexOf('AC-26')).toBeLessThan(html.indexOf('>R-1<'));
    for (const label of ['Fails', 'Not verified', 'Passes']) expect(html).toContain(label);
    expect(html).not.toContain('No verdict');
  });

  it('no recorded verdict reads Not verified on every criterion, and the summary counts by state, never "all N"', () => {
    const criteria = Array.from({ length: 26 }, (_, i) => ({ criterionId: `R-${i + 1}`, text: `Requirement ${i + 1}.`, verdict: null, stale: false }));
    const html = renderToStaticMarkup(
      <SpecSourceBlock specSource={{ specId: 's-1', revision: 1 }} living={living({ scoped: false, outcome: { outcome: 'unverified', reason: '', criteria } })} />
    );
    expect(html).toContain('0 of 26 verified');
    expect(html).not.toMatch(/Fails|Failed|all 26 criteria/);
    expect(html.match(/>Not verified</g)?.length).toBe(1 + 8);
  });

  it('Fails only for a fail on the current head; a fail on an older commit says so', () => {
    const html = renderToStaticMarkup(
      <SpecSourceBlock specSource={{ specId: 's-1', revision: 1 }} living={living({ scoped: false, outcome: {
        outcome: 'fail', reason: 'R-1 failed', criteria: [
          { criterionId: 'R-1', text: 'x', verdict: 'fail', stale: true },
          { criterionId: 'R-2', text: 'y', verdict: 'fail', stale: false },
        ],
      } })} />
    );
    expect(html).toContain('Failed on an older commit');
    expect(html.match(/>Fails</g)?.length).toBe(1);
    expect(html).toContain('0 of 2 verified · 2 failed');
  });

  it('says when a newer revision is approved, and a pass on an older commit is not a pass', () => {
    const html = renderToStaticMarkup(
      <SpecSourceBlock specSource={{ specId: 's-1', revision: 1 }} living={living({ approvedRevision: 2, scoped: false, outcome: {
        outcome: 'unverified', reason: '', criteria: [{ criterionId: 'R-1', text: 'x', verdict: 'pass', stale: true }],
      } })} />
    );
    expect(html).toContain('Revision 2 is approved now');
    expect(html).toContain('0 of 1 verified');
    expect(html).toContain('Passed on an older commit');
  });

  it('shows a reviewer result a test outranked as a note, with the check still reading fail', () => {
    const html = renderToStaticMarkup(
      <SpecSourceBlock specSource={{ specId: 's-1', revision: 1 }} living={living({ outcome: {
        outcome: 'fail', reason: 'AC-26 failed',
        criteria: [{ criterionId: 'AC-26', text: 'x', verdict: 'fail', stale: false, notes: [{ verdict: 'pass', source: 'review' }] }],
      } })} />
    );
    expect(html).toContain('data-testid="task-spec-criterion-note"');
    expect(html).toContain('reviewer says');
    expect(html).toContain('Fails');
  });
});

