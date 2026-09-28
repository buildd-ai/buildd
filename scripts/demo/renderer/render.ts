/**
 * render.ts: turn a storyboard's stills into the demo film, frame by frame.
 *
 *   bun run demo:render --shots <dir>/demo-v5 --out <video dir> [--cuts v5a,v5b,v5c] [--only full,hero] [--stills 2,9.5]
 *   bun run demo:render --shots <dir>/demo-v4 --out <video dir>            # the v4 cut
 *
 * <dir>/demo-v4 is what `bun run demo:shoot scripts/demo/storyboards/demo-v4.yaml --out <dir>`
 * wrote (manifest.json + PNGs). The cuts live in cuts.ts; the clock in timeline.ts.
 *
 * How: a loopback-only Bun server hosts the stage (stage.ts, bundled here) and
 * the stills; headless Chromium (Playwright) poses the stage for each frame and
 * screenshots it; ffmpeg encodes. The soundtrack is synthesized (audio.ts).
 * Only local tools: bun, Playwright's Chromium, ffmpeg. Nothing is uploaded.
 *
 * Each cut family (FAMILIES: v4, v5a dark, v5b light, v5c simple) writes to its
 * own folder under --out (v5a → a/, ...; v4 → the root), named by its prefix:
 *   <prefix>.mp4 / .webm                       full cut with soundtrack
 *   <prefix>-silent.mp4 / .webm                full cut, no audio
 *   <prefix>-hero.mp4 / .webm / .webp          16s seamless loop, silent
 *   <prefix>-hero-poster.jpg, <prefix>-poster.jpg
 *   contact-full.jpg, contact-hero.jpg         one frame per second, tiled
 *   key-<cut>-<name>.png                       the cut's named review stills
 *   shotlist.json                              shots, timings, captions
 * `--stills t1,t2` writes still-<cut>-<t>.png at those times instead of encoding.
 */
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { fullCut, heroLoop, type Stills } from './cuts';
import { v5Film, v5Hero, type V5 } from './cuts-v5';
import { cutDuration, frameCount, shotStarts, soundCues, type Cut, type Rect, type ShotImage } from './timeline';
import { synthesize, wav } from './audio';

const ROOT = resolve(import.meta.dir, '../../..');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

export function pngSize(buf: Uint8Array): { width: number; height: number } {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (v.getUint32(0) !== 0x89504e47) throw new Error('not a PNG');
  return { width: v.getUint32(16), height: v.getUint32(20) };
}

/** The storyboard manifest as a still lookup for the cuts. Missing stills or boxes fail loudly, before any rendering. */
export function stillsFrom(manifest: any, dir: string, theme: string, files = new Map<string, string>()): Stills & { files: Map<string, string> } {
  const step = (id: string) => {
    const s = manifest.steps.find((x: any) => x.id === id);
    if (!s) throw new Error(`[render] storyboard has no step "${id}" (re-run demo:shoot?)`);
    return s;
  };
  const image = (file: string, at = 0): ShotImage => {
    const path = join(dir, file);
    if (!existsSync(path)) throw new Error(`[render] missing still ${path}`);
    const { width, height } = pngSize(readFileSync(path));
    const src = `/shots/${encodeURIComponent(file)}`;
    files.set(src, path);
    return { src, at, width, height };
  };
  const keyOf = (viewport: string) => (viewport === 'desktop' ? theme : `${viewport}-${theme}`);
  const img = (id: string, viewport = 'desktop', at = 0) => {
    const file = step(id).files[keyOf(viewport)];
    if (!file) throw new Error(`[render] step "${id}" has no ${keyOf(viewport)} still`);
    return image(file, at);
  };
  /** CSS-px box → fractions of that step's still. */
  const frac = (id: string, viewport: string, b: { x: number; y: number; width: number; height: number }): Rect => {
    const im = img(id, viewport);
    const scale = manifest.viewports?.[viewport]?.scale ?? (viewport === 'phone' ? 3 : 2);
    const W = im.width / scale, H = im.height / scale;
    return { x: b.x / W, y: b.y / H, w: b.width / W, h: b.height / H };
  };
  const boxes = (id: string, target: string, viewport = 'desktop'): Rect[] => {
    const h = (step(id).highlights?.[keyOf(viewport)] ?? []).find((x: any) => x.target === target);
    if (!h?.boxes?.length) throw new Error(`[render] step "${id}" recorded no "${target}" box (${keyOf(viewport)})`);
    return h.boxes.map((b: any) => frac(id, viewport, b));
  };
  return {
    files,
    img,
    typing: (id) => {
      const list: string[] | undefined = step(id).files[`${theme}Type`];
      if (!list?.length) throw new Error(`[render] step "${id}" has no typing frames`);
      return list.map((f) => image(f));
    },
    boxes,
    box: (id, target, index = 0, viewport = 'desktop') => {
      const all = boxes(id, target, viewport);
      if (!all[index]) throw new Error(`[render] step "${id}" has no "${target}" box #${index}`);
      return all[index];
    },
    boxAttrs: (id, target, viewport = 'desktop') => {
      const h = (step(id).highlights?.[keyOf(viewport)] ?? []).find((x: any) => x.target === target);
      return (h?.boxes ?? []).map((b: any) => ({ ...b, rect: frac(id, viewport, b) }));
    },
    text: (id, phrase, viewport = 'desktop') => {
      const t = (step(id).texts?.[keyOf(viewport)] ?? []).find((x: any) => x.text === phrase);
      if (!t?.rects?.length) throw new Error(`[render] step "${id}" recorded no text box for "${phrase}"`);
      return { rects: t.rects.map((b: any) => frac(id, viewport, b)), block: frac(id, viewport, t.block) };
    },
  };
}

/** Plex Mono faces from the demo server's own build, so captions use the app's font file. */
function fontCss(): { css: string; media: Map<string, string> } {
  const media = new Map<string, string>();
  const dir = join(ROOT, 'apps/web/.next/static');
  const rules: string[] = [];
  const walk = (d: string): string[] => existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.css') ? [join(d, e.name)] : []) : [];
  for (const file of walk(join(dir, 'chunks'))) {
    for (const rule of readFileSync(file, 'utf8').match(/@font-face\{[^}]*\}/g) ?? []) {
      if (!/IBM Plex Mono/.test(rule) || !/U\+0000-00FF/i.test(rule)) continue;
      const url = /url\(\.\.\/media\/([^)]+)\)/.exec(rule)?.[1];
      if (!url) continue;
      media.set(`/media/${url}`, join(dir, 'media', url));
      rules.push(rule.replace(/font-family:[^;]+;/, "font-family:'Plex Mono Demo';").replace(/url\(\.\.\/media\//, 'url(/media/'));
    }
  }
  return { css: rules.join('\n'), media };
}

function sh(cmd: string[], quiet = true) {
  const r = Bun.spawnSync(cmd, { stdout: quiet ? 'ignore' : 'inherit', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`[render] ${cmd[0]} failed:\n${r.stderr.toString().slice(-2000)}`);
}

/** A family of cuts: one film and its hero loop, rendered into `dir` under `prefix`. */
type Family = { dir: string; prefix: string; theme: 'dark' | 'light'; cuts: (s: Stills) => Cut[] };
const v5 = (variant: V5, theme: 'dark' | 'light'): Family => ({
  dir: variant, prefix: `buildd-demo-v5${variant}`, theme,
  cuts: (s) => [v5Film(s, variant, theme), v5Hero(s, variant, theme)],
});
export const FAMILIES: Record<string, Family> = {
  v4: { dir: '.', prefix: 'buildd-demo-v4', theme: 'dark', cuts: (s) => [fullCut(s), heroLoop(s)] },
  v5a: v5('a', 'dark'),
  v5b: v5('b', 'light'),
  v5c: v5('c', 'light'),
};

async function main() {
  const shotsDir = resolve(arg('shots') ?? '');
  const outRoot = resolve(arg('out') ?? join(import.meta.dir, '../out/video')); // gitignored: videos stay out of git
  if (!existsSync(join(shotsDir, 'manifest.json'))) {
    console.error('usage: bun run demo:render --shots <storyboard out>/<name> --out <dir> [--cuts v5a,v5b,v5c] [--only full,hero] [--stills 2,9.5]');
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(join(shotsDir, 'manifest.json'), 'utf8'));
  const names = arg('cuts')?.split(',') ?? (/demo-v5\.ya?ml$/.test(manifest.storyboard ?? '') ? ['v5a', 'v5b', 'v5c'] : ['v4']);
  const only = arg('only')?.split(',') ?? ['full', 'hero'];
  const stillTimes = arg('stills')?.split(',').map(Number);
  const files = new Map<string, string>();
  const jobs = names.map((name) => {
    const fam = FAMILIES[name];
    if (!fam) throw new Error(`[render] unknown cut family "${name}" (${Object.keys(FAMILIES).join(', ')})`);
    const stills = stillsFrom(manifest, shotsDir, arg('theme') ?? fam.theme, files);
    return { name, fam, outDir: join(outRoot, fam.dir), cuts: fam.cuts(stills).filter((c) => only.includes(c.name)) };
  });

  const build = await Bun.build({ entrypoints: [join(import.meta.dir, 'stage.ts')], target: 'browser', minify: false });
  if (!build.success) throw new Error(`[render] stage bundle failed: ${build.logs.join('\n')}`);
  const js = await build.outputs[0].text();
  const fonts = fontCss();
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${fonts.css}
html,body{margin:0}*{box-sizing:border-box}img{display:block}</style></head>
<body><div id="frame"></div><script type="module">${js}</script></body></html>`;

  // Loopback only: the stills and fonts never leave the machine.
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(req) {
      const path = decodeURIComponent(new URL(req.url).pathname);
      if (path === '/') return new Response(html, { headers: { 'content-type': 'text/html' } });
      const file = files.get(`/shots/${encodeURIComponent(path.slice('/shots/'.length))}`) ?? fonts.media.get(path);
      return file ? new Response(Bun.file(file)) : new Response('not found', { status: 404 });
    },
  });

  const browser = await chromium.launch({ headless: true });
  try {
    for (const job of jobs) {
      const { outDir, fam } = job;
      const PREFIX = fam.prefix;
      mkdirSync(outDir, { recursive: true });
      const shotlist: any = { generatedAt: new Date().toISOString(), family: job.name, theme: fam.theme, cuts: [] };
      for (const cut of job.cuts) {
        const page = await browser.newPage({ viewport: { width: cut.width, height: cut.height }, deviceScaleFactor: 1 });
        page.on('pageerror', (e) => console.warn(`[render] stage error: ${e.message}`));
        await page.goto(`http://127.0.0.1:${server.port}/`);
        await page.waitForFunction(() => typeof window.__load === 'function');
        const loaded = await page.evaluate((c) => window.__load(c), cut as any);
        if (!loaded.fonts) console.warn('[render] IBM Plex Mono not available; captions fall back to Menlo');
        const duration = cutDuration(cut);
        const starts = shotStarts(cut);
        shotlist.cuts.push({
          name: cut.name, duration, fps: cut.fps, loop: !!cut.loop,
          shots: cut.shots.map((s, i) => ({ id: s.id, start: +starts[i].toFixed(2), dur: s.dur, caption: cut.captions === false ? null : s.caption ?? null })),
        });
        const still = async (t: number, file: string) => {
          await page.evaluate((tt) => window.__render(tt), t);
          await page.screenshot({ path: join(outDir, file) });
        };
        for (const [k, t] of Object.entries(cut.keyStills ?? {})) await still(t, `key-${cut.name}-${k}.png`);
        if (stillTimes) {
          for (const t of stillTimes) await still(t, `still-${cut.name}-${t}.png`);
          await page.close();
          continue;
        }

        const frames = join(outDir, `.frames-${cut.name}`);
        rmSync(frames, { recursive: true, force: true });
        mkdirSync(frames, { recursive: true });
        const n = frameCount(cut);
        const t0 = Date.now();
        for (let f = 0; f < n; f++) {
          await page.evaluate((tt) => window.__render(tt), f / cut.fps);
          await page.screenshot({ path: join(frames, `${String(f).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 94 });
          if (f % 300 === 0) console.log(`[render] ${job.name} ${cut.name} frame ${f}/${n} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
        }
        await page.close();

        const input = ['-framerate', String(cut.fps), '-i', join(frames, '%05d.jpg')];
        const x264 = ['-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
        const vp9 = ['-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-row-mt', '1', '-pix_fmt', 'yuv420p'];
        const ff = (...a: string[]) => sh(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', ...a]);
        const bg = fam.theme === 'light' ? '0xebe6de' : '0x12110f';
        const sheet = (video: string, name: string) => {
          const cols = 6;
          const rows = Math.ceil(Math.ceil(duration) / cols);
          ff('-i', video, '-vf', `fps=1,scale=480:-1,tile=${cols}x${rows}:padding=6:margin=6:color=${bg}`, '-frames:v', '1', '-q:v', '3', join(outDir, name));
        };
        const poster = join(frames, `${String(Math.min(n - 1, Math.round((cut.poster ?? 0) * cut.fps))).padStart(5, '0')}.jpg`);

        if (cut.name === 'full') {
          const audio = join(outDir, `.${PREFIX}.wav`);
          writeFileSync(audio, wav(synthesize(soundCues(cut), duration)));
          const withAudio = (fmt: string[], acodec: string[], file: string) => ff(...input, '-i', audio, ...fmt, ...acodec, '-shortest', join(outDir, file));
          withAudio(x264, ['-c:a', 'aac', '-b:a', '192k'], `${PREFIX}.mp4`);
          withAudio(vp9, ['-c:a', 'libopus', '-b:a', '128k'], `${PREFIX}.webm`);
          ff(...input, ...x264, '-an', join(outDir, `${PREFIX}-silent.mp4`));
          ff(...input, ...vp9, '-an', join(outDir, `${PREFIX}-silent.webm`));
          ff('-i', poster, '-q:v', '2', join(outDir, `${PREFIX}-poster.jpg`));
          sheet(join(outDir, `${PREFIX}.mp4`), 'contact-full.jpg');
          rmSync(audio, { force: true });
        } else {
          ff(...input, ...x264, '-an', join(outDir, `${PREFIX}-hero.mp4`));
          ff(...input, ...vp9, '-an', join(outDir, `${PREFIX}-hero.webm`));
          ff(...input, '-vf', 'fps=15,scale=960:-1:flags=lanczos', '-c:v', 'libwebp_anim', '-loop', '0', '-q:v', '72', '-compression_level', '6', '-an', join(outDir, `${PREFIX}-hero.webp`));
          ff('-i', poster, '-q:v', '2', join(outDir, `${PREFIX}-hero-poster.jpg`));
          sheet(join(outDir, `${PREFIX}-hero.mp4`), 'contact-hero.jpg');
        }
        if (!process.argv.includes('--keep-frames')) rmSync(frames, { recursive: true, force: true });
        console.log(`[render] ${job.name} ${cut.name}: ${n} frames, ${duration.toFixed(1)}s, ${((Date.now() - t0) / 1000).toFixed(0)}s wall`);
      }
      writeFileSync(join(outDir, 'shotlist.json'), JSON.stringify(shotlist, null, 2));
    }
  } finally {
    await browser.close();
    server.stop(true);
  }
  console.log(`[render] done → ${outRoot}`);
}

if (import.meta.main) {
  await main();
  process.exit(0);
}
