import { describe, test, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { InstructResultBanner } from './InstructWorkerForm';

describe('InstructResultBanner', () => {
  test('renders nothing before a result exists', () => {
    const html = renderToStaticMarkup(<InstructResultBanner result={null} />);
    expect(html).toBe('');
  });

  test('renders the server-composed message, not a fixed string', () => {
    const html = renderToStaticMarkup(
      <InstructResultBanner
        result={{ message: 'Instructions queued for delivery on next worker check-in', deliveryState: 'pending' }}
      />,
    );
    expect(html).toContain('Instructions queued for delivery on next worker check-in');
    expect(html).not.toContain('Instruction queued for delivery');
  });

  test('a confirmed ack-backed queue entry renders as success, not a warning', () => {
    const html = renderToStaticMarkup(
      <InstructResultBanner result={{ message: 'Delivered and acknowledged', deliveryState: 'pending' }} />,
    );
    expect(html).toContain('text-status-success');
    expect(html).not.toContain('text-status-warning');
  });

  test('an unconfirmed Pusher-only delivery is styled as a warning', () => {
    const html = renderToStaticMarkup(
      <InstructResultBanner
        result={{ message: 'Instructions sent via Pusher — delivery is not confirmed', deliveryState: 'delivered' }}
      />,
    );
    expect(html).toContain('text-status-warning');
    expect(html).not.toContain('text-status-success');
    expect(html).toContain('delivery is not confirmed');
  });
});
