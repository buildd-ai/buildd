import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import MissionRecoveryNotice from './MissionRecoveryNotice';
import type { TaskRecoveryView } from '@/lib/incident-recovery-refs';

const view = { stateWord: 'Repairing', sentence: 'Buildd is repairing it.', pill: 'fixing' } as unknown as TaskRecoveryView;

describe('MissionRecoveryNotice', () => {
  it('renders nothing with no items', () => {
    expect(renderToStaticMarkup(<MissionRecoveryNotice items={[]} />)).toBe('');
  });

  // min-h-11 below md: the 44px tap target (docs/design/design-system.md).
  it('each task link is a 44px tap target on a phone', () => {
    const html = renderToStaticMarkup(<MissionRecoveryNotice items={[{ taskId: 't1', title: 'Fix it', view }]} />);
    expect(html).toMatch(/<a [^>]*class="block min-h-11 md:min-h-0 py-3 md:py-0 [^"]*"[^>]*href="\/app\/tasks\/t1"|<a [^>]*href="\/app\/tasks\/t1"[^>]*class="block min-h-11 md:min-h-0 py-3 md:py-0 /);
  });
});
