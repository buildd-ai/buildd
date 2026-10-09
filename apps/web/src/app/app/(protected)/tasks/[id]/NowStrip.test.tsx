import { describe, it, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import NowStrip, { PausedBar } from './NowStrip';
import { deriveNow } from './task-activity';
describe('evidence rail', () => {
  it('renders phases with provenance and removes percent displays', () => {
    const now = deriveNow([{ type:'status', progress:70, label:'Checking changes', ts:10 }], { status:'running', currentAction:null, startMs:0, nowMs:20, prUrl:null, filesChanged:2 });
    const html = renderToStaticMarkup(<NowStrip now={now} nowMs={20} />);
    expect(html).toContain('run-evidence-rail');
    expect(html).not.toContain('worker-now-pct');
    expect(html).not.toContain('worker-progress-bar');
    expect(html).not.toContain('70%');
    expect([...html.matchAll(/<li data-phase=/g)]).toHaveLength(now.evidence.phases.filter(p => p.state !== 'skipped').length);
    expect(html).toContain('data-source="reported"');
    expect(html).toContain('Changes, done, reported');
  });
  it('paused state keeps evidence without a percentage bar', () => {
    const html = renderToStaticMarkup(<PausedBar elapsed="1m" turns={2} tokens={null} />);
    expect(html).toContain('Paused');
    expect(html).not.toContain('progressbar');
  });
});

// §4 M-2 / C-6: below md nine labelled columns cannot fit in ~290px. The phone
// rail is one line (current phase, n of m), a segment row, and a 44px disclosure.
describe('evidence rail below md', () => {
  const live = () => deriveNow(
    [{ type: 'checkpoint', event: 'first_edit', ts: 5 } as never],
    { status: 'running', currentAction: null, startMs: 0, nowMs: 20, prUrl: null, filesChanged: 0, commitCount: 0 } as never,
  );

  it('is a disclosure at least 44px tall, closed by default, with the head phase as n of m', () => {
    const now = live();
    const html = renderToStaticMarkup(<NowStrip now={now} nowMs={20} />);
    const compact = html.slice(html.indexOf('data-testid="run-evidence-compact"'));
    expect(compact).toMatch(/^data-testid="run-evidence-compact" class="md:hidden/);
    const button = compact.match(/<button[^>]*>/)![0];
    expect(button).toContain('min-h-11');
    expect(button).toContain('aria-expanded="false"');
    const phases = now.evidence.phases.filter(p => p.state !== 'skipped');
    const i = phases.findIndex(p => p.state === 'current');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(html).toMatch(new RegExp(`data-testid="run-evidence-head"[^>]*>.*${phases[i].label}.*· ${i + 1} of ${phases.length}`));
    // One segment per phase; the labelled list mounts only when opened.
    expect([...html.matchAll(/data-cell=/g)]).toHaveLength(phases.length);
    expect(html).not.toContain('run-evidence-list');
  });

  it('keeps the labelled horizontal rail for md and up only', () => {
    const html = renderToStaticMarkup(<NowStrip now={live()} nowMs={20} />);
    expect(html).toMatch(/data-testid="run-evidence-rail" class="hidden md:flex/);
  });

  it('tells segment states apart by pattern, not colour alone', () => {
    const now = live();
    const html = renderToStaticMarkup(<NowStrip now={now} nowMs={20} />);
    const cell = (state: string) => html.match(new RegExp(`<span data-cell="[a-z_]+" data-state="${state}" class="([^"]+)"`))?.[1] ?? '';
    expect(cell('current')).toContain('fleet-hatch-accent');
    expect(cell('unknown')).toContain('border-dashed');
    expect(cell('done')).toMatch(/bg-text-primary|fleet-hatch/);
  });
});
