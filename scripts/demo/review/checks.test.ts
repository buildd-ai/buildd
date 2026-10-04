import { describe, expect, test } from 'bun:test';
import {
  clipMeta, collisions, confidenceCollapse, contrastFloor, displayWidth, exitCode, legibility, lumaStats,
  numberContradictions, parseBlack, parseFreeze, parseTsv, sampleTimes, seamCheck, stackedLabels, textOverShape, litWords, fontPx, inFadeOut, applyAccepted, emptyGap, isTypeCard, flicker, type Word,
} from './checks';

const W = (text: string, x: number, y: number, w: number, h: number, conf = 90, line = 1): Word => ({ text, x, y, w, h, conf, line });

describe('displayWidth: the width the site shows each clip at', () => {
  test('beats: 700 on desktop, 360 on a phone; heroes 1280 / 360; the film 1280', () => {
    expect(displayWidth('spec')).toBe(700);
    expect(displayWidth('spec-light')).toBe(700);
    expect(displayWidth('spec-mobile')).toBe(360);
    expect(displayWidth('spec-light-mobile')).toBe(360);
    expect(displayWidth('hero')).toBe(1280);
    expect(displayWidth('hero-light-mobile')).toBe(360);
    expect(displayWidth('full')).toBe(1280);
    expect(displayWidth('captioned')).toBe(1280);
  });
});

describe('clipMeta: crossfade midpoints in the clip\'s own time', () => {
  const shots = [{ start: 0, dur: 4.5 }, { start: 4.5, dur: 4.5 }];
  test('a beat is folded: its first fade moved to the end, so output = cut - fade, and the seam is a crossfade', () => {
    const m = clipMeta('spec', { loop: false, shots }, 0.8);
    expect(m.folded).toBe(true);
    expect(m.loop).toBe(true);
    // Between the shots, and the folded seam's own midpoint (encoded length = sum of shots = 9).
    expect(m.crossfades.map((x) => +x.toFixed(2))).toEqual([4.1, 8.6]);
  });
  test('a hero is a true loop from t = 0: crossfades at start + fade/2', () => {
    const m = clipMeta('hero', { loop: true, shots: [{ start: 0, dur: 13.2 }] }, 0.8);
    expect(m.folded).toBe(false);
    expect(m.loop).toBe(true);
    expect(m.crossfades).toEqual([]);
  });
  test('the captioned film is a film too: not folded, not a loop', () => {
    const m = clipMeta('captioned', { loop: false, shots }, 0.8);
    expect(m.folded).toBe(false);
    expect(m.loop).toBe(false);
  });
  test('the film is not a loop', () => {
    const m = clipMeta('full', { loop: false, shots }, 0.8);
    expect(m.loop).toBe(false);
    expect(m.crossfades.map((x) => +x.toFixed(2))).toEqual([4.9]);
  });
});

describe('sampleTimes', () => {
  test('every 0.5s, plus each crossfade midpoint, plus the last frame for the seam, sorted and unique', () => {
    const t = sampleTimes(2.0, [1.25], { loop: true, fps: 30 });
    expect(t).toEqual([0, 0.5, 1, 1.25, 1.5, 1.967]);
  });
  test('no seam frame for a clip that does not loop', () => {
    expect(sampleTimes(1.0, [], { loop: false, fps: 30 })).toEqual([0, 0.5]);
  });
});

describe('ffmpeg parsers', () => {
  test('blackdetect intervals', () => {
    const err = '[blackdetect @ 0x1] black_start:0 black_end:0.733333 black_duration:0.733333\n[blackdetect @ 0x1] black_start:5.2 black_end:6 black_duration:0.8';
    expect(parseBlack(err)).toEqual([{ start: 0, end: 0.733333 }, { start: 5.2, end: 6 }]);
  });
  test('freezedetect intervals, including one still open at the end', () => {
    const err = 'lavfi.freezedetect.freeze_start: 2.5\nlavfi.freezedetect.freeze_duration: 3\nlavfi.freezedetect.freeze_end: 5.5\nlavfi.freezedetect.freeze_start: 9';
    expect(parseFreeze(err, 12)).toEqual([{ start: 2.5, end: 5.5 }, { start: 9, end: 12 }]);
  });
});

describe('parseTsv: tesseract word boxes', () => {
  test('keeps level-5 words with text, drops empty and low-confidence noise', () => {
    const tsv = [
      'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
      '5\t1\t1\t1\t1\t1\t10\t20\t50\t16\t91.5\tDone',
      '5\t1\t1\t1\t1\t2\t70\t20\t30\t16\t-1\t',
      '5\t1\t1\t1\t2\t1\t10\t50\t40\t14\t12\t~',
      '4\t1\t1\t1\t1\t0\t10\t20\t100\t16\t-1\t',
    ].join('\n');
    expect(parseTsv(tsv)).toEqual([{ text: 'Done', x: 10, y: 20, w: 50, h: 16, conf: 91.5, line: 1001001 }]);
  });
});

describe('lumaStats + contrastFloor: a "dark rectangle" fails', () => {
  test('mean and RMS contrast of an 8-bit gray buffer', () => {
    const s = lumaStats(new Uint8Array([0, 0, 255, 255]));
    expect(s.mean).toBeCloseTo(127.5, 5);
    expect(s.rms).toBeCloseTo(127.5, 5);
  });
  test('a near-black low-contrast frame is high severity on a dark theme; a busy dark UI passes', () => {
    expect(contrastFloor({ mean: 9, rms: 6 }, 'dark')?.severity).toBe('high');
    expect(contrastFloor({ mean: 32, rms: 30 }, 'dark')).toBeNull();
  });
  test('a light-theme frame needs real contrast too (a washed-out frame fails)', () => {
    expect(contrastFloor({ mean: 228, rms: 7 }, 'light')?.severity).toBe('high');
    expect(contrastFloor({ mean: 215, rms: 35 }, 'light')).toBeNull();
  });
});

test('inFadeOut: the last second of a clip that does not loop is its fade-out', () => {
  expect(inFadeOut(56.5, 56.8, false)).toBe(true);
  expect(inFadeOut(50, 56.8, false)).toBe(false);
  expect(inFadeOut(8.9, 9, true)).toBe(false);
});

describe('emptyGap: a big flat hole between content (the spec list before its rows arrived)', () => {
  const W0 = 160, H0 = 90;
  const frame = (fill: (x: number, y: number) => number) => { const g = new Uint8Array(W0 * H0); for (let y = 0; y < H0; y++) for (let x = 0; x < W0; x++) g[y * W0 + x] = fill(x, y); return g; };
  const text = (x: number, y: number) => ((x * 7 + y * 3) % 5 === 0 ? 220 : 20); // busy, like rows of text
  test('content above and below a flat middle covering ~40% of the frame is flagged', () => {
    const g = frame((x, y) => (y < 25 || y > 65 ? text(x, y) : 20));
    const f = emptyGap(g, W0, H0);
    expect(f).not.toBeNull();
    expect(f!.severity).toBe('high');
  });
  test('the same frame with the middle filled passes', () => {
    expect(emptyGap(frame(text), W0, H0)).toBeNull();
  });
  test('an empty margin at the bottom edge is a crop, not a gap', () => {
    expect(emptyGap(frame((x, y) => (y < 40 ? text(x, y) : 20)), W0, H0)).toBeNull();
  });
  test('a gap that runs out to a side margin (and around to the bottom) still counts: only its columns matter', () => {
    // Content top and bottom on the left 70%; the right 30% is empty top to bottom (a margin); the middle of the left is empty.
    const g = frame((x, y) => (x > 112 ? 20 : y < 20 || y > 70 ? text(x, y) : 20));
    expect(emptyGap(g, W0, H0)).not.toBeNull();
  });
  test('a small flat area between content passes', () => {
    expect(emptyGap(frame((x, y) => (y < 40 || y > 50 ? text(x, y) : 20)), W0, H0)).toBeNull();
  });
});

test('isTypeCard: a frame with display-size type is a title card, not a dark rectangle', () => {
  expect(isTypeCard([W('buildd', 100, 100, 300, 70, 92)], 1920, 1280)).toBe(true);
  expect(isTypeCard([W('subtitle', 100, 100, 120, 14, 92)], 1920, 1280)).toBe(false);
  expect(isTypeCard([W('blur', 100, 100, 300, 70, 40)], 1920, 1280)).toBe(false);
});

describe('flicker: an element that re-appears (on, off, on) within 2s', () => {
  const fps = 10, blocks = 20;
  const series = (fn: (f: number, b: number) => number, n = 60) => Array.from({ length: n }, (_, f) => Uint8Array.from({ length: blocks }, (_, b) => fn(f, b)));
  test('a block that lights, dims and lights again within 2s is flagged', () => {
    const lit = (f: number) => (f >= 5 && f < 10) || (f >= 15 && f < 20);
    const f = flicker(series((fr, b) => (b === 3 && lit(fr) ? 200 : 30)), fps);
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('high');
    expect(f[0].t).toBeCloseTo(0.5, 1);
  });
  test('a reveal that stays, or a tap that pulses once (on then off), is not flicker', () => {
    expect(flicker(series((fr, b) => (b === 3 && fr >= 5 ? 200 : 30)), fps)).toEqual([]);
    expect(flicker(series((fr, b) => (b === 3 && fr >= 5 && fr < 9 ? 200 : 30)), fps)).toEqual([]);
  });
  test('a moving edge passing over (one frame dark, then the new content) is motion, not flicker', () => {
    // light, a 1-frame dark edge, light again, then a real change that stays.
    const v = (f: number) => (f === 10 ? 30 : 200);
    expect(flicker(series((fr, b) => (b === 3 ? v(fr) : 120)), fps)).toEqual([]);
  });
  test('the same toggles 3s apart are not flicker', () => {
    const lit = (f: number) => (f >= 5 && f < 10) || (f >= 40 && f < 45);
    expect(flicker(series((fr, b) => (b === 3 && lit(fr) ? 200 : 30)), fps)).toEqual([]);
  });
  test('a whole-frame change (a dip or a cut) is not an element flickering', () => {
    const dip = (f: number) => (f >= 5 && f < 8) || (f >= 12 && f < 15);
    expect(flicker(series((fr) => (dip(fr) ? 10 : 150)), fps)).toEqual([]);
  });
});

describe('seamCheck', () => {
  test('a loop whose last frame is not its first fails', () => {
    expect(seamCheck(0.62, true)?.severity).toBe('high');
    expect(seamCheck(0.97, true)).toBeNull();
    expect(seamCheck(0.1, false)).toBeNull();
  });
});

describe('fontPx: a word\'s font size from its box, by its letter shapes', () => {
  test('x-height-only words ("are") box about half the font; caps about 0.72; ascender + descender the whole em', () => {
    expect(fontPx(W('are', 0, 0, 30, 11, 90))).toBeCloseTo(20, 0);
    expect(fontPx(W('NEW', 0, 0, 30, 14.4, 90))).toBeCloseTo(20, 0);
    expect(fontPx(W('typed', 0, 0, 30, 19, 90))).toBeCloseTo(20, 0);
  });
});

describe('legibility: glyph height at display size', () => {
  const words = [W('Invoices', 10, 10, 120, 22), W('tiny', 10, 40, 30, 9)];
  test('scales source px to display px and flags readable-meant text that falls under the floor', () => {
    // 1280 source shown at 700: "Invoices" 22px box (an ascender word, ~23px font) -> 12.6px ok; "tiny" 9px box -> ~6px font, too small.
    // With no target from the renderer, small lit text is medium (high is for the lit target).
    const f = legibility(words, { sourceWidth: 1280, displayWidth: 700 });
    expect(f).toHaveLength(1);
    expect(f[0].issue).toContain('tiny');
    expect(f[0].severity).toBe('medium');
  });
  test('a word the frame edge cuts ("lling" of "billing") is a crop, not a font size: skipped', () => {
    expect(legibility([W('lling', 0, 300, 40, 9)], { sourceWidth: 1280, displayWidth: 700, sourceHeight: 720 })).toEqual([]);
    expect(legibility([W('lling', 1250, 300, 30, 9)], { sourceWidth: 1280, displayWidth: 700, sourceHeight: 720 })).toEqual([]);
  });
  test('ignores words OCR barely read (dimmed context is meant to recede)', () => {
    expect(legibility([W('tiny', 0, 0, 30, 9, 40)], { sourceWidth: 1280, displayWidth: 700 })).toEqual([]);
  });
});

describe('litWords: which words the spotlight lights (the rest is dimmed context)', () => {
  // 100x20 gray: word A drawn at full contrast (0 on 255), word B dimmed (90 on 160).
  const g = new Uint8Array(100 * 20).fill(255);
  for (let y = 4; y < 14; y++) { for (let x = 4; x < 30; x += 2) g[y * 100 + x] = 0; for (let x = 54; x < 80; x++) g[y * 100 + x] = x % 2 ? 90 : 160; }
  for (let y = 0; y < 20; y++) for (let x = 50; x < 100; x++) if (g[y * 100 + x] === 255) g[y * 100 + x] = 160;
  const words = [W('lit', 4, 4, 26, 10), W('dim', 54, 4, 26, 10)];
  test('a word at near the frame\'s best contrast is lit; one well below it is not', () => {
    const lit = litWords(words, { gray: g, width: 100, height: 20, scale: 1 });
    expect(lit.has(words[0])).toBe(true);
    expect(lit.has(words[1])).toBe(false);
  });
  test('legibility: small lit text is high; small dimmed context is only low', () => {
    const f = legibility([W('lit', 10, 10, 30, 9), W('ctx', 10, 40, 30, 9)], { sourceWidth: 1280, displayWidth: 700, lit: new Set([]) });
    expect(f.every((x) => x.severity === 'low')).toBe(true);
  });
});

describe('legibility against the lit target and artifacts (regions from the renderer)', () => {
  const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
  const target = [box(0, 0, 400, 100)], artifacts = [box(0, 200, 400, 200)];
  const o = { sourceWidth: 1280, displayWidth: 700, target, artifacts };
  test('the lit target too small is high', () => {
    expect(legibility([W('Looks', 20, 20, 60, 9)], o)[0].severity).toBe('high');
  });
  test('other lit text too small is only medium', () => {
    const w = W('subtitle', 20, 150, 60, 9);
    expect(legibility([w], { ...o, lit: new Set([w]) }).map((f) => f.severity)).toEqual(['medium']);
  });
  test('text inside an artifact (a screenshot under review) is exempt', () => {
    const w = W('3.763,97', 20, 250, 60, 9);
    expect(legibility([w], { ...o, lit: new Set([w]) })).toEqual([]);
  });
  test('OCR fragments (under 3 characters, or under 80 confidence) are not text', () => {
    expect(legibility([W('be', 20, 20, 10, 3), W('ho', 40, 20, 10, 3), W('cents', 60, 20, 40, 4, 72)], o)).toEqual([]);
  });
});

describe('collisions: text over text', () => {
  test('two words on different lines whose boxes overlap', () => {
    const f = collisions([W('Done', 100, 100, 200, 80, 90, 1), W('builder', 120, 130, 150, 30, 80, 2)]);
    expect(f).toHaveLength(1);
    expect(f[0].issue).toMatch(/Done.*builder|builder.*Done/);
  });
  test('neighbouring words on one line do not count', () => {
    expect(collisions([W('a', 0, 0, 20, 10, 90, 1), W('b', 18, 0, 20, 10, 90, 1)])).toEqual([]);
  });
  test('OCR fragments do not count: both words must be real words read with confidence', () => {
    expect(collisions([W('Done', 100, 100, 200, 80, 90, 1), W('aah', 120, 130, 150, 30, 55, 2)])).toEqual([]);
    expect(collisions([W('Done', 100, 100, 200, 80, 90, 1), W('|', 120, 130, 150, 30, 95, 2)])).toEqual([]);
  });
});

describe('textOverShape: display type with something drawn through it', () => {
  // A 200x100 gray frame, flat 20; a big word box at (60,30) 80x40.
  const frame = (stripes: boolean) => {
    const g = new Uint8Array(200 * 100).fill(20);
    if (stripes) for (let y = 40; y < 52; y++) for (let x = 0; x < 200; x++) g[y * 200 + x] = 160; // a bar across the word
    return g;
  };
  const big = [W('Done.', 60, 30, 80, 40, 92)];
  test('a big word on a flat background passes', () => {
    expect(textOverShape(big, { gray: frame(false), width: 200, height: 100, scale: 1, displayWidth: 200 })).toEqual([]);
  });
  test('a bar running through the word is flagged', () => {
    const f = textOverShape(big, { gray: frame(true), width: 200, height: 100, scale: 1, displayWidth: 200 });
    expect(f).toHaveLength(1);
    expect(f[0].issue).toContain('Done.');
  });
  test('the next word on the row is masked out of the ring, so a sentence in big type passes', () => {
    const g = new Uint8Array(200 * 100).fill(20);
    for (let y = 30; y < 70; y++) for (let x = 150; x < 190; x += 3) g[y * 200 + x] = 220; // glyph strokes of the next word
    const ws = [W('Invoices', 60, 30, 80, 40, 92, 1), W('show', 150, 30, 40, 40, 92, 1)];
    expect(textOverShape(ws, { gray: g, width: 200, height: 100, scale: 1, displayWidth: 200 })).toEqual([]);
  });
  test('punctuation and cursors are not display type', () => {
    expect(textOverShape([W('|', 60, 30, 80, 40, 92)], { gray: frame(true), width: 200, height: 100, scale: 1, displayWidth: 200 })).toEqual([]);
  });
  test('small UI text is left to the other checks (its neighbours are other UI)', () => {
    const small = [W('Done.', 60, 30, 30, 12, 92)];
    expect(textOverShape(small, { gray: frame(true), width: 200, height: 100, scale: 1, displayWidth: 200 })).toEqual([]);
  });
});

describe('confidenceCollapse: overprint shows as OCR falling apart on one frame', () => {
  test('a frame far below both neighbours is flagged; a gentle dip is not', () => {
    const frames = [{ t: 0, conf: 88, words: 20 }, { t: 0.5, conf: 41, words: 20 }, { t: 1, conf: 86, words: 20 }, { t: 1.5, conf: 80, words: 20 }];
    expect(confidenceCollapse(frames, []).map((f) => f.t)).toEqual([0.5]);
  });
  test('frames inside a crossfade are skipped (two layers blend there by design)', () => {
    const frames = [{ t: 0, conf: 88, words: 20 }, { t: 0.5, conf: 41, words: 20 }, { t: 1, conf: 86, words: 20 }];
    expect(confidenceCollapse(frames, [0.5])).toEqual([]);
  });
});

describe('numberContradictions', () => {
  test('an impossible "N of M" is flagged', () => {
    expect(numberContradictions([{ t: 1, text: 'LANDED 14 of 13' }])[0].issue).toContain('14 of 13');
  });
  test('a stat label must sit right before its number: "4 RUNNERS × 2 SLOTS" is not "runners: 2"', () => {
    expect(numberContradictions([{ t: 0, text: 'FLEET 4 RUNNERS × 2 SLOTS' }])).toEqual([]);
  });
  test('a label never reaches across a " · " line break ("YOUR ANSWERS · WORK · 11" is not answers: 11)', () => {
    expect(numberContradictions([{ t: 0, text: 'PRS MERGED · SCREENS YOU JUDGED · YOUR ANSWERS · WORK · 11 · YOUR ANSWERS 2' }])).toEqual([]);
  });
  test('one frame giving the same total two different counts is flagged', () => {
    const f = numberContradictions([{ t: 2, text: 'GOAL 4/4 CRITERIA · 3 of 4 criteria pass' }]);
    expect(f).toHaveLength(1);
  });
  test('a count the record states in words and the same count in a stat must agree', () => {
    const f = numberContradictions([{ t: 3, text: '1 decision from a human · YOUR ANSWERS 2' }]);
    expect(f).toHaveLength(1);
    expect(numberContradictions([{ t: 3, text: '2 decisions from you · YOUR ANSWERS 2' }])).toEqual([]);
  });
  test('a bare head is not compared when the frame also qualifies it (OCR dropped "JUDGED" from "SCREENS YOU JUDGED 2")', () => {
    expect(numberContradictions([{ t: 3, text: '6 screens reviewed · SCREENS REVIEWED 6 · SCREENS YOU 2 · SCREENS 6' }])).toEqual([]);
  });
  test('legibility: the lit target is high, from the renderer\'s regions', () => {
    const w = W('tiny', 10, 40, 30, 9);
    expect(legibility([w], { sourceWidth: 1280, displayWidth: 700, lit: new Set([w]), target: [{ x: 0, y: 0, w: 100, h: 100 }] })[0].severity).toBe('high');
  });
  test('a capitalized label after a number is not a count: "Iteration 1 Condition unmet" beside "Iteration 2 Condition met"', () => {
    expect(numberContradictions([{ t: 0, text: 'Iteration 1 Condition unmet COMMAND · Iteration 2 Condition met COMMAND' }])).toEqual([]);
  });
  test('consistent numbers pass', () => {
    expect(numberContradictions([{ t: 1, text: 'LANDED 13 of 13 · 4/4 criteria' }])).toEqual([]);
  });
});

test('stackedLabels: a header line that carries numbers itself is not a stat label', () => {
  const words = [W('FLEET', 400, 100, 50, 12, 90, 1), W('4', 460, 100, 10, 12, 90, 1), W('RUNNERS', 475, 100, 70, 12, 90, 1), W('2', 400, 125, 14, 22, 90, 2)];
  expect(stackedLabels(words)).toEqual([]);
});

test('stackedLabels: a stat value gets the caps label stacked above it', () => {
  const words = [W('YOUR', 400, 100, 40, 12, 90, 1), W('ANSWERS', 445, 100, 70, 12, 90, 1), W('WORK', 600, 100, 40, 12, 90, 1), W('2', 400, 125, 14, 22, 90, 2), W('31m', 600, 125, 40, 22, 90, 2)];
  expect(stackedLabels(words)).toEqual(['YOUR ANSWERS 2']);
});

describe('applyAccepted: a known false positive stays in the report, with its reason, but does not fail the run', () => {
  const rules = [{ clip: '^review', check: 'legibility', match: '3\\.763|¥', reason: 'text inside the invoice screenshot' }];
  test('a matching finding is marked accepted with the reason; exitCode ignores it', () => {
    const f = applyAccepted([{ clip: 'review-light', severity: 'high' as const, check: 'legibility', issue: 'lit text set under 9px: "3.763,97" 5.8px' }], rules);
    expect(f[0].accepted).toBe('text inside the invoice screenshot');
    expect(exitCode(f)).toBe(0);
  });
  test('anything else is untouched', () => {
    const f = applyAccepted([{ clip: 'spec', severity: 'high' as const, check: 'legibility', issue: '"3.763" 5px' }, { clip: 'review', severity: 'high' as const, check: 'judge', issue: '3.763 tiny' }], rules);
    expect(f.every((x) => !x.accepted)).toBe(true);
    expect(exitCode(f)).toBe(1);
  });
});

test('exitCode: non-zero on any high finding', () => {
  expect(exitCode([{ severity: 'low' }, { severity: 'medium' }])).toBe(0);
  expect(exitCode([{ severity: 'high' }])).toBe(1);
});
