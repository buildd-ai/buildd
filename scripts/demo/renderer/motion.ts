/**
 * Draws v6x's abstract beats (motion-model.ts) into a shot layer and returns
 * the function that poses them for a moment. Brand only: IBM Plex Mono,
 * square corners, 2px rules, hard offset shadows, the orange accent, flat
 * fills; no gradients, no blur. Bundled into the stage.
 */
import { doneIn, fleetRows, phoneChosen, screenChecks, splitAt, splitHeadline, typedChars, verifyAt, type Motion } from './motion-model';

export type MotionPalette = { bg: string; surface: string; text: string; muted: string; rule: string; shadow: string; track: string };

const ACCENT = '#f4811f';
const OK = '#3fb68b';
const MONO = "'Plex Mono Demo', 'IBM Plex Mono', Menlo, monospace";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, style: Partial<CSSStyleDeclaration>, parent: HTMLElement, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  Object.assign(e.style, style);
  if (text !== undefined) e.textContent = text;
  parent.appendChild(e);
  return e;
}

function label(layer: HTMLElement, P: MotionPalette, text: string) {
  const l = el('div', { position: 'absolute', left: '160px', top: '104px', display: 'flex', alignItems: 'center', gap: '14px', fontFamily: MONO, fontSize: '22px', fontWeight: '600', letterSpacing: '0.2em', color: P.muted }, layer);
  el('span', { width: '12px', height: '12px', background: ACCENT }, l);
  el('span', {}, l, text.toUpperCase());
}

const card = (P: MotionPalette, shadow = 8): Partial<CSSStyleDeclaration> => ({ background: P.surface, border: `2px solid ${P.rule}`, boxShadow: `${shadow}px ${shadow}px 0 0 ${P.shadow}` });

/** A square check box: an outline that fills green and draws its check as `c` goes 0 to 1. */
function checkBox(parent: HTMLElement, P: MotionPalette, size: number) {
  const box = el('div', { position: 'relative', width: `${size}px`, height: `${size}px`, flex: '0 0 auto', border: `3px solid ${P.rule}`, background: 'transparent' }, parent);
  const fill = el('div', { position: 'absolute', inset: '0', background: OK, opacity: '0' }, box);
  // Two square-ended strokes, not a glyph (Plex Mono's check reads as a "V").
  const mark = el('div', { position: 'absolute', left: `${size * 0.3}px`, top: `${size * 0.1}px`, width: `${size * 0.26}px`, height: `${size * 0.5}px`, borderRight: `${Math.round(size * 0.12)}px solid #ffffff`, borderBottom: `${Math.round(size * 0.12)}px solid #ffffff`, transform: 'rotate(45deg) scale(0.6)', opacity: '0' }, box);
  return (c: number) => {
    fill.style.opacity = String(c);
    mark.style.opacity = String(c);
    mark.style.transform = `rotate(45deg) scale(${0.6 + 0.4 * c})`;
  };
}

/**
 * The hero (motion-model `verify`): the checks, the agents' bars, then Done.
 * Desktop puts the checks left and the bars right, and Done takes the bars'
 * place; the 4:5 phone frame stacks the checks over the bars.
 */
function buildVerify(m: Extract<Motion, { kind: 'verify' }>, root: HTMLElement, P: MotionPalette, frame: { width: number; height: number }) {
  const tall = frame.height > frame.width;
  const L = tall
    ? { pad: 56, top: 64, head: 22, rowH: 118, rowTop: 128, box: 54, font: 38, gap: 26, barsTop: 650, barsW: 608, barH: 28, barGap: 18, done: 104, doneTop: 640 }
    // Desktop: the four rows (3 * 150 + 70 tall) sit centred in the frame, the label above them.
    : { pad: 160, top: 216, head: 22, rowH: 150, rowTop: 280, box: 70, font: 54, gap: 36, barsTop: 0, barsW: 600, barH: 44, barGap: 0, done: 168, doneTop: 280 + (520 - 168) / 2 };
  const head = el('div', { position: 'absolute', left: `${L.pad}px`, top: `${L.top}px`, display: 'flex', alignItems: 'center', gap: '14px', fontSize: `${L.head}px`, fontWeight: '600', letterSpacing: '0.2em', color: P.muted }, root);
  el('span', { width: '12px', height: '12px', background: ACCENT }, head);
  el('span', {}, head, m.label.toUpperCase());
  const ticks = m.checks.map((text, i) => {
    const row = el('div', { position: 'absolute', left: `${L.pad}px`, top: `${L.rowTop + i * L.rowH}px`, height: `${L.box}px`, display: 'flex', alignItems: 'center', gap: `${L.gap}px`, fontSize: `${L.font}px`, fontWeight: '600', whiteSpace: 'nowrap' }, root);
    const set = checkBox(row, P, L.box);
    const word = el('span', { opacity: '0.55' }, row, text);
    return (c: number) => { set(c); word.style.opacity = String(0.55 + 0.45 * c); };
  });
  // The bars: one per agent, each lined up with its check on desktop, stacked under the list on a phone.
  const barsX = tall ? L.pad : frame.width - L.pad - L.barsW;
  const barsBox = el('div', { position: 'absolute', left: '0', top: '0', right: '0', bottom: '0' }, root);
  const fills = m.checks.map((_, i) => {
    const y = tall ? L.barsTop + i * (L.barH + L.barGap) : L.rowTop + i * L.rowH + (L.box - L.barH) / 2;
    const track = el('div', { position: 'absolute', left: `${barsX}px`, top: `${y}px`, width: `${L.barsW}px`, height: `${L.barH}px`, background: P.track }, barsBox);
    return el('div', { position: 'absolute', left: '0', top: '0', bottom: '0', width: '0', background: m.colors[i % m.colors.length] }, track);
  });
  const done = el('div', { position: 'absolute', left: `${barsX}px`, top: `${L.doneTop}px`, display: 'flex', alignItems: 'center', gap: `${Math.round(L.done * 0.22)}px`, fontSize: `${L.done}px`, fontWeight: '600', letterSpacing: '-0.02em', opacity: '0' }, root);
  el('span', { width: `${Math.round(L.done * 0.28)}px`, height: `${Math.round(L.done * 0.28)}px`, background: ACCENT }, done);
  el('span', {}, done, 'Done.');
  return (t: number) => {
    const v = verifyAt(m, t);
    v.checks.forEach((c, i) => ticks[i](c));
    fills.forEach((f, i) => { f.style.width = `${(v.bars[i] * 100).toFixed(2)}%`; });
    // Done takes the bars' place: they leave entirely, so nothing shows through it.
    barsBox.style.opacity = String(1 - v.done);
    done.style.opacity = String(v.done);
    done.style.transform = `translateY(${20 * (1 - v.done)}px)`;
  };
}

export function buildMotion(m: Motion, layer: HTMLElement, P: MotionPalette, frame = { width: 1920, height: 1080 }): (local: number) => void {
  const root = el('div', { position: 'absolute', inset: '0', fontFamily: MONO, color: P.text }, layer);
  if (m.kind === 'verify') return buildVerify(m, root, P, frame);
  label(root, P, m.label);

  if (m.kind === 'type') {
    const box = el('div', { position: 'absolute', left: '160px', right: '160px', top: '400px', padding: '56px 64px', ...card(P, 12) }, root);
    const line = el('div', { fontSize: '62px', fontWeight: '500', lineHeight: '1.25', letterSpacing: '-0.01em' }, box);
    const typed = el('span', {}, line);
    const cursor = el('span', { display: 'inline-block', width: '0.55em', height: '1.05em', background: ACCENT, verticalAlign: '-0.18em', marginLeft: '6px' }, line);
    return (t) => {
      typed.textContent = m.text.slice(0, typedChars(m, t));
      cursor.style.opacity = t < m.to || Math.floor(t * 2) % 2 === 0 ? '1' : '0';
    };
  }

  if (m.kind === 'split') {
    const head = el('div', { position: 'absolute', left: '160px', right: '160px', top: '170px', fontSize: '34px', fontWeight: '500' }, root, m.text);
    const colW = (1600 - 2 * 48) / 3;
    const tiles: HTMLDivElement[][] = [];
    m.columns.forEach((col, c) => {
      const x = 160 + c * (colW + 48);
      el('div', { position: 'absolute', left: `${x}px`, width: `${colW}px`, top: '290px', paddingBottom: '12px', borderBottom: `2px solid ${P.rule}`, fontSize: '20px', fontWeight: '600', letterSpacing: '0.16em', color: P.muted }, root, `${c + 1}  ${col.title.toUpperCase()}`);
      tiles.push(col.tiles.map((name, r) => {
        const t = el('div', { position: 'absolute', left: `${x}px`, width: `${colW}px`, top: `${340 + r * 100}px`, height: '82px', display: 'flex', alignItems: 'center', gap: '18px', padding: '0 24px', ...card(P, 5), opacity: '0' }, root);
        el('span', { width: '12px', height: '12px', background: c === 0 ? ACCENT : P.muted, flex: '0 0 auto' }, t);
        el('span', { fontSize: '26px', fontWeight: '500' }, t, name);
        return t;
      }));
    });
    return (t) => {
      head.style.opacity = String(splitHeadline(m, t));
      splitAt(m, t).forEach((col, c) => col.forEach((p, r) => {
        const el = tiles[c][r];
        // From the top slot of its own column straight down; never sideways.
        // Straight down into its own slot, from just above it (the first only settles).
        el.style.transform = `translateY(${r === 0 ? 0 : -36 * (1 - p)}px) scale(${0.92 + 0.08 * p})`;
        el.style.opacity = String(p <= 0 ? 0 : Math.min(1, p * 3));
      }));
    };
  }

  if (m.kind === 'fleet') {
    const head = el('div', { position: 'absolute', right: '160px', top: '92px', fontSize: '30px', color: P.muted }, root);
    const count = el('span', { fontSize: '72px', fontWeight: '600', color: ACCENT }, head);
    el('span', {}, head, ` / ${m.total} agents live`);
    const grid = el('div', { position: 'absolute', left: '160px', right: '160px', top: '240px', ...card(P, 10) }, root);
    const lanes: HTMLDivElement[] = [], bars: HTMLDivElement[] = [];
    m.runners.forEach((r, ri) => {
      const row = el('div', { display: 'flex', borderTop: ri ? `2px solid ${P.track}` : 'none' }, grid);
      const name = el('div', { width: '250px', padding: '24px 28px', borderRight: `2px solid ${P.track}` }, row);
      el('div', { fontSize: '30px', fontWeight: '600' }, name, r.name);
      el('div', { fontSize: '20px', color: P.muted, marginTop: '6px' }, name, r.sub);
      const col = el('div', { flex: '1', display: 'flex', flexDirection: 'column', gap: '14px', padding: '22px 28px' }, row);
      for (const s of r.slots) {
        const lane = el('div', { height: '48px', background: P.track, position: 'relative', opacity: s ? '0.3' : '0.3' }, col);
        if (!s) { el('div', { position: 'absolute', left: '16px', top: '11px', fontSize: '20px', color: P.muted }, lane, 'idle'); continue; }
        const bar = el('div', { position: 'absolute', left: '0', top: '0', bottom: '0', width: '0', background: s.color, overflow: 'hidden' }, lane);
        el('div', { position: 'absolute', left: '16px', top: '9px', fontSize: '22px', fontWeight: '600', color: '#ffffff', whiteSpace: 'nowrap' }, bar, s.label);
        lanes.push(lane);
        bars.push(bar);
      }
    });
    return (t) => {
      const f = fleetRows(m, t);
      lanes.forEach((l, i) => { l.style.opacity = String(0.3 + 0.7 * f.lit[i]); });
      bars.forEach((b, i) => { b.style.width = `${Math.round(f.bars[i] * (58 + ((i * 17) % 36)))}%`; });
      count.textContent = String(f.live);
    };
  }

  if (m.kind === 'phone') {
    const phone = el('div', { position: 'absolute', left: '360px', top: '150px', width: '430px', height: '820px', padding: '44px 34px', ...card(P, 12) }, root);
    el('div', { display: 'flex', alignItems: 'center', gap: '12px', fontSize: '18px', fontWeight: '600', letterSpacing: '0.16em', color: ACCENT }, phone).append(
      Object.assign(document.createElement('span'), { style: `width:12px;height:12px;background:${ACCENT}` }), document.createTextNode('THE BUILDER ASKS'));
    el('div', { fontSize: '36px', fontWeight: '600', lineHeight: '1.25', margin: '28px 0 40px' }, phone, m.question);
    const opts = m.options.map((o) => {
      const b = el('div', { position: 'relative', border: `2px solid ${P.rule}`, padding: '26px 24px', marginBottom: '18px', fontSize: '26px', fontWeight: '600', overflow: 'hidden' }, phone);
      const fill = el('div', { position: 'absolute', inset: '0', background: ACCENT, opacity: '0' }, b);
      el('span', { position: 'relative' }, b, o);
      return fill;
    });
    const sent = el('div', { fontSize: '22px', color: OK, marginTop: '26px', opacity: '0' }, phone, 'Sent to the Builder.');
    const side = el('div', { position: 'absolute', left: '900px', top: '430px', width: '700px', fontSize: '44px', fontWeight: '500', lineHeight: '1.3', color: P.text }, root, 'It asks when a choice matters.');
    return (t) => {
      const c = phoneChosen(m, t);
      opts[0].style.opacity = String(c);
      sent.style.opacity = String(Math.max(0, c * 2 - 1));
      side.style.opacity = '1';
    };
  }

  if (m.kind === 'screens') {
    const [ph, dk] = m.images;
    const frames = [
      { img: ph, x: 330, y: 200, w: 330, h: 700, name: 'PHONE' },
      { img: dk, x: 740, y: 260, w: 850, h: 598, name: 'DESKTOP' },
    ];
    const stamps = frames.map((f) => {
      const fr = el('div', { position: 'absolute', left: `${f.x}px`, top: `${f.y}px`, width: `${f.w}px`, height: `${f.h}px`, overflow: 'hidden', ...card(P, 10) }, root);
      const im = el('img', { width: '100%', display: 'block' }, fr);
      im.dataset.src = f.img.src;
      const cap = el('div', { position: 'absolute', left: `${f.x}px`, top: `${f.y + f.h + 26}px`, display: 'flex', alignItems: 'center', gap: '12px', fontSize: '22px', fontWeight: '600', letterSpacing: '0.16em', color: P.muted }, root);
      const sq = el('span', { width: '14px', height: '14px', background: P.muted }, cap);
      const word = el('span', {}, cap, f.name);
      const stamp = el('div', { position: 'absolute', left: `${f.x + f.w - 52}px`, top: `${f.y - 28}px`, width: '80px', height: '80px', background: OK, border: `2px solid ${P.rule}`, boxShadow: `6px 6px 0 0 ${P.shadow}`, opacity: '0' }, root);
      // A drawn check (two square-ended strokes), not a glyph: Plex Mono's check reads as a "V".
      el('div', { position: 'absolute', left: '24px', top: '12px', width: '22px', height: '40px', borderRight: '8px solid #ffffff', borderBottom: '8px solid #ffffff', transform: 'rotate(45deg)' }, stamp);
      return { stamp, sq, word, name: f.name };
    });
    return (t) => {
      screenChecks(m, t).forEach((c, i) => {
        const s = stamps[i];
        s.stamp.style.opacity = String(c);
        s.stamp.style.transform = `scale(${1.25 - 0.25 * c})`;
        s.sq.style.background = c > 0.5 ? OK : P.muted;
        s.word.textContent = c > 0.5 ? `${s.name} · LOOKS RIGHT` : s.name;
      });
    };
  }

  // done
  const box = el('div', { position: 'absolute', left: '160px', top: '380px' }, root);
  const title = el('div', { display: 'flex', alignItems: 'center', gap: '34px', fontSize: '150px', fontWeight: '600', letterSpacing: '-0.02em' }, box);
  el('span', { width: '44px', height: '44px', background: ACCENT }, title);
  el('span', {}, title, m.title);
  const sub = el('div', { fontSize: '32px', color: P.muted, marginTop: '26px' }, box, m.sub);
  return (t) => {
    const d = doneIn(m, t);
    box.style.opacity = String(d);
    box.style.transform = `translateY(${24 * (1 - d)}px)`;
    sub.style.opacity = String(Math.max(0, (d - 0.4) / 0.6));
  };
}

/** The <img> elements a motion beat loads (its screenshots), for the stage's loader. */
export function motionImages(layer: HTMLElement): HTMLImageElement[] {
  return Array.from(layer.querySelectorAll('img'));
}
