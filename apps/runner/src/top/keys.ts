/**
 * `buildd top` keys: raw terminal input -> key names -> state changes plus the
 * effects run.ts carries out (a socket action, opening a URL, quitting).
 * Pure, so every key is unit-tested (top-keys.test.ts).
 */
import {
  currentMission, currentWorkspace, cycleWorkspace, missionRows, selectedRow, taskRows, teamCount, workspaceList,
  type TaskRow, type TopState,
} from './state';

export type Key =
  | { name: 'up' | 'down' | 'left' | 'right' | 'enter' | 'escape' | 'backspace' | 'tab' | 'ctrl-c' }
  | { name: 'char'; ch: string };

/** Split one chunk of raw stdin into keys (a fresh decoder, flushed at the end). */
export function parseKeys(chunk: string): Key[] {
  const d = createKeyDecoder();
  return [...d.feed(chunk), ...d.flush()];
}

export interface KeyDecoder {
  /**
   * Decode the next read, received at `now` (ms). A sequence cut off at the
   * end is carried into the next feed; an unterminated terminal string that
   * has been silent for OSC_ABANDON_MS is dropped first.
   */
  feed(chunk: string, now?: number): Key[];
  /** The read has settled: a lone ESC waiting for more is the escape key. Half-read terminal strings stay swallowed. */
  flush(): Key[];
  /** True when the last byte read was a lone ESC (run.ts flushes it after a short wait). */
  pendingEscape(): boolean;
}

const ARROWS: Record<string, Key['name']> = { A: 'up', B: 'down', C: 'right', D: 'left' };
/** Longest CSI / terminal string swallowed before giving up on it, so a stray ESC can never eat the keyboard. */
const MAX_SEQ = 64;
const MAX_STRING = 1024;
/** An unterminated terminal string silent this long is abandoned, so Alt+] never eats later keys. */
export const OSC_ABANDON_MS = 100;

/**
 * The only terminal string `top` asks for is the OSC 11 reply
 * `11;rgb:RRRR/GGGG/BBBB` (or `rgba:…/AAAA`). True while `s`, the bytes after
 * `ESC ]`, can still grow into one; a byte that breaks the shape means a person
 * typed it (Alt+] then a key), so the string is dropped there.
 */
const H = '[0-9a-f]{0,4}';
const OSC11_PREFIX = new RegExp(`^(?:1(?:1(?:;(?:r(?:g(?:b(?:a|a?:${H}(?:/${H}(?:/${H}(?:/${H})?)?)?)?)?)?)?)?)?)?$`, 'i');
export function couldBeOsc11Reply(s: string): boolean {
  return OSC11_PREFIX.test(s);
}

/**
 * A stateful stdin decoder for the whole session. Terminal sequences (CSI
 * `ESC [ … final`, SS3 `ESC O x`, and strings `ESC ] … BEL | ESC \`, which is
 * the shape of a late OSC 11 background reply) are tracked across reads, so a
 * reply split over two chunks is swallowed whole and none of its bytes (the
 * `c` of `rgb:cccc`, a `/`) are read as keys.
 *
 * The string is bounded, because Alt+] sends `ESC ]` with no reply behind it:
 * it is dropped (and the byte read as a key) as soon as a byte arrives that
 * cannot continue an OSC 11 reply, or once it has been silent for
 * OSC_ABANDON_MS. DCS, SOS, PM and APC (`ESC P`, Alt+Shift+P) are never asked
 * for, so their introducer is dropped on the spot.
 */
export function createKeyDecoder(): KeyDecoder {
  type St = 'ground' | 'esc' | 'csi' | 'ss3' | 'str' | 'strEsc';
  let st: St = 'ground';
  let seqLen = 0;
  /** The bytes of the OSC string so far, after `ESC ]`. */
  let osc = '';
  /** When the OSC string last received a byte. */
  let oscAt = 0;

  const ground = (keys: Key[], c: string, cp: number) => {
    if (c === '\x1b') { st = 'esc'; return; }
    if (c === '\r' || c === '\n') { keys.push({ name: 'enter' }); return; }
    if (c === '\x03') { keys.push({ name: 'ctrl-c' }); return; }
    if (c === '\x7f' || c === '\b') { keys.push({ name: 'backspace' }); return; }
    if (c === '\t') { keys.push({ name: 'tab' }); return; }
    if (cp < 0x20) return;
    keys.push({ name: 'char', ch: c });
  };

  const step = (keys: Key[], c: string, cp: number) => {
    switch (st) {
      case 'ground':
        return ground(keys, c, cp);
      case 'esc':
        if (c === '[') { st = 'csi'; seqLen = 0; return; }
        if (c === 'O') { st = 'ss3'; return; }
        // OSC: possibly the background reply, never typed.
        if (c === ']') { st = 'str'; seqLen = 0; osc = ''; return; }
        // DCS, SOS, PM, APC: never asked for, so a person typed it (Alt+Shift+P). Drop it.
        if (c === 'P' || c === 'X' || c === '^' || c === '_') { st = 'ground'; return; }
        keys.push({ name: 'escape' });
        st = 'ground';
        return ground(keys, c, cp);
      case 'csi':
        if (cp >= 0x40 && cp <= 0x7e) {
          st = 'ground';
          if (ARROWS[c]) keys.push({ name: ARROWS[c] } as Key);
          return;
        }
        if (c === '\x03') { st = 'ground'; keys.push({ name: 'ctrl-c' }); return; }
        if (++seqLen > MAX_SEQ) st = 'ground';
        return;
      case 'ss3':
        st = 'ground';
        if (ARROWS[c]) keys.push({ name: ARROWS[c] } as Key);
        return;
      case 'str':
        if (c === '\x07') { st = 'ground'; return; }
        if (c === '\x1b') { st = 'strEsc'; return; }
        // A terminal reply never carries ctrl-c: a person pressed it.
        if (c === '\x03') { st = 'ground'; keys.push({ name: 'ctrl-c' }); return; }
        if (!couldBeOsc11Reply(osc + c)) { st = 'ground'; return ground(keys, c, cp); }
        osc += c;
        if (++seqLen > MAX_STRING) st = 'ground';
        return;
      case 'strEsc':
        if (c === '\\') { st = 'ground'; return; }
        // ESC inside a string ends it and starts a new sequence.
        st = 'esc';
        return step(keys, c, cp);
    }
  };

  return {
    feed(chunk, now = Date.now()) {
      const keys: Key[] = [];
      // A string left open and silent is no reply: drop it before reading on.
      if ((st === 'str' || st === 'strEsc') && now - oscAt > OSC_ABANDON_MS) st = 'ground';
      for (const c of chunk) step(keys, c, c.codePointAt(0)!); // for-of keeps surrogate pairs together
      if (st === 'str' || st === 'strEsc') oscAt = now;
      return keys;
    },
    flush() {
      if (st !== 'esc') return [];
      st = 'ground';
      return [{ name: 'escape' }];
    },
    pendingEscape: () => st === 'esc',
  };
}

export type Effect =
  | { type: 'action'; action: 'answer' | 'message' | 'pause' | 'stop'; workerId: string; taskId: string; title: string; message?: string }
  | { type: 'claim'; taskId: string; title: string }
  | { type: 'open'; taskId: string }
  /** The runner's page on buildd.dev, where its workspaces are set (R-20). */
  | { type: 'openRunner' }
  | { type: 'quit' };

export interface KeyResult {
  state: TopState;
  effects: Effect[];
}

const info = (state: TopState, text: string): TopState => ({ ...state, status: { text, tone: 'info' } });
const refuse = (state: TopState, text: string): TopState => ({ ...state, status: { text, tone: 'error' } });

/** The row a key acts on: the open detail's task, else the selected row. */
function targetRow(state: TopState, now: number): TaskRow | null {
  if (state.mode.kind === 'detail') {
    const id = state.mode.taskId;
    const row = taskRows({ ...state, filter: '' }, now).find(r => r.taskId === id);
    return row ?? null;
  }
  return state.focus === 'tasks' ? selectedRow(state, now) : null;
}

function moveMission(state: TopState, delta: number): TopState {
  const rows = missionRows(state);
  const cur = rows.findIndex(r => r.key === currentMission(state).key);
  const idx = Math.max(0, Math.min(rows.length - 1, cur + delta));
  return { ...state, missionCursor: idx, selectedMission: rows[idx].key, rowCursor: 0 };
}

function moveRow(state: TopState, delta: number, now: number): TopState {
  const n = taskRows(state, now).length;
  if (n === 0) return state;
  const cur = Math.min(state.rowCursor, n - 1);
  return { ...state, rowCursor: Math.max(0, Math.min(n - 1, cur + delta)) };
}

function actOnRow(state: TopState, ch: string, now: number): KeyResult {
  const row = targetRow(state, now);
  const none = { state: refuse(state, 'Pick a task first (→ moves to the task list).'), effects: [] };
  if (!row) return none;

  switch (ch) {
    case 'a': {
      if ((row.kind === 'asking' || row.kind === 'paused') && row.workerId) {
        return { state: { ...state, status: null, mode: { kind: 'input', purpose: 'answer', text: '', taskId: row.taskId, workerId: row.workerId, prompt: row.question, from: fromOf(state) } }, effects: [] };
      }
      return { state: refuse(state, `"${row.title}" is not asking anything.`), effects: [] };
    }
    case 'm': {
      if ((row.kind === 'running' || row.kind === 'asking') && row.workerId) {
        return { state: { ...state, status: null, mode: { kind: 'input', purpose: 'message', text: '', taskId: row.taskId, workerId: row.workerId, from: fromOf(state) } }, effects: [] };
      }
      return { state: refuse(state, `No agent is running on "${row.title}".`), effects: [] };
    }
    case 'p': {
      if (row.kind === 'running' && row.workerId) {
        return { state: info(state, `Asking "${row.title}" to pause…`), effects: [{ type: 'action', action: 'pause', workerId: row.workerId, taskId: row.taskId, title: row.title }] };
      }
      return { state: refuse(state, row.kind === 'paused' ? `"${row.title}" is already paused.` : `No agent is running on "${row.title}".`), effects: [] };
    }
    case 'x': {
      if ((row.kind === 'running' || row.kind === 'asking' || row.kind === 'paused') && row.workerId) {
        return { state: { ...state, status: null, mode: { kind: 'confirm', purpose: 'stop', taskId: row.taskId, workerId: row.workerId, from: fromOf(state) } }, effects: [] };
      }
      return { state: refuse(state, `No agent is running on "${row.title}".`), effects: [] };
    }
    case 'c': {
      if (row.kind === 'waiting') {
        return { state: info(state, `Claiming "${row.title}" onto this runner…`), effects: [{ type: 'claim', taskId: row.taskId, title: row.title }] };
      }
      return { state: refuse(state, `"${row.title}" is not waiting, so there is nothing to claim.`), effects: [] };
    }
    case 'o':
      return { state: info(state, `Opening "${row.title}" on buildd…`), effects: [{ type: 'open', taskId: row.taskId }] };
  }
  return { state, effects: [] };
}

export function handleKey(state: TopState, key: Key, now: number): KeyResult {
  if (key.name === 'ctrl-c') return { state, effects: [{ type: 'quit' }] };
  const mode = state.mode;

  if (mode.kind === 'input') {
    if (key.name === 'escape') return { state: { ...state, mode: mode.purpose === 'filter' ? { kind: 'list' } : backTo(mode), status: null }, effects: [] };
    if (key.name === 'backspace') return { state: { ...state, mode: { ...mode, text: [...mode.text].slice(0, -1).join('') } }, effects: [] };
    if (key.name === 'char') return { state: { ...state, mode: { ...mode, text: mode.text + key.ch } }, effects: [] };
    if (key.name === 'enter') {
      if (mode.purpose === 'filter') {
        return { state: { ...state, filter: mode.text.trim(), rowCursor: 0, mode: { kind: 'list' }, status: null }, effects: [] };
      }
      const text = mode.text.trim();
      if (!text) return { state: refuse(state, 'Type something first, or esc to cancel.'), effects: [] };
      const title = taskRows({ ...state, filter: '' }, now).find(r => r.taskId === mode.taskId)?.title ?? 'the task';
      const verb = mode.purpose === 'answer' ? 'Sending the answer' : 'Sending the message';
      return {
        state: { ...state, mode: backTo(mode), status: { text: `${verb} to "${title}"…`, tone: 'info' } },
        effects: [{ type: 'action', action: mode.purpose, workerId: mode.workerId!, taskId: mode.taskId!, title, message: text }],
      };
    }
    return { state, effects: [] };
  }

  if (mode.kind === 'confirm') {
    const title = taskRows({ ...state, filter: '' }, now).find(r => r.taskId === mode.taskId)?.title ?? 'the task';
    if (key.name === 'char' && (key.ch === 'y' || key.ch === 'Y')) {
      return {
        state: { ...state, mode: backTo(mode), status: { text: `Stopping "${title}"…`, tone: 'info' } },
        effects: [{ type: 'action', action: 'stop', workerId: mode.workerId, taskId: mode.taskId, title }],
      };
    }
    return { state: { ...state, mode: backTo(mode), status: { text: `Kept "${title}" running.`, tone: 'info' } }, effects: [] };
  }

  if (mode.kind === 'help') {
    if (key.name === 'char' && key.ch === 'q') return { state, effects: [{ type: 'quit' }] };
    if (key.name === 'char' && key.ch === 'o') return { state: info(state, 'Opening this runner on buildd…'), effects: [{ type: 'openRunner' }] };
    return { state: { ...state, mode: { kind: 'list' }, status: null }, effects: [] };
  }

  // list and detail
  if (key.name === 'char' && key.ch === 'q') return { state, effects: [{ type: 'quit' }] };
  if (key.name === 'char' && key.ch === '?') return { state: { ...state, mode: { kind: 'help' }, status: null }, effects: [] };
  if (key.name === 'escape') {
    if (mode.kind === 'detail') return { state: { ...state, mode: { kind: 'list' }, status: null }, effects: [] };
    if (state.filter) return { state: { ...state, filter: '', rowCursor: 0, status: null }, effects: [] };
    return { state: { ...state, status: null }, effects: [] };
  }
  if (key.name === 'char' && 'ampxco'.includes(key.ch)) return actOnRow({ ...state, status: null }, key.ch, now);

  if (mode.kind === 'detail') return { state, effects: [] };

  // list only
  const cleared = { ...state, status: null };
  switch (key.name) {
    case 'up':
      return { state: state.focus === 'missions' ? moveMission(cleared, -1) : moveRow(cleared, -1, now), effects: [] };
    case 'down':
      return { state: state.focus === 'missions' ? moveMission(cleared, 1) : moveRow(cleared, 1, now), effects: [] };
    case 'left':
      return { state: { ...cleared, focus: 'missions' }, effects: [] };
    case 'right':
      return { state: { ...cleared, focus: 'tasks' }, effects: [] };
    case 'tab':
      return { state: { ...cleared, focus: state.focus === 'missions' ? 'tasks' : 'missions' }, effects: [] };
    case 'enter': {
      if (state.focus === 'missions') return { state: { ...cleared, focus: 'tasks', rowCursor: 0 }, effects: [] };
      const row = selectedRow(state, now);
      if (!row) return { state, effects: [] };
      return { state: { ...cleared, mode: { kind: 'detail', taskId: row.taskId } }, effects: [] };
    }
    case 'char':
      if (key.ch === 'k') return { state: state.focus === 'missions' ? moveMission(cleared, -1) : moveRow(cleared, -1, now), effects: [] };
      if (key.ch === 'j') return { state: state.focus === 'missions' ? moveMission(cleared, 1) : moveRow(cleared, 1, now), effects: [] };
      if (key.ch === 'w') return { state: switchWorkspace(cleared), effects: [] };
      if (key.ch === '/') return { state: { ...cleared, mode: { kind: 'input', purpose: 'filter', text: state.filter } }, effects: [] };
      return { state, effects: [] };
  }
  return { state, effects: [] };
}

/** `w` (R-19): the next workspace, then all of them again. */
function switchWorkspace(state: TopState): TopState {
  const list = workspaceList(state);
  if (list.length < 2) return info(state, 'This runner serves one workspace, so there is nothing to switch to.');
  const next = cycleWorkspace(state);
  const ws = currentWorkspace(next);
  // With several teams, say whose workspace this is (R-7).
  const team = ws && teamCount(next) > 1 && ws.teamName ? ` (${ws.teamName})` : '';
  return info(next, ws ? `Showing ${ws.name}${team}. w for the next workspace.` : `Showing all ${list.length} workspaces.`);
}

const fromOf = (state: TopState): 'detail' | undefined => (state.mode.kind === 'detail' ? 'detail' : undefined);

/** After a prompt, go back to the detail view if that is where it was opened. */
function backTo(mode: TopState['mode']): TopState['mode'] {
  if ((mode.kind === 'input' || mode.kind === 'confirm') && mode.from === 'detail' && mode.taskId) return { kind: 'detail', taskId: mode.taskId };
  return { kind: 'list' };
}

/**
 * The status line for a finished action. A refusal shows the server's own
 * reason (the socket relays its status and body unchanged).
 */
export function actionResultText(effect: Effect, result: { status: number; body: unknown }): { text: string; tone: 'ok' | 'error' } {
  const ok = result.status >= 200 && result.status < 300;
  const title = 'title' in effect ? effect.title : '';
  const done: Record<string, string> = {
    answer: `Answer sent to "${title}". The agent picks it up from here.`,
    message: `Message sent to "${title}".`,
    pause: `"${title}" will pause at its next safe point.`,
    stop: `Stop sent to "${title}".`,
    claim: `Claimed "${title}" onto this runner.`,
  };
  const verb: Record<string, string> = { answer: 'Answer', message: 'Message', pause: 'Pause', stop: 'Stop', claim: 'Claim' };
  const kind = effect.type === 'action' ? effect.action : effect.type;
  if (ok) return { text: done[kind] ?? 'Done.', tone: 'ok' };
  return { text: `${verb[kind] ?? 'Action'} refused: ${refusalReason(result)}`, tone: 'error' };
}

export function refusalReason(result: { status: number; body: unknown }): string {
  const b = result.body as any;
  const reason = typeof b === 'string' ? b : b?.error ?? b?.message ?? b?.reason;
  if (typeof reason === 'string' && reason.trim()) return `${reason.trim()} (HTTP ${result.status})`;
  return `HTTP ${result.status}`;
}
