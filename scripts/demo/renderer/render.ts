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
 *   <prefix>-beat-<beat>.mp4 / .webm / -poster.jpg   (--only beats, v6a) one silent
 *                                              1280w seamless loop per feature beat
 * `--site <dir>` then publishes the site set there under fixed names: <beat>[-mobile][-light].*,
 * hero[-light].* (v6x loop), full.mp4 (v6a with sound, capped at 8MB), and manifest.json.
 * It builds a sibling dir and swaps it in (publishDir), so a killed run never wipes the last set.
 * `--regions` records where each cut's lit target and artifacts sit (into shotlist.json) without encoding.
 * `--review` then runs `demo:review` on the published set (pixel checks + judge; non-zero on a high finding).
 * `--stills t1,t2` writes still-<cut>-<t>.png at those times instead of encoding.
 */
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { fullCut, heroLoop, type Stills } from './cuts';
import { v5Film, v5Hero, type V5 } from './cuts-v5';
import { speakPassage } from './tts';
import { V7_LINES, V7_VOICE, v7Captioned, v7Film } from './cuts-v7';
import { askButtonShots, BEATS, beatLoopSeconds, captionCollisions, fanoutEscapes, v6aBeats, v6aFilm, v6aHero, v6xFilm, v6xHero } from './cuts-v6';
import { copyFileSync, renameSync, statSync } from 'fs';
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
    file: (path) => {
      const abs = resolve(ROOT, path);
      if (!existsSync(abs)) throw new Error(`[render] missing asset ${abs}`);
      const { width, height } = pngSize(readFileSync(abs));
      const src = `/shots/${encodeURIComponent('asset-' + path.replace(/[\\/]/g, '_'))}`;
      files.set(src, abs);
      return { src, at: 0, width, height };
    },
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

/**
 * ffmpeg filtergraph closing a loop: the cut's last `fade` seconds cross-fade
 * onto its first, so a clip `total` long plays back seamless at total - fade.
 */
/** `dip` turns the seam's crossfade into a dip through black (dark theme) or white (light). */
export function seamlessLoopFilter(total: number, fade: number, scale = '', dip?: 'black' | 'white'): string {
  const r = (n: number) => +n.toFixed(3);
  return `[0:v]split[a][b];[a]trim=start=${r(fade)}:end=${r(total)},setpts=PTS-STARTPTS[main];` +
    `[b]trim=start=0:end=${r(fade)},setpts=PTS-STARTPTS[head];` +
    `[main][head]xfade=transition=${dip ? `fade${dip}` : 'fade'}:duration=${r(fade)}:offset=${r(total - 2 * fade)}${scale ? ',' + scale : ''}[v]`;
}

/** Cuts from this run replace same-named ones; the rest are kept, in their order. */
export function mergeShotlists<T extends { name: string }>(prior: T[], now: T[]): T[] {
  const names = new Set(now.map((c) => c.name));
  return [...prior.filter((c) => !names.has(c.name)), ...now];
}

/** A family of cuts: one film and its hero loop, rendered into `dir` under `prefix`. */
type Family = { dir: string; prefix: string; theme: 'dark' | 'light'; cuts: (s: Stills, prep?: any) => Cut[]; prepare?: () => Promise<any> };
const v5 = (variant: V5, theme: 'dark' | 'light'): Family => ({
  dir: variant, prefix: `buildd-demo-v5${variant}`, theme,
  cuts: (s) => [v5Film(s, variant, theme), v5Hero(s, variant, theme)],
});
export const FAMILIES: Record<string, Family> = {
  v4: { dir: '.', prefix: 'buildd-demo-v4', theme: 'dark', cuts: (s) => [fullCut(s), heroLoop(s)] },
  v5a: v5('a', 'dark'),
  v5b: v5('b', 'light'),
  v5c: v5('c', 'light'),
  v6a: { dir: 'a', prefix: 'buildd-demo-v6a', theme: 'dark', cuts: (s) => [v6aFilm(s), v6aHero(s), ...v6aBeats(s), ...v6aBeats(s, { mobile: true })] },
  // The site's light set: the same beats and the v6x hero loop, on light stills.
  v6l: { dir: 'l', prefix: 'buildd-demo-v6l', theme: 'light', cuts: (s) => [v6xHero(s, 'light'), v6xHero(s, 'light', { mobile: true }), ...v6aBeats(s, { theme: 'light' }), ...v6aBeats(s, { mobile: true, theme: 'light' })] },
  // v7: the voiced film. Its lines are spoken first (tts.ts, cached), so the cuts can be timed to them.
  v7: {
    dir: 'v7', prefix: 'buildd-demo-v7', theme: 'dark',
    // One continuous read, cut into its lines at the reader's own pauses (tts.ts speakPassage).
    prepare: async () => speakPassage(V7_LINES, V7_VOICE),
    cuts: (s, spoken) => [v7Film(s, spoken), v7Captioned(s, spoken)],
  },
  v6x: { dir: 'x', prefix: 'buildd-demo-v6x', theme: 'dark', cuts: (s) => [v6xFilm(s), v6xHero(s), v6xHero(s, 'dark', { mobile: true })] },
};

async function main() {
  const shotsDir = resolve(arg('shots') ?? '');
  const outRoot = resolve(arg('out') ?? join(import.meta.dir, '../out/video')); // gitignored: videos stay out of git
  if (!existsSync(join(shotsDir, 'manifest.json'))) {
    console.error('usage: bun run demo:render --shots <storyboard out>/<name> --out <dir> [--cuts v5a,v5b,v5c] [--only full,hero] [--stills 2,9.5]');
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(join(shotsDir, 'manifest.json'), 'utf8'));
  const board = manifest.storyboard ?? '';
  const names = arg('cuts')?.split(',') ?? (/demo-v7\.ya?ml$/.test(board) ? ['v7'] : /demo-v6\.ya?ml$/.test(board) ? ['v6a', 'v6x', 'v6l'] : /demo-v5\.ya?ml$/.test(board) ? ['v5a', 'v5b', 'v5c'] : ['v4']);
  // v6 promises: the floating Ask button never shows, and nothing below is drawn if a check fails.
  if (names.some((n) => n.startsWith('v6'))) {
    const asks = askButtonShots(manifest);
    if (asks.length) throw new Error(`[render] the canvas Ask button is visible in: ${asks.join(', ')} (storyboard hide:)`);
  }
  const only = arg('only')?.split(',') ?? ['full', 'hero'];
  const stillTimes = arg('stills')?.split(',').map(Number);
  const files = new Map<string, string>();
  // A family may need async work before its cuts exist (v7 speaks its lines, so shots can be timed to them).
  const preps = new Map<string, any>();
  for (const name of names) if (FAMILIES[name]?.prepare) preps.set(name, await FAMILIES[name].prepare!());
  const jobs = names.map((name) => {
    const fam = FAMILIES[name];
    if (!fam) throw new Error(`[render] unknown cut family "${name}" (${Object.keys(FAMILIES).join(', ')})`);
    const stills = stillsFrom(manifest, shotsDir, arg('theme') ?? fam.theme, files);
    const cuts = fam.cuts(stills, preps.get(name)).filter((c) => wantsCut(only, c.name));
    if (name.startsWith('v6') || name === 'v7') for (const c of cuts) {
      const bad = [...captionCollisions(c).map((x) => `caption "${x.text}" covers a lit element or control in ${x.shot} at ${x.t}s`), ...fanoutEscapes(c)];
      if (bad.length) throw new Error(`[render] ${name} ${c.name}:\n  ${bad.join('\n  ')}`);
    }
    return { name, fam, outDir: join(outRoot, fam.dir), cuts };
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
        const entry: any = {
          name: cut.name, duration, fps: cut.fps, loop: !!cut.loop, fade: cut.fade,
          shots: cut.shots.map((s, i) => ({ id: s.id, start: +starts[i].toFixed(2), dur: s.dur, caption: cut.captions === false ? null : s.caption ?? null })),
        };
        shotlist.cuts.push(entry);
        // Where the lit target and the artifacts sit, every 0.25s of cut time (demo:review's legibility rules).
        const regions: any[] = [];
        for (let t = 0; t < duration; t += 0.25) {
          await page.evaluate((tt) => window.__render(tt), t);
          regions.push({ t: +t.toFixed(2), ...(await page.evaluate(() => window.__regions())) });
        }
        entry.regions = regions;
        if (process.argv.includes('--regions')) { await page.close(); continue; }
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

        if (cut.name.startsWith('beat-')) {
          // Beats render at their own frame (1280x720, 720x900): no scaling here.
          const loopFilter = seamlessLoopFilter(duration, cut.fade, '', cut.dip ? (cut.theme === 'light' ? 'white' : 'black') : undefined);
          const out = (fmt: string[], file: string) => ff(...input, '-filter_complex', loopFilter, '-map', '[v]', ...fmt, '-an', join(outDir, file));
          // Each beat steps its CRF up until it fits BEAT_MAX_BYTES (a busy screen, like the rules list, runs large).
          const under = (ladder: number[], fmt: (crf: number) => string[], file: string) => {
            for (const crf of ladder) { out(fmt(crf), file); if (statSync(join(outDir, file)).size <= BEAT_MAX_BYTES) return; }
            console.warn(`[render] ${file} is still over ${BEAT_MAX_BYTES} bytes at crf ${ladder[ladder.length - 1]}`);
          };
          under(crfLadder(24, 32), (crf) => ['-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart'], `${PREFIX}-${cut.name}.mp4`);
          under(crfLadder(38, 46), (crf) => ['-c:v', 'libvpx-vp9', '-crf', String(crf), '-b:v', '0', '-row-mt', '1', '-pix_fmt', 'yuv420p'], `${PREFIX}-${cut.name}.webm`);
          const posterAt = cut.poster ?? cut.fade + beatLoopSeconds(cut) * 0.6;
          const mid = join(frames, `${String(Math.min(n - 1, Math.round(posterAt * cut.fps))).padStart(5, '0')}.jpg`);
          ff('-i', mid, '-q:v', '3', join(outDir, `${PREFIX}-${cut.name}-poster.jpg`));
        } else if (cut.name === 'full') {
          const audio = join(outDir, `.${PREFIX}.wav`);
          if (cut.voice?.length) {
            // Voice over clicks: no bed; the clicks duck under the voice (sidechain), then a limiter.
            const clicks = join(outDir, `.${PREFIX}-clicks.wav`);
            writeFileSync(clicks, wav(synthesize(soundCues(cut), duration, { bed: false })));
            const ins = [clicks, ...cut.voice.map((v) => v.file)].flatMap((f) => ['-i', f]);
            const delays = cut.voice.map((v, i) => `[${i + 1}:a]aresample=48000,adelay=${Math.round(v.at * 1000)}:all=1,apad[v${i}]`).join(';');
            const mixV = `${cut.voice.map((_, i) => `[v${i}]`).join('')}amix=inputs=${cut.voice.length}:normalize=0:duration=longest,volume=1.0[voice]`;
            const graph = `${delays};${mixV};[voice]asplit[vo][vk];[0:a]aresample=48000[ck];[ck][vk]sidechaincompress=threshold=0.015:ratio=10:attack=8:release=350[duck];` +
              `[duck][vo]amix=inputs=2:normalize=0:duration=first,alimiter=limit=0.9,atrim=0:${duration.toFixed(3)}[a]`;
            ff(...ins, '-filter_complex', graph, '-map', '[a]', '-ac', '1', '-ar', '48000', audio);
            rmSync(clicks, { force: true });
          } else {
            writeFileSync(audio, wav(synthesize(soundCues(cut), duration)));
          }
          const withAudio = (fmt: string[], acodec: string[], file: string) => ff(...input, '-i', audio, ...fmt, ...acodec, '-shortest', join(outDir, file));
          withAudio(x264, ['-c:a', 'aac', '-b:a', '192k'], `${PREFIX}.mp4`);
          withAudio(vp9, ['-c:a', 'libopus', '-b:a', '128k'], `${PREFIX}.webm`);
          if (cut.maxBytes) capMp4(join(outDir, `${PREFIX}.mp4`), cut.maxBytes);
          ff(...input, ...x264, '-an', join(outDir, `${PREFIX}-silent.mp4`));
          ff(...input, ...vp9, '-an', join(outDir, `${PREFIX}-silent.webm`));
          ff('-i', poster, '-q:v', '2', join(outDir, `${PREFIX}-poster.jpg`));
          sheet(join(outDir, `${PREFIX}.mp4`), 'contact-full.jpg');
          rmSync(audio, { force: true });
        } else {
          // hero, hero-mobile: named by the cut.
          ff(...input, ...x264, '-an', join(outDir, `${PREFIX}-${cut.name}.mp4`));
          ff(...input, ...vp9, '-an', join(outDir, `${PREFIX}-${cut.name}.webm`));
          ff(...input, '-vf', 'fps=15,scale=960:-1:flags=lanczos', '-c:v', 'libwebp_anim', '-loop', '0', '-q:v', '72', '-compression_level', '6', '-an', join(outDir, `${PREFIX}-${cut.name}.webp`));
          ff('-i', poster, '-q:v', '2', join(outDir, `${PREFIX}-${cut.name}-poster.jpg`));
          sheet(join(outDir, `${PREFIX}-${cut.name}.mp4`), `contact-${cut.name}.jpg`);
        }
        if (!process.argv.includes('--keep-frames')) rmSync(frames, { recursive: true, force: true });
        console.log(`[render] ${job.name} ${cut.name}: ${n} frames, ${duration.toFixed(1)}s, ${((Date.now() - t0) / 1000).toFixed(0)}s wall`);
      }
      // Merge by cut name: a `--only beats` run must not drop the full cut's entry.
      const listFile = join(outDir, 'shotlist.json');
      const prior = existsSync(listFile) ? JSON.parse(readFileSync(listFile, 'utf8')) : null;
      if (prior?.family === shotlist.family) shotlist.cuts = mergeShotlists(prior.cuts ?? [], shotlist.cuts);
      writeFileSync(listFile, JSON.stringify(shotlist, null, 2));
    }
  } finally {
    await browser.close();
    server.stop(true);
  }
  const site = arg('site');
  if (site) assembleSite(outRoot, resolve(site), names.length === 1 && names[0] === 'v7' ? v7SiteFiles() : siteFiles());
  // Optional: review the published clips' pixels (scripts/demo/review). Exits non-zero on a high finding.
  if (site && process.argv.includes('--review')) {
    const r = Bun.spawnSync(['bun', 'run', join(import.meta.dir, '../review/review.ts'), '--clips', resolve(site)], { stdout: 'inherit', stderr: 'inherit' });
    if (r.exitCode !== 0) { console.error('[render] demo:review found high-severity issues'); process.exit(r.exitCode ?? 1); }
  }
  console.log(`[render] done → ${outRoot}`);
}

/** The fixed names the site codes against: <beat>.*, hero.* (v6x loop), full.* (v6a with sound). */
export function siteFiles(): Array<[from: string, to: string]> {
  const in_ = (fam: string, f: string) => join(FAMILIES[fam].dir, `${FAMILIES[fam].prefix}${f}`);
  const set = (fam: string, from: string, to: string): Array<[string, string]> =>
    [['.webm', '.webm'], ['.mp4', '.mp4'], ['-poster.jpg', '-poster.jpg']].map(([a, b]) => [in_(fam, from + a), to + b]);
  return [
    ...BEATS.flatMap((b) => [
      ...set('v6a', `-beat-${b}`, b), ...set('v6a', `-beat-${b}-mobile`, `${b}-mobile`),
      ...set('v6l', `-beat-${b}`, `${b}-light`), ...set('v6l', `-beat-${b}-mobile`, `${b}-light-mobile`),
    ]),
    ...set('v6x', '-hero', 'hero'), ...set('v6x', '-hero-mobile', 'hero-mobile'),
    ...set('v6l', '-hero', 'hero-light'), ...set('v6l', '-hero-mobile', 'hero-light-mobile'),
    // The film with sound: one mp4 (the dialog plays one source), capped at FULL_MAX_BYTES by assembleSite.
    [in_('v6a', '.mp4'), 'full.mp4'], [in_('v6a', '-poster.jpg'), 'full-poster.jpg'],
  ];
}

/** `--only` names: a cut name (`hero` also takes `hero-mobile`), or `beats` for every beat. */
export function wantsCut(only: string[], name: string): boolean {
  return only.includes(name) || (only.includes('beats') && name.startsWith('beat-')) || (only.includes('hero') && name === 'hero-mobile');
}

/** A rendered file (`<dir>/<prefix>[-<cut>].mp4`) back to its family dir and cut name; the bare prefix is the full film. */
export function clipSource(from: string): { dir: string; cut: string } {
  const [dir, file] = from.split('/');
  const m = file.replace(/\.mp4$/, '').match(/^buildd-demo-v\d+[a-z]+(?:-(.+))?$/);
  return { dir, cut: m?.[1] ?? 'full' };
}

/** CRFs to try, from `start` up to `max` in steps of 2. */
export function crfLadder(start: number, max: number): number[] {
  const out: number[] = [];
  for (let c = start; c <= max; c += 2) out.push(c);
  return out;
}

/** A site beat clip (each of mp4 and webm) stays under this. */
export const BEAT_MAX_BYTES = 1.2 * 1024 * 1024;

/** The v7 set: the voiced film and the silent captioned cut, with posters (no webm: one source each). */
export function v7SiteFiles(): Array<[from: string, to: string]> {
  return [['v7/buildd-demo-v7.mp4', 'full.mp4'], ['v7/buildd-demo-v7-poster.jpg', 'full-poster.jpg'],
    ['v7/buildd-demo-v7-captioned.mp4', 'captioned.mp4'], ['v7/buildd-demo-v7-captioned-poster.jpg', 'captioned-poster.jpg']];
}

/** The site's film with sound stays under this; assembleSite re-encodes it down if the render is bigger. */
export const FULL_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Build a directory next to `site`, then swap it in with renames, so a render
 * that dies part way (or is killed) leaves the previous set whole. The old set
 * is only removed after the new one is in place.
 */
export function publishDir(site: string, build: (tmp: string) => void): void {
  const tmp = `${site}.next-${process.pid}`;
  const old = `${site}.old-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    build(tmp);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  const had = existsSync(site);
  if (had) renameSync(site, old);
  renameSync(tmp, site);
  if (had) rmSync(old, { recursive: true, force: true });
}

/** Re-encode an mp4 in place, stepping CRF up until it fits `max` bytes (same size, same audio). */
function capMp4(file: string, max: number) {
  for (let crf = 24; statSync(file).size > max && crf <= 36; crf += 2) {
    const out = `${file}.crf${crf}.mp4`;
    const r = Bun.spawnSync(['ffmpeg', '-y', '-v', 'error', '-i', file, '-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-c:a', 'aac', '-b:a', '128k', out]);
    if (r.exitCode !== 0) throw new Error(`[render] ffmpeg re-encode failed: ${r.stderr.toString()}`);
    renameSync(out, file);
  }
  if (statSync(file).size > max) throw new Error(`[render] ${file} is still over ${max} bytes at crf 36`);
}

function assembleSite(outRoot: string, site: string, files = siteFiles()) {
  const missing = files.filter(([from]) => !existsSync(join(outRoot, from))).map(([from]) => from);
  if (missing.length) throw new Error(`[render] --site: not rendered yet:\n  ${missing.join('\n  ')}`);
  const probe = (f: string) => +Bun.spawnSync(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).stdout.toString().trim();
  const size = (f: string) => Bun.spawnSync(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', f]).stdout.toString().trim().split(',').filter(Boolean).map(Number);
  publishDir(site, (tmp) => {
    for (const [from, to] of files) copyFileSync(join(outRoot, from), join(tmp, to));
    capMp4(join(tmp, 'full.mp4'), FULL_MAX_BYTES);
    const clips = files.map(([, to]) => to).filter((f) => f.endsWith('.mp4')).map((f) => f.slice(0, -4));
    // Each clip carries its cut's shots, so `demo:review` can find the crossfades from the site set alone.
    const shotlists = new Map<string, any[]>();
    const cutOf = (to: string) => {
      const from = files.find(([, t]) => t === to)?.[0];
      if (!from) return undefined;
      const { dir, cut } = clipSource(from);
      if (!shotlists.has(dir)) {
        const f = join(outRoot, dir, 'shotlist.json');
        shotlists.set(dir, existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')).cuts ?? [] : []);
      }
      const c = shotlists.get(dir)!.find((x: any) => x.name === cut);
      return c ? { name: cut, loop: !!c.loop, fade: c.fade ?? 0.8, fps: c.fps, shots: c.shots.map((x: any) => ({ id: x.id, start: x.start, dur: x.dur })), regions: c.regions ?? [] } : undefined;
    };
    const manifest = clips.map((beat) => {
      const webm = join(tmp, `${beat}.webm`);
      return {
        beat, durationSec: +probe(join(tmp, `${beat}.mp4`)).toFixed(2), size: size(join(tmp, `${beat}.mp4`)),
        bytes: statSync(join(tmp, `${beat}.mp4`)).size, ...(existsSync(webm) ? { webmBytes: statSync(webm).size } : {}),
        cut: cutOf(`${beat}.mp4`),
      };
    });
    writeFileSync(join(tmp, 'manifest.json'), JSON.stringify(manifest, null, 2));
  });
  console.log(`[render] site set → ${site}`);
}

if (import.meta.main) {
  await main();
  process.exit(0);
}
