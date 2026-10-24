import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import StageMeter, { STAGE_METER_STATES, stageMeterName, type StageMeterState } from './StageMeter';

const html = (state: StageMeterState, extra: { fixRounds?: number; stage?: 'build' | 'verify' | 'deliver' } = {}) =>
  renderToStaticMarkup(<StageMeter state={state} {...extra} />);

/** Per-segment pattern + mark: what a person sees with colour removed. */
const signature = (h: string) =>
  [...h.matchAll(/data-pattern="([^"]+)"(?: data-mark="([^"]*)")?/g)].map(m => `${m[1]}${m[2] ? `:${m[2]}` : ''}`).join('|');

describe('StageMeter', () => {
  it('draws three segments: Build, Verify, Deliver', () => {
    expect([...html('build').matchAll(/data-segment="(\w+)"/g)].map(m => m[1])).toEqual(['build', 'verify', 'deliver']);
  });

  it('gives every state a pattern signature no other state shares', () => {
    const sigs = STAGE_METER_STATES.map(s => signature(html(s, { fixRounds: 2 })));
    expect(new Set(sigs).size).toBe(STAGE_METER_STATES.length);
  });

  it('keeps the fixing states apart from their plain stage by pattern, not hue', () => {
    expect(signature(html('fixing-in-build', { fixRounds: 1 }))).toContain('hatch');
    expect(signature(html('build'))).not.toContain('hatch');
    expect(signature(html('fixing-in-verify', { fixRounds: 3 }))).toBe('done|hatch:↻3|empty');
  });

  it('prints ↻N only on the fixing states', () => {
    expect(html('fixing-in-build', { fixRounds: 2 })).toContain('↻2');
    expect(html('verify', { fixRounds: 2 })).not.toContain('↻');
  });

  it('outlines a check that cannot run and fills waiting-on-you with a mark', () => {
    expect(signature(html('check-cant-run', { stage: 'verify' }))).toBe('done|outline:?|empty');
    expect(signature(html('waiting-on-you', { stage: 'verify' }))).toBe('done|alert:!|empty');
  });

  it('greys done segments and leaves later ones empty', () => {
    expect(signature(html('deliver'))).toBe('done|done|solid');
    expect(signature(html('build'))).toBe('solid|empty|empty');
  });

  it('names each state as an image, with the stage and round where they matter', () => {
    const names = new Set<string>();
    for (const s of STAGE_METER_STATES) {
      const h = html(s, { fixRounds: 2 });
      expect(h).toContain('role="img"');
      names.add(h.match(/aria-label="([^"]+)"/)![1]);
    }
    expect(names.size).toBe(STAGE_METER_STATES.length);
    expect(stageMeterName('fixing-in-verify', 'verify', 2)).toBe('Being fixed in verify, fix round 2');
    expect(stageMeterName('waiting-on-you', 'deliver')).toBe('Waiting on you, at deliver');
  });

  it('lets a caller replace the name', () => {
    expect(renderToStaticMarkup(<StageMeter state="build" label="Build, 3 of 5 tasks" />)).toContain('aria-label="Build, 3 of 5 tasks"');
  });
});
