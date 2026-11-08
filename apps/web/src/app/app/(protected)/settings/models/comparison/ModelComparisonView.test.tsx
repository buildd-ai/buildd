import { describe, it, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildModelComparison, type ComparisonRow } from '@buildd/core/model-comparison';
import ModelComparisonView from './ModelComparisonView';
import { resolveComparisonWorkspace } from './workspace-pick';
import { rateText, durationText, costText } from './comparison-view';

let seq = 0;
const row = (o: Partial<ComparisonRow> = {}): ComparisonRow => {
  seq++;
  return {
    workerId: `w${seq}`, taskId: `00000000-0000-0000-0000-${String(seq).padStart(12, '0')}`, chainId: null,
    resolvedModel: 'model-a', endpointKind: 'anthropic_api', modelVersion: null, quantization: null, backend: null,
    harnessVersion: null, runtime: null, taskClass: null, startedAt: new Date(), endedAt: null, createdAt: new Date(),
    durationMs: null, inputTokens: null, outputTokens: null, tokensPerSecond: null, terminalOutcome: 'completed',
    failureOrigin: 'none', costUsd: null, reviewVerdict: null, ciState: null, specVerdict: null, prOutcome: null, reworked: false, ...o,
  };
};
const render = (rows: ComparisonRow[]) => renderToStaticMarkup(<ModelComparisonView data={buildModelComparison(rows, {})} />);

describe('ModelComparisonView', () => {
  it('renders unknowns as Not recorded, never as zero, and lists coverage gaps', () => {
    const html = render([row(), row()]);
    expect(html).toContain('Not recorded');
    expect(html).toContain('Model version not recorded for 2 of 2');
    expect(html).toContain('No results');
    expect(html).not.toContain('$0');
    expect(html).not.toContain('0%');
    expect(html).not.toContain('—');
  });

  it('labels the data observational and keeps benchmark scores in their own section', () => {
    const html = render([row({ reviewVerdict: 'approved' })]);
    expect(html).toContain('Observed in production');
    expect(html).toContain('Small sample');
    expect(html).toContain('Public benchmark scores');
    expect(html).toContain('No benchmark scores are listed');
    expect(html).toContain('Same task, different models');
  });

  it('declares no winner for tiny samples', () => {
    const html = render([row({ reviewVerdict: 'approved' }), row({ resolvedModel: 'model-b', reviewVerdict: 'changes_requested' })]);
    expect(html).toContain('Too few attempts to compare quality');
    expect(html.toLowerCase()).not.toContain('winner');
    expect(html.toLowerCase()).not.toContain('best model');
  });

  it('shows an established gap once both sides have enough attempts', () => {
    const rows = [
      ...Array.from({ length: 40 }, () => row({ reviewVerdict: 'approved' })),
      ...Array.from({ length: 40 }, (_, i) => row({ resolvedModel: 'model-b', reviewVerdict: i < 10 ? 'approved' : 'changes_requested' })),
    ];
    const html = render(rows);
    expect(html).toContain('Enough attempts');
    expect(html).toContain('model-b has a lower rate than model-a');
  });

  it('links to the underlying tasks and has a plain empty state', () => {
    expect(render([row()])).toContain('/app/tasks/00000000-0000-0000-0000-');
    expect(render([])).toContain('No attempts match these filters.');
  });
});

describe('view helpers', () => {
  it('rate text carries n, interval and unrecorded count', () => {
    const r = rateText({ k: 3, n: 4, unknown: 2, rate: 0.75, interval: { lower: 0.3, upper: 0.95 }, status: 'small_sample' });
    expect(r.value).toBe('75%');
    expect(r.detail).toBe('3 of 4, 30% to 95%, 2 not recorded');
  });
  it('known-only cost and null duration', () => {
    expect(costText({ knownCount: 0, unknownCount: 3, knownUsd: null, meanKnownUsd: null }).value).toBe('Not recorded');
    expect(costText({ knownCount: 2, unknownCount: 1, knownUsd: 1.5, meanKnownUsd: 0.75 }).detail).toContain('1 without a cost');
    expect(durationText(null)).toBe('Not recorded');
    expect(durationText(45_000)).toBe('45s');
  });
});

describe('workspace access boundary', () => {
  const mine = [{ id: 'a' }, { id: 'b' }];
  it('only a reachable workspace can be read; others fall back to the first reachable one', () => {
    expect(resolveComparisonWorkspace(mine, 'b')?.id).toBe('b');
    expect(resolveComparisonWorkspace(mine, 'someone-elses')?.id).toBe('a');
    expect(resolveComparisonWorkspace(mine, undefined)?.id).toBe('a');
    expect(resolveComparisonWorkspace([], 'a')).toBeNull();
  });
});
