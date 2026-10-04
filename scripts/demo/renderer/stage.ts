/**
 * The browser stage: builds the frame's DOM once from a cut, then
 * `window.__render(t)` poses it for time t. Bundled by render.ts (Bun.build)
 * and driven frame by frame; nothing here animates on its own, so every frame
 * is a pure function of t (the clock is timeline.ts).
 *
 * Look: square corners, 2px rules, hard offset shadows, flat fills (no blur,
 * no gradients), IBM Plex Mono caption chips with the accent square. A dark
 * and a light palette, picked by the cut's `theme`.
 *
 * On a screen shot, everything the edit adds (spotlight, masks, marks, the
 * Board's flying tiles) lives in an `fx` layer inside the transformed image,
 * in image pixels, so it tracks the camera exactly.
 */
import { buildMotion, motionImages } from './motion';
import { burstPose, captionPlace, cameraAt, captionsAt, clamp, cutDuration, fadeOutAt, fleetAt, layersAt, maskAt, placeScreen, spotAt, stillAt, tapAt, type Cut, type Rect, type Shot } from './timeline';

type Palette = { bg: string; surface: string; text: string; muted: string; rule: string; shadow: string; dim: string; track: string };
const PALETTES: Record<'dark' | 'light', Palette> = {
  dark: { bg: '#12110f', surface: '#1a1816', text: '#ede8e2', muted: 'rgba(237,232,226,0.62)', rule: 'rgba(255,245,230,0.55)', shadow: '#000000', dim: '#0a0908', track: '#26231f' },
  light: { bg: '#ebe6de', surface: '#f7f4ee', text: '#1f1b17', muted: 'rgba(31,27,23,0.6)', rule: '#1a1512', shadow: '#1a1512', dim: '#f4f0e9', track: '#ddd7cc' },
};
const ACCENT = '#f4811f';
const MONO = "'Plex Mono Demo', 'IBM Plex Mono', Menlo, monospace";

type Built = {
  shot: Shot;
  layer: HTMLDivElement;
  body: HTMLDivElement;
  imgs: HTMLImageElement[];
  fx?: { root: HTMLDivElement; svg: SVGSVGElement; path: SVGPathElement; masks: HTMLDivElement[]; marks: HTMLDivElement[]; sprites: HTMLDivElement[]; covers: HTMLDivElement[] };
  fleet?: { bars: HTMLDivElement[]; rows: HTMLDivElement[]; count: HTMLSpanElement };
  motion?: (local: number) => void;
  place: 'top' | 'bottom';
  chips: HTMLDivElement[];
  scrim?: HTMLDivElement;
  tap: HTMLDivElement;
};

let P: Palette = PALETTES.dark;

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

function chip(parent: HTMLElement, cut: Cut, side: boolean): HTMLDivElement {
  const size = cut.captionSize ?? 32;
  const c = el('div', {
    position: 'absolute', display: 'flex', alignItems: 'center', gap: `${Math.round(size * 0.55)}px`,
    background: P.surface, color: P.text, border: `2px solid ${P.rule}`, boxShadow: `6px 6px 0 0 ${P.shadow}`,
    fontFamily: MONO, fontWeight: '500', fontSize: `${size}px`, lineHeight: '1.3', letterSpacing: '-0.005em',
    padding: `${Math.round(size * 0.55)}px ${Math.round(size * 0.85)}px ${Math.round(size * 0.55)}px ${Math.round(size * 0.7)}px`,
    opacity: '0', whiteSpace: side ? 'normal' : 'nowrap', zIndex: '5',
  }, parent);
  const sq = Math.round(size * 0.38);
  el('span', { width: `${sq}px`, height: `${sq}px`, background: ACCENT, flex: '0 0 auto' }, c);
  el('span', {}, c);
  return c;
}

const SVG = 'http://www.w3.org/2000/svg';

function buildFx(shot: Shot, body: HTMLElement): Built['fx'] {
  if (!shot.spot && !shot.masks && !shot.marks && !shot.burst) return undefined;
  // Above the stills (z-index 1), as its own stacking context.
  const root = el('div', { position: 'absolute', left: '0', top: '0', pointerEvents: 'none', zIndex: '2' }, body);
  const box = { position: 'absolute', left: '0', top: '0', opacity: '0' } as Partial<CSSStyleDeclaration>;
  const masks = (shot.masks ?? []).map(() => el('div', { ...box }, root));
  const covers = (shot.burst?.tiles ?? []).map(() => el('div', { ...box }, root));
  // The spotlight is a masked flat rect: white keeps the dim, black holes let
  // the still through. A mask (not an even-odd path) so overlapping holes,
  // e.g. a card and the button on it, stay lit.
  const svg = document.createElementNS(SVG, 'svg');
  Object.assign(svg.style, { position: 'absolute', left: '0', top: '0', overflow: 'visible' });
  const id = `spot-${Math.random().toString(36).slice(2)}`;
  const mask = document.createElementNS(SVG, 'mask');
  mask.setAttribute('id', id);
  mask.setAttribute('maskUnits', 'userSpaceOnUse');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('fill', P.dim);
  path.setAttribute('mask', `url(#${id})`);
  svg.append(mask, path);
  root.appendChild(svg);
  const sprites = (shot.burst?.tiles ?? []).map(() => el('div', { ...box, backgroundRepeat: 'no-repeat', transformOrigin: '50% 50%' }, root));
  const marks = (shot.marks ?? []).map(() => el('div', { ...box, background: ACCENT }, root));
  return { root, svg, path, masks, marks, sprites, covers };
}

function buildFleet(shot: Shot, layer: HTMLElement): Built['fleet'] {
  const f = shot.fleet!;
  const wrap = el('div', { position: 'absolute', left: '160px', right: '160px', top: '120px', fontFamily: MONO, color: P.text }, layer);
  const head = el('div', { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '34px' }, wrap);
  el('div', { fontSize: '24px', letterSpacing: '0.2em', color: P.muted, fontWeight: '600' }, head).textContent = `FLEET · ${f.runners.length} RUNNERS × ${f.runners[0]?.slots.length ?? 0} SLOTS`;
  const countBox = el('div', { fontSize: '30px', color: P.muted }, head);
  const count = el('span', { fontSize: '64px', fontWeight: '600', color: ACCENT }, countBox);
  el('span', {}, countBox).textContent = ` / ${f.total} agents live`;
  const grid = el('div', { border: `2px solid ${P.rule}`, background: P.surface, boxShadow: `8px 8px 0 0 ${P.shadow}` }, wrap);
  const bars: HTMLDivElement[] = [];
  const rows: HTMLDivElement[] = [];
  f.runners.forEach((r, ri) => {
    const row = el('div', { display: 'flex', borderTop: ri ? `2px solid ${P.track}` : 'none' }, grid);
    const name = el('div', { width: '260px', padding: '22px 28px', borderRight: `2px solid ${P.track}` }, row);
    el('div', { fontSize: '30px', fontWeight: '600' }, name).textContent = r.name;
    el('div', { fontSize: '20px', color: P.muted, marginTop: '6px' }, name).textContent = r.sub;
    const lanes = el('div', { flex: '1', display: 'flex', flexDirection: 'column', gap: '14px', padding: '20px 28px', justifyContent: 'center' }, row);
    for (const slot of r.slots) {
      const lane = el('div', { height: '44px', background: P.track, position: 'relative' }, lanes);
      if (!slot) {
        el('div', { position: 'absolute', left: '16px', top: '9px', fontSize: '20px', color: P.muted }, lane).textContent = 'idle';
        continue;
      }
      const bar = el('div', { position: 'absolute', left: '0', top: '0', bottom: '0', width: '0', background: slot.color, overflow: 'hidden' }, lane);
      el('div', { position: 'absolute', left: '16px', top: '8px', fontSize: '22px', fontWeight: '600', color: '#ffffff', whiteSpace: 'nowrap' }, bar).textContent = slot.label;
      bars.push(bar);
      rows.push(lane);
    }
  });
  return { bars, rows, count };
}

function build(cut: Cut, root: HTMLElement): Built[] {
  Object.assign(root.style, { position: 'relative', width: `${cut.width}px`, height: `${cut.height}px`, overflow: 'hidden', background: P.bg });
  return cut.shots.map((shot) => {
    const layer = el('div', { position: 'absolute', inset: '0', opacity: '0', background: P.bg }, root);
    const body = el('div', { position: 'absolute', left: '0', top: '0', transformOrigin: '0 0' }, layer);
    const imgs: HTMLImageElement[] = [];
    let fx: Built['fx'];
    let fleet: Built['fleet'];
    let motion: Built['motion'];
    if (shot.layout === 'phone') {
      const g = phoneGeometry(cut, shot);
      Object.assign(body.style, {
        left: `${g.x}px`, top: `${g.y}px`, width: `${g.w}px`, height: `${g.h}px`, background: '#0a0908',
        border: `2px solid ${P.rule}`, boxShadow: `12px 12px 0 0 ${P.shadow}`, transformOrigin: '50% 50%',
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
      fx = buildFx(shot, body);
    } else if (shot.layout === 'fleet' && shot.fleet) {
      fleet = buildFleet(shot, layer);
    } else if (shot.layout === 'motion' && shot.motion) {
      motion = buildMotion(shot.motion, layer, P, { width: cut.width, height: cut.height });
      imgs.push(...motionImages(layer));
    } else if (shot.card) {
      const box = el('div', { position: 'absolute', inset: '0', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '22px' }, layer);
      const title = el('div', { display: 'flex', alignItems: 'center', gap: '22px', fontFamily: MONO, fontWeight: '600', fontSize: '72px', color: P.text }, box);
      el('span', { width: '26px', height: '26px', background: ACCENT }, title);
      el('span', {}, title).textContent = shot.card.title;
      if (shot.card.sub) el('div', { fontFamily: MONO, fontSize: '30px', color: P.muted }, box).textContent = shot.card.sub;
    }
    const n = !shot.caption ? 0 : typeof shot.caption === 'string' ? 1 : shot.caption.length;
    const chips = Array.from({ length: cut.captions === false ? 0 : n }, () => chip(layer, cut, shot.layout === 'phone'));
    const tap = el('div', {
      position: 'absolute', width: '72px', height: '72px', marginLeft: '-36px', marginTop: '-36px',
      border: `4px solid ${ACCENT}`, boxShadow: `4px 4px 0 0 ${P.shadow}`, opacity: '0', boxSizing: 'border-box', zIndex: '6',
    }, layer);
    const dot = el('div', { position: 'absolute', left: '50%', top: '50%', width: '14px', height: '14px', marginLeft: '-7px', marginTop: '-7px', background: ACCENT }, tap);
    dot.dataset.dot = '1';
    const place = captionPlace(cut, shot);
    // Under the caption chips: the ground fading in from the caption's edge (cut.captionScrim).
    const scrim = cut.captionScrim && chips.length
      ? el('div', { position: 'absolute', left: '0', right: '0', [place === 'top' ? 'top' : 'bottom']: '0', height: `${Math.round(cut.height * 0.36)}px`, zIndex: '4', opacity: '0',
          background: `linear-gradient(to ${place === 'top' ? 'bottom' : 'top'}, color-mix(in srgb, ${P.bg} 96%, transparent) 62%, transparent)` }, layer)
      : undefined;
    return { shot, layer, body, imgs, fx, fleet, motion, chips, scrim, tap, place };
  });
}

// ── Colour sampling for 'auto' masks: what is behind the cover, from the still itself.
const sampled = new Map<string, string>();
const canvas = document.createElement('canvas');
canvas.width = canvas.height = 1;
const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
function sampleAt(img: HTMLImageElement, x: number, y: number): string {
  const key = `${img.dataset.src}|${x.toFixed(4)}|${y.toFixed(4)}`;
  let c = sampled.get(key);
  if (!c) {
    ctx.clearRect(0, 0, 1, 1);
    ctx.drawImage(img, Math.round(x * img.naturalWidth), Math.round(y * img.naturalHeight), 1, 1, 0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    c = `rgb(${r},${g},${b})`;
    sampled.set(key, c);
  }
  return c;
}

function px(r: Rect, W: number, H: number) {
  return { left: r.x * W, top: r.y * H, width: r.w * W, height: r.h * H };
}

function poseFx(b: Built, local: number, img: HTMLImageElement, W: number, H: number, scale: number) {
  const fx = b.fx!;
  const { shot } = b;
  Object.assign(fx.root.style, { width: `${W}px`, height: `${H}px` });
  // Masks: covers that fade or wipe away to reveal what is under them.
  (shot.masks ?? []).forEach((m, i) => {
    const s = maskAt(m, local, shot.dur + 5);
    const d = fx.masks[i];
    if (s.opacity <= 0) { d.style.opacity = '0'; return; }
    const r = px(m.rect, W, H);
    const fill = m.fill === 'dim' ? P.dim : !m.fill || m.fill === 'auto'
      ? sampleAt(img, m.sample?.x ?? m.rect.x + 3 / W, m.sample?.y ?? m.rect.y + 3 / H)
      : m.fill;
    Object.assign(d.style, {
      left: `${r.left + r.width * s.left}px`, top: `${r.top}px`, width: `${r.width * (1 - s.left)}px`, height: `${r.height}px`,
      background: fill, opacity: String(m.fill === 'dim' ? s.opacity * 0.62 : s.opacity),
    });
  });
  // The burst: each tile lifted off the still, flying to its place (burstPose).
  if (shot.burst) {
    const bu = shot.burst;
    bu.tiles.forEach((t, i) => {
      const q = burstPose(bu, i, local);
      const r = px(t, W, H);
      const cover = fx.covers[i];
      const sp = fx.sprites[i];
      if (q.p >= 1) { cover.style.opacity = '0'; sp.style.opacity = '0'; return; }
      const sx = bu.sample === 'left' ? t.x - 8 / W : t.x + 3 / W;
      Object.assign(cover.style, { left: `${r.left - 2}px`, top: `${r.top - 2}px`, width: `${r.width + 6}px`, height: `${r.height + 6}px`, background: sampleAt(img, sx, t.y + t.h / 2), opacity: '1' });
      const dx = (q.x + q.w / 2 - (t.x + t.w / 2)) * W;
      const dy = (q.y + q.h / 2 - (t.y + t.h / 2)) * H;
      const sh = Math.round(8 * (1 - q.p)) / scale;
      Object.assign(sp.style, {
        left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`,
        backgroundImage: `url("${img.dataset.src}")`, backgroundSize: `${W}px ${H}px`, backgroundPosition: `${-r.left}px ${-r.top}px`,
        transform: `translate(${dx}px, ${dy}px) scale(${q.scale})`, opacity: String(q.opacity),
        boxShadow: sh > 0 ? `${sh}px ${sh}px 0 0 ${P.shadow}` : 'none', zIndex: '2',
      });
    });
  }
  // The spotlight: one flat dim over everything but the holes.
  const spot = spotAt(shot.spot, local);
  if (spot.dim > 0) {
    // Padding in output pixels, applied after the zoom: the hole always clears its element.
    const k = ((shot.spot ?? []).filter((x) => x.at <= local).pop()?.padPx ?? 0) / scale;
    const holes = spot.rects.filter((r) => r.w > 0 && r.h > 0).map((r) => px(r, W, H));
    const mask = fx.svg.querySelector('mask')!;
    mask.setAttribute('x', '0'); mask.setAttribute('y', '0'); mask.setAttribute('width', String(W)); mask.setAttribute('height', String(H));
    mask.innerHTML = `<rect x="0" y="0" width="${W}" height="${H}" fill="white"/>` + holes.map((q) => `<rect x="${q.left - k}" y="${q.top - k}" width="${q.width + 2 * k}" height="${q.height + 2 * k}" fill="black"/>`).join('');
    fx.svg.setAttribute('width', String(W));
    fx.svg.setAttribute('height', String(H));
    fx.path.setAttribute('d', `M0 0H${W}V${H}H0Z`);
    fx.path.setAttribute('fill-opacity', String(spot.dim));
    fx.svg.style.display = 'block';
  } else {
    fx.svg.style.display = 'none';
  }
  // Marks: an accent underline under a phrase.
  (shot.marks ?? []).forEach((m, i) => {
    const o = Math.min(ease01((local - m.from) / 0.3), 1 - ease01((local - m.to) / 0.3));
    const r = px(m.rect, W, H);
    const d = fx.marks[i];
    const grow = ease01((local - m.from) / 0.5);
    Object.assign(d.style, { left: `${r.left}px`, top: `${r.top + r.height + 4 / scale}px`, width: `${r.width * grow}px`, height: `${5 / scale}px`, opacity: String(Math.max(0, o)), zIndex: '3' });
  });
}

function ease01(u: number) {
  const x = clamp(u);
  return x * x * (3 - 2 * x);
}

function poseFleet(b: Built, local: number) {
  const f = fleetAt(b.shot.fleet!, local);
  b.fleet!.bars.forEach((bar, i) => {
    bar.style.width = `${Math.round(f.bars[i] * (56 + ((i * 17) % 38)))}%`;
  });
  b.fleet!.count.textContent = String(f.live);
}

type Px = [x: number, y: number, w: number, h: number];
type Regions = { target: Px[]; artifacts: Px[] };
let lastRegions: Regions = { target: [], artifacts: [] };

function pose(cut: Cut, b: Built, local: number, opacity: number): Regions {
  const { shot } = b;
  b.layer.style.opacity = String(opacity);
  b.layer.style.display = opacity > 0 ? 'block' : 'none';
  const u = clamp(local / shot.dur);
  const cam = cameraAt(shot.camera, u);
  let toFrame = (x: number, y: number) => ({ x, y });
  if (b.imgs.length && (shot.layout === 'screen' || shot.layout === 'phone')) {
    const still = stillAt(shot.images, local);
    b.imgs.forEach((img, i) => {
      img.style.opacity = i === still.index ? String(still.alpha) : still.prev && shot.images[i].src === still.prev ? '1' : '0';
      img.style.zIndex = i === still.index ? '1' : '0';
    });
    if (shot.layout === 'screen') {
      const img = shot.images[still.index];
      const p = placeScreen(img, cut, cam);
      b.body.style.transform = `translate(${p.x}px, ${p.y}px) scale(${p.scale})`;
      const framed = cam.zoom < 1;
      b.body.style.outline = framed ? `${2 / p.scale}px solid ${P.rule}` : 'none';
      b.body.style.boxShadow = framed ? `${12 / p.scale}px ${12 / p.scale}px 0 0 ${P.shadow}` : 'none';
      b.body.style.width = `${img.width}px`;
      b.body.style.height = `${img.height}px`;
      if (b.fx) poseFx(b, local, b.imgs[still.index], img.width, img.height, p.scale);
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
  }
  if (b.fleet) poseFleet(b, local);
  if (b.motion) {
    b.motion(local);
    toFrame = (x, y) => ({ x: x * cut.width, y: y * cut.height });
  }
  // Where the lit target and the artifacts land in the frame, for demo:review.
  const px = (r: Rect): Px => { const a = toFrame(r.x, r.y), z = toFrame(r.x + r.w, r.y + r.h); return [Math.round(a.x), Math.round(a.y), Math.round(z.x - a.x), Math.round(z.y - a.y)]; };
  const lit = spotAt(shot.spot, local);
  const regions: Regions = { target: lit.dim > 0 ? lit.rects.map(px) : [], artifacts: (shot.artifacts ?? []).map(px) };
  const last = !cut.loop && b === built[built.length - 1];
  const caps = captionsAt(shot, local, last ? cut.fade + 60 : cut.fade);
  // On for the whole captioned shot (fading with its layer): a scrim that faded in with the caption let dimmed UI show through mid-fade.
  if (b.scrim) b.scrim.style.opacity = '1';
  b.chips.forEach((c, i) => {
    const cap = caps[i];
    (c.lastChild as HTMLElement).textContent = cap?.text ?? '';
    c.style.opacity = String(cap?.opacity ?? 0);
    if (shot.layout === 'phone') {
      const g = phoneGeometry(cut, shot);
      Object.assign(c.style, { left: `${g.x + g.w + 110}px`, top: '50%', transform: 'translateY(-50%)', maxWidth: `${cut.width - (g.x + g.w + 110) - 110}px` });
    } else {
      Object.assign(c.style, b.place === 'top' ? { left: '72px', top: '72px', bottom: 'auto' } : { left: '72px', bottom: '72px', top: 'auto' });
    }
  });
  const tap = tapAt(shot.taps, local);
  const dot = b.tap.querySelector<HTMLElement>('[data-dot]');
  if (tap?.rect) {
    // Outline the control just outside its edge, pulsing in; nothing lands on the label.
    const a = toFrame(tap.rect.x, tap.rect.y), z = toFrame(tap.rect.x + tap.rect.w, tap.rect.y + tap.rect.h);
    const pad = 6 + 10 * (tap.scale - 1);
    Object.assign(b.tap.style, { left: `${a.x - pad}px`, top: `${a.y - pad}px`, width: `${z.x - a.x + 2 * pad}px`, height: `${z.y - a.y + 2 * pad}px`, marginLeft: '0', marginTop: '0', opacity: String(tap.opacity), transform: 'none' });
    if (dot) dot.style.display = 'none';
  } else if (tap) {
    const f = toFrame(tap.x, tap.y);
    Object.assign(b.tap.style, { left: `${f.x}px`, top: `${f.y}px`, width: '72px', height: '72px', marginLeft: '-36px', marginTop: '-36px', opacity: String(tap.opacity), transform: `scale(${tap.scale})` });
    if (dot) dot.style.display = 'block';
  } else {
    b.tap.style.opacity = '0';
  }
  return regions;
}

declare global {
  interface Window { __load: (cut: Cut) => Promise<{ fonts: boolean; duration: number }>; __render: (t: number) => Promise<void>; __regions: () => Regions }
}

let built: Built[] = [];

/** Load a shot's stills; fails loudly so a frame is never shot with a missing image. */
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
  P = PALETTES[cut.theme ?? 'dark'];
  document.body.style.background = P.bg;
  const root = document.getElementById('frame') as HTMLDivElement;
  root.innerHTML = '';
  built = build(cut, root);
  curtain = el('div', { position: 'absolute', inset: '0', background: P.bg, opacity: '0', zIndex: '10' }, root);
  // Stills are large; only the shots on screen hold decoded images (see __render).
  for (const b of built) await ensure(b);
  for (const b of built) release(b);
  await document.fonts.ready;
  const fonts = document.fonts.check("500 32px 'Plex Mono Demo'") || document.fonts.check("500 32px 'IBM Plex Mono'");
  return { fonts, duration: cutDuration(cut) };
};

window.__regions = () => lastRegions;

window.__render = async (t: number) => {
  if (!current) return;
  const layers = layersAt(current, t);
  const on = new Map(layers.map((l, z) => [l.index, { ...l, z }]));
  // Keep the next shot warm too, so a cut never waits on a decode mid-fade.
  const keep = new Set([...on.keys()].flatMap((i) => [i, (i + 1) % built.length]));
  for (const [i, b] of built.entries()) if (!keep.has(i)) release(b);
  for (const i of keep) await ensure(built[i]);
  let best = -1;
  built.forEach((b, i) => {
    const l = on.get(i);
    if (!l) { b.layer.style.opacity = '0'; b.layer.style.display = 'none'; return; }
    b.layer.style.zIndex = String(l.z + 1);
    const r = pose(current!, b, l.local, l.opacity);
    if (l.opacity > best) { best = l.opacity; lastRegions = r; }
  });
  if (curtain) curtain.style.opacity = String(fadeOutAt(current, t));
};
