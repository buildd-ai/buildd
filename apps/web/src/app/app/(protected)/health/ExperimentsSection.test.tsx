import { describe, it, expect, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('next/navigation', () => ({
  useRouter: () => ({ replace: () => {}, refresh: () => {}, push: () => {} }),
  usePathname: () => '/app/health',
  useSearchParams: () => new URLSearchParams(''),
}));

import { ExperimentsSection } from './ExperimentsSection';
import type { HealthExperiments, HealthExperimentItem } from '@/lib/health-experiments-shared';
import type { ExperimentReadout } from '@buildd/core/experiment-readout';

const arm = (over: Record<string, unknown> = {}) => ({
  assigned: 4, n: 3, pending: 1, clean: 2, cleanRate: 2 / 3, cleanInterval: { lower: 0.2, upper: 0.94 },
  servedRate: 1,
  secondary: { firstPassReviewRate: null, meanReworkRounds: null, meanTurns: null, meanTokens: null, modelAttributableFailureRate: null },
  ...over,
});

const readout = (over: Partial<ExperimentReadout> = {}): ExperimentReadout => ({
  minSamplePerArm: 30,
  control: arm() as any,
  treatment: arm({ n: 2, clean: 1, cleanRate: 0.5 }) as any,
  difference: { difference: -0.1667, lower: -0.7, upper: 0.5 },
  verdict: 'insufficient_n',
  inheritedExcluded: 0,
  strata: {} as any,
  ...over,
});

const item = (over: Partial<HealthExperimentItem['experiment']> = {}, r: ExperimentReadout | null = readout()): HealthExperimentItem => ({
  experiment: {
    id: 'exp-1', key: 'premium-vs-standard', title: 'Premium vs standard', hypothesis: 'Premium lifts clean completion',
    status: 'running', kind: 'model_routing', treatmentFraction: 0.5, policyVersion: 1, config: {},
    visibility: 'team', decision: null, startedAt: '2026-01-01T00:00:00.000Z', concludedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...over,
  },
  readout: r,
});

const render = (data: HealthExperiments | null) => renderToStaticMarkup(<ExperimentsSection data={data} />);

describe('ExperimentsSection — visibility', () => {
  it('renders nothing with no data', () => {
    expect(render(null)).toBe('');
  });

  it('renders nothing for a member who can see no experiments', () => {
    expect(render({ canManage: false, items: [] })).toBe('');
  });

  it('an admin with no experiments still gets the section and the create entry point', () => {
    const html = render({ canManage: true, items: [] });
    expect(html).toContain('data-testid="health-section-experiments"');
    expect(html).toContain('data-testid="experiment-create-open"');
    expect(html).toContain('No experiments yet');
  });
});

describe('ExperimentsSection — controls are admin-only', () => {
  it('member sees the readout but no controls and no create form', () => {
    const html = render({ canManage: false, items: [item()] });
    expect(html).toContain('data-testid="experiment-readout"');
    expect(html).not.toContain('data-testid="experiment-controls"');
    expect(html).not.toContain('experiment-pause');
    expect(html).not.toContain('experiment-create-open');
  });

  it('admin: running shows pause + conclude; draft shows start; paused shows resume', () => {
    const running = render({ canManage: true, items: [item()] });
    expect(running).toContain('data-testid="experiment-pause"');
    expect(running).toContain('data-testid="experiment-conclude"');
    expect(running).not.toContain('data-testid="experiment-start"');

    const draft = render({ canManage: true, items: [item({ status: 'draft', startedAt: null }, null)] });
    expect(draft).toContain('data-testid="experiment-start"');
    expect(draft).toContain('nothing enrolls until it is started');

    const paused = render({ canManage: true, items: [item({ status: 'paused' })] });
    expect(paused).toContain('Resume');
  });

  it('concluded experiments show the decision and no controls, even for admins', () => {
    const html = render({ canManage: true, items: [item({ status: 'concluded', decision: 'Keep routing as is.' })] });
    expect(html).toContain('Keep routing as is.');
    expect(html).not.toContain('data-testid="experiment-controls"');
  });
});

describe('ExperimentsSection — readout', () => {
  it('shows per-arm n, the primary rate with its interval, and "Insufficient data" plainly', () => {
    const html = render({ canManage: false, items: [item()] });
    expect(html).toContain('data-testid="experiment-arm-control"');
    expect(html).toContain('data-testid="experiment-arm-treatment"');
    expect(html).toContain('66.7%');
    expect(html).toContain('20%–94%');
    expect(html).toContain('Insufficient data');
    expect(html).toContain('needs 30 resolved per arm');
  });

  it('a decisive verdict is named', () => {
    const html = render({ canManage: false, items: [item({}, readout({ verdict: 'treatment_better', difference: { difference: 0.2, lower: 0.05, upper: 0.35 } }))] });
    expect(html).toContain('Treatment better');
    expect(html).toContain('+20.0 pts');
  });

  it('shows status, fraction and start date', () => {
    const html = render({ canManage: false, items: [item()] });
    expect(html).toContain('data-testid="experiment-status"');
    expect(html).toContain('treatment 50% of eligible');
    expect(html).toContain('started 2026-01-01');
  });
});
