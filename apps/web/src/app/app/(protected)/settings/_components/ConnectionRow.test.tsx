import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import ConnectionRow, { StatusChip } from './ConnectionRow';

describe('StatusChip', () => {
  it('draws every connection tone as the shared TonePill', () => {
    const tone = (t: 'ok' | 'warn' | 'err' | 'idle') =>
      renderToStaticMarkup(<StatusChip tone={t}>x</StatusChip>).match(/data-tone="([a-z]+)"/)?.[1];
    expect(tone('ok')).toBe('ok');
    expect(tone('warn')).toBe('dec');
    expect(tone('err')).toBe('bad');
    expect(tone('idle')).toBe('q');
    expect(renderToStaticMarkup(<StatusChip tone="ok">x</StatusChip>)).not.toContain('status-pill');
  });
});

describe('ConnectionRow', () => {
  it('sets the title and meta in sans, not mono', () => {
    const html = renderToStaticMarkup(
      <ConnectionRow title="Cloudflare" meta="Cloud runner account" open={false} onToggle={() => {}}>body</ConnectionRow>,
    );
    expect(html).toContain('Cloudflare');
    expect(html).not.toContain('font-mono text-[13px]');
    expect(html).not.toContain('font-mono text-[11px]');
  });
});
