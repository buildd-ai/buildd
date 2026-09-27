import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import ConversationList from './ConversationList';

const items = [{ id: 'c1', title: 'Invoices', untitled: false, lastMessageAt: '2026-01-02T10:00:00.000Z' }] as Parameters<typeof ConversationList>[0]['items'];

describe('ConversationList', () => {
  it('its heading is the screen\'s mono overline (`RECENT`), not the sans UI face', () => {
    const html = renderToStaticMarkup(<ConversationList items={items} />);
    const heading = html.match(/<div data-testid="conversation-list-heading"[^>]*>([^<]*)</);
    expect(heading?.[1]).toBe('Recent');
    const cls = html.match(/data-testid="conversation-list-heading" class="([^"]*)"/)?.[1] ?? '';
    for (const c of ['font-mono', 'text-[11px]', 'uppercase', 'tracking-[.16em]', 'text-[var(--chat-muted)]']) expect(cls.split(' ')).toContain(c);
    expect(cls).not.toContain('font-convo');
  });

  it('renders nothing with no conversations', () => {
    expect(renderToStaticMarkup(<ConversationList items={[]} />)).toBe('');
  });
});
