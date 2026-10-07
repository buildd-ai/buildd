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
