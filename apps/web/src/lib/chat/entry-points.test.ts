import { describe, it, expect } from 'bun:test';
import {
  askAboutHref, composerHint, conversationHref, formHref, isChatShortcut, newWorkHref, parseAbout, parseChatEntry,
} from './entry-points';

const M = '11111111-1111-4111-8111-111111111111';
const WS = '22222222-2222-4222-8222-222222222222';

describe('newWorkHref — create buttons open chat when it is available', () => {
  it('chat available: + Mission and New task open a new conversation with the intent', () => {
    expect(newWorkHref('mission', true)).toBe('/app/chat?new=mission');
    expect(newWorkHref('task', true, WS)).toBe(`/app/chat?new=task&ws=${WS}`);
  });

  it('chat unavailable: the same buttons open the forms, as before', () => {
    expect(newWorkHref('mission', false)).toBe('/app/missions/new');
    expect(newWorkHref('task', false)).toBe('/app/tasks/new');
    expect(newWorkHref('task', false, WS)).toBe(`/app/tasks/new?workspaceId=${WS}`);
  });

  it('formHref is the fallback link chat offers', () => {
    expect(formHref('mission', WS)).toBe('/app/missions/new');
    expect(formHref('task', WS)).toBe(`/app/tasks/new?workspaceId=${WS}`);
  });
});

describe('askAboutHref / conversationHref', () => {
  it('docks the object and scopes the conversation to its workspace', () => {
    expect(askAboutHref({ kind: 'mission', id: M }, WS)).toBe(`/app/chat?about=mission%3A${M}&ws=${WS}`);
  });

  it('carries intent and about to the conversation page, never the workspace', () => {
    expect(conversationHref('c1', { intent: 'task', about: null, workspaceId: WS })).toBe('/app/chat/c1?new=task');
    expect(conversationHref('c1', { about: { kind: 'task', id: M } })).toBe(`/app/chat/c1?about=task%3A${M}`);
    expect(conversationHref('c1')).toBe('/app/chat/c1');
  });
});

describe('parseChatEntry — invalid values read as absent', () => {
  it('round-trips what the hrefs produce', () => {
    const q = Object.fromEntries(new URL(`https://x${askAboutHref({ kind: 'task', id: M }, WS)}`).searchParams);
    expect(parseChatEntry(q)).toEqual({ intent: null, about: { kind: 'task', id: M }, workspaceId: WS });
    expect(parseChatEntry({ new: 'mission' })).toEqual({ intent: 'mission', about: null, workspaceId: null });
  });

  it('drops unknown intents, kinds and non-uuid ids', () => {
    expect(parseChatEntry({ new: 'schedule', ws: 'not-a-uuid', about: 'mission:abc' })).toEqual({ intent: null, about: null, workspaceId: null });
    expect(parseAbout(`initiative:${M}`)).toBeNull();
    expect(parseAbout(`mission:${M}`)).toEqual({ kind: 'mission', id: M });
    expect(parseChatEntry({ new: ['task', 'mission'] }).intent).toBe('task');
  });
});

describe('composerHint', () => {
  it('names the outcome for a mission, the change for a task, the object when docked', () => {
    expect(composerHint({ intent: 'mission', about: null })).toBe('Describe the outcome you want…');
    expect(composerHint({ intent: 'task', about: null })).toMatch(/^Describe the change/);
    expect(composerHint({ intent: null, about: { kind: 'mission', id: M } })).toBe('Ask about this mission…');
    expect(composerHint({ intent: null, about: null })).toBeUndefined();
  });
});

describe('isChatShortcut', () => {
  const div = { tagName: 'DIV' };
  it('a bare c outside a field opens chat', () => {
    expect(isChatShortcut({ key: 'c', target: div })).toBe(true);
    expect(isChatShortcut({ key: 'c', target: null })).toBe(true);
  });
  it('never while typing, and never on a chord or a repeat', () => {
    expect(isChatShortcut({ key: 'c', target: { tagName: 'input' } })).toBe(false);
    expect(isChatShortcut({ key: 'c', target: { tagName: 'TEXTAREA' } })).toBe(false);
    expect(isChatShortcut({ key: 'c', target: { tagName: 'SELECT' } })).toBe(false);
    expect(isChatShortcut({ key: 'c', target: { tagName: 'DIV', isContentEditable: true } })).toBe(false);
    expect(isChatShortcut({ key: 'c', metaKey: true, target: div })).toBe(false);
    expect(isChatShortcut({ key: 'c', ctrlKey: true, target: div })).toBe(false);
    expect(isChatShortcut({ key: 'C', shiftKey: true, target: div })).toBe(false);
    expect(isChatShortcut({ key: 'c', repeat: true, target: div })).toBe(false);
    expect(isChatShortcut({ key: 'c', defaultPrevented: true, target: div })).toBe(false);
    expect(isChatShortcut({ key: 'k', target: div })).toBe(false);
  });
});
