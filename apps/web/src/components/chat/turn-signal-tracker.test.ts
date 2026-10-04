import { describe, expect, it } from 'bun:test';
import { parseTurnSignalPost, type TurnSignal } from '@/lib/chat/turn-signal';
import { hasAnswerContent, TurnSignalTracker, type ProbeResult } from './turn-signal-tracker';

const AID = '0a0a0a0a-0000-4000-8000-000000000001';

function harness(init: { probe?: ProbeResult; hidden?: boolean; online?: boolean } = {}) {
  const state = { t: 1_000, probe: init.probe ?? 'not_visible' as ProbeResult, hidden: init.hidden ?? false, online: init.online ?? true };
  const posts: Array<{ ref: string; signal: TurnSignal; beacon: boolean }> = [];
  const tracker = new TurnSignalTracker({
    now: () => state.t,
    probe: () => state.probe,
    post: (ref, signal, beacon) => posts.push({ ref, signal, beacon }),
    docHidden: () => state.hidden,
    online: () => state.online,
  });
  return { tracker, state, posts };
}

describe('TurnSignalTracker', () => {
  it('a turn that rendered: offsets for every step, posted once, and the post passes the server\'s parser', () => {
    const { tracker, state, posts } = harness();
    tracker.submit('u1');
    state.t += 500; tracker.streaming();
    state.t += 700; tracker.content(AID); tracker.check();
    state.probe = 'visible'; state.t += 100; tracker.check();
    state.t += 2000; tracker.end('ready');
    tracker.finalize();
    tracker.finalize();
    expect(posts).toHaveLength(1);
    expect(posts[0].signal).toEqual({ at: 1000, startMs: 500, contentMs: 1200, renderMs: 1300, endMs: 3300, outcome: 'ready', assistantId: AID });
    expect(parseTurnSignalPost({ ref: posts[0].ref, signal: posts[0].signal }).ok).toBe(true);
  });

  it('content that never reached the screen: no renderMs, nothing suppressing', () => {
    const { tracker, posts } = harness();
    tracker.submit('u1'); tracker.streaming(); tracker.content(AID); tracker.check(); tracker.end('ready'); tracker.finalize();
    expect(posts[0].signal.renderMs).toBeUndefined();
    expect(posts[0].signal.endMs).toBeDefined();
    expect(posts[0].signal.hidden).toBeUndefined();
  });

  it('background during the turn is flagged, and a visible probe while hidden is not a render', () => {
    const { tracker, state, posts } = harness({ probe: 'visible' });
    tracker.submit('u1'); tracker.content(AID);
    state.hidden = true; tracker.flag('hidden'); tracker.check();
    tracker.end('ready'); tracker.finalize();
    expect(posts[0].signal.hidden).toBe(true);
    expect(posts[0].signal.renderMs).toBeUndefined();
  });

  it('pagehide sends a beacon right away; nothing more is sent for that turn', () => {
    const { tracker, posts } = harness();
    tracker.submit('u1'); tracker.content(AID);
    tracker.pagehide();
    tracker.end('ready'); tracker.finalize();
    expect(posts).toEqual([{ ref: 'u1', signal: expect.objectContaining({ pagehide: true }), beacon: true }]);
  });

  it('leaving the conversation mid-turn, pressing stop, a hidden pane, offline at submit: all flagged', () => {
    const left = harness(); left.tracker.submit('u1'); left.tracker.left();
    expect(left.posts[0].signal.left).toBe(true);

    const stop = harness(); stop.tracker.submit('u1'); stop.tracker.flag('stopped'); stop.tracker.end('ready'); stop.tracker.finalize();
    expect(stop.posts[0].signal.stopped).toBe(true);

    const pane = harness({ probe: 'pane_hidden' }); pane.tracker.submit('u1'); pane.tracker.content(AID); pane.tracker.check(); pane.tracker.end('ready'); pane.tracker.finalize();
    expect(pane.posts[0].signal.paneHidden).toBe(true);

    const off = harness({ online: false }); off.tracker.submit('u1'); off.tracker.end('error'); off.tracker.finalize();
    expect(off.posts[0].signal).toMatchObject({ offline: true, outcome: 'error' });
  });

  it('a new turn sends the open one as it stands; the same ref twice is one turn', () => {
    const { tracker, posts } = harness();
    tracker.submit('u1'); tracker.submit('u1');
    tracker.submit('u2');
    expect(posts.map(p => p.ref)).toEqual(['u1']);
    expect(tracker.current).toBe('u2');
  });

  it('holds ids, numbers and flags only', () => {
    const { tracker, posts } = harness({ probe: 'visible' });
    tracker.submit('u1'); tracker.content(AID); tracker.check(); tracker.end('ready'); tracker.finalize();
    for (const v of Object.values(posts[0].signal)) expect(['number', 'boolean'].includes(typeof v) || v === AID || v === 'ready').toBe(true);
  });
});

describe('hasAnswerContent', () => {
  it('text or an approval card; tool rows and blank text are not an answer', () => {
    expect(hasAnswerContent([{ type: 'text', text: 'hi' } as never])).toBe(true);
    expect(hasAnswerContent([{ type: 'tool-x', state: 'approval-requested' } as never])).toBe(true);
    expect(hasAnswerContent([{ type: 'text', text: '  ' } as never, { type: 'tool-x', state: 'output-available' } as never])).toBe(false);
  });
});
