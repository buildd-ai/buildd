import { describe, it, expect, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));

mock.module('@/lib/pusher-client', () => ({
  subscribeToChannel: () => null,
  unsubscribeFromChannel: () => {},
  getSubscribedChannel: () => null,
  CHANNEL_PREFIX: 'buildd-',
}));

mock.module('../useLocalUiHealth', () => ({
  useLocalUiHealth: () => ({ available: [] }),
}));

const { isDialogStatus, StartTaskShell } = await import('./StartTaskButton');

describe('isDialogStatus — routes /start outcomes to inline vs dialog', () => {
  it('treats a 200 outcome (waiting/queued/accepted) as inline, not a dialog', () => {
    expect(isDialogStatus('idle')).toBe(false);
    expect(isDialogStatus('starting')).toBe(false);
    expect(isDialogStatus('waiting')).toBe(false);
    expect(isDialogStatus('queued')).toBe(false);
    expect(isDialogStatus('accepted')).toBe(false);
  });

  it('treats a 422 gate response and a hard failure as a dialog — they require a decision', () => {
    expect(isDialogStatus('gated')).toBe(true);
    expect(isDialogStatus('failed')).toBe(true);
  });
});

describe('StartTaskShell — the actual inline-vs-modal render branch', () => {
  const inlineMarker = <p data-testid="inline-marker">Start requested</p>;
  const modalMarker = <p data-testid="modal-marker">Blocked</p>;

  function render(status: Parameters<typeof StartTaskShell>[0]['status']) {
    return renderToStaticMarkup(
      <StartTaskShell status={status} onBackdropClick={() => {}} modal={modalMarker}>
        {inlineMarker}
      </StartTaskShell>,
    );
  }

  it('opens no dialog for a gate-clean start (200 → waiting)', () => {
    const html = render('waiting');
    expect(html).toContain('inline-marker');
    expect(html).not.toContain('fixed inset-0');
    expect(html).not.toContain('modal-marker');
  });

  it('opens no dialog for the queued degrade or the claimed/accepted state', () => {
    expect(render('queued')).not.toContain('fixed inset-0');
    expect(render('accepted')).not.toContain('fixed inset-0');
  });

  it('opens the existing dialog for a 422 gate response', () => {
    const html = render('gated');
    expect(html).toContain('fixed inset-0');
    expect(html).toContain('modal-marker');
    // The inline content stays mounted underneath — only the dialog is added.
    expect(html).toContain('inline-marker');
  });

  it('opens the existing dialog for a hard failure', () => {
    const html = render('failed');
    expect(html).toContain('fixed inset-0');
    expect(html).toContain('modal-marker');
  });
});
