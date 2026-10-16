/**
 * `buildd top` frame renderer: state in, lines out. Pure, so the frame at
 * 80x24 and 120x40 is snapshot-tested (top-render.test.ts).
 *
 * Every line is exactly `cols` wide. Rows never wrap: at narrow widths the
 * cost column goes first, then the role column, and text is cut with "…".
 */
import type { Palette, PaletteToken } from '../terminal-palette';
import { progressPieces } from './progress';
import { queueSections, selectedQueueRow, type QueueRow, type QueueSection } from './queue';
import {
  busySlots, currentMission, currentWorkspace, deliveredDay, describeToolCall, filterLine, formatDuration, missionMeta, missionRows, missionStageLine, missionStageWord, planOf,
  providerHoldLine, providerHolds, selectedRow,
  NO_MISSION, taskRows, workerForTask, workspaceSummary, type MissionRow, type RowKind, type TaskRow, type TopState,
} from './state';

export interface FrameOptions {
  cols: number;
  rows: number;
  now: number;
  palette: Palette;
}

// ── width helpers ───────────────────────────────────────────────────────────

const segmenter = new Intl.Segmenter();

function charWidth(ch: string): number {
  return typeof Bun !== 'undefined' ? Bun.stringWidth(ch) : ch.length;
}

export function textWidth(s: string): number {
  let w = 0;
  for (const { segment } of segmenter.segment(s)) w += charWidth(segment);
  return w;
}

/** Cut to `width` columns (with "…" when cut) and pad with spaces to exactly `width`. */
export function fit(s: string, width: number, align: 'left' | 'right' = 'left'): string {
  if (width <= 0) return '';
  const clean = s.replace(/[\r\n\t]+/g, ' ');
  let out = '';
  let w = 0;
  const total = textWidth(clean);
  if (total <= width) {
    const pad = ' '.repeat(width - total);
    return align === 'right' ? pad + clean : clean + pad;
  }
  for (const { segment } of segmenter.segment(clean)) {
    const cw = charWidth(segment);
    if (w + cw > width - 1) break;
    out += segment;
    w += cw;
  }
  return out + '…' + ' '.repeat(Math.max(0, width - w - 1));
}

// ── glyphs ──────────────────────────────────────────────────────────────────

const GLYPH: Record<RowKind, { ch: string; token: PaletteToken }> = {
  running: { ch: '●', token: 'accent' },
  asking: { ch: '?', token: 'warning' },
  paused: { ch: '?', token: 'warning' },
  waiting: { ch: '○', token: 'queue' },
  review: { ch: '◐', token: 'info' },
  done: { ch: '✓', token: 'success' },
  failed: { ch: '✗', token: 'error' },
  cancelled: { ch: '✗', token: 'faint' },
};

// ── columns ─────────────────────────────────────────────────────────────────

const ROLE_W = 10;
const ELAPSED_W = 6;
const COST_W = 9;

/** Which optional columns fit in a pane `width` wide. */
export function columnsFor(width: number): { role: boolean; cost: boolean } {
  return { cost: width >= 76, role: width >= 52 };
}

function formatTokens(n: number | undefined): string {
  if (n === undefined) return '';
  if (n < 1000) return `${n} tok`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k tok`;
  return `${(n / 1_000_000).toFixed(1)}M tok`;
}

function renderRow(row: TaskRow, width: number, selected: boolean, p: Palette): string {
  const cols = columnsFor(width);
  const g = GLYPH[row.kind];
  // " ● " prefix = 3
  let rest = width - 3;
  const roleW = cols.role ? ROLE_W : 0;
  const elapsedW = ELAPSED_W;
  const costW = cols.cost ? COST_W : 0;
  rest -= roleW + elapsedW + costW;
  const titleW = Math.max(8, Math.min(28, Math.floor(rest * 0.45)));
  const tailW = Math.max(0, rest - titleW);

  // Title, role and status are separate columns (R-21): a cut title ends in
  // "…" and one space always follows it.
  const title = fit(row.title, titleW - 1) + ' ';
  const role = cols.role ? fit(row.role ?? '', ROLE_W - 1) + ' ' : '';
  const elapsed = row.elapsedMs !== undefined ? fit(formatDuration(row.elapsedMs), elapsedW - 1, 'right') + ' ' : ' '.repeat(elapsedW);

  let tail: string;
  let tailToken: PaletteToken = 'muted';
  if (row.kind === 'asking') {
    tail = fit(`asks: "${row.question ?? ''}"`, tailW);
    tailToken = 'text';
  } else if (row.kind === 'running') {
    tail = fit(row.action ?? '', tailW);
    tailToken = 'text';
  } else {
    tail = fit(row.reason ?? '', tailW);
  }
  const cost = cols.cost ? fit(row.group === 'running' ? formatTokens(row.tokens) : '', COST_W, 'right') : '';

  // The › marks the selection even with no colour at all (NO_COLOR). Primary
  // text is the terminal's own foreground (R-17); only the selected row, which
  // paints its own background, pairs it with the theme's text colour.
  const primary: PaletteToken = selected ? 'selectedText' : 'text';
  if (tailToken === 'text') tailToken = primary;
  const line =
    (selected ? p.fg('accent', '›') : ' ') + p.fg(g.token, g.ch) + ' ' +
    p.fg(primary, title) +
    p.fg('muted', role) +
    p.fg('muted', elapsed) +
    p.fg(tailToken, tail) +
    p.fg('muted', cost);
  return selected ? p.selectedBg(line) : line;
}

// ── frame ───────────────────────────────────────────────────────────────────

function header(state: TopState, cols: number, p: Palette): string {
  const host = state.runner.hostname;
  // R-19: which workspaces this runner serves, e.g. "5 workspaces · Acme".
  const served = workspaceSummary(state);
  const busy = busySlots(state);
  const online = state.runner.online ? '● online' : '○ reconnecting';
  const version = state.runner.version ? ` · v${state.runner.version}` : '';
  // Widest first; drop the version, then shorten the slots, then the hostname.
  const variants: Array<{ host: boolean; slots: string; version: string }> = [
    { host: true, slots: `${busy} of ${state.runner.maxConcurrent} slots busy`, version },
    { host: true, slots: `${busy} of ${state.runner.maxConcurrent} slots busy`, version: '' },
    { host: true, slots: `${busy}/${state.runner.maxConcurrent} busy`, version: '' },
    { host: false, slots: `${busy}/${state.runner.maxConcurrent} busy`, version: '' },
  ];
  for (const v of variants) {
    const leftParts = [v.host ? host : null, served || null].filter(Boolean).join(' · ');
    const left = ` buildd${leftParts ? ' · ' + leftParts : ''}`;
    const right = `${v.slots} · ${online}${v.version} `;
    const gap = cols - textWidth(left) - textWidth(right);
    if (gap < 1) continue;
    return (
      ' ' + p.fg('accent', 'buildd') + p.fg('muted', leftParts ? ` · ${leftParts}` : '') +
      ' '.repeat(gap) +
      p.fg('muted', `${v.slots} · `) +
      p.fg(state.runner.online ? 'accent' : 'muted', online) +
      p.fg('muted', `${v.version} `)
    );
  }
  return fit(` buildd · ${host}`, cols);
}

function rule(cols: number, p: Palette): string {
  return p.fg('faint', '─'.repeat(cols));
}

const HINTS_LIST = ['↑↓ move', '⏎ open', 'a answer', 'm message', 'p pause', 'x stop', 'c claim', 'o web', 'tab queue', 't team', 'w workspace', '/ filter', '? help', 'q quit'];
const HINTS_QUEUE = ['↑↓ move', 'c claim', 'o web', 'tab missions', 't team', 'w workspace', '/ filter', '? help', 'q quit'];
const HINTS_HELP = ['o open this runner on buildd', 'any key back', 'q quit'];
const HINTS_DETAIL = ['esc back', 'a answer', 'm message', 'p pause', 'x stop', 'c claim', 'o web', 'q quit'];

/** Dropped first when the footer is too narrow; `? help`, `t`, `w` and `q quit` always stay. */
const HINT_DROP_ORDER = ['/ filter', 'o web', '⏎ open', '↑↓ move', 'tab queue', 'm message', 'c claim', 'p pause', 'x stop', 'a answer', 'esc back'];

function fitHints(hints: string[], cols: number): string {
  for (const sep of ['  ', ' ']) {
    const s = ' ' + hints.join(sep);
    if (textWidth(s) <= cols) return s;
  }
  const list = [...hints];
  for (const drop of HINT_DROP_ORDER) {
    if (textWidth(' ' + list.join(' ')) <= cols) break;
    const i = list.indexOf(drop);
    if (i >= 0) list.splice(i, 1);
  }
  // Still too wide: drop from the middle until it fits; `q quit` always stays.
  while (list.length > 2 && textWidth(' ' + list.join(' ')) > cols) list.splice(list.length - 2, 1);
  return ' ' + list.join(' ');
}

function footer(state: TopState, cols: number, p: Palette): string {
  const m = state.mode;
  if (m.kind === 'input') {
    const label = m.purpose === 'filter' ? 'filter' : m.purpose === 'answer' ? 'answer' : 'message';
    const prefix = ` ${label} › `;
    const room = cols - textWidth(prefix) - 1;
    // Show the end of a long input, where the cursor is.
    let text = m.text;
    while (textWidth(text) > room && text.length > 0) text = text.slice(1);
    return p.fg('accent', prefix) + p.fg('text', text) + p.fg('accent', '▏') + ' '.repeat(Math.max(0, cols - textWidth(prefix) - textWidth(text) - 1));
  }
  if (m.kind === 'confirm') {
    const t = state.tasks.find(x => x.id === m.taskId)?.title ?? workerForTask(state, m.taskId)?.taskTitle ?? 'this task';
    return p.fg('accent', fit(` Stop the agent on "${t}"? y stops it, any other key keeps it running`, cols));
  }
  if (state.status) {
    const token: PaletteToken = state.status.tone === 'error' ? 'error' : state.status.tone === 'ok' ? 'success' : 'muted';
    return p.fg(token, fit(' ' + state.status.text, cols));
  }
  const hints = m.kind === 'detail' ? HINTS_DETAIL : m.kind === 'help' ? HINTS_HELP : state.view === 'queue' ? HINTS_QUEUE : HINTS_LIST;
  return p.fg('muted', fit(fitHints(hints, cols), cols));
}

/** The fewest title columns a mission row keeps before it drops its stage word: two letters and "…". */
const MIN_MISSION_TITLE = 3;

function leftWidth(cols: number): number {
  return cols >= 110 ? 28 : cols >= 90 ? 24 : 22;
}

/**
 * The missions pane (R-24): a heading row per team, then that team's open
 * missions (building and verifying first, then on hold), then the ones
 * delivered in the last 7 days, dimmed. A second, dimmed line carries "local
 * session" or "delivered Oct 14"; when the pane is too short those lines go
 * first (except the selected mission's), then the pane scrolls to keep the
 * selected mission in view.
 */
function leftPane(missions: MissionRow[], current: MissionRow, focused: boolean, lw: number, height: number, p: Palette): string[] {
  const hasTeams = missions.some(m => m.team !== null);
  const build = (withMeta: boolean) => {
    const lines: string[] = [];
    let selected = 0;
    missions.forEach((m, i) => {
      if (hasTeams && (i === 0 || m.team !== missions[i - 1].team)) {
        lines.push(m.team === null ? ' '.repeat(lw) : p.fg('muted', fit(' ' + m.team, lw)));
      }
      const isCurrent = m.key === current.key;
      const delivered = m.deliveredAt !== undefined;
      // Done over total always (R-31), with the stage word beside it (R-18).
      // The title gives way first; only when it would vanish does the stage
      // word go, and the heading still says it.
      const tally = m.key === NO_MISSION || m.total > 0 ? `${m.done}/${m.total}` : '';
      const stage = missionStageWord(m);
      const fullCount = [stage, tally].filter(Boolean).join(' ') || (m.held ? 'on hold' : '');
      const count = delivered ? '' : lw - 3 - (fullCount.length + 2) >= MIN_MISSION_TITLE || !tally ? fullCount : tally;
      const marker = isCurrent ? '▸' : ' ';
      const titleW = lw - 3 - (count ? count.length + 2 : 1);
      const title = p.fg(delivered ? 'muted' : 'text', fit(m.title, titleW));
      const line = ` ${p.fg(isCurrent ? 'accent' : 'faint', marker)} ${title}${count ? ' ' + p.fg(m.running > 0 ? 'accent' : 'muted', count) : ''} `;
      if (isCurrent) selected = lines.length;
      lines.push(isCurrent && focused ? p.selectedBg(line) : line);
      const meta = missionMeta(m);
      if (meta && (withMeta || isCurrent)) lines.push(p.fg('muted', fit('   ' + meta, lw)));
    });
    // Without team headings the pane keeps its MISSIONS label.
    if (!hasTeams) return { lines: [p.fg('muted', fit(' MISSIONS', lw)), ...lines], selected: selected + 1 };
    return { lines, selected };
  };
  let built = build(true);
  if (built.lines.length > height) built = build(false);
  let lines = built.lines;
  if (lines.length > height) {
    const offset = Math.min(Math.max(0, built.selected - height + 1), lines.length - height);
    lines = lines.slice(offset, offset + height);
  }
  return lines;
}

function listBody(state: TopState, cols: number, height: number, now: number, p: Palette): string[] {
  const lw = leftWidth(cols);
  const rw = cols - lw - 1;
  const missions = missionRows(state, now);
  const mission = currentMission(state, now);
  const rows = taskRows(state, now);
  const sel = selectedRow(state, now);

  // Left pane.
  const left = leftPane(missions, mission, state.focus === 'missions', lw, height, p);

  // Right pane.
  const right: string[] = [];
  const nRunning = rows.filter(r => r.group === 'running').length;
  const nWaiting = rows.filter(r => r.group === 'waiting').length;
  // A mission with no rows has nothing to count; its heading gets the room.
  const counts = rows.length === 0 && mission.key !== NO_MISSION ? '' : `${nRunning} running · ${nWaiting} waiting `;
  const filterNote = state.filter ? ` (filter: ${state.filter})` : '';
  const ws = currentWorkspace(state);
  const meta = missionMeta(mission);
  const status = mission.deliveredAt !== undefined && meta ? ` · ${meta}` : missionStageLine(mission) ? ` · ${missionStageLine(mission)}` : mission.planning ? ' · planning' : meta ? ` · ${meta}` : '';
  const heading = (ws ? `${ws.name} · ` : '') + mission.title + status + filterNote;
  const titleW = rw - textWidth(counts) - 1;
  // One space always separates a cut heading from the counts (R-21).
  right.push(' ' + p.fg('text', fit(heading, titleW - 1)) + ' ' + p.fg(nRunning > 0 ? 'accent' : 'muted', counts));
  // R-29: the whole mission as squares, done first, under its heading.
  const progress = mission.key === NO_MISSION ? null : progressRow(mission, rw, p);
  if (progress) right.push(progress);
  right.push(p.fg('faint', '─'.repeat(rw)));

  const groups: Array<{ key: TaskRow['group']; label: string }> = [
    { key: 'running', label: 'RUNNING' },
    { key: 'waiting', label: 'WAITING' },
    { key: 'done', label: 'DONE TODAY' },
  ];
  const lines: Array<{ text: string; rowIndex?: number }> = [];
  for (const g of groups) {
    const inGroup = rows.map((r, i) => ({ r, i })).filter(x => x.r.group === g.key);
    if (inGroup.length === 0) continue;
    lines.push({ text: p.fg('muted', fit(' ' + g.label, rw)) });
    for (const { r, i } of inGroup) {
      lines.push({ text: renderRow(r, rw, state.focus === 'tasks' && sel?.taskId === r.taskId, p), rowIndex: i });
    }
  }
  if (rows.length === 0) {
    const empty = state.filter ? ' Nothing matches the filter.'
      : mission.deliveredAt !== undefined ? ` Delivered ${deliveredDay(mission.deliveredAt)}. Its finished work is not listed here.`
      : mission.local ? ' A person runs this mission from their own session.'
      : ' Nothing here yet. Work this runner takes shows up as it happens.';
    lines.push({ text: p.fg('muted', fit(empty, rw)) });
  }

  // Scroll so the selected row stays in view.
  const room = height - right.length;
  const selLine = lines.findIndex(l => l.rowIndex !== undefined && rows[l.rowIndex].taskId === sel?.taskId);
  let offset = 0;
  if (selLine >= room) offset = selLine - room + 1;
  for (const l of lines.slice(offset, offset + room)) right.push(l.text);

  const out: string[] = [];
  for (let i = 0; i < height; i++) {
    const l = left[i] ?? ' '.repeat(lw);
    const r = right[i] ?? ' '.repeat(rw);
    out.push(l + p.fg('faint', '│') + r);
  }
  return out;
}

/** The selected mission's progress row, exactly `width` wide; null when the server sent no cells. */
function progressRow(mission: MissionRow, width: number, p: Palette): string | null {
  const pieces = progressPieces(mission.stage?.progress, width - 1, textWidth);
  if (!pieces) return null;
  let used = 1;
  let out = ' ';
  for (const piece of pieces) {
    const room = width - used;
    if (room <= 0) break;
    const w = textWidth(piece.text);
    const t = w <= room ? piece.text : fit(piece.text, room);
    out += p.fg(piece.token, t);
    used += Math.min(w, room);
  }
  return out + ' '.repeat(Math.max(0, width - used));
}

function detailBody(state: TopState, taskId: string, cols: number, height: number, now: number, p: Palette): string[] {
  const rows = taskRows(state, now);
  const row = rows.find(r => r.taskId === taskId);
  const task = state.tasks.find(t => t.id === taskId);
  const w = workerForTask(state, taskId);
  const out: string[] = [];
  const push = (s: string) => out.push(s);
  const line = (token: PaletteToken, s: string) => push(p.fg(token, fit(s, cols)));

  const title = row?.title ?? task?.title ?? w?.taskTitle ?? taskId;
  const g = row ? GLYPH[row.kind] : GLYPH.waiting;
  const meta = [
    row?.role,
    row?.elapsedMs !== undefined ? formatDuration(row.elapsedMs) : null,
    task?.mission?.title ?? (task?.missionId ? `mission ${task.missionId.slice(0, 8)}` : '(no mission)'),
  ].filter(Boolean).join(' · ');
  const titleW = Math.max(8, cols - 3 - textWidth(meta) - 3);
  push(' ' + p.fg(g.token, g.ch) + ' ' + p.fg('text', fit(title, titleW)) + p.fg('muted', fit('   ' + meta, Math.max(0, cols - 3 - titleW))));

  if (w?.prUrl) line('info', ` PR ${w.prUrl}`);
  if (row?.kind === 'asking' && row.question) {
    line('warning', ` asks: "${row.question}"`);
    const opts = w?.waitingFor?.options?.map(o => o.label).filter(Boolean) ?? [];
    if (opts.length) line('muted', `   options: ${opts.join(' / ')}`);
  } else if (row?.reason) {
    line('muted', ` ${row.reason}`);
  } else if (row?.action) {
    line('text', ` now: ${row.action}`);
  }
  if (!w) {
    line('muted', ' This runner has not started an agent on it.');
  }

  const plan = planOf(w);
  if (plan.length) {
    push('');
    line('muted', ' PLAN');
    for (const item of plan.slice(0, 6)) {
      const mark = item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '●' : '○';
      const token: PaletteToken = item.status === 'completed' ? 'success' : item.status === 'in_progress' ? 'accent' : 'queue';
      push('  ' + p.fg(token, mark) + ' ' + p.fg('text', fit(item.content, cols - 4)));
    }
    if (plan.length > 6) line('muted', `   and ${plan.length - 6} more`);
  }

  const ms = (w?.milestones ?? []).slice(-5);
  if (ms.length) {
    push('');
    line('muted', ' MILESTONES');
    for (const m of ms) push(p.fg('muted', `  ${clock(m.ts)} `) + p.fg('text', fit(m.label, cols - 9)));
  }

  const calls = w?.toolCalls ?? [];
  if (calls.length) {
    push('');
    line('muted', ` TOOL CALLS (${calls.length})`);
    const room = Math.max(0, height - out.length);
    for (const t of calls.slice(-room)) push(p.fg('muted', `  ${clock(t.timestamp)} `) + p.fg('text', fit(describeToolCall(t), cols - 9)));
  }

  const lines = out.slice(0, height).map(l => fitAnsi(l, cols, p));
  while (lines.length < height) lines.push(' '.repeat(cols));
  return lines;
}

function clock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Pad a line that already carries colour to exactly `cols` visible columns. */
function fitAnsi(line: string, cols: number, _p: Palette): string {
  // eslint-disable-next-line no-control-regex
  const visible = textWidth(line.replace(/\x1b\[[0-9;]*m/g, ''));
  if (visible >= cols) return line;
  return line + ' '.repeat(cols - visible);
}

const HELP_KEYS: Array<[string, string]> = [
  ['↑↓ j k', 'move; ← → switch between missions and tasks'],
  ['⏎', 'open a task: plan, milestones, tool calls'],
  ['a', 'answer the question an agent is asking'],
  ['m', 'send a message to a running agent'],
  ['p', 'pause a running agent'],
  ['x', 'stop a running agent (asks first)'],
  ['c', 'claim a waiting task onto this runner'],
  ['tab', 'switch between Missions and Queue (what this runner takes next)'],
  ['o', 'open the task on buildd'],
  ['t', 'show the next team, then all of them'],
  ['w', 'show the next workspace of that team, then all of them'],
  ['/', 'filter by title; esc clears it'],
  ['q', 'quit (the runner keeps running)'],
];

/** `?` (R-20): the keys, and what this view cannot see. */
function helpBody(state: TopState, cols: number, height: number, p: Palette): string[] {
  const out: string[] = [];
  out.push(p.fg('muted', fit(' KEYS', cols)));
  for (const [k, what] of HELP_KEYS) out.push(p.fg('accent', fit(`  ${k}`, 10)) + p.fg('text', fit(what, cols - 10)));
  out.push(' '.repeat(cols));
  const served = workspaceSummary(state);
  out.push(p.fg('text', fit(` This view shows only the workspaces this runner serves${served ? ` (${served})` : ''}.`, cols)));
  out.push(p.fg('muted', fit(" Work elsewhere is not shown here. o opens this runner's page on buildd.", cols)));
  out.push(p.fg('muted', fit(' To change its workspaces, run buildd login --workspaces (same key).', cols)));
  const lines = out.slice(0, height);
  while (lines.length < height) lines.push(' '.repeat(cols));
  return lines;
}

/** The whole screen as `rows` lines, each `cols` wide. */
export function renderFrame(state: TopState, opts: FrameOptions): string[] {
  const { cols, rows, now, palette: p } = opts;
  // A provider limit that holds all of that provider's work is said once, on
  // its own line under the header, instead of on every row (R-25, AC-11).
  const holdLines = providerHolds(state, now)
    .slice(0, 2)
    .map(h => p.fg('warning', fit(' ' + providerHoldLine(h, now), cols)));
  // The line under the header: Missions | Queue (R-26), then what is shown and the keys that change it (R-23).
  const filterRow = tabLine(state, cols, p);
  const bodyH = Math.max(1, rows - 5 - holdLines.length);
  const body = state.mode.kind === 'detail'
    ? detailBody(state, state.mode.taskId, cols, bodyH, now, p)
    : state.mode.kind === 'help'
      ? helpBody(state, cols, bodyH, p)
      : state.view === 'queue'
        ? queueBody(state, cols, bodyH, now, p)
        : listBody(state, cols, bodyH, now, p);
  return [header(state, cols, p), filterRow, ...holdLines, rule(cols, p), ...body, rule(cols, p), footer(state, cols, p)];
}

// ── Queue view (R-26) ───────────────────────────────────────────────────────

/** ` [ Missions ]  Queue` with the filter line beside it; the filter is cut, never the tabs. */
function tabLine(state: TopState, cols: number, p: Palette): string {
  const missions = state.view === 'missions' ? '[ Missions ]' : 'Missions';
  const queue = state.view === 'queue' ? '[ Queue ]' : 'Queue';
  const tabs = ` ${missions}  ${queue}`;
  const filter = filterLine(state);
  const room = cols - textWidth(tabs) - 3;
  const tail = room > 0 ? '   ' + fit(filter, room) : '';
  const paint = (label: string, active: boolean) => p.fg(active ? 'accent' : 'muted', label);
  const line = ' ' + paint(missions, state.view === 'missions') + '  ' + paint(queue, state.view === 'queue') + p.fg('muted', tail);
  return fitAnsi(line, cols, p);
}

const POS_W = 3;
const QWS_W = 13;
const QEST_W = 6;
/** The narrowest title the queue keeps before it drops a column. */
const QTITLE_MIN = 30;

interface QueueCols { est: boolean; workspace: boolean; mission: number; starts: number; title: number }

/**
 * The queue's columns at `cols`: est. goes first, then workspace, and below 60
 * columns the mission and start columns narrow. Every row is exactly `cols`
 * wide and never wraps.
 */
export function queueColumnsFor(cols: number, estimatesOn: boolean): QueueCols {
  const mission = cols < 60 ? 12 : 17;
  const starts = cols < 60 ? 10 : 13;
  const fixed = 1 + POS_W + mission + starts;
  const est = estimatesOn && cols - fixed - QWS_W - QEST_W >= QTITLE_MIN;
  const workspace = cols - fixed - (est ? QEST_W : 0) - QWS_W >= QTITLE_MIN;
  const title = Math.max(4, cols - fixed - (workspace ? QWS_W : 0) - (est ? QEST_W : 0));
  return { est, workspace, mission, starts, title };
}

function queueHeading(section: QueueSection, cols: number, c: QueueCols, p: Palette): string {
  const text =
    ' ' + fit(`${section.teamName} · next for this runner`, POS_W + c.title) +
    (c.workspace ? fit('workspace', QWS_W) : '') +
    fit('mission', c.mission) +
    (c.est ? fit('est.', QEST_W) : '') +
    fit('starts', c.starts);
  return p.fg('muted', fit(text, cols));
}

function queueRowLine(row: QueueRow, c: QueueCols, selected: boolean, p: Palette): string {
  const pos = row.position !== null ? fit(String(row.position), POS_W - 1, 'right') + ' ' : ' '.repeat(POS_W);
  const primary: PaletteToken = selected ? 'selectedText' : row.position === null ? 'muted' : 'text';
  // Every column is cut with "…" and followed by a space (R-21).
  const col = (s: string, w: number) => fit(s, w - 1) + ' ';
  // A start held to a time stands out; "next" and "after N" do not.
  const timed = (row.position !== null || row.held === true) && row.starts !== 'next' && !row.starts.startsWith('after') && row.starts !== '-';
  const line =
    (selected ? p.fg('accent', '›') : ' ') +
    p.fg('muted', pos) +
    p.fg(primary, col(row.title, c.title)) +
    (c.workspace ? p.fg('muted', col(row.workspace, QWS_W)) : '') +
    p.fg('muted', col(row.mission, c.mission)) +
    (c.est ? p.fg('muted', col(row.est ?? '-', QEST_W)) : '') +
    p.fg(timed ? 'warning' : 'muted', fit(row.starts, c.starts));
  return selected ? p.selectedBg(line) : line;
}

/** The Queue view: per team in view, what this runner takes next, then what it never takes. */
function queueBody(state: TopState, cols: number, height: number, now: number, p: Palette): string[] {
  const sections = queueSections(state, now);
  const sel = selectedQueueRow(state, now);
  const lines: Array<{ text: string; taskId?: string }> = [];
  if (!state.queue) {
    lines.push({ text: p.fg('muted', fit(' Reading the queue…', cols)) });
  } else if (sections.length === 0) {
    lines.push({ text: p.fg('muted', fit(state.filter ? ' Nothing in the queue matches the filter.' : ' Nothing is waiting for this runner.', cols)) });
  }
  for (const section of sections) {
    const c = queueColumnsFor(cols, section.estimatesOn);
    lines.push({ text: queueHeading(section, cols, c, p) });
    for (const r of section.rows) lines.push({ text: queueRowLine(r, c, sel?.taskId === r.taskId, p), taskId: r.taskId });
    if (section.rows.length === 0) lines.push({ text: p.fg('muted', fit('    Nothing this runner takes is waiting.', cols)) });
    if (section.held.length > 0) {
      lines.push({ text: p.fg('muted', fit(' Held, each on its own', cols)) });
      for (const r of section.held) lines.push({ text: queueRowLine(r, c, sel?.taskId === r.taskId, p), taskId: r.taskId });
    }
    if (section.notFor.length > 0) {
      lines.push({ text: p.fg('muted', fit(' Not for this runner', cols)) });
      for (const r of section.notFor) lines.push({ text: queueRowLine(r, c, sel?.taskId === r.taskId, p), taskId: r.taskId });
    }
  }
  if (state.queue?.truncated) lines.push({ text: p.fg('muted', fit(' The queue is longer than this; view the full queue on buildd.', cols)) });
  // Scroll so the selected row stays in view.
  const selLine = lines.findIndex(l => l.taskId !== undefined && l.taskId === sel?.taskId);
  const offset = selLine >= height ? selLine - height + 1 : 0;
  const out = lines.slice(offset, offset + height).map(l => fitAnsi(l.text, cols, p));
  while (out.length < height) out.push(' '.repeat(cols));
  return out;
}
