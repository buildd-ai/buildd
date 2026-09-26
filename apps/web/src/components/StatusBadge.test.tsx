import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import StatusBadge from './StatusBadge';

// In a squeezed flex row (Worker History on a phone) the badge wrapped
// "Waiting input" onto two lines and shrank below its label.
describe('StatusBadge', () => {
  it('never wraps or shrinks inside a flex row', () => {
    const cls = renderToStaticMarkup(<StatusBadge status="waiting_input" />).match(/^<span class="([^"]*)"/)?.[1].split(/\s+/) ?? [];
    expect(cls).toContain('whitespace-nowrap');
    expect(cls).toContain('shrink-0');
  });
});

// Regression (demo reshoot, task page Related tasks): an attempt's badge read
// the raw DB value `in_progress`. The badge speaks display labels only.
describe('StatusBadge labels', () => {
  it('reads an in-progress task as Running, never the raw enum', () => {
    const html = renderToStaticMarkup(<StatusBadge status="in_progress" />);
    expect(html).toContain('Running');
    expect(html).not.toContain('in_progress');
  });
});
