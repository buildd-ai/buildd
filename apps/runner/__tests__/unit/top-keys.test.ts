/**
 * `buildd top` keys (R-5, R-6): each key either changes the view or asks
 * run.ts for one effect; an action on the wrong kind of row says why instead.
 */
import { describe, expect, test } from 'bun:test';
import { OSC_ABANDON_MS, actionResultText, createKeyDecoder, handleKey, parseKeys, type Effect, type Key } from '../../src/top/keys';
import { reduce, selectedRow, taskRows, type TopState } from '../../src/top/state';
import { NOW, fixtureState } from './top-fixture';

const ch = (c: string): Key => ({ name: 'char', ch: c });
function press(s: TopState, ...keys: Array<Key | string>) {
  const effects: Effect[] = [];
  for (const k of keys) {
    const list = typeof k === 'string' ? parseKeys(k) : [k];
    for (const key of list) {
      const r = handleKey(s, key, NOW);
      s = r.state;
      effects.push(...r.effects);
    }
  }
  return { s, effects };
}
/** Put the cursor on the row with this title. */
const on = (title: string): TopState => {
  const s = fixtureState();
  for (let i = 0; i < 20; i++) {
    const st = { ...s, rowCursor: i };
    if (selectedRow(st, NOW)?.title === title) return st;
  }
  throw new Error(`no row ${title}`);
};

describe('parseKeys', () => {
  test('arrows, enter, escape, ctrl-c, backspace, text', () => {
    expect(parseKeys('\x1b[A\x1b[B\x1bOC\x1b[D')).toEqual([{ name: 'up' }, { name: 'down' }, { name: 'right' }, { name: 'left' }]);
    expect(parseKeys('\r')).toEqual([{ name: 'enter' }]);
    expect(parseKeys('\x1b')).toEqual([{ name: 'escape' }]);
    expect(parseKeys('\x03')).toEqual([{ name: 'ctrl-c' }]);
    expect(parseKeys('\x7f')).toEqual([{ name: 'backspace' }]);
    expect(parseKeys('hé😀')).toEqual([ch('h'), ch('é'), ch('😀')]);
  });
  test('unknown escape sequences are swallowed, not typed', () => {
    expect(parseKeys('\x1b[3~x')).toEqual([ch('x')]);
  });
});

describe('moving', () => {
  test('↓/j move the row cursor, ← and → switch panes, ↓ in missions changes the mission', () => {
    let { s } = press(fixtureState(), '\x1b[B', 'j');
    expect(selectedRow(s, NOW)?.title).toBe('single instance');
    ({ s } = press(s, '\x1b[D', '\x1b[B'));
    expect(s.focus).toBe('missions');
    expect(s.selectedMission).toBe('m-spec-0000-0000');
    expect(s.rowCursor).toBe(0);
    ({ s } = press(s, '\r'));
    expect(s.focus).toBe('tasks');
  });

  test('enter opens detail, esc returns', () => {
    let { s } = press(fixtureState(), '\r');
    expect(s.mode).toEqual({ kind: 'detail', taskId: 't-name' });
    ({ s } = press(s, '\x1b'));
    expect(s.mode).toEqual({ kind: 'list' });
  });
});

describe('actions (R-6)', () => {
  test('a answers a question inline: type, enter, one answer effect', () => {
    const { s, effects } = press(on('installer hint'), 'a', 'Print the URL', '\r');
    expect(effects).toEqual([{ type: 'action', action: 'answer', workerId: 'w-hint', taskId: 't-hint', title: 'installer hint', message: 'Print the URL' }]);
    expect(s.mode).toEqual({ kind: 'list' });
    expect(s.status?.text).toContain('Sending the answer');
  });

  test('an empty answer is not sent', () => {
    const { effects, s } = press(on('installer hint'), 'a', '  ', '\r');
    expect(effects).toEqual([]);
    expect(s.status?.tone).toBe('error');
  });

  test('esc cancels an answer and backspace edits it', () => {
    let { s, effects } = press(on('installer hint'), 'a', 'abc', { name: 'backspace' });
    expect(s.mode).toMatchObject({ kind: 'input', text: 'ab' });
    ({ s, effects } = press(s, '\x1b'));
    expect(effects).toEqual([]);
    expect(s.mode).toEqual({ kind: 'list' });
  });

  test('a on a row that is not asking says so', () => {
    const { s, effects } = press(fixtureState(), 'a');
    expect(effects).toEqual([]);
    expect(s.status).toEqual({ text: '"name override" is not asking anything.', tone: 'error' });
  });

  test('m messages a running agent', () => {
    const { effects } = press(fixtureState(), 'm', 'use the env var', '\r');
    expect(effects).toEqual([{ type: 'action', action: 'message', workerId: 'w-name', taskId: 't-name', title: 'name override', message: 'use the env var' }]);
  });

  test('p pauses a running agent; not a waiting task', () => {
    expect(press(fixtureState(), 'p').effects).toEqual([{ type: 'action', action: 'pause', workerId: 'w-name', taskId: 't-name', title: 'name override' }]);
    const r = press(on('buildd top'), 'p');
    expect(r.effects).toEqual([]);
    expect(r.s.status?.text).toBe('No agent is running on "buildd top".');
  });

  test('x asks first; y stops, anything else keeps it running', () => {
    let r = press(fixtureState(), 'x');
    expect(r.effects).toEqual([]);
    expect(r.s.mode).toMatchObject({ kind: 'confirm', workerId: 'w-name' });
    const yes = press(r.s, 'y');
    expect(yes.effects).toEqual([{ type: 'action', action: 'stop', workerId: 'w-name', taskId: 't-name', title: 'name override' }]);
    const no = press(r.s, 'n');
    expect(no.effects).toEqual([]);
    expect(no.s.status?.text).toBe('Kept "name override" running.');
  });

  test('c claims a waiting task onto this runner; refused on a running one', () => {
    expect(press(on('buildd top'), 'c').effects).toEqual([{ type: 'claim', taskId: 't-top', title: 'buildd top' }]);
    expect(press(fixtureState(), 'c').effects).toEqual([]);
  });

  test('o opens the task', () => {
    expect(press(on('docs page'), 'o').effects).toEqual([{ type: 'open', taskId: 't-docs' }]);
  });

  test('actions from the detail view go back to it', () => {
    const { s, effects } = press(on('installer hint'), '\r', 'a', 'ok', '\r');
    expect(effects[0]).toMatchObject({ action: 'answer', message: 'ok' });
    expect(s.mode).toEqual({ kind: 'detail', taskId: 't-hint' });
  });

  test('/ filters by title; esc clears it', () => {
    let { s } = press(fixtureState(), '/', 'docs', '\r');
    expect(s.filter).toBe('docs');
    expect(selectedRow(s, NOW)?.title).toBe('docs page');
    ({ s } = press(s, '\x1b'));
    expect(s.filter).toBe('');
  });

  test('q and ctrl-c quit; q while typing is just a letter', () => {
    expect(press(fixtureState(), 'q').effects).toEqual([{ type: 'quit' }]);
    expect(press(fixtureState(), '\x03').effects).toEqual([{ type: 'quit' }]);
    const typing = press(fixtureState(), 'm', 'q');
    expect(typing.effects).toEqual([]);
    expect(typing.s.mode).toMatchObject({ text: 'q' });
    expect(press(typing.s, '\x03').effects).toEqual([{ type: 'quit' }]);
  });
});

describe('status line from the server answer', () => {
  const answer: Effect = { type: 'action', action: 'answer', workerId: 'w', taskId: 't', title: 'installer hint', message: 'x' };
  test('ok', () => {
    expect(actionResultText(answer, { status: 200, body: { ok: true } })).toEqual({ text: 'Answer sent to "installer hint". The agent picks it up from here.', tone: 'ok' });
  });
  test('a refusal shows the server reason verbatim', () => {
    expect(actionResultText(answer, { status: 409, body: { error: 'Worker is not waiting for input' } }))
      .toEqual({ text: 'Answer refused: Worker is not waiting for input (HTTP 409)', tone: 'error' });
    expect(actionResultText({ type: 'claim', taskId: 't', title: 'x' }, { status: 400, body: 'nope' }).text).toBe('Claim refused: nope (HTTP 400)');
    expect(actionResultText(answer, { status: 502, body: {} }).text).toBe('Answer refused: HTTP 502');
  });
});

describe('revision 2 keys (R-19, R-20)', () => {
  const withWorkspaces = (): TopState => reduce(fixtureState(), {
    type: 'workspaces',
    workspaces: [
      { id: 'ws-aaaa-0000', name: 'alpha', teamId: 'team-1' },
      { id: 'ws-bbbb-0000', name: 'bravo', teamId: 'team-2' },
    ],
  });

  test('w cycles the workspace and says which one', () => {
    let { s } = press(withWorkspaces(), 'w');
    expect(s.selectedWorkspace).toBe('ws-aaaa-0000');
    expect(s.status?.text).toBe('Showing alpha. w for the next workspace.');
    ({ s } = press(s, 'w', 'w'));
    expect(s.selectedWorkspace).toBeNull();
    expect(s.status?.text).toBe('Showing all 2 workspaces.');
  });

  test('w names the team when the workspaces span several (R-7)', () => {
    const named = reduce(fixtureState(), {
      type: 'workspaces',
      workspaces: [
        { id: 'ws-aaaa-0000', name: 'alpha', teamId: 'team-1', teamName: 'Team One' },
        { id: 'ws-bbbb-0000', name: 'bravo', teamId: 'team-2', teamName: 'Team Two' },
      ],
    });
    const { s } = press(named, 'w');
    expect(s.status?.text).toBe('Showing alpha (Team One). w for the next workspace.');
  });

  test('w with nothing to switch to says so', () => {
    const { s } = press(fixtureState(), 'w');
    expect(s.selectedWorkspace).toBeNull();
    expect(s.status?.text).toBe('This runner serves one workspace, so there is nothing to switch to.');
  });

  test('? opens help; o there opens the runner page; esc or ? closes it', () => {
    let { s, effects } = press(fixtureState(), '?');
    expect(s.mode).toEqual({ kind: 'help' });
    ({ effects } = press(s, 'o'));
    expect(effects).toEqual([{ type: 'openRunner' }]);
    expect(press(s, '\x1b').s.mode).toEqual({ kind: 'list' });
    expect(press(s, '?').s.mode).toEqual({ kind: 'list' });
    expect(press(s, 'q').effects).toEqual([{ type: 'quit' }]);
  });

  test('a late OSC 11 reply is swallowed, never typed as keys', () => {
    expect(parseKeys('\x1b]11;rgb:ffff/ffff/ffff\x07j')).toEqual([ch('j')]);
    expect(parseKeys('\x1b]11;rgb:0000/0000/0000\x1b\\k')).toEqual([ch('k')]);
  });
});

describe('terminal replies split across reads never become keys (R-17)', () => {
  // Real answers to the OSC 11 query, ended by BEL and by ST. The c's are the
  // dangerous part: a bare c claims the selected waiting task.
  const REPLIES = ['\x1b]11;rgb:cccc/cccc/cccc\x07', '\x1b]11;rgb:ffff/ffff/ffff\x1b\\', '\x1b]11;rgba:fafa/fafa/fafa/ffff\x07'];

  /** The selected row is a waiting task, so a leaked c would claim it. */
  const onWaiting = (): TopState => {
    const s = { ...fixtureState(), focus: 'tasks' as const };
    const idx = taskRows(s, NOW).findIndex(r => r.kind === 'waiting');
    expect(idx).toBeGreaterThan(-1);
    return { ...s, rowCursor: idx };
  };

  for (const reply of REPLIES) {
    test(`every split point of ${JSON.stringify(reply)} is swallowed`, () => {
      for (let k = 1; k < reply.length; k++) {
        const d = createKeyDecoder();
        const keys = [...d.feed(reply.slice(0, k)), ...d.feed(reply.slice(k))];
        expect({ k, keys }).toEqual({ k, keys: [] });
        // Nothing left half-read: the next key is read normally.
        expect(d.feed('j')).toEqual([ch('j')]);

        // And no key action fires on a waiting row.
        let s = onWaiting();
        const before = s;
        const effects: Effect[] = [];
        const d2 = createKeyDecoder();
        for (const part of [reply.slice(0, k), reply.slice(k)]) {
          for (const key of d2.feed(part)) {
            const r = handleKey(s, key, NOW);
            s = r.state;
            effects.push(...r.effects);
          }
        }
        expect({ k, effects }).toEqual({ k, effects: [] });
        expect(s).toEqual(before);
      }
    });
  }

  test('a split point inside the reply, with a real key typed right after, keeps only the key', () => {
    const reply = REPLIES[0];
    for (let k = 1; k < reply.length; k++) {
      const d = createKeyDecoder();
      expect([...d.feed(reply.slice(0, k)), ...d.feed(reply.slice(k) + 'q')]).toEqual([ch('q')]);
    }
  });

  test('a split CSI (arrow) still reads as the arrow', () => {
    const d = createKeyDecoder();
    expect([...d.feed('\x1b'), ...d.feed('[B')]).toEqual([{ name: 'down' }]);
    const d2 = createKeyDecoder();
    expect([...d2.feed('\x1b['), ...d2.feed('3'), ...d2.feed('~x')]).toEqual([ch('x')]);
  });

  test('a lone escape is a key once the read settles (flush)', () => {
    const d = createKeyDecoder();
    expect(d.feed('\x1b')).toEqual([]);
    expect(d.pendingEscape()).toBe(true);
    expect(d.flush()).toEqual([{ name: 'escape' }]);
    expect(d.pendingEscape()).toBe(false);
  });

  test('flush never turns a half-read reply into keys', () => {
    const d = createKeyDecoder();
    d.feed('\x1b]11;rgb:cc');
    expect(d.flush()).toEqual([]);
    expect(d.feed('cc/cccc/cccc\x07c')).toEqual([ch('c')]);
  });

  test('ctrl-c still quits from inside an unfinished terminal string', () => {
    const d = createKeyDecoder();
    expect(d.feed('\x1b]11;rgb:cc\x03')).toEqual([{ name: 'ctrl-c' }]);
  });
});

describe('an unterminated terminal string never eats the keyboard', () => {
  // Alt+] sends ESC ] and Alt+Shift+P sends ESC P: no terminal reply follows.
  test('Alt+] then a key that cannot be in an OSC 11 reply: the key is read', () => {
    const d = createKeyDecoder();
    expect(d.feed('\x1b]', 0)).toEqual([]);
    expect(d.feed('j', 10)).toEqual([ch('j')]);
    expect(d.feed('k', 20)).toEqual([ch('k')]);
  });

  test('Alt+] then q in the same read quits', () => {
    expect(parseKeys('\x1b]q')).toEqual([ch('q')]);
  });

  test('Alt+] then a key that could start a reply is dropped after 100 ms of silence', () => {
    const d = createKeyDecoder();
    expect(d.feed('\x1b]', 0)).toEqual([]);
    expect(d.feed('1', 20)).toEqual([]); // still a possible "11;rgb:…"
    expect(d.feed('c', 200)).toEqual([ch('c')]); // abandoned: c is a key again
    expect(d.feed('a', 210)).toEqual([ch('a')]);
  });

  test('a lone Alt+] goes stale after 100 ms and the next key reads', () => {
    const d = createKeyDecoder();
    expect(d.feed('\x1b]', 0)).toEqual([]);
    expect(d.feed('1', 150)).toEqual([ch('1')]);
  });

  test('a reply that strays from the OSC 11 shape is dropped where it strays', () => {
    const d = createKeyDecoder();
    expect(d.feed('\x1b]11;rgb:cc', 0)).toEqual([]);
    expect(d.feed('x', 5)).toEqual([ch('x')]);
    expect(d.feed('j', 6)).toEqual([ch('j')]);
  });

  test('Alt+Shift+P (ESC P) and the other string introducers never swallow later keys', () => {
    for (const intro of ['P', 'X', '^', '_']) {
      const d = createKeyDecoder();
      expect(d.feed(`\x1b${intro}`, 0)).toEqual([]);
      expect({ intro, keys: d.feed('j', 10) }).toEqual({ intro, keys: [ch('j')] });
    }
  });

  test('a real reply streaming in within 100 ms gaps is still swallowed whole', () => {
    const reply = '\x1b]11;rgb:cccc/cccc/cccc\x07';
    const d = createKeyDecoder();
    let t = 0;
    const keys: Key[] = [];
    for (const c of reply) keys.push(...d.feed(c, (t += 40)));
    expect(keys).toEqual([]);
    expect(d.feed('c', t + 1)).toEqual([ch('c')]);
  });

  test('OSC_ABANDON_MS is 100', () => {
    expect(OSC_ABANDON_MS).toBe(100);
  });
});
