import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import Pipeline, { PIPELINE_STAGES, dotPattern, groupByStage, pipelineStage, type PipelineDelivery, type PipelineStage } from './Pipeline';

const d = (id: string, state: PipelineDelivery['state'], stage?: PipelineDelivery['stage']): PipelineDelivery => ({ id, state, stage });

const MANY: PipelineDelivery[] = [
  d('q1', 'queued'), d('q2', 'queued', 'verify'),
  d('b1', 'build'), d('b2', 'build'), d('b3', 'fixing-in-build'),
  d('v1', 'verify'), d('v2', 'verify'), d('v3', 'verify'), d('v4', 'fixing-in-verify'), d('v5', 'check-cant-run', 'verify'), d('v6', 'waiting-on-you', 'verify'),
  d('dl1', 'deliver'),
];

/** Per stage: the printed count and the number of dots, read back off the markup. */
function readCells(html: string) {
  const out = {} as Record<PipelineStage, { count: number; dots: number }>;
  for (const stage of PIPELINE_STAGES) {
    const cell = html.split(`data-stage="${stage}"`)[1].split('data-stage=')[0];
    const count = Number(cell.match(/data-count="(\d+)"/)![1]);
    const dotsBlock = cell.split(`data-dots="${stage}"`)[1] ?? '';
    out[stage] = { count, dots: (dotsBlock.match(/data-dot="/g) ?? []).length };
  }
  return out;
}

describe('Pipeline', () => {
  it('AC-12: each stage count equals its dots and its group size, from one list', () => {
    const groups = groupByStage(MANY);
    const cells = readCells(renderToStaticMarkup(<Pipeline deliveries={MANY} />));
    for (const stage of ['build', 'verify', 'deliver'] as const) {
      expect(cells[stage].count).toBe(groups[stage].length);
      expect(cells[stage].dots).toBe(groups[stage].length);
    }
    expect(cells.queued.count).toBe(groups.queued.length);
    expect([cells.queued.count, cells.build.count, cells.verify.count, cells.deliver.count]).toEqual([2, 3, 6, 1]);
  });

  it('AC-12: every delivery lands in exactly one group', () => {
    const groups = groupByStage(MANY);
    const all = PIPELINE_STAGES.flatMap(s => groups[s].map(x => x.id));
    expect(all.sort()).toEqual(MANY.map(x => x.id).sort());
  });

  it('shows 0 with no dots for an empty stage, and for no deliveries at all', () => {
    const cells = readCells(renderToStaticMarkup(<Pipeline deliveries={[]} />));
    for (const stage of PIPELINE_STAGES) expect(cells[stage]).toEqual({ count: 0, dots: 0 });
    const onlyBuild = readCells(renderToStaticMarkup(<Pipeline deliveries={[d('b', 'build')]} />));
    expect(onlyBuild.verify).toEqual({ count: 0, dots: 0 });
  });

  it('groups a state that can sit anywhere by the stage its meter lights', () => {
    expect(pipelineStage(d('x', 'waiting-on-you', 'deliver'))).toBe('deliver');
    expect(pipelineStage(d('x', 'check-cant-run'))).toBe('build');
    expect(pipelineStage(d('x', 'queued', 'verify'))).toBe('queued');
    expect(pipelineStage(d('x', 'fixing-in-verify', 'build'))).toBe('verify');
  });

  it('draws fixing hatched, cant-run outlined and waiting-on-you in the alert colour', () => {
    expect(dotPattern(d('x', 'fixing-in-build'))).toBe('fixing');
    expect(dotPattern(d('x', 'check-cant-run', 'verify'))).toBe('cant-run');
    expect(dotPattern(d('x', 'waiting-on-you', 'verify'))).toBe('waiting');
    const html = renderToStaticMarkup(<Pipeline deliveries={[d('w', 'waiting-on-you', 'verify'), d('v', 'verify')]} />);
    expect((html.match(/var\(--status-error\)/g) ?? []).length).toBe(1);
  });

  it('names each cell with its count and links it only when given an href', () => {
    const plain = renderToStaticMarkup(<Pipeline deliveries={MANY} />);
    expect(plain).toContain('aria-label="Verify: 6 deliveries"');
    expect(plain).toContain('aria-label="Deliver: 1 delivery"');
    expect(plain).not.toContain('<a ');
    const linked = renderToStaticMarkup(<Pipeline deliveries={MANY} hrefFor={s => `#stage-${s}`} />);
    expect(linked).toContain('href="#stage-verify"');
  });
});
