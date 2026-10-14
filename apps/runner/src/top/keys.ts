/**
 * `buildd top` keys: raw terminal input -> key names -> state changes plus the
 * effects run.ts carries out (a socket action, opening a URL, quitting).
 * Pure, so every key is unit-tested (top-keys.test.ts).
 */
import {
  currentMission, currentWorkspace, cycleWorkspace, missionRows, selectedRow, taskRows, workspaceList,
  type TaskRow, type TopState,
} from './state';

export type Key =
  | { name: 'up' | 'down' | 'left' | 'right' | 'enter' | 'escape' | 'backspace' | 'tab' | 'ctrl-c' }
  | { name: 'char'; ch: string };

/** Split one chunk of raw stdin into keys. */
export function parseKeys(chunk: string): Key[] {
  const keys: Key[] = [];
  for (let i = 0; i < chunk.length; i++) {
    const c = chunk[i];
    if (c === '\x1b') {
      const next = chunk[i + 1];
      // An OSC string (a late answer to the OSC 11 background query): swallow
      // it up to BEL or ST so none of its bytes are read as keys.
      if (next === ']') {
        let j = i + 2;
        while (j < chunk.length && chunk[j] !== '\x07' && !(chunk[j] === '\x1b' && chunk[j + 1] === '\\')) j++;
        i = chunk[j] === '\x1b' ? j + 1 : j;
        continue;
      }
      if ((next === '[' || next === 'O') && i + 2 < chunk.length) {
        const code = chunk[i + 2];
        const map: Record<string, Key['name']> = { A: 'up', B: 'down', C: 'right', D: 'left' };
        if (map[code]) { keys.push({ name: map[code] } as Key); i += 2; continue; }
        // Unknown CSI sequence (e.g. F-keys, \x1b[3~): skip to its final byte.
        let j = i + 2;
        while (j < chunk.length && !/[A-Za-z~]/.test(chunk[j])) j++;
        i = j;
        continue;
      }
      keys.push({ name: 'escape' });
      continue;
    }
    if (c === '\r' || c === '\n') { keys.push({ name: 'enter' }); continue; }
    if (c === '\x03') { keys.push({ name: 'ctrl-c' }); continue; }
    if (c === '\x7f' || c === '\b') { keys.push({ name: 'backspace' }); continue; }
    if (c === '\t') { keys.push({ name: 'tab' }); continue; }
    if (c < ' ') continue;
    // Keep surrogate pairs together.
    const cp = chunk.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    if (ch.length > 1) i += ch.length - 1;
    keys.push({ name: 'char', ch });
  }
  return keys;
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
  return info(next, ws ? `Showing ${ws.name}. w for the next workspace.` : `Showing all ${list.length} workspaces.`);
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
