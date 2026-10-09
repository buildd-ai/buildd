import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { missionTone, OpenButton, StateChip } from './objects/parts';
import { readFileSync } from 'node:fs';
import { AgentAvatar } from './ChatFeed';

describe('chat semantic palette', () => {
  it('awaiting verification and stalled override the underlying mission status', () => {
    expect(missionTone('Awaiting verification', 'active')).toBe('attention');
    expect(missionTone('Awaiting verification', 'completed')).toBe('attention');
    expect(missionTone('Stalled', 'active')).toBe('attention');
    expect(missionTone('Active', 'active')).toBe('neutral');
    expect(missionTone('Verified', 'completed')).toBe('ok');
    expect(missionTone('Failed', 'failed')).toBe('bad');
    expect(missionTone('Held', 'held')).toBe('idle');
  });
  it('mission chips and navigation carry semantic or ink tokens', () => {
    for (const label of ['Awaiting verification', 'Stalled']) {
      const html = renderToStaticMarkup(<StateChip label={label} tone={missionTone(label, 'active')} />);
      expect(html).toContain('text-status-warning');
      expect(html).not.toContain('text-accent');
    }
    for (const inPane of [true, false]) {
      const html = renderToStaticMarkup(<OpenButton inPane={inPane} onOpen={() => {}} />);
      expect(html).toContain('text-text-primary');
      expect(html).not.toContain('accent');
    }
  });
  it('the About card uses status tokens for warning and error chips', () => {
    const source = readFileSync(new URL('./MissionSheet.tsx', import.meta.url), 'utf8');
    // The badge is the shared pill: attention is the decision tone, bad the error tone.
    expect(source).toContain('<StateChip');
    expect(renderToStaticMarkup(<StateChip label="x" tone="bad" />)).toContain('text-status-error');
    expect(renderToStaticMarkup(<StateChip label="x" tone="attention" />)).toContain('text-status-warning');
  });
  it('Buildd uses inverse ink tokens even when its role provides purple', () => {
    const html = renderToStaticMarkup(<AgentAvatar agent={{ name: 'buildd', color: '#6366F1' }} />);
    expect(html).toContain('bg-text-primary');
    expect(html).toContain('text-surface-1');
    expect(html).not.toContain('#6366F1');
  });
});
