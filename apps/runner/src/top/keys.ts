/**
 * `buildd top` keys: raw terminal input -> key names -> state changes plus the
 * effects run.ts carries out (a socket action, opening a URL, quitting).
 * Pure, so every key is unit-tested (top-keys.test.ts).
 */
import { TERMS } from '@buildd/shared';
import {
  isLooseKey, busySlots, currentMission, isFoldKey, currentTeam, foldKey, heldNow, holdRunningWords, currentWorkspace, cycleTeam, cycleWorkspace, missionList, scopedWorkspaces, selectedRow, taskRows, teamCount, teamList, workspaceList,
  type TaskRow, type TopState,
} from './state';
import { queueRowList, selectedQueueRow } from './queue';
import { claimRefusalWords } from './claim-refusal';

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
  /** `s`: an interactive `claude` session about this mission or task, on this machine (talk.ts). */
  | { type: 'talk'; kind: 'mission' | 'task'; id: string; title: string }
  /** `o` on a mission with no task picked: its page on buildd. */
  | { type: 'openMission'; missionId: string }
  /** The runner's page on buildd.dev, where its workspaces are set (R-20). */
  | { type: 'openRunner' }
  /** `h`: hold this runner (`on`) or resume it (R-33). */
  | { type: 'hold'; on: boolean }
  /**
   * `+` / `-`: set the runner's slots (R-43). `extras: 'pause'` is `p` right
   * after a lower: pause the most recently started extras (R-45).
   */
  | { type: 'slots'; slots: number; extras?: 'pause' }
  /** Read the queue now: the Queue view just opened (R-26). */
  | { type: 'refreshQueue' }
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

function moveMission(state: TopState, delta: number, now: number): TopState {
  const rows = missionList(state, now);
  const cur = rows.findIndex(r => r.key === currentMission(state, now).key);
  const idx = Math.max(0, Math.min(rows.length - 1, cur + delta));
  return { ...state, missionCursor: idx, selectedMission: rows[idx].key, rowCursor: 0 };
}

/**
 * Enter in the missions pane (R-24): on a fold row, open or close it; on a
 * delivered mission listed under an open fold, close that fold and go back to
 * its row. Null: not a fold matter.
 */
function toggleFold(state: TopState, now: number): TopState | null {
  if (state.filter) return null;
  const cur = currentMission(state, now);
  if (cur.fold) {
    const unfolded = cur.fold.open ? state.unfolded.filter(k => k !== cur.key) : [...state.unfolded, cur.key];
    return { ...state, unfolded, selectedMission: cur.key, rowCursor: 0 };
  }
  if (cur.deliveredAt !== undefined) return foldAll(state, now);
  return null;
}

/** Esc (R-24): close every open fold; a selected delivered mission hands the cursor to its fold row. */
function foldAll(state: TopState, now: number): TopState {
  const cur = currentMission(state, now);
  const selectedMission = cur.deliveredAt !== undefined ? foldKey(cur.team) : state.selectedMission;
  return { ...state, unfolded: [], selectedMission, rowCursor: 0 };
}

function moveRow(state: TopState, delta: number, now: number): TopState {
  const n = taskRows(state, now).length;
  if (n === 0) return state;
  const cur = Math.min(state.rowCursor, n - 1);
  return { ...state, rowCursor: Math.max(0, Math.min(n - 1, cur + delta)) };
}

/** `c` on a task of a mission managed from a local session: no runner takes it, and where that changes. */
export const LOCAL_CLAIM_WORDS = 'Its mission is managed from a local session, so no runner takes it. o opens it on buildd, where the mission can go to runners.';

/** The mission a key opens when no task is picked; null for loose tasks and the fold row. */
function openableMission(state: TopState, now: number): string | null {
  const m = currentMission(state, now);
  return isLooseKey(m.key) || m.fold ? null : m.key;
}

function actOnRow(state: TopState, ch: string, now: number): KeyResult {
  const row = targetRow(state, now);
  const none = { state: refuse(state, 'Pick a task first (→ moves to the task list).'), effects: [] };
  if (!row) {
    // `o` with no task picked opens the mission itself.
    const missionId = ch === 'o' ? openableMission(state, now) : null;
    if (missionId) return { state: info(state, `Opening "${currentMission(state, now).title}" on buildd…`), effects: [{ type: 'openMission', missionId }] };
    return none;
  }
  if (row.elsewhere && 'ampx'.includes(ch)) {
    const where = row.elsewhere === 'local' ? 'in a local session' : 'on another runner';
    return { state: refuse(state, `"${row.title}" runs ${where}; top acts only on this runner's agents. o opens it on buildd.`), effects: [] };
  }

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
      if (row.elsewhere === 'local') return { state: refuse(state, LOCAL_CLAIM_WORDS), effects: [] };
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
  // Right after `-` left more running than slots, `p` pauses the newest extras
  // (R-45); any other key drops the offer and is handled as usual.
  if (state.slotOffer) {
    const offer = state.slotOffer;
    state = { ...state, slotOffer: null };
    if (key.name === 'char' && key.ch === 'p' && state.mode.kind === 'list') {
      return {
        state: info(state, `Pausing the ${offer.extras === 1 ? 'newest agent' : `${offer.extras} newest agents`}…`),
        effects: [{ type: 'slots', slots: offer.slots, extras: 'pause' }],
      };
    }
  }
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
    const anyOpen = state.unfolded.length > 0 || currentMission(state, now).deliveredAt !== undefined;
    if (mode.kind === 'list' && state.view === 'missions' && anyOpen) {
      return { state: { ...foldAll(state, now), status: null }, effects: [] };
    }
    return { state: { ...state, status: null }, effects: [] };
  }
  // `+` / `-` (R-43): one more or one fewer slot, from any list or detail view.
  if (key.name === 'char' && (key.ch === '+' || key.ch === '=' || key.ch === '-')) return slotKey(state, key.ch === '-' ? -1 : 1);
  // `h` (R-33): hold or resume, no confirmation, from any list or detail view.
  if (key.name === 'char' && key.ch === 'h') {
    const on = !heldNow(state, now);
    return {
      state: info(state, on ? 'Holding: nothing new starts, running agents finish…' : 'Resuming: looking for work now…'),
      effects: [{ type: 'hold', on }],
    };
  }
  if (mode.kind === 'list' && state.view === 'queue') {
    const q = queueKey({ ...state, status: null }, key, now);
    if (q) return q;
  }
  if (key.name === 'char' && key.ch === 's') return talkKey({ ...state, status: null }, now);
  if (key.name === 'char' && 'ampxco'.includes(key.ch)) return actOnRow({ ...state, status: null }, key.ch, now);

  if (mode.kind === 'detail') return { state, effects: [] };

  // list only
  const cleared = { ...state, status: null };
  switch (key.name) {
    case 'up':
      return { state: state.focus === 'missions' ? moveMission(cleared, -1, now) : moveRow(cleared, -1, now), effects: [] };
    case 'down':
      return { state: state.focus === 'missions' ? moveMission(cleared, 1, now) : moveRow(cleared, 1, now), effects: [] };
    case 'left':
      return { state: { ...cleared, focus: 'missions' }, effects: [] };
    case 'right':
      return { state: { ...cleared, focus: 'tasks' }, effects: [] };
    case 'tab':
      // R-26: Tab switches Missions <-> Queue; ← → still move between the panes.
      return { state: { ...cleared, view: 'queue', queueCursor: 0 }, effects: [{ type: 'refreshQueue' }] };
    case 'enter': {
      if (state.focus === 'missions') {
        const folded = toggleFold(cleared, now);
        if (folded) return { state: folded, effects: [] };
        return { state: { ...cleared, focus: 'tasks', rowCursor: 0 }, effects: [] };
      }
      const row = selectedRow(state, now);
      if (!row) return { state, effects: [] };
      return { state: { ...cleared, mode: { kind: 'detail', taskId: row.taskId } }, effects: [] };
    }
    case 'char':
      if (key.ch === 'k') return { state: state.focus === 'missions' ? moveMission(cleared, -1, now) : moveRow(cleared, -1, now), effects: [] };
      if (key.ch === 'j') return { state: state.focus === 'missions' ? moveMission(cleared, 1, now) : moveRow(cleared, 1, now), effects: [] };
      if (key.ch === 'w') return { state: switchWorkspace(cleared), effects: [] };
      if (key.ch === 't') return { state: switchTeam(cleared), effects: [] };
      if (key.ch === '/') return { state: { ...cleared, mode: { kind: 'input', purpose: 'filter', text: state.filter } }, effects: [] };
      return { state, effects: [] };
  }
  return { state, effects: [] };
}

/** `w` (R-19): the next workspace of the team in view, then all of them again. */
function switchWorkspace(state: TopState): TopState {
  const list = scopedWorkspaces(state);
  const team = currentTeam(state);
  if (list.length < 2) {
    return info(state, team ? `${team.name} has one workspace here, so there is nothing to switch to.` : 'This runner serves one workspace, so there is nothing to switch to.');
  }
  const next = cycleWorkspace(state);
  const ws = currentWorkspace(next);
  // With several teams, say whose workspace this is (R-7).
  const owner = ws && teamCount(next) > 1 && ws.teamName ? ` (${ws.teamName})` : '';
  if (ws) return info(next, `Showing ${ws.name}${owner}. w for the next workspace.`);
  return info(next, team ? `Showing all ${list.length} workspaces of ${team.name}.` : `Showing all ${list.length} workspaces.`);
}

/** `t` (R-23): the next team, then all of them again. */
function switchTeam(state: TopState): TopState {
  const teams = teamList(state);
  if (teams.length < 2) return info(state, 'This runner serves one team, so there is nothing to switch to.');
  const next = cycleTeam(state);
  const team = currentTeam(next);
  if (team) return info(next, `Showing ${team.name}. t for the next team.`);
  return info(next, `Showing all ${workspaceList(next).length} workspaces in ${teams.length} teams.`);
}

/**
 * Keys the Queue view handles itself (R-26): ↑↓ over its rows, `c` claims the
 * selected row through the same claim path as the Missions view, `o` opens it,
 * Tab goes back to Missions. Null: the key is handled as in the Missions view
 * (t, w, /, ?, q, esc).
 */
function queueKey(state: TopState, key: Key, now: number): KeyResult | null {
  const n = queueRowList(state, now).length;
  const move = (d: number) => ({ state: n === 0 ? state : { ...state, queueCursor: Math.max(0, Math.min(n - 1, Math.min(state.queueCursor, n - 1) + d)) }, effects: [] });
  if (key.name === 'tab') return { state: { ...state, view: 'missions' }, effects: [] };
  if (key.name === 'up' || (key.name === 'char' && key.ch === 'k')) return move(-1);
  if (key.name === 'down' || (key.name === 'char' && key.ch === 'j')) return move(1);
  if (key.name === 'left' || key.name === 'right' || key.name === 'enter') return { state, effects: [] };
  if (key.name !== 'char') return null;
  if (key.ch === 'c' || key.ch === 'o') {
    const row = selectedQueueRow(state, now);
    if (!row) return { state: refuse(state, 'Nothing in the queue to pick.'), effects: [] };
    if (key.ch === 'o') return { state: info(state, `Opening "${row.title}" on buildd…`), effects: [{ type: 'open', taskId: row.taskId }] };
    if (row.position === null && !row.held) {
      return { state: refuse(state, row.exclusion === 'local_session' ? LOCAL_CLAIM_WORDS : `Not for this runner: ${row.reason}.`), effects: [] };
    }
    return { state: info(state, `Claiming "${row.title}" onto this runner…`), effects: [{ type: 'claim', taskId: row.taskId, title: row.title }] };
  }
  if ('ampx'.includes(key.ch)) return { state: info(state, 'Tab back to Missions to act on running work.'), effects: [] };
  return null;
}

/**
 * `s`: talk to the selected mission's planner, or steer the selected task's
 * agent. In the missions pane the mission is the target; in the task list (or
 * a task's detail) the task is.
 */
function talkKey(state: TopState, now: number): KeyResult {
  if (state.view === 'queue' || state.mode.kind !== 'list' && state.mode.kind !== 'detail') {
    return { state: refuse(state, 'Tab back to Missions to talk to one.'), effects: [] };
  }
  if (state.mode.kind === 'list' && state.focus === 'missions') {
    const m = currentMission(state, now);
    if (isLooseKey(m.key) || isFoldKey(m.key)) return { state: refuse(state, 'Pick a mission to talk to (↑↓), or → for a task.'), effects: [] };
    return { state: info(state, `Opening Claude on "${m.title}"…`), effects: [{ type: 'talk', kind: 'mission', id: m.key, title: m.title }] };
  }
  const row = targetRow(state, now);
  if (!row) return { state: refuse(state, 'Pick a task first (→ moves to the task list).'), effects: [] };
  return { state: info(state, `Opening Claude on "${row.title}"…`), effects: [{ type: 'talk', kind: 'task', id: row.taskId, title: row.title }] };
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
  if (effect.type === 'hold') {
    if (!ok) return { text: `${effect.on ? 'Hold' : 'Resume'} refused: ${refusalReason(result)}`, tone: 'error' };
    const running = typeof (result.body as any)?.running === 'number' ? (result.body as any).running : 0;
    return effect.on
      ? { text: `${TERMS['runner.paused'].word}: nothing new starts, ${holdRunningWords(running)}. h resumes.`, tone: 'ok' }
      : { text: 'Resumed: looking for work now.', tone: 'ok' };
  }
  if (effect.type === 'slots') {
    if (!ok) return { text: `Slots refused: ${refusalReason(result)}`, tone: 'error' };
    const b = result.body as { line?: unknown; failed?: unknown } | null;
    const failed = Array.isArray(b?.failed) ? (b!.failed as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    if (failed.length > 0) return { text: failed[0], tone: 'error' };
    return { text: typeof b?.line === 'string' ? b.line : `Slots now ${effect.slots}.`, tone: 'ok' };
  }
  if (effect.type === 'talk') return ok ? { text: 'Back from Claude.', tone: 'ok' } : { text: refusalReason(result), tone: 'error' };
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
  if (kind === 'claim') return { text: `Not claimed: ${claimRefusalWords(result.body, result.status)}.`, tone: 'error' };
  return { text: `${verb[kind] ?? 'Action'} refused: ${refusalReason(result)}`, tone: 'error' };
}

export function refusalReason(result: { status: number; body: unknown }): string {
  const b = result.body as any;
  const reason = typeof b === 'string' ? b : b?.error ?? b?.message ?? b?.reason;
  if (typeof reason === 'string' && reason.trim()) return `${reason.trim()} (HTTP ${result.status})`;
  return `HTTP ${result.status}`;
}

/** Slots a person may set from top (runner-slots.ts bounds). */
const MIN_TOP_SLOTS = 1;
const MAX_TOP_SLOTS = 50;

/**
 * `+` / `-`: raise or lower the slots by one (R-43..R-45). Lowering below the
 * running count lets the extras finish and offers `p` to pause the newest
 * instead, in the status line.
 */
function slotKey(state: TopState, delta: 1 | -1): KeyResult {
  const cur = state.runner.maxConcurrent;
  const slots = cur + delta;
  if (slots < MIN_TOP_SLOTS) return { state: refuse(state, `${cur} slot is the fewest: buildd hold stops new work instead.`), effects: [] };
  if (slots > MAX_TOP_SLOTS) return { state: refuse(state, `${MAX_TOP_SLOTS} slots is the most.`), effects: [] };
  const running = busySlots(state);
  const extras = running - slots;
  // Shown at once; the runner's answer replaces it.
  const next: TopState = { ...state, runner: { ...state.runner, maxConcurrent: slots }, slotOffer: extras > 0 ? { slots, extras } : null };
  const text = extras > 0
    ? `${running} running, slots now ${slots}: they finish, nothing new starts until ${slots - 1 === 0 ? 'none run' : `${slots - 1} run`}. p pauses the ${extras === 1 ? 'newest' : `${extras} newest`} instead.`
    : `Slots now ${slots}: ${running} running, ${slots - running} free${delta > 0 ? ', looking for work for them now' : ''}.`;
  return { state: info(next, text), effects: [{ type: 'slots', slots }] };
}
