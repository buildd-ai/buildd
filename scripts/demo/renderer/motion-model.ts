/**
 * The abstract "brand motion" beats of v6x, pure: what each shows at a given
 * moment, and the sounds it makes. motion.ts draws them; nothing here touches
 * the DOM, so the tests read the same numbers the frames do.
 *
 *   type    one sentence typed large
 *   split   the sentence becomes 12 tiles, dropping into three columns, one column at a time
 *   fleet   four runner rows; six role-coloured bars light up and fill, a row at a time
 *   phone   a phone with one question and two options; one is tapped
 *   screens two screenshot frames, each stamped with a check
 *   done    "Done." and one line of what was verified
 *   title   v7: big lines of type, one after another (the hook)
 *   chapter v7: a chapter card: its number and its title
 *   recap   v7: the chapter titles stacked, then one closing line and the URL
 *   beforeAfter v7: two phone screenshots side by side; the before is marked
 *           broken, then the after is checked
 *   doubt   v7.1 opening: one agent row; "Done ✓" lands, then a small question mark
 *   checks  v7.1: "Done when" and its checks set large, each appearing once and staying
 *   verify  the hero: a short list of checks and the agents' bars. Each agent
 *           fills its bar ("I'm done"), then its check ticks (buildd checks);
 *           after the last, one "Done.". It resets to its first frame by the
 *           end, so a single-shot loop has no seam.
 */
import type { FleetRunner } from './timeline';

export type Motion =
  | { kind: 'type'; label: string; text: string; from: number; to: number }
  | { kind: 'split'; label: string; text: string; columns: Array<{ title: string; tiles: string[] }>; from: number; stagger: number; columnGap: number; dur: number }
  | { kind: 'fleet'; label: string; runners: FleetRunner[]; from: number; stagger: number; grow: number; total: number }
  | { kind: 'phone'; label: string; question: string; options: [string, string]; tapAt: number }
  | { kind: 'screens'; label: string; images: [{ src: string; width: number; height: number }, { src: string; width: number; height: number }]; checks: [number, number] }
  | { kind: 'done'; label: string; title: string; sub: string; from: number }
  | { kind: 'title'; label: string; lines: string[]; from: number; stagger: number }
  | { kind: 'chapter'; label: string; index: string; title: string; from: number }
  | { kind: 'recap'; label: string; titles: string[]; from: number; stagger: number; line: string; lineAt: number; url: string }
  | { kind: 'beforeAfter'; label: string; before: { src: string; width: number; height: number }; after: { src: string; width: number; height: number }; brokenAt: number; afterAt: number; checkAt: number; view?: number }
  | { kind: 'doubt'; label: string; agent: string; task: string; from: number; doneAt: number; doubtAt: number }
  | { kind: 'checks'; label: string; title: string; items: string[]; from: number; stagger: number }
  | { kind: 'verify'; label: string; checks: string[]; colors: string[]; from: number; stagger: number; grow: number; spread: number; lag: number; doneAt: number; resetAt: number; resetDur: number };

function ease(u: number) {
  const x = Math.min(1, Math.max(0, u));
  return x * x * x * (x * (6 * x - 15) + 10);
}

/** Characters of the sentence showing at `local`. */
export function typedChars(m: Extract<Motion, { kind: 'type' }>, local: number): number {
  return Math.round(m.text.length * Math.min(1, Math.max(0, (local - m.from) / (m.to - m.from))));
}

/** When tile (column c, row r) of a split starts falling. */
export function splitStart(m: Extract<Motion, { kind: 'split' }>, c: number, r: number): number {
  let t = m.from;
  for (let k = 0; k < c; k++) t += m.columns[k].tiles.length * m.stagger + m.columnGap;
  return t + r * m.stagger;
}

/** Each tile's progress (0 hidden at the column top, 1 in place), by column. */
export function splitAt(m: Extract<Motion, { kind: 'split' }>, local: number): number[][] {
  return m.columns.map((col, c) => col.tiles.map((_, r) => ease((local - splitStart(m, c, r)) / m.dur)));
}

/** The sentence at the top of a split fades to a quiet header as the first tiles land. */
export function splitHeadline(m: Extract<Motion, { kind: 'split' }>, local: number): number {
  return 1 - 0.55 * ease((local - m.from) / 0.8);
}

/** Fleet: per live slot, how lit its row is (0..1) and how full its bar is (0..1), plus the live count. */
export function fleetRows(m: Extract<Motion, { kind: 'fleet' }>, local: number): { lit: number[]; bars: number[]; live: number } {
  const lit: number[] = [], bars: number[] = [];
  let j = 0;
  for (const r of m.runners) for (const s of r.slots) if (s) {
    const t0 = m.from + j * m.stagger;
    lit.push(ease((local - t0) / 0.35));
    bars.push(ease((local - t0) / m.grow));
    j++;
  }
  return { lit, bars, live: lit.filter((x) => x > 0).length };
}

/** Phone: 0 before the tap, rising to 1 as the chosen option fills. */
export function phoneChosen(m: Extract<Motion, { kind: 'phone' }>, local: number): number {
  return ease((local - m.tapAt) / 0.3);
}

/** Screens: each frame's check, 0..1. */
export function screenChecks(m: Extract<Motion, { kind: 'screens' }>, local: number): [number, number] {
  return [ease((local - m.checks[0]) / 0.25), ease((local - m.checks[1]) / 0.25)];
}

export function doneIn(m: Extract<Motion, { kind: 'done' }>, local: number): number {
  return ease((local - m.from) / 0.6);
}

type Verify = Extract<Motion, { kind: 'verify' }>;

/** When agent i's bar is full: it reports done. Later agents take longer. */
export function verifyFull(m: Verify, i: number): number {
  return m.from + i * m.stagger + m.grow + i * m.spread;
}

/** When check i ticks: buildd checks the agent's claim, `lag` after it. */
export function verifyTick(m: Verify, i: number): number {
  return verifyFull(m, i) + m.lag;
}

/**
 * The hero at `local`: each bar's fill and each check (0..1), whether the bars
 * show, and Done (0..1). Done and the bars never share a frame: the bars leave
 * just before Done comes in, and at the reset Done leaves before the (empty)
 * bars come back. Everything is back at its first frame by the end of the
 * shot (resetAt + resetDur), so a single-shot loop has no seam.
 */
export function verifyAt(m: Verify, local: number): { bars: number[]; checks: number[]; barsShown: number; done: number } {
  const keep = 1 - ease((local - m.resetAt) / m.resetDur);
  const q = (x: number) => +x.toFixed(6);
  const reset = local >= m.resetAt;
  const doneOut = 1 - ease((local - m.resetAt) / 0.5);
  const barsBack = ease((local - (m.resetAt + 0.55)) / 0.5);
  return {
    bars: m.checks.map((_, i) => q(reset ? 0 : ease((local - (m.from + i * m.stagger)) / (m.grow + i * m.spread)))),
    checks: m.checks.map((_, i) => q(ease((local - verifyTick(m, i)) / 0.25) * keep)),
    barsShown: q(reset ? barsBack : 1 - ease((local - (m.doneAt - 0.5)) / 0.45)),
    done: q(ease((local - m.doneAt) / 0.6) * doneOut),
  };
}

/** Title: each line's opacity, one after another. */
export function titleIn(m: Extract<Motion, { kind: 'title' }>, local: number): number[] {
  return m.lines.map((_, i) => ease((local - (m.from + i * m.stagger)) / 0.45));
}

/** Chapter card: 0..1 as it comes in. */
export function chapterIn(m: Extract<Motion, { kind: 'chapter' }>, local: number): number {
  return ease((local - m.from) / 0.4);
}

/** Recap: each title's opacity, then the closing line's. */
export function recapAt(m: Extract<Motion, { kind: 'recap' }>, local: number): { titles: number[]; line: number; url: number } {
  return { titles: m.titles.map((_, i) => ease((local - (m.from + i * m.stagger)) / 0.4)), line: ease((local - m.lineAt) / 0.5), url: ease((local - (m.lineAt + 0.8)) / 0.5) };
}

/** Before/after: the broken mark on the before, the after sliding in, then its check. */
export function beforeAfterAt(m: Extract<Motion, { kind: 'beforeAfter' }>, local: number): { broken: number; after: number; check: number } {
  return { broken: ease((local - m.brokenAt) / 0.3), after: ease((local - m.afterAt) / 0.5), check: ease((local - m.checkAt) / 0.25) };
}

/** Opening: the row, its "Done ✓", then the doubt, each 0..1 and never going back. */
export function doubtAt(m: Extract<Motion, { kind: 'doubt' }>, local: number): { row: number; done: number; doubt: number } {
  return { row: ease((local - m.from) / 0.5), done: ease((local - m.doneAt) / 0.3), doubt: ease((local - m.doubtAt) / 0.35) };
}

/** Checks: the title, then each item once; opacity only rises. */
export function checksIn(m: Extract<Motion, { kind: 'checks' }>, local: number): { title: number; items: number[] } {
  return { title: ease((local - m.from) / 0.4), items: m.items.map((_, i) => ease((local - (m.from + 0.5 + i * m.stagger)) / 0.45)) };
}

/** The sounds a motion beat makes, in seconds into its shot. */
export function motionCues(m: Motion): Array<{ type: 'key' | 'tap' | 'pluck' | 'chime'; at: number; note?: number }> {
  switch (m.kind) {
    case 'type': {
      const out = [];
      const step = (m.to - m.from) / m.text.length;
      for (let i = 0; i < m.text.length; i += 2) out.push({ type: 'key' as const, at: m.from + i * step });
      return out;
    }
    case 'split': return m.columns.map((_, c) => ({ type: 'pluck' as const, at: splitStart(m, c, 0) + m.dur, note: c }));
    case 'fleet': {
      const out = [];
      let j = 0;
      for (const r of m.runners) for (const s of r.slots) if (s) out.push({ type: 'pluck' as const, at: m.from + j++ * m.stagger, note: j });
      return out;
    }
    case 'phone': return [{ type: 'tap', at: m.tapAt }];
    case 'screens': return m.checks.map((at) => ({ type: 'tap' as const, at }));
    case 'done': return [{ type: 'chime', at: m.from + 0.2 }];
    case 'title': return [];
    case 'doubt': return [];
    case 'checks': return [];
    case 'chapter': return [];
    case 'recap': return [];
    // One soft click as the after lands, and the gentle tone is the green check's (cuts-v7 puts it on the check).
    case 'beforeAfter': return [{ type: 'tap', at: m.afterAt }];
    case 'verify': return [...m.checks.map((_, i) => ({ type: 'pluck' as const, at: verifyTick(m, i), note: i })), { type: 'chime' as const, at: m.doneAt + 0.2 }];
  }
}
