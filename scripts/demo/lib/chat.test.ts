import { describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { confirmedParts, DEMO_ENCRYPTION_KEY, demoInputHash, fillKeys } from './chat';
import { IdMap, loadStory } from './story';

const STORY = join(import.meta.dir, '../stories/multi-currency.json');
const ids = { get: (k: string) => ({ M1: 'mission-id', ws: 'ws-id' } as Record<string, string>)[k] ?? (() => { throw new Error(`unknown ${k}`); })() };

describe('fillKeys', () => {
  test('resolves {{KEY}} at any depth and leaves other strings alone', () => {
    expect(fillKeys({ a: ['{{M1}}', { b: 'in {{ws}}' }], n: 1, t: 'plain {braces}' }, ids))
      .toEqual({ a: ['mission-id', { b: 'in ws-id' }], n: 1, t: 'plain {braces}' });
  });
  test('an unknown key throws instead of writing a dangling id', () => {
    expect(() => fillKeys('{{NOPE}}', ids)).toThrow();
  });
});

describe('confirmedParts', () => {
  const parts = [
    { type: 'text', text: 'Here is a draft.' },
    { type: 'tool-manage_missions', toolCallId: 'call_x', state: 'approval-requested', input: { action: 'create' }, approval: { id: 'ap' } },
  ];
  test('the approval part becomes the filed call carrying the mission ref, and the follow-up comes after', () => {
    const out = confirmedParts(parts, 'call_x', { summary: 'filed', data: 'ok', objects: [{ kind: 'mission', id: 'm' }], followUp: 'Filed.' });
    expect(out[0]).toEqual(parts[0]);
    expect(out[1]).toMatchObject({ state: 'output-available', approval: { id: 'ap', approved: true }, output: { summary: 'filed', objects: [{ kind: 'mission', id: 'm' }] } });
    expect(out[1].input).toEqual({ action: 'create' });
    expect(out[2]).toEqual({ type: 'text', text: 'Filed.' });
  });
  test('confirming a call that is not there fails loudly', () => {
    expect(() => confirmedParts(parts, 'nope', { summary: '', data: '', objects: [] })).toThrow();
  });
});

describe('demoInputHash', () => {
  test('matches the chat route\'s own approval hash', async () => {
    mock.module('@buildd/core/db', () => ({ db: {} }));
    const { hashToolInput } = await import('../../../apps/web/src/lib/chat/approvals');
    const input = { title: 'x', action: 'create', goalCriteria: [{ type: 'no_open_tasks', label: undefined }], n: 3 };
    expect(demoInputHash(input)).toBe(hashToolInput(input));
  });
});

describe('the multi-currency chat opener', () => {
  const { story } = loadStory(STORY);
  const conv = story.chat.conversations[0];

  test('every {{KEY}} in the conversation names a dataset key the seed registers', () => {
    const map = new IdMap('t');
    for (const k of ['ws', 'M1', 'u_maya']) map.register(k);
    expect(() => fillKeys({ messages: conv.messages, onConfirm: conv._onConfirm }, map)).not.toThrow();
  });

  test('the open approval points at a real approval-requested part, and t=0 confirms it', () => {
    const msg = conv.messages.find((m: any) => m.key === conv.approval.messageKey);
    const part = msg.parts.find((p: any) => p.toolCallId === conv.approval.toolCallId);
    expect(part).toMatchObject({ type: 'tool-manage_missions', state: 'approval-requested', approval: { id: conv.approval.approvalId } });
    expect(part.input.action).toBe('create');
    const create = story.timeline.find((e) => e.op === 'mission_create' && e.mission === 'M1');
    expect(create?.t).toBe(0);
    expect(create?.conversation).toBe(conv.key);
    expect(conv._onConfirm.objects[0]).toMatchObject({ kind: 'mission', id: '{{M1}}' });
  });

  test('stays fictional: no uuids, and the provider key is marked not real', () => {
    const raw = JSON.stringify(story.chat);
    expect(raw).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(story.chat.providerKey.value).toContain('not-a-real-key');
  });

  test('the key is sealed with the value the demo server decrypts with', () => {
    const serve = readFileSync(join(import.meta.dir, '../serve.sh'), 'utf8');
    expect(serve).toContain(`ENCRYPTION_KEY=${DEMO_ENCRYPTION_KEY}`);
  });

  test('the storyboard opens on the chat, before the board', () => {
    const board = Bun.YAML.parse(readFileSync(join(import.meta.dir, '../storyboards/multi-currency.yaml'), 'utf8')) as { steps: Array<{ id: string; goto?: string; click?: string; viewports?: string[] }> };
    expect(board.steps[0]).toMatchObject({ id: 'c0-chat-propose', goto: '/app/chat/{C1}' });
    expect(board.steps.some(s => s.click === 'object-expand' && s.viewports?.includes('phone'))).toBe(true);
  });

  type BoardStep = { id: string; goto?: string; advance?: string; waitFor?: string | string[]; scrollTo?: string; scrollAlign?: string; record?: { advanceTo?: string } };
  const boardSteps = () =>
    (Bun.YAML.parse(readFileSync(join(import.meta.dir, '../storyboards/multi-currency.yaml'), 'utf8')) as { steps: BoardStep[] }).steps;

  test('the opener frames the confirm button, not just the top of a card taller than the chat', () => {
    // The approval card is taller than the chat on a phone and nearly so on
    // desktop; anchored at its top, the composer covered "Confirm & file".
    expect(boardSteps().find((s) => s.id === 'c0-chat-propose')).toMatchObject({ scrollTo: 'approval-confirm', scrollAlign: 'end' });
  });

  test('the respond step waits for the chat question sheet: a mission from a chat answers there', () => {
    // /app/tasks/[id]/respond redirects to the mission's conversation
    // (?focus=question) once one exists, so the standalone respond hero never renders.
    const respond = boardSteps().find((s) => s.goto === '/app/tasks/{T8}/respond');
    const waits = [respond?.waitFor ?? []].flat();
    expect(waits).not.toContain('respond-question-hero');
    expect(waits.join(' ')).toContain('chat-object-sheet');
  });

  test('records the home fleet filling to peak, 10:00 -> 12:00', () => {
    const live = boardSteps().find((s) => s.goto === '/app/home' && s.record);
    expect(live).toMatchObject({ advance: '10:00', record: { advanceTo: '12:00' } });
  });
});
