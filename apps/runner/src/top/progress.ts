/**
 * The selected mission's progress row (spec c7410e76 R-29, R-30): one square
 * per task, in the mission page's Overview groups and order, then the counts
 * in words.
 *
 * The cells come from the server (`mission.stage.progress`, built by the
 * mission page's own `overviewProgress`), so `top` never orders or groups
 * them itself; this only chooses glyphs and fits the row to the pane.
 *
 *   ■■■■■■■■ ▶▶ ▢▢▢ ◐◐   8 done · 2 in progress · 3 waiting · 2 checks
 *
 * When that is too wide, settled runs collapse first ("■×14", as the mission
 * page's small strip does), then every long run, then each group becomes one
 * glyph beside its own count. The counts in words are always in the row.
 * Every glyph differs by shape, so the row reads the same under NO_COLOR.
 */
import type { PaletteToken } from '../terminal-palette';

export type ProgressGroup = 'done' | 'active' | 'waiting' | 'checks';

export interface ProgressCell {
  /** The strip's display state: landed, running, failed, ready, blocked... */
  state: string;
  group: ProgressGroup;
}

export interface ProgressMark {
  ch: string;
  token: PaletteToken;
  /** Merged or waiting: collapses first when the row is too wide. */
  settled: boolean;
}

/** A task that stopped without shipping, whatever group it sits in. */
const FAILED = new Set(['failed', 'ci_failed', 'not_landed']);

const GROUP_MARK: Record<ProgressGroup, ProgressMark> = {
  done: { ch: '■', token: 'success', settled: true },
  active: { ch: '▶', token: 'accent', settled: false },
  waiting: { ch: '▢', token: 'queue', settled: true },
  checks: { ch: '◐', token: 'info', settled: false },
};
const FAILED_MARK: ProgressMark = { ch: '✗', token: 'error', settled: false };

export function progressMark(cell: ProgressCell): ProgressMark {
  if (FAILED.has(cell.state)) return FAILED_MARK;
  return GROUP_MARK[cell.group] ?? GROUP_MARK.waiting;
}

const GROUPS: readonly ProgressGroup[] = ['done', 'active', 'waiting', 'checks'];

function groupWord(group: ProgressGroup, n: number): string {
  switch (group) {
    case 'done': return `${n} done`;
    case 'active': return `${n} in progress`;
    case 'waiting': return `${n} waiting`;
    case 'checks': return `${n} ${n === 1 ? 'check' : 'checks'}`;
  }
}

/** The counts in words, as the mission page's legend: `8 done · 2 in progress · 3 waiting · 2 checks`. */
export function progressCounts(cells: readonly ProgressCell[]): string {
  return countsByGroup(cells).map(g => groupWord(g.group, g.cells.length)).join(' · ');
}

function countsByGroup(cells: readonly ProgressCell[]): Array<{ group: ProgressGroup; cells: ProgressCell[] }> {
  return GROUPS.map(group => ({ group, cells: cells.filter(c => c.group === group) })).filter(g => g.cells.length > 0);
}

/** The done count from progress cells (for the left pane to match the right pane). */
export function progressDone(cells: readonly ProgressCell[] | undefined): number {
  if (!cells) return 0;
  return cells.filter(c => c.group === 'done').length;
}

/** The total count from progress cells (for the left pane to match the right pane). */
export function progressTotal(cells: readonly ProgressCell[] | undefined): number {
  if (!cells) return 0;
  return cells.length;
}

/** One drawn piece of the row: a glyph run, or plain words. */
export interface ProgressPiece {
  text: string;
  token: PaletteToken | 'muted';
}

/** Runs of the same glyph inside one group, in order. */
function runsOf(cells: readonly ProgressCell[]): Array<{ mark: ProgressMark; count: number }> {
  const runs: Array<{ mark: ProgressMark; count: number }> = [];
  for (const c of cells) {
    const mark = progressMark(c);
    const last = runs[runs.length - 1];
    if (last && last.mark.ch === mark.ch) last.count++;
    else runs.push({ mark, count: 1 });
  }
  return runs;
}

/** Shortest a run of three or more gets: `■×14`. */
const COLLAPSE_AT = 3;

function squares(cells: readonly ProgressCell[], collapse: 'none' | 'settled' | 'all'): ProgressPiece[] {
  const out: ProgressPiece[] = [];
  for (const [i, g] of countsByGroup(cells).entries()) {
    if (i > 0) out.push({ text: ' ', token: 'muted' });
    for (const r of runsOf(g.cells)) {
      const fold = r.count >= COLLAPSE_AT && (collapse === 'all' || (collapse === 'settled' && r.mark.settled));
      out.push({ text: fold ? `${r.mark.ch}×${r.count}` : r.mark.ch.repeat(r.count), token: r.mark.token });
    }
  }
  return out;
}

/** Each group as its glyphs once, then its own count: `■ 22 done · ▶✗ 3 in progress`. */
function legend(cells: readonly ProgressCell[]): ProgressPiece[] {
  const out: ProgressPiece[] = [];
  for (const [i, g] of countsByGroup(cells).entries()) {
    if (i > 0) out.push({ text: ' · ', token: 'muted' });
    const seen = new Set<string>();
    for (const c of g.cells) {
      const m = progressMark(c);
      if (seen.has(m.ch)) continue;
      seen.add(m.ch);
      out.push({ text: m.ch, token: m.token });
    }
    out.push({ text: ' ' + groupWord(g.group, g.cells.length), token: 'muted' });
  }
  return out;
}

const piecesWidth = (pieces: readonly ProgressPiece[], width: (s: string) => number) =>
  pieces.reduce((n, p) => n + width(p.text), 0);

/**
 * The row's pieces for a pane `room` columns wide (after its one-space
 * indent), widest form that fits first. Null with no cells: an older server,
 * or a mission with nothing to draw.
 */
export function progressPieces(
  cells: readonly ProgressCell[] | undefined,
  room: number,
  width: (s: string) => number,
): ProgressPiece[] | null {
  if (!cells || cells.length === 0) return null;
  const counts = progressCounts(cells);
  for (const collapse of ['none', 'settled', 'all'] as const) {
    for (const gap of ['   ', '  ']) {
      const pieces = [...squares(cells, collapse), { text: gap + counts, token: 'muted' as const }];
      if (piecesWidth(pieces, width) <= room) return pieces;
    }
  }
  const short = legend(cells);
  if (piecesWidth(short, width) <= room) return short;
  // Narrower than any terminal top supports: the words alone, cut by the caller.
  return [{ text: counts, token: 'muted' }];
}
