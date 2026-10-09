import { describe, it, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AskAboutLink, ChatEntryProvider, NewWorkLink, SetUpChatNudge, type ChatEntryValue } from './ChatEntry';

const M = '11111111-1111-4111-8111-111111111111';
const WS = '22222222-2222-4222-8222-222222222222';
const ON: ChatEntryValue = { available: true, teamId: 'team-1', setupHref: null };
const OFF: ChatEntryValue = { available: false, teamId: 'team-1', setupHref: null };
const ADMIN_NO_KEY: ChatEntryValue = { available: false, teamId: 'team-1', setupHref: '/app/settings/models#provider-keys' };

const html = (value: ChatEntryValue | null, node: React.ReactNode) =>
  renderToStaticMarkup(value ? <ChatEntryProvider value={value}>{node}</ChatEntryProvider> : <>{node}</>);

describe('NewWorkLink', () => {
  it('chat available: + Mission opens chat with the intent', () => {
    const out = html(ON, <NewWorkLink kind="mission" workspaceId={WS}>+ Mission</NewWorkLink>);
    expect(out).toContain(`href="/app/chat?new=mission&amp;ws=${WS}"`);
    expect(out).toContain('data-opens="chat"');
  });

  it('chat unavailable, or no provider above it: the form, as before', () => {
    expect(html(OFF, <NewWorkLink kind="mission">+ Mission</NewWorkLink>)).toContain('href="/app/missions/new"');
    expect(html(null, <NewWorkLink kind="task" workspaceId={WS}>New task</NewWorkLink>)).toContain('href="/app/missions/new"');
  });
});

describe('AskAboutLink', () => {
  it('opens chat with the object docked', () => {
    const out = html(ON, <AskAboutLink kind="mission" id={M} teamId="team-1" workspaceId={WS} />);
    expect(out).toContain(`href="/app/chat?about=mission%3A${M}&amp;ws=${WS}"`);
    expect(out).toContain('Ask about this mission');
    expect(html(ON, <AskAboutLink kind="task" id={M} />)).toContain('Ask about this task');
  });

  it('is absent without chat, and for an object in another team', () => {
    expect(html(OFF, <AskAboutLink kind="mission" id={M} />)).toBe('');
    expect(html(ADMIN_NO_KEY, <AskAboutLink kind="mission" id={M} />)).toBe('');
    expect(html(ON, <AskAboutLink kind="mission" id={M} teamId="team-2" />)).toBe('');
  });
});

describe('SetUpChatNudge', () => {
  it('shows only for an admin with no provider key', () => {
    expect(html(ADMIN_NO_KEY, <SetUpChatNudge />)).toContain('href="/app/settings/models#provider-keys"');
    expect(html(OFF, <SetUpChatNudge />)).toBe('');
    expect(html(ON, <SetUpChatNudge />)).toBe('');
    expect(html(null, <SetUpChatNudge />)).toBe('');
  });
});
