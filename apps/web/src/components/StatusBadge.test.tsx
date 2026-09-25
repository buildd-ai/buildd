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
