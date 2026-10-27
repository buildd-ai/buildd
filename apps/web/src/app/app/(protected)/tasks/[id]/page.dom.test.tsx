/**
 * DOM tests for task page layout and jargon issues (task page ~390px and 1280px).
 * - Jargon: 'LOOP SATISFIED · 1/3' → plainer; 'LOOP HISTORY · until CI passes' → plainer
 * - CI stated three times: timeline says it once
 * - Design preview blank: empty state with message
 * - Layout: check aligned on "Code review · Approved", download doesn't wrap on phone, disclosures match
 */
import { describe, it, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

const { LoopStatusChip, LoopHistory } = await import('@/components/LoopStatus');

describe('Task page — loop status jargon', () => {
  it('Loop status chip uses plain language, not LOOP SATISFIED', () => {
    const html = renderToStaticMarkup(
      <LoopStatusChip
        loopIteration={0}
        maxLoops={3}
        loopState="satisfied"
        exitConditionType="pr_checks_green"
      />,
    );
    expect(html).not.toContain('LOOP SATISFIED');
    expect(html).toContain('Looping succeeded');
  });

  it('Loop status chip uses plain language, not LOOP EXHAUSTED', () => {
    const html = renderToStaticMarkup(
      <LoopStatusChip
        loopIteration={2}
        maxLoops={3}
        loopState="exhausted"
      />,
    );
    expect(html).not.toContain('LOOP EXHAUSTED');
    expect(html).toContain('Looping failed');
  });

  it('Loop history section uses plain language header', () => {
    const entries = [
      {
        iteration: 0,
        conditionType: 'pr_checks_green' as const,
        satisfied: true,
        summary: 'Test passed',
        evaluatedAt: new Date().toISOString(),
        workerId: 'w1',
        evidence: undefined,
      },
    ];
    const html = renderToStaticMarkup(
      <LoopHistory
        entries={entries}
        loopState="satisfied"
        maxLoops={3}
      />,
    );
    expect(html).toContain('Loop cycles');
    expect(html).toContain('stopped after CI passed');
    expect(html).not.toContain('LOOP HISTORY');
    expect(html).not.toContain('until CI passes');
  });

  it('Loop condition goal uses plain language', () => {
    const entries = [
      {
        iteration: 0,
        conditionType: 'command' as const,
        satisfied: false,
        summary: 'Check failed',
        evaluatedAt: new Date().toISOString(),
        workerId: 'w1',
        evidence: undefined,
      },
    ];
    const html = renderToStaticMarkup(
      <LoopHistory
        entries={entries}
        loopState="exhausted"
        maxLoops={3}
      />,
    );
    expect(html).toContain('stopped after check passed');
  });
});

describe('Task page — design preview empty state', () => {
  it('DesignPreview shows error message when frame fails to load', async () => {
    const { default: DesignPreview } = await import('@/components/DesignPreview');
    const html = renderToStaticMarkup(
      <DesignPreview
        artifactId="test-id"
        title="Test Design"
        revision={1}
        frameUrl={null}
        screens={[]}
      />,
    );
    expect(html).toContain('Preview unavailable');
    expect(html).toContain('Download the file to open it');
  });
});

describe('Task page — disclosure styles', () => {
  it('Run disclosure has visible arrow marker', async () => {
    // This test imports the page.tsx which renders the disclosure
    // We test that the disclosure has the proper styling classes
    const { default: TaskChecks } = await import('@/app/app/(protected)/tasks/[id]/TaskChecks');
    const html = renderToStaticMarkup(
      <TaskChecks
        checks={{
          current: [
            {
              key: 'tests' as const,
              name: 'Tests',
              state: 'passed' as const,
              result: 'All tests passed',
            },
          ],
          history: [],
          review: null,
          rounds: null,
          reviewOpen: false,
          reviewRoundLine: null,
          openFindings: [],
        }}
        prNumber={null}
        prUrl={null}
        headSha={null}
        findings={new Map()}
        currentTaskId="task-1"
      />,
    );
    expect(html).toContain('list-none');
    expect(html).toContain('items-baseline');
  });
});
