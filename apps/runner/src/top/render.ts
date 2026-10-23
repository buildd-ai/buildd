/**
 * `buildd top` frame renderer: state in, lines out. Pure, so the frame at
 * 80x24 and 120x40 is snapshot-tested (top-render.test.ts).
 *
 * Every line is exactly `cols` wide. Rows never wrap: at narrow widths the
 * cost column goes first, then the route words, then the role column (R-7,
 * R-41), and text is cut with "…".
 */
import { TERMS, titleWithAttempt, slotsInUse } from '@buildd/shared';
import type { Palette, PaletteToken } from '../terminal-palette';
import { detailDollars, runWords, workerSpend } from '../run-route';
import { progressPieces } from './progress';
import { queueNextLine, queueSections, selectedQueueRow, slotsSummary, type QueueRow, type QueueSection } from './queue';
import {
  busySlots, claimLoopLine, currentMission, currentWorkspace, deliveredDay, deliveredMissions, describeToolCall, emptyMissionWords, filterLine, formatDuration, heldNow, holdLine, missionList, missionRowStage, missionStageWord, missionStatusLine, planOf,
  DELIVERED_DAYS,
  providerHoldLine, providerHolds, routeProblemLines, runsOn, sandboxLines, loginsLine, selectedRow, spendTodayLine,
  isLooseKey, taskRows, workerForTask, workspaceSummary, type MissionRow, type RowKind, type TaskRow, type TopState,
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
/** "Codex · OpenRouter (team)" and a space. */
const ROUTE_W = 26;
/** The action column's floor when the route words take room from it. */
const MIN_TAIL_W = 12;

/**
 * Which optional columns fit in a pane `width` wide. The route words (R-40)
 * only take a column when a running row has one; they go after cost and
 * before role (R-41).
 */
export function columnsFor(width: number, withRoute = false): { role: boolean; cost: boolean; route: boolean } {
  if (!withRoute) return { cost: width >= 76, role: width >= 52, route: false };
  return { cost: width >= 88, route: width >= 72, role: width >= 52 };
}

function formatTokens(n: number | undefined): string {
  if (n === undefined) return '';
  if (n < 1000) return `${n} tok`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k tok`;
  return `${(n / 1_000_000).toFixed(1)}M tok`;
}

function renderRow(row: TaskRow, width: number, selected: boolean, p: Palette, withRoute = false): string {
  const cols = columnsFor(width, withRoute);
  const g = GLYPH[row.kind];
  // " ● " prefix = 3
  let rest = width - 3;
  const roleW = cols.role ? ROLE_W : 0;
  const elapsedW = ELAPSED_W;
  const costW = cols.cost ? COST_W : 0;
  const routeW = cols.route ? ROUTE_W : 0;
  rest -= roleW + routeW + elapsedW + costW;
  // With route words in the row the title keeps its room and the action gives way.
  const titleW = Math.max(8, Math.min(28, cols.route ? rest - MIN_TAIL_W : Math.floor(rest * 0.45)));
  const tailW = Math.max(0, rest - titleW);

  // Title, role and status are separate columns (R-21): a cut title ends in
  // "…" and one space always follows it.
  const title = fit(row.title, titleW - 1) + ' ';
  const role = cols.role ? fit(row.role ?? '', ROLE_W - 1) + ' ' : '';
  const route = cols.route ? fit(row.route ?? '', ROUTE_W - 1) + ' ' : '';
  const elapsed = row.elapsedMs !== undefined ? fit(formatDuration(row.elapsedMs), elapsedW - 1, 'right') + ' ' : ' '.repeat(elapsedW);

  let tail: string;
  let tailToken: PaletteToken = 'muted';
  if (row.kind === 'asking') {
    tail = fit(`asks: "${row.question ?? ''}"`, tailW);
    tailToken = 'text';
  } else if (row.kind === 'running') {
    tail = fit(row.action ?? '', tailW);
    // Work another runner or a local session runs reads quieter than this runner's own.
    tailToken = row.elsewhere ? 'muted' : 'text';
  } else {
    tail = fit(row.reason ?? '', tailW);
  }
  // Dollars on a per-token route (R-41); a plan run, or one with no result yet, shows its tokens.
  const cost = cols.cost ? fit(row.group === 'running' ? row.dollars ?? formatTokens(row.tokens) : '', COST_W, 'right') : '';

  // The › marks the selection even with no colour at all (NO_COLOR). Primary
  // text is the terminal's own foreground (R-17); only the selected row, which
  // paints its own background, pairs it with the theme's text colour.
  const primary: PaletteToken = selected ? 'selectedText' : 'text';
  if (tailToken === 'text') tailToken = primary;
  const line =
    (selected ? p.fg('accent', '›') : ' ') + p.fg(row.elsewhere && row.kind === 'running' ? 'muted' : g.token, g.ch) + ' ' +
    p.fg(primary, title) +
    p.fg('muted', role) +
    (route ? p.fg('muted', route) : '') +
    p.fg('muted', elapsed) +
    p.fg(tailToken, tail) +
    p.fg('muted', cost);
  return selected ? p.selectedBg(line) : line;
}

// ── frame ───────────────────────────────────────────────────────────────────

function header(state: TopState, cols: number, now: number, p: Palette): string {
  const host = state.runner.hostname;
  // R-19: which workspaces this runner serves, e.g. "5 workspaces · Acme".
  const served = workspaceSummary(state);
  const busy = busySlots(state);
  // R-33: a paused runner reads "paused" where "online" would be.
  // Before the first connection it is loading; reconnecting only once one was up and dropped.
  const online = !state.runner.online ? (state.runner.connectedOnce ? '○ reconnecting' : '○ loading') : heldNow(state, now) ? `● ${TERMS['runner.paused'].short}` : '● online';
  const version = state.runner.version ? ` · v${state.runner.version}` : '';
  // Widest first; drop the version, then shorten the slots, then the hostname.
  const variants: Array<{ host: boolean; slots: string; version: string }> = [
    // R-22: where the number came from, e.g. "3 of 12 slots in use (set on buildd.dev by Max, 14:02)".
    ...(state.runner.slotsNote ? [{ host: true, slots: `${slotsInUse(busy, state.runner.maxConcurrent)} (${state.runner.slotsNote})`, version: '' }] : []),
    // R-43: "3 of 6 slots in use" (terms catalog: capacity is never "busy").
    { host: true, slots: slotsInUse(busy, state.runner.maxConcurrent), version },
    { host: true, slots: slotsInUse(busy, state.runner.maxConcurrent), version: '' },
    { host: true, slots: slotsInUse(busy, state.runner.maxConcurrent, 'short'), version: '' },
    { host: false, slots: slotsInUse(busy, state.runner.maxConcurrent, 'short'), version: '' },
  ];
  // `buildd top --dev`: which build this is, never dropped for width.
  const build = state.build ? ` dev ${state.build.sha}${state.build.stale ? ' (stale)' : ''}` : '';
  for (const v of variants) {
    const leftParts = [v.host ? host : null, served || null].filter(Boolean).join(' · ');
    const left = ` buildd${build}${leftParts ? ' · ' + leftParts : ''}`;
    const right = `${v.slots} · ${online}${v.version} `;
    const gap = cols - textWidth(left) - textWidth(right);
    if (gap < 1) continue;
    return (
      ' ' + p.fg('accent', 'buildd') + (build ? p.fg('warning', build) : '') + p.fg('muted', leftParts ? ` · ${leftParts}` : '') +
      ' '.repeat(gap) +
      p.fg('muted', `${v.slots} · `) +
      p.fg(state.runner.online ? 'accent' : 'muted', online) +
      p.fg('muted', `${v.version} `)
    );
  }
  return fit(` buildd${build} · ${host}`, cols);
}

function rule(cols: number, p: Palette): string {
  return p.fg('faint', '─'.repeat(cols));
}

const HINTS_LIST = ['↑↓ move', '⏎ open', 'a answer', 'm message', 'p pause', 'x stop', 'c claim', 's/S talk', 'h hold', '+- slots', 'o web', 'tab queue', 't team', 'w workspace', '/ filter', '? help', 'q quit'];
const HINTS_QUEUE = ['↑↓ move', 'c claim', 'h hold', '+- slots', 'o web', 'tab missions', 't team', 'w workspace', '/ filter', '? help', 'q quit'];
const HINTS_HELP = ['o open this runner on buildd', 'any key back', 'q quit'];
const HINTS_DETAIL = ['esc back', 'a answer', 'm message', 'p pause', 'x stop', 'c claim', 's/S talk', 'o web', 'q quit'];

/** Dropped first when the footer is too narrow; `? help`, `t`, `w` and `q quit` always stay. */
const HINT_DROP_ORDER = ['b logins', 's/S talk', '+- slots', 'p pause', 'x stop', 'h hold', 'm message', 'c claim', 'a answer', 'tab queue', 'o web', '/ filter', '↑↓ move', '⏎ open', 'esc back'];

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
    const t = titleWithAttempt(state.tasks.find(x => x.id === m.taskId)?.title ?? workerForTask(state, m.taskId)?.taskTitle) || 'this task';
    return p.fg('accent', fit(` Stop the agent on "${t}"? y stops it, any other key keeps it running`, cols));
  }
  if (state.status) {
    const token: PaletteToken = state.status.tone === 'error' ? 'error' : state.status.tone === 'ok' ? 'success' : 'muted';
    return p.fg(token, fit(' ' + state.status.text, cols));
  }
  const hints = m.kind === 'detail' ? HINTS_DETAIL : m.kind === 'help' ? HINTS_HELP : state.view === 'queue' ? HINTS_QUEUE : HINTS_LIST;
  // b only where the runner has a login mode to switch (spec 34a48877 R-14), after +- slots.
  const withLogins = (h: string[]) => state.runner.loginMode ? h.flatMap(x => x === '+- slots' ? [x, 'b logins'] : [x]) : h;
  return p.fg('muted', fit(fitHints(m.kind === 'detail' || m.kind === 'help' ? hints : withLogins(hints), cols), cols));
}

/** The fewest title columns a mission row keeps before it drops its stage word: two letters and "…". */
const MIN_MISSION_TITLE = 3;

/** The most lines the selected mission's name wraps onto (R-57). */
const MAX_NAME_LINES = 4;

/**
 * The missions pane grows with the terminal, about a quarter of it, to 48
 * columns; while you move between missions it takes about a third, to 64 (R-57).
 */
function leftWidth(cols: number, focused: boolean): number {
  if (focused) return cols >= 110 ? Math.min(64, Math.max(36, Math.floor(cols / 3))) : cols >= 90 ? 30 : 28;
  return cols >= 110 ? Math.min(48, Math.max(28, Math.floor(cols / 4))) : cols >= 90 ? 24 : 22;
}

/**
 * Word-wrap `s` into lines: the first `first` columns wide, the rest `rest`,
 * at most `max` lines, the last cut with "…" when words are left over.
 */
function wrapName(s: string, first: number, rest: number, max: number): string[] {
  const lines: string[] = [];
  let line = '';
  const words = s.replace(/\s+/g, ' ').trim().split(' ');
  for (let i = 0; i < words.length; i++) {
    const room = lines.length === 0 ? first : rest;
    const next = line ? `${line} ${words[i]}` : words[i];
    if (textWidth(next) <= room) { line = next; continue; }
    if (lines.length === max - 1) return [...lines, fit(words.slice(i).reduce((a, w) => `${a} ${w}`, line).trim(), room).trimEnd()];
    if (line) lines.push(line);
    line = words[i];
    // A single word wider than the line is cut on its own line.
    if (textWidth(line) > (lines.length === 0 ? first : rest)) line = fit(line, lines.length === 0 ? first : rest).trimEnd();
  }
  if (line) lines.push(line);
  return lines;
}

/** A fold row's words: "Done this week · 4", or "Done · 4" where that does not fit. */
function foldTitle(m: MissionRow, room: number): string {
  const full = `${m.title} · ${m.fold!.count}`;
  return textWidth(full) <= room ? full : `${TERMS['mission.done'].word} · ${m.fold!.count}`;
}

/**
 * The missions pane (R-24): a heading row per team, then that team's open
 * missions (building and verifying first, then paused), then one dimmed
 * "Done this week · N" row. Opened, it lists the missions done in
 * the last 7 days under it, dimmed, each with its day on its own row ("Oct
 * 14"), so a full pane cannot drop the day. A mission managed from a local
 * session says so in its stage words ("building in your session"), on its own row.
 * When the pane is too short it scrolls to keep the selected mission in view.
 */
function leftPane(missions: MissionRow[], current: MissionRow, focused: boolean, lw: number, height: number, p: Palette): string[] {
  const hasTeams = missions.some(m => m.team !== null);
  const build = () => {
    const lines: string[] = [];
    let selected = 0;
    missions.forEach((m, i) => {
      if (hasTeams && (i === 0 || m.team !== missions[i - 1].team)) {
        lines.push(m.team === null ? ' '.repeat(lw) : p.fg('muted', fit(' ' + m.team, lw)));
      }
      const isCurrent = m.key === current.key;
      if (m.fold) {
        const line = ` ${p.fg(isCurrent ? 'accent' : 'faint', isCurrent ? '▸' : ' ')} ${p.fg('muted', fit(foldTitle(m, lw - 4), lw - 4))} `;
        if (isCurrent) selected = lines.length;
        lines.push(isCurrent && focused ? p.selectedBg(line) : line);
        return;
      }
      const delivered = m.deliveredAt !== undefined;
      // Done over total always (R-31), with the stage word beside it (R-18).
      // The title gives way first; only when it would vanish does the stage
      // word go, and the heading still says it.
      // Loose tasks count what is still open: their done total says nothing.
      const tally = isLooseKey(m.key) ? (m.total > m.done ? `${m.total - m.done} open` : '') : m.total > 0 ? `${m.done}/${m.total}` : '';
      const stage = missionRowStage(m);
      const fullCount = [stage, tally].filter(Boolean).join(' ') || (m.held ? TERMS['mission.paused'].short : '');
      // Widest that leaves the title room: the stage with "in your session", then without it, then the tally alone.
      const fits = (c: string) => lw - 3 - (c.length + 2) >= MIN_MISSION_TITLE;
      const plain = [missionStageWord(m), tally].filter(Boolean).join(' ');
      const count = delivered ? deliveredDay(m.deliveredAt!) : [fullCount, plain, tally].find(c => c && fits(c)) ?? (tally || plain || fullCount);
      const marker = isCurrent ? '▸' : ' ';
      const titleW = lw - 3 - (count ? count.length + 2 : 1);
      const countText = count ? ' ' + p.fg(m.running > 0 ? 'accent' : 'muted', count) : '';
      const token: PaletteToken = delivered ? 'muted' : 'text';
      // The selected mission shows its whole name, wrapped under itself (R-57).
      const name = isCurrent ? wrapName(m.title, titleW, lw - 4, MAX_NAME_LINES) : [m.title];
      name.forEach((part, k) => {
        const line = k === 0
          ? ` ${p.fg(isCurrent ? 'accent' : 'faint', marker)} ${p.fg(token, fit(part, titleW))}${countText} `
          : `   ${p.fg(token, fit(part, lw - 4))} `;
        lines.push(isCurrent && focused ? p.selectedBg(line) : line);
      });
      if (isCurrent) selected = lines.length - 1;
    });
    // Without team headings the pane keeps its MISSIONS label.
    if (!hasTeams) return { lines: [p.fg('muted', fit(' MISSIONS', lw)), ...lines], selected: selected + 1 };
    return { lines, selected };
  };
  const built = build();
  let lines = built.lines;
  if (lines.length > height) {
    const offset = Math.min(Math.max(0, built.selected - height + 1), lines.length - height);
    lines = lines.slice(offset, offset + height);
  }
  return lines;
}

function listBody(state: TopState, cols: number, height: number, now: number, p: Palette): string[] {
  const lw = leftWidth(cols, state.focus === 'missions');
  const rw = cols - lw - 1;
  const missions = missionList(state, now);
  const mission = currentMission(state, now);
  const rows = taskRows(state, now);
  const sel = selectedRow(state, now);

  // Left pane.
  const left = leftPane(missions, mission, state.focus === 'missions', lw, height, p);

  // Right pane.
  const right: string[] = [];
  const nRunning = rows.filter(r => r.group === 'running').length;
  const nWaiting = rows.filter(r => r.group === 'waiting').length;
  // Live work in words, only when there is some: an empty pane says so below.
  const counts = [nRunning > 0 ? `${nRunning} running` : null, nWaiting > 0 ? `${nWaiting} waiting` : null].filter(Boolean).join(' · ');
  const countsCol = counts ? counts + ' ' : '';
  const filterNote = state.filter ? ` (filter: ${state.filter})` : '';
  const ws = currentWorkspace(state);
  const delivered = mission.fold ? deliveredMissions(state, mission, now) : [];
  const title = mission.fold ? `${mission.fold.count} ${TERMS['mission.done'].short} in the last ${DELIVERED_DAYS} days` : mission.title;
  const heading = (ws ? `${ws.name} · ` : '') + title + filterNote;
  const titleW = rw - textWidth(countsCol) - 1;
  // One space always separates a cut heading from the counts (R-21).
  right.push(' ' + p.fg('text', fit(heading, titleW - 1)) + ' ' + p.fg(nRunning > 0 ? 'accent' : 'muted', countsCol));
  // Under the title: the stage, how far it got, who runs it.
  const statusLine = missionStatusLine(mission);
  if (statusLine) right.push(p.fg('muted', fit(' ' + statusLine, rw)));
  // R-29: the whole mission as squares, done first, under its heading.
  const progress = isLooseKey(mission.key) ? null : progressRow(mission, rw, p);
  if (progress) right.push(progress);
  right.push(p.fg('faint', '─'.repeat(rw)));

  const groups: Array<{ key: TaskRow['group']; label: string }> = [
    { key: 'running', label: 'Working now' },
    { key: 'waiting', label: 'Waiting' },
    { key: 'done', label: 'Done today' },
  ];
  const lines: Array<{ text: string; rowIndex?: number }> = [];
  const withRoute = rows.some(r => !!r.route);
  for (const g of groups) {
    const inGroup = rows.map((r, i) => ({ r, i })).filter(x => x.r.group === g.key);
    if (inGroup.length === 0) continue;
    lines.push({ text: p.fg('muted', fit(' ' + g.label, rw)) });
    for (const { r, i } of inGroup) {
      lines.push({ text: renderRow(r, rw, state.focus === 'tasks' && sel?.taskId === r.taskId, p, withRoute), rowIndex: i });
    }
  }
  if (mission.fold) {
    // The deliveries themselves, newest first: the day, then the mission.
    for (const m of delivered) lines.push({ text: p.fg('muted', fit(` ${fit(deliveredDay(m.deliveredAt!), 7)}`, 9)) + p.fg('text', fit(m.title, rw - 9)) });
  } else if (rows.length === 0) {
    lines.push({ text: p.fg('muted', fit(' ' + emptyMissionWords(mission, state.filter), rw)) });
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

  const title = row?.title ?? (titleWithAttempt(task?.title ?? w?.taskTitle) || taskId);
  const g = row ? GLYPH[row.kind] : GLYPH.waiting;
  const meta = [
    row?.role,
    row?.elapsedMs !== undefined ? formatDuration(row.elapsedMs) : null,
    task?.mission?.title ?? (task?.missionId ? `mission ${task.missionId.slice(0, 8)}` : '(no mission)'),
  ].filter(Boolean).join(' · ');
  const titleW = Math.max(8, cols - 3 - textWidth(meta) - 3);
  push(' ' + p.fg(g.token, g.ch) + ' ' + p.fg('text', fit(title, titleW)) + p.fg('muted', fit('   ' + meta, Math.max(0, cols - 3 - titleW))));

  // Backend and route, and the run's dollars in the words that say how it is paid (R-40, R-41).
  if (w?.route) {
    const served = w.resultMeta?.actualModel && w.sessionModel && w.resultMeta.actualModel !== w.sessionModel
      ? `served ${w.resultMeta.actualModel} (asked for ${w.sessionModel})` : null;
    const dollars = detailDollars(workerSpend(w), w.resultMeta?.actualModel ?? w.sessionModel);
    line('muted', ' ' + [runWords(w.route.backend, w.route), served, dollars].filter(Boolean).join(' · '));
  }
  // Why it runs on that backend when the claim moved it (R-40): "Routed to Codex by this runner's balanced mode."
  if (w?.routedWhy) line('muted', ` ${w.routedWhy.charAt(0).toUpperCase()}${w.routedWhy.slice(1)}.`);
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
  ['⏎', 'open a task: plan, milestones, tool calls; on Done this week, list them on the left too'],
  ['a', 'answer the question an agent is asking'],
  ['m', 'send a message to a running agent'],
  ['p', 'pause a running agent'],
  ['x', 'stop a running agent (asks first)'],
  ['c', 'claim a waiting task onto this runner'],
  ['tab', 'switch between Missions and Queue (what this runner takes next)'],
  ['h', 'hold: running agents finish, nothing new starts; h again resumes'],
  ['o', 'open the task on buildd, or the mission when no task is picked'],
  ['t', 'show the next team, then all of them'],
  ['w', 'show the next workspace of that team, then all of them'],
  ['/', 'filter missions and tasks by title, done ones too; esc clears it'],
  ['q', 'quit (the runner keeps running)'],
];

/** `?` (R-20): the keys, and what this view cannot see. */
function helpBody(state: TopState, cols: number, height: number, p: Palette): string[] {
  const out: string[] = [];
  out.push(p.fg('muted', fit(' KEYS', cols)));
  // b only where the runner has a login mode to switch (spec 34a48877 R-14).
  const keys = state.runner.loginMode
    ? HELP_KEYS.flatMap(e => e[0] === 'h' ? [e, ['b', 'switch which login takes new work: balanced, claude-first, codex-first'] as [string, string]] : [e])
    : HELP_KEYS;
  for (const [k, what] of keys) out.push(p.fg('accent', fit(`  ${k}`, 10)) + p.fg('text', fit(what, cols - 10)));
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
  // A person's hold (R-33): its own line straight under the header, in the
  // accent: a choice the person made, not a fault.
  const ownLine = holdLine(state, now);
  // What the claim loop did last, or that it is looking now (task 9e12f377).
  const ownHold = ownLine ? [p.fg('accent', fit(' ' + ownLine, cols))] : [];
  // What the claim loop did last, or that it is looking now (task 9e12f377);
  // not while held, and not when the provider line above already says why.
  const loopText = ownLine ? null : claimLoopLine(state, now);
  const loopLine = loopText && !(holdLines.length > 0 && state.claimOutcomes.broad?.reason === 'budget_exhausted')
    ? [p.fg('muted', fit(' ' + loopText, cols))]
    : [];
  // The line under the header: Missions | Queue (R-26), then what is shown and the keys that change it (R-23).
  const filterRow = tabLine(state, cols, now, p);
  // R-39, R-42: the routes this runner runs on, then today's dollars per bucket.
  // A route that does not work is a warning on its own line, with where to fix it.
  const runsOnText = runsOn(state, now);
  const todayText = spendTodayLine(state, now);
  // R-60: what each login does now, and the login mode with b to change it.
  const loginsText = loginsLine(state, now);
  const routeLines = [
    ...(runsOnText ? [p.fg('muted', fit(' ' + runsOnText, cols))] : []),
    ...(loginsText ? [p.fg('muted', fit(' ' + loginsText, cols))] : []),
    ...routeProblemLines(state).map(l => p.fg('warning', fit(' ' + l, cols))),
    ...sandboxLines(state).map(l => p.fg(l.warn ? 'warning' : 'muted', fit(' ' + l.text, cols))),
    ...(todayText ? [p.fg('muted', fit(' ' + todayText, cols))] : []),
  ];
  const bodyH = Math.max(1, rows - 5 - holdLines.length - ownHold.length - routeLines.length - loopLine.length);
  const body = state.mode.kind === 'detail'
    ? detailBody(state, state.mode.taskId, cols, bodyH, now, p)
    : state.mode.kind === 'help'
      ? helpBody(state, cols, bodyH, p)
      : state.view === 'queue'
        ? queueBody(state, cols, bodyH, now, p)
        : listBody(state, cols, bodyH, now, p);
  return [header(state, cols, now, p), ...ownHold, ...routeLines, filterRow, ...holdLines, ...loopLine, rule(cols, p), ...body, rule(cols, p), footer(state, cols, p)];
}

// ── Queue view (R-26) ───────────────────────────────────────────────────────

/** ` [ Missions ]  Queue` with the filter line beside it; the filter is cut, never the tabs. */
function tabLine(state: TopState, cols: number, now: number, p: Palette): string {
  const missions = state.view === 'missions' ? '[ Missions ]' : 'Missions';
  const queue = state.view === 'queue' ? '[ Queue ]' : 'Queue';
  const tabs = ` ${missions}  ${queue}`;
  const filter = filterLine(state);
  // R-26: the Queue counts slots on its own line, with the keys that change them.
  // Widest that leaves the filter whole: with the keys, then without, then only the free count.
  const summary = slotsSummary(state, now);
  const variants = state.view === 'queue'
    ? [`${summary}   - fewer  + more `, `${summary} `, `${summary.replace(/ · \d+ running/, '')} `]
    : [''];
  const fits = (r: string) => textWidth(tabs) + 3 + textWidth(filter) + 2 + textWidth(r) <= cols;
  const right = variants.find(fits) ?? (textWidth(tabs) + 3 + 12 + textWidth(variants[variants.length - 1]) <= cols ? variants[variants.length - 1] : '');
  const room = cols - textWidth(tabs) - 3 - textWidth(right);
  const tail = room > 0 ? '   ' + fit(filter, room) : '';
  const paint = (label: string, active: boolean) => p.fg(active ? 'accent' : 'muted', label);
  const line = ' ' + paint(missions, state.view === 'missions') + '  ' + paint(queue, state.view === 'queue') + p.fg('muted', tail) + (right ? p.fg('muted', right) : '');
  return fitAnsi(line, cols, p);
}

const POS_W = 3;
const QWS_W = 13;
const QEST_W = 6;
/** The narrowest title the queue keeps before it drops a column. */
const QTITLE_MIN = 30;

interface QueueCols { est: boolean; workspace: boolean; by: number; mission: number; starts: number; title: number }

/**
 * The queue's columns at `cols`: est. goes first, then workspace, and below 60
 * columns the mission and start columns narrow. Every row is exactly `cols`
 * wide and never wraps.
 */
export function queueColumnsFor(cols: number, estimatesOn: boolean): QueueCols {
  const mission = cols < 60 ? 12 : cols < 110 ? 14 : 17;
  // The by column (R-58): "you", a first name, or "-"; a long name is cut.
  const by = cols < 110 ? 6 : 9;
  // Wide enough for "when #4 ends (same files)"; a held row's title gets more at 120.
  const starts = cols < 60 ? 10 : cols < 80 ? 13 : cols < 110 ? 26 : 36;
  // The by column stays at every width (R-58); est. and workspace give way first.
  const fixed = 1 + POS_W + by + mission + starts;
  const est = estimatesOn && cols - fixed - QWS_W - QEST_W >= QTITLE_MIN;
  const workspace = cols - fixed - (est ? QEST_W : 0) - QWS_W >= QTITLE_MIN;
  const title = Math.max(4, cols - fixed - (workspace ? QWS_W : 0) - (est ? QEST_W : 0));
  return { est, workspace, by, mission, starts, title };
}

function queueHeading(section: QueueSection, cols: number, c: QueueCols, p: Palette): string {
  const text =
    ' ' + fit(`${section.teamName} · next for this runner`, POS_W + c.title - 1) + ' ' +
    fit('by', c.by) +
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
  // "now" is in the accent; a start held to a time stands out; a wait in words does not.
  const now = row.position !== null && row.starts === 'now';
  const timed = (row.position !== null || row.held === true) && /\d\d:\d\d/.test(row.starts);
  const line =
    (selected ? p.fg('accent', '›') : ' ') +
    p.fg('muted', pos) +
    p.fg(primary, col(row.title, c.title)) +
    p.fg('muted', col(row.by, c.by)) +
    (c.workspace ? p.fg('muted', col(row.workspace, QWS_W)) : '') +
    p.fg('muted', col(row.mission, c.mission)) +
    (c.est ? p.fg('muted', col(row.est ?? '-', QEST_W)) : '') +
    p.fg(now ? 'accent' : timed ? 'warning' : 'muted', fit(row.starts, c.starts));
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
  // R-59: what runs next, from the rows' own reasons.
  const next = queueNextLine(state, now);
  if (next) lines.push({ text: p.fg('text', fit(' ' + next, cols)) });
  for (const section of sections) {
    const c = queueColumnsFor(cols, section.estimatesOn);
    lines.push({ text: queueHeading(section, cols, c, p) });
    for (const r of section.rows) {
      lines.push({ text: queueRowLine(r, c, sel?.taskId === r.taskId, p), taskId: r.taskId });
      // Under the selected row: the work it starts alongside (I-38).
      if (sel?.taskId === r.taskId && r.alongside) lines.push({ text: p.fg('muted', fit(' '.repeat(POS_W + 1) + r.alongside, cols)) });
    }
    if (section.rows.length === 0) lines.push({ text: p.fg('muted', fit('    Nothing this runner takes is waiting.', cols)) });
    if (section.held.length > 0) {
      lines.push({ text: p.fg('muted', fit(' Not yet', cols)) });
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
