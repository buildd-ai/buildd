/**
 * The browser stage: builds the frame's DOM once from a cut, then
 * `window.__render(t)` poses it for time t. Bundled by render.ts (Bun.build)
 * and driven frame by frame; nothing here animates on its own, so every frame
 * is a pure function of t.
 *
 * Look: square corners, 2px rules, hard offset shadows, flat fills (no blur,
 * no gradients), IBM Plex Mono caption chips with the accent square.
 */
import { cameraAt, captionsAt, clamp, cutDuration, fadeOutAt, layersAt, placeScreen, stillAt, tapAt, type Cut, type Shot } from './timeline';

const BG = '#12110f';
const SURFACE = '#1a1816';
const TEXT = '#ede8e2';
const MUTED = 'rgba(237,232,226,0.62)';
const RULE = 'rgba(255,245,230,0.55)';
const ACCENT = '#f4811f';
const SHADOW = '#000000';

type Built = {
  shot: Shot;
  layer: HTMLDivElement;
  body: HTMLDivElement;
  imgs: HTMLImageElement[];
  chips: HTMLDivElement[];
  tap: HTMLDivElement;
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, style: Partial<CSSStyleDeclaration> = {}, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  Object.assign(e.style, style);
  parent?.appendChild(e);
  return e;
}

function phoneGeometry(cut: Cut, shot: Shot) {
  const img = shot.images[0];
  const bezel = 14;
  const screenH = cut.height * 0.84;
  const scale = screenH / img.height;
  const screenW = img.width * scale;
  const w = screenW + bezel * 2;
  const h = screenH + bezel * 2;
  const centerX = cut.captions === false ? cut.width / 2 : cut.width * 0.3;
  return { bezel, scale, screenW, screenH, w, h, x: centerX - w / 2, y: (cut.height - h) / 2 };
}

function chip(parent: HTMLElement, big: boolean): HTMLDivElement {
  const c = el('div', {
    position: 'absolute', display: 'flex', alignItems: 'center', gap: big ? '20px' : '16px',
    background: SURFACE, color: TEXT, border: `2px solid ${RULE}`, boxShadow: `6px 6px 0 0 ${SHADOW}`,
    fontFamily: "'Plex Mono Demo', 'IBM Plex Mono', Menlo, monospace", fontWeight: '500',
    fontSize: big ? '36px' : '32px', lineHeight: '1.3', letterSpacing: '-0.005em',
    padding: big ? '22px 30px' : '16px 26px 16px 22px', opacity: '0', whiteSpace: big ? 'normal' : 'nowrap',
  }, parent);
  el('span', { width: big ? '14px' : '12px', height: big ? '14px' : '12px', background: ACCENT, flex: '0 0 auto' }, c);
  el('span', {}, c);
  return c;
}

function build(cut: Cut, root: HTMLElement): Built[] {
  Object.assign(root.style, { position: 'relative', width: `${cut.width}px`, height: `${cut.height}px`, overflow: 'hidden', background: BG });
  return cut.shots.map((shot) => {
    const layer = el('div', { position: 'absolute', inset: '0', opacity: '0', background: BG }, root);
    const body = el('div', { position: 'absolute', left: '0', top: '0', transformOrigin: '0 0' }, layer);
    const imgs: HTMLImageElement[] = [];
    if (shot.layout === 'phone') {
      const g = phoneGeometry(cut, shot);
      Object.assign(body.style, {
        left: `${g.x}px`, top: `${g.y}px`, width: `${g.w}px`, height: `${g.h}px`, background: '#0a0908',
        border: `2px solid ${RULE}`, boxShadow: `12px 12px 0 0 ${SHADOW}`, transformOrigin: '50% 50%',
      });
      const screen = el('div', { position: 'absolute', left: `${g.bezel - 2}px`, top: `${g.bezel - 2}px`, width: `${g.screenW}px`, height: `${g.screenH}px`, overflow: 'hidden' }, body);
      for (const im of shot.images) {
        const i = el('img', { position: 'absolute', left: '0', top: '0', width: `${g.screenW}px`, height: `${g.screenH}px`, opacity: '0' }, screen);
        i.dataset.src = im.src;
        imgs.push(i);
      }
    } else if (shot.layout === 'screen') {
      for (const im of shot.images) {
        const i = el('img', { position: 'absolute', left: '0', top: '0', width: `${im.width}px`, height: `${im.height}px`, opacity: '0' }, body);
        i.dataset.src = im.src;
        imgs.push(i);
      }
    } else if (shot.card) {
      const box = el('div', { position: 'absolute', inset: '0', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '22px' }, layer);
      const title = el('div', { display: 'flex', alignItems: 'center', gap: '22px', fontFamily: "'Plex Mono Demo', 'IBM Plex Mono', monospace", fontWeight: '600', fontSize: '72px', color: TEXT }, box);
      el('span', { width: '26px', height: '26px', background: ACCENT }, title);
      el('span', {}, title).textContent = shot.card.title;
      if (shot.card.sub) el('div', { fontFamily: "'Plex Mono Demo', 'IBM Plex Mono', monospace", fontSize: '30px', color: MUTED }, box).textContent = shot.card.sub;
    }
    const n = !shot.caption ? 0 : typeof shot.caption === 'string' ? 1 : shot.caption.length;
    const chips = Array.from({ length: cut.captions === false ? 0 : n }, () => chip(layer, shot.layout === 'phone'));
    const tap = el('div', {
      position: 'absolute', width: '72px', height: '72px', marginLeft: '-36px', marginTop: '-36px',
      border: `4px solid ${ACCENT}`, boxShadow: `4px 4px 0 0 ${SHADOW}`, opacity: '0', boxSizing: 'border-box',
    }, layer);
    el('div', { position: 'absolute', left: '50%', top: '50%', width: '14px', height: '14px', marginLeft: '-7px', marginTop: '-7px', background: ACCENT }, tap);
    return { shot, layer, body, imgs, chips, tap };
  });
}

function pose(cut: Cut, b: Built, local: number, opacity: number) {
  const { shot } = b;
  b.layer.style.opacity = String(opacity);
  b.layer.style.display = opacity > 0 ? 'block' : 'none';
  const u = clamp(local / shot.dur);
  const cam = cameraAt(shot.camera, u);
  const still = stillAt(shot.images, local);
  b.imgs.forEach((img, i) => {
    img.style.opacity = i === still.index ? String(still.alpha) : still.prev && shot.images[i].src === still.prev ? '1' : '0';
    img.style.zIndex = i === still.index ? '2' : '1';
  });
  // Where a point of the shot lands on the frame, for the tap marker.
  let toFrame = (x: number, y: number) => ({ x, y });
  if (shot.layout === 'screen') {
    const img = shot.images[still.index];
    const p = placeScreen(img, cut, cam);
    b.body.style.transform = `translate(${p.x}px, ${p.y}px) scale(${p.scale})`;
    // Framed (zoom < 1): a window with a rule and a hard shadow, both in output px.
    const framed = cam.zoom < 1;
    b.body.style.outline = framed ? `${2 / p.scale}px solid ${RULE}` : 'none';
    b.body.style.boxShadow = framed ? `${12 / p.scale}px ${12 / p.scale}px 0 0 ${SHADOW}` : 'none';
    b.body.style.width = `${img.width}px`;
    b.body.style.height = `${img.height}px`;
    toFrame = (x, y) => ({ x: p.x + x * img.width * p.scale, y: p.y + y * img.height * p.scale });
  } else if (shot.layout === 'phone') {
    const g = phoneGeometry(cut, shot);
    b.body.style.transform = `scale(${cam.zoom})`;
    const cx = g.x + g.w / 2, cy = g.y + g.h / 2;
    toFrame = (x, y) => ({
      x: cx + (g.x + g.bezel + x * g.screenW - cx) * cam.zoom,
      y: cy + (g.y + g.bezel + y * g.screenH - cy) * cam.zoom,
    });
  }
  // The last shot keeps its caption until the closing fade takes everything.
  const last = !cut.loop && b === built[built.length - 1];
  const caps = captionsAt(shot, local, last ? cut.fade + 60 : cut.fade);
  b.chips.forEach((c, i) => {
    const cap = caps[i];
    (c.lastChild as HTMLElement).textContent = cap?.text ?? '';
    c.style.opacity = String(cap?.opacity ?? 0);
    if (shot.layout === 'phone') {
      const g = phoneGeometry(cut, shot);
      Object.assign(c.style, { left: `${g.x + g.w + 110}px`, top: '50%', transform: 'translateY(-50%)', maxWidth: `${cut.width - (g.x + g.w + 110) - 110}px` });
    } else {
      Object.assign(c.style, { left: '72px', bottom: '72px' });
    }
  });
  const tap = tapAt(shot.taps, local);
  if (tap) {
    const f = toFrame(tap.x, tap.y);
    Object.assign(b.tap.style, { left: `${f.x}px`, top: `${f.y}px`, opacity: String(tap.opacity), transform: `scale(${tap.scale})` });
  } else {
    b.tap.style.opacity = '0';
  }
}

declare global {
  interface Window { __load: (cut: Cut) => Promise<{ fonts: boolean; duration: number }>; __render: (t: number) => Promise<void> }
}

let built: Built[] = [];

/** Load and decode a shot's stills; fails loudly so a frame is never shot with a missing image. */
async function ensure(b: Built) {
  await Promise.all(b.imgs.map(async (i) => {
    if (i.getAttribute('src')) return;
    await new Promise<void>((ok, fail) => {
      i.onload = () => ok();
      i.onerror = () => fail(new Error(`cannot load ${i.dataset.src}`));
      i.src = i.dataset.src!;
    });
    // decode() can reject for very large stills under a software rasterizer even
    // though the image paints; loading is the guarantee, decoding is a head start.
    await i.decode().catch(() => {});
  }));
}

function release(b: Built) {
  for (const i of b.imgs) i.removeAttribute('src');
}
let current: Cut | null = null;
let curtain: HTMLDivElement | null = null;

window.__load = async (cut: Cut) => {
  current = cut;
  const root = document.getElementById('frame') as HTMLDivElement;
  root.innerHTML = '';
  built = build(cut, root);
  curtain = el('div', { position: 'absolute', inset: '0', background: BG, opacity: '0', zIndex: '10' }, root);
  // Stills are large; only the shots on screen hold decoded images (see __render).
  for (const b of built) await ensure(b);
  for (const b of built) release(b);
  await document.fonts.ready;
  const fonts = document.fonts.check("500 32px 'Plex Mono Demo'") || document.fonts.check("500 32px 'IBM Plex Mono'");
  return { fonts, duration: cutDuration(cut) };
};

window.__render = async (t: number) => {
  if (!current) return;
  const layers = layersAt(current, t);
  const on = new Map(layers.map((l, z) => [l.index, { ...l, z }]));
  // Keep the next shot warm too, so a cut never waits on a decode mid-fade.
  const keep = new Set([...on.keys()].flatMap((i) => [i, (i + 1) % built.length]));
  for (const [i, b] of built.entries()) if (!keep.has(i)) release(b);
  for (const i of keep) await ensure(built[i]);
  built.forEach((b, i) => {
    const l = on.get(i);
    if (!l) { b.layer.style.opacity = '0'; b.layer.style.display = 'none'; return; }
    b.layer.style.zIndex = String(l.z + 1);
    pose(current!, b, l.local, l.opacity);
  });
  if (curtain) curtain.style.opacity = String(fadeOutAt(current, t));
};
