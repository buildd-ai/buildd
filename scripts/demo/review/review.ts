/**
 * review.ts: review the RENDERED site clips, pixels not the cut model.
 *
 *   bun run demo:review --clips ~/buildd-demo-renders/v6/site [--out <dir>] [--no-judge] [--only spec,hero] [--copy <clips.ts>]
 *
 * For every clip in the set (manifest.json): sample frames every 0.5s, at each
 * crossfade midpoint and across the loop seam; run the deterministic checks in
 * checks.ts (blank/frozen frames, the seam's SSIM, a contrast floor, OCR glyph
 * height at the size the site shows the clip, text over text, OCR collapse,
 * numbers that disagree); then, unless --no-judge, ask headless Claude Code to
 * judge a grid of the frames against the beat's headline. Writes one HTML
 * report (<out>/index.html, default <clips>/../review) and exits 1 on any
 * high-severity finding.
 *
 * The judge runs `claude -p` with ANTHROPIC_API_KEY removed from its
 * environment, so it uses the logged-in subscription (OAuth), never an API
 * key. Verdicts are cached by the clip's hash and the prompt, so a re-run
 * only judges clips that changed. Local tools only: ffmpeg, tesseract, claude.
 */
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { basename, dirname, join, relative, resolve } from 'path';
import {
  clipMeta, collisions, confidenceCollapse, contrastFloor, displayWidth, exitCode, legibility, lumaStats,
  numberContradictions, parseBlack, parseFreeze, parseTsv, sampleTimes, seamCheck, stackedLabels, textOverShape, litWords,
  type Finding, type Severity, type Word,
} from './checks';

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const flag = (name: string) => process.argv.includes(`--${name}`);
const MENLO = '/System/Library/Fonts/Menlo.ttc';
const PROMPT_VERSION = 'v2';

function sh(cmd: string[], opts: { stdout?: 'pipe' } = {}): { out: Buffer; err: string; code: number } {
  const r = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe', ...opts });
  return { out: Buffer.from(r.stdout), err: r.stderr.toString(), code: r.exitCode ?? 1 };
}
async function shAsync(cmd: string[], o: { cwd?: string; env?: Record<string, string | undefined> } = {}): Promise<{ out: string; err: string; code: number }> {
  const p = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe', cwd: o.cwd, env: o.env as any });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { out, err, code: await p.exited };
}
async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}
const ff = (...a: string[]) => sh(['ffmpeg', '-v', 'error', '-y', ...a]);

type Copy = { headline: string; body: string };
/** The site's words for each clip: beats from lib/clips.ts, the hero from the page's h1. */
function siteCopy(clipsTs?: string): Record<string, Copy> {
  const out: Record<string, Copy> = {};
  if (!clipsTs || !existsSync(clipsTs)) return out;
  const src = readFileSync(clipsTs, 'utf8');
  // One object per beat: its id, headline and (optional) body.
  for (const block of src.split(/\n\s*\{\s*\n/).slice(1)) {
    const id = block.match(/id:\s*'([a-z]+)'/)?.[1];
    const headline = block.match(/headline:\s*(["'`])(.+?)\1,/)?.[2];
    if (id && headline) out[id] = { headline, body: block.match(/body:\s*(["'`])(.+?)\1,/)?.[2] ?? '' };
  }
  const page = join(dirname(clipsTs), '..', 'app', 'page.tsx');
  if (existsSync(page)) {
    const h1 = readFileSync(page, 'utf8').match(/<h1[^>]*>\s*([^<]+?)\s*<\/h1>/);
    if (h1) out.hero = { headline: h1[1].replace(/&apos;/g, "'"), body: 'the site hero loop, full-bleed above the fold' };
  }
  out.full = { headline: 'Watch it ship (the full film, with sound)', body: 'the whole story in one cut' };
  return out;
}
const baseOf = (name: string) => name.replace(/-light/, '').replace(/-mobile$/, '');
const themeOf = (name: string): 'dark' | 'light' => (name.includes('-light') ? 'light' : 'dark');

type Sample = { t: number; png: string; thumb: string; kind: 'step' | 'crossfade' | 'seam'; luma: { mean: number; rms: number }; conf: number; words: number; text: string };
type Judge = { findings: Finding[]; costUsd: number; ms: number; tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }; model?: string; cached: boolean; error?: string };
type ClipReport = { name: string; file: string; width: number; height: number; duration: number; fps: number; display: number; theme: 'dark' | 'light'; samples: Sample[]; findings: Finding[]; judge?: Judge };

function probe(file: string) {
  const r = sh(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate:format=duration', '-of', 'json', file]);
  const j = JSON.parse(r.out.toString());
  const [a, b] = String(j.streams[0].r_frame_rate).split('/').map(Number);
  return { width: j.streams[0].width as number, height: j.streams[0].height as number, fps: b ? a / b : a, duration: +j.format.duration };
}

async function measure(name: string, file: string, entry: any, out: string): Promise<ClipReport> {
  const p = probe(file);
  const display = displayWidth(name);
  const theme = themeOf(name);
  const cut = entry?.cut;
  const meta = cut ? clipMeta(name, cut, cut.fade ?? 0.8) : { folded: false, loop: name !== 'full', crossfades: [] as number[] };
  const dir = join(out, 'frames', name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const findings: Finding[] = [];

  // Blank or frozen stretches, one pass. A hold is a design choice; a hold
  // over most of the clip, or any black, is not.
  const det = sh(['ffmpeg', '-hide_banner', '-i', file, '-vf', 'blackdetect=d=0.25:pix_th=0.05,freezedetect=n=0.001:d=3.5,metadata=mode=print', '-f', 'null', '-']).err;
  for (const b of parseBlack(det)) findings.push({ t: b.start, severity: 'high', check: 'black', issue: `black frames ${b.start.toFixed(2)}–${b.end.toFixed(2)}s` });
  for (const f of parseFreeze(det, p.duration)) {
    const share = (f.end - f.start) / p.duration;
    findings.push({ t: f.start, severity: share > 0.6 ? 'medium' : 'low', check: 'freeze', issue: `no motion ${f.start.toFixed(1)}–${f.end.toFixed(1)}s (${Math.round(share * 100)}% of the clip)` });
  }

  const times = sampleTimes(p.duration, meta.crossfades, { loop: meta.loop, fps: p.fps });
  const seamT = meta.loop ? times[times.length - 1] : -1;
  const thumbW = Math.round(display / 2.5 / 2) * 2;
  const samples = await pool(times, 6, async (t): Promise<Sample> => {
    const png = join(dir, `${t.toFixed(3)}.png`);
    // The seam: decode the last half second and keep overwriting, so the file ends on the very last frame.
    if (t === seamT) ff('-sseof', '-0.5', '-i', file, '-update', '1', png);
    else ff('-ss', String(t), '-i', file, '-frames:v', '1', png);
    const gray = sh(['ffmpeg', '-v', 'error', '-i', png, '-vf', `scale=${display}:-2,format=gray`, '-f', 'rawvideo', '-']).out;
    const luma = lumaStats(new Uint8Array(gray));
    // OCR on gray, inverted for the dark theme (tesseract reads dark-on-light best).
    const ocrIn = join(dir, `${t.toFixed(3)}-ocr.png`);
    ff('-i', png, '-vf', theme === 'dark' ? 'format=gray,negate' : 'format=gray', ocrIn);
    const tsv = (await shAsync(['tesseract', ocrIn, '-', '--psm', '11', 'tsv'])).out;
    rmSync(ocrIn, { force: true });
    const words = parseTsv(tsv);
    const thumb = join(dir, `${t.toFixed(3)}-thumb.jpg`);
    ff('-i', png, '-vf', `scale=${thumbW}:-2`, '-q:v', '5', thumb);
    const g = new Uint8Array(gray);
    const px = { gray: g, width: display, height: Math.round(g.length / display), scale: display / p.width };
    // Crossfades blend two layers by design: overlap checks skip them (the judge sees those frames).
    const blending = meta.crossfades.some((c) => Math.abs(c - t) < 0.45);
    const lit = litWords(words, px);
    const layered = blending ? [] : [...collisions(words), ...textOverShape(words, { ...px, displayWidth: display })];
    for (const f of [contrastFloor(luma, theme), ...legibility(words, { sourceWidth: p.width, displayWidth: display, lit }), ...layered]) if (f) findings.push({ ...f, t });
    // Numbers only from words OCR read confidently: a misread checkbox row ("000006") is not a claim.
    const sure = words.filter((w) => w.conf >= 80);
    const lines = new Map<number, Word[]>();
    for (const w of sure) (lines.get(w.line) ?? lines.set(w.line, []).get(w.line)!).push(w);
    const text = [...[...lines.values()].map((ws) => ws.map((w) => w.text).join(' ')), ...stackedLabels(sure)].join(' · ');
    const conf = words.length ? words.reduce((a, w) => a + w.conf, 0) / words.length : 0;
    const kind = t === seamT ? 'seam' : meta.crossfades.some((c) => Math.abs(c - t) < 1e-3) ? 'crossfade' : 'step';
    return { t, png, thumb, kind, luma, conf, words: words.length, text };
  });
  findings.push(...confidenceCollapse(samples.filter((s) => s.kind === 'step').map((s) => ({ t: s.t, conf: s.conf, words: s.words })), meta.crossfades));
  findings.push(...numberContradictions(samples.map((s) => ({ t: s.t, text: s.text }))));
  if (meta.loop) {
    const ssim = +(sh(['ffmpeg', '-hide_banner', '-i', samples[samples.length - 1].png, '-i', samples[0].png, '-lavfi', 'ssim', '-f', 'null', '-']).err.match(/All:([\d.]+)/)?.[1] ?? 0);
    const f = seamCheck(ssim, true);
    if (f) findings.push({ ...f, t: seamT });
  }
  return { name, file, width: p.width, height: p.height, duration: p.duration, fps: p.fps, display, theme, samples, findings: findings.map((f) => ({ ...f, clip: name })) };
}

/** A grid of frames at display size, each with its timestamp burned in. */
function grid(frames: Array<{ png: string; label: string }>, display: number, cols: number, outFile: string) {
  const tmp = `${outFile}.d`;
  mkdirSync(tmp, { recursive: true });
  const files = frames.map((f, i) => {
    const o = join(tmp, `${i}.png`);
    ff('-i', f.png, '-vf', `scale=${display}:-2,drawtext=fontfile=${MENLO}:text='${f.label}':x=8:y=8:fontsize=${Math.max(14, Math.round(display / 40))}:fontcolor=white:box=1:boxcolor=0xd0021b@0.85:boxborderw=6`, o);
    return o;
  });
  const { width, height } = probe(files[0]);
  const layout = files.map((_, i) => `${(i % cols) * (width + 8)}_${Math.floor(i / cols) * (height + 8)}`).join('|');
  if (files.length === 1) ff('-i', files[0], outFile);
  else ff(...files.flatMap((f) => ['-i', f]), '-filter_complex', `xstack=inputs=${files.length}:layout=${layout}:fill=0x808080`, outFile);
  rmSync(tmp, { recursive: true, force: true });
}

function judgePrompt(c: ClipReport, copy: Copy | undefined, images: string[]): string {
  return `You are reviewing one short clip from the buildd landing page before it ships. Be a strict, specific design reviewer.

Clip: ${c.name} (${c.theme} theme, ${c.duration.toFixed(1)}s, shown on the page at ${c.display}px wide).
The site's words next to this clip: headline "${copy?.headline ?? '(none)'}", body "${copy?.body ?? '(none)'}".

Read these images with the Read tool (they are at the clip's real display size; the red label on each frame is its time):
1. ${images[0]}: frames every 0.5s across the clip.
${images[1] ? `2. ${images[1]}: the transition frames (crossfade midpoints), then the loop seam (the last frame, then the first).` : ''}

How these clips are made (so you judge the right things): each is a crop of a real product screen, zoomed onto one element. Everything outside that element is dimmed on purpose, so dimmed text cut off at the frame edge is expected. Flag cut-off text only when it is in the lit (bright) element, or is the thing the headline names. The clips are silent loops with no captions, because the page's headline sits beside them; a missing caption is not a finding. A loop's last frame should look like its first.

Judge:
- Does the clip show what the headline claims?
- Anything overlapping (text over text, text over shapes), clipped or cut off at the frame edge?
- Do the numbers agree with each other within a frame?
- Ugly mid-transition frames (two screens smeared into one, a flash, a jump)?
- Is the key element readable at ${c.display}px wide?

Severity: "high" = a visitor would notice a defect, or a false or contradictory claim; "medium" = noticeably rough; "low" = a nitpick.
Reply with ONLY one JSON object and nothing else: {"findings":[{"t":<seconds or null>,"severity":"high"|"medium"|"low","issue":"<one sentence>"}]}. An empty list if it is clean.`;
}

async function judge(c: ClipReport, copy: Copy | undefined, out: string): Promise<Judge> {
  const dir = join(out, 'judge');
  mkdirSync(dir, { recursive: true });
  const steps = c.samples.filter((s) => s.kind === 'step');
  const pick = steps.length > 12 ? Array.from({ length: 12 }, (_, i) => steps[Math.round((i * (steps.length - 1)) / 11)]) : steps;
  const cols = c.display <= 360 ? 4 : 3;
  const g1 = join(dir, `${c.name}-frames.png`);
  grid(pick.map((s) => ({ png: s.png, label: `${s.t.toFixed(2)}s` })), c.display, cols, g1);
  const trans = [...c.samples.filter((s) => s.kind === 'crossfade').map((s) => ({ png: s.png, label: `${s.t.toFixed(2)}s crossfade` }))];
  const seam = c.samples.find((s) => s.kind === 'seam');
  if (seam) trans.push({ png: seam.png, label: `${seam.t.toFixed(2)}s last` }, { png: c.samples[0].png, label: '0.00s first' });
  const g2 = trans.length ? join(dir, `${c.name}-transitions.png`) : undefined;
  if (g2) grid(trans, c.display, Math.min(cols, trans.length), g2);
  const images = [g1, ...(g2 ? [g2] : [])];
  const prompt = judgePrompt(c, copy, images);
  const hash = createHash('sha256').update(readFileSync(c.file)).update(prompt.replace(/\/[^\s]+\.png/g, '')).update(PROMPT_VERSION).digest('hex').slice(0, 24);
  const cacheFile = join(out, '.judge-cache', `${hash}.json`);
  if (existsSync(cacheFile)) return { ...JSON.parse(readFileSync(cacheFile, 'utf8')), cached: true };
  // OAuth only: drop any API key so `claude` uses the logged-in subscription.
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  const t0 = Date.now();
  const r = await shAsync(['claude', '-p', prompt, '--output-format', 'json', '--allowedTools', 'Read', '--add-dir', dir], { cwd: dir, env });
  let res: Judge = { findings: [], costUsd: 0, ms: Date.now() - t0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cached: false };
  try {
    const j = JSON.parse(r.out);
    const u = j.usage ?? {};
    res = {
      ...res, costUsd: j.total_cost_usd ?? 0, ms: j.duration_ms ?? res.ms, model: Object.keys(j.modelUsage ?? {})[0],
      tokens: { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 },
    };
    const text = String(j.result ?? '');
    const body = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    res.findings = (body.findings ?? []).map((f: any) => ({ clip: c.name, t: typeof f.t === 'number' ? f.t : undefined, severity: (['high', 'medium', 'low'].includes(f.severity) ? f.severity : 'medium') as Severity, check: 'judge', issue: String(f.issue) }));
  } catch (e) {
    res.error = `judge output unreadable (exit ${r.code}): ${(r.err || r.out).slice(0, 300)}`;
  }
  if (!res.error) { mkdirSync(dirname(cacheFile), { recursive: true }); writeFileSync(cacheFile, JSON.stringify(res)); }
  return res;
}

// ── report ──────────────────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const b64 = (f: string) => (existsSync(f) ? `data:image/jpeg;base64,${readFileSync(f).toString('base64')}` : '');
const SEV_COLOR: Record<Severity, string> = { high: '#d0021b', medium: '#e08a00', low: '#6b7280' };

function nearest(c: ClipReport, t: number | undefined) {
  if (t === undefined) return undefined;
  return c.samples.reduce((a, s) => (Math.abs(s.t - t) < Math.abs(a.t - t) ? s : a), c.samples[0]);
}

function report(clips: ClipReport[], clipsDir: string, out: string, copy: Record<string, Copy>) {
  const all = clips.flatMap((c) => [...c.findings, ...(c.judge?.findings ?? [])]);
  const count = (fs: Finding[], s: Severity) => fs.filter((f) => f.severity === s).length;
  const judged = clips.filter((c) => c.judge && !c.judge.cached);
  const cost = clips.reduce((a, c) => a + (c.judge?.costUsd ?? 0), 0);
  const tokens = clips.reduce((a, c) => { const t = c.judge?.tokens; return t ? { i: a.i + t.input + t.cacheRead + t.cacheWrite, o: a.o + t.output } : a; }, { i: 0, o: 0 });
  const ms = clips.reduce((a, c) => a + (c.judge?.ms ?? 0), 0);
  const rows = clips.map((c) => {
    const fs = [...c.findings, ...(c.judge?.findings ?? [])];
    return `<tr><td><a href="#${c.name}">${c.name}</a></td><td>${c.theme}</td><td>${c.display}px</td><td>${c.duration.toFixed(1)}s</td>${(['high', 'medium', 'low'] as Severity[]).map((s) => `<td class="n ${count(fs, s) ? s : ''}">${count(fs, s)}</td>`).join('')}<td>${c.judge ? (c.judge.error ? 'error' : c.judge.cached ? 'cached' : `${(c.judge.ms / 1000).toFixed(0)}s`) : '—'}</td></tr>`;
  }).join('');
  const rel = (f: string) => relative(out, f);
  const clipBlock = (c: ClipReport) => {
    const fs = [...c.findings, ...(c.judge?.findings ?? [])].sort((a, b) => ['high', 'medium', 'low'].indexOf(a.severity) - ['high', 'medium', 'low'].indexOf(b.severity));
    const flagged = new Map<number, Finding[]>();
    for (const f of fs) { const s = nearest(c, f.t); if (s) (flagged.get(s.t) ?? flagged.set(s.t, []).get(s.t)!).push(f); }
    const strip = c.samples.map((s) => {
      const hit = flagged.get(s.t);
      const worst = hit?.[0]?.severity;
      const k = s.png ? (c.width / 1) : 1;
      const boxes = (hit ?? []).filter((f) => f.box).map((f) => { const b = f.box!; return `<i class="box" style="left:${(b.x / c.width) * 100}%;top:${(b.y / c.height) * 100}%;width:${(b.w / c.width) * 100}%;height:${(b.h / c.height) * 100}%"></i>`; }).join('');
      void k;
      return `<figure class="${worst ?? ''}" title="${esc((hit ?? []).map((f) => `[${f.severity}] ${f.issue}`).join('\n'))}"><div class="im"><img src="${b64(s.thumb)}">${boxes}</div><figcaption>${s.t.toFixed(2)}s${s.kind !== 'step' ? ` · ${s.kind}` : ''}${hit ? `<br><b>${esc(hit[0].issue.slice(0, 90))}</b>` : ''}</figcaption></figure>`;
    }).join('');
    const list = fs.length ? `<ul class="fs">${fs.map((f) => `<li><span class="sev ${f.severity}">${f.severity}</span> <code>${f.check}</code> ${f.t !== undefined ? `<code>${f.t.toFixed(2)}s</code> ` : ''}${esc(f.issue)}</li>`).join('')}</ul>` : '<p class="ok">No findings.</p>';
    return `<div class="clip" id="${c.name}"><h4>${c.name} <small>${c.theme} · ${c.width}×${c.height} shown at ${c.display}px</small></h4>
<video src="${esc(rel(c.file))}" width="${c.display}" autoplay muted loop playsinline controls></video>
<div class="strip">${strip}</div>${list}${c.judge?.error ? `<p class="err">${esc(c.judge.error)}</p>` : ''}</div>`;
  };
  const groups = new Map<string, ClipReport[]>();
  for (const c of clips) { const k = c.name.endsWith('-mobile') ? `${baseOf(c.name)}-mobile` : baseOf(c.name); (groups.get(k) ?? groups.set(k, []).get(k)!).push(c); }
  const sections = [...groups.entries()].map(([k, cs]) => {
    const cp = copy[baseOf(k)];
    return `<section><h3>${k}${cp ? ` <small>“${esc(cp.headline)}” ${esc(cp.body)}</small>` : ''}</h3><div class="pair">${cs.sort((a, b) => (a.theme === 'dark' ? -1 : 1)).map(clipBlock).join('')}</div></section>`;
  }).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>demo:review · ${basename(clipsDir)}</title><style>
body{font:14px/1.45 -apple-system,system-ui,sans-serif;margin:24px;background:#f4f2ee;color:#1c1b19}
table{border-collapse:collapse;margin:12px 0 28px}td,th{border:1px solid #d8d4cc;padding:4px 10px;text-align:left}
td.n{text-align:right}td.high{background:#fde2e2;font-weight:700}td.medium{background:#fdf0dc}
section{margin:36px 0;border-top:2px solid #1c1b19;padding-top:10px}h3 small,h4 small{font-weight:400;color:#6b6760}
.pair{display:flex;gap:28px;flex-wrap:wrap;align-items:flex-start}.clip{max-width:100%}
video{display:block;background:#000;max-width:100%}
.strip{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0;max-width:${1280 + 40}px}
figure{margin:0;width:min-content;border:2px solid transparent}figure.high{border-color:#d0021b}figure.medium{border-color:#e08a00}figure.low{border-color:#9ca3af}
.im{position:relative}.im img{display:block}.box{position:absolute;border:2px solid #d0021b;box-sizing:border-box}
figcaption{font:11px/1.3 ui-monospace,Menlo,monospace;color:#6b6760;max-width:220px;padding:2px}figcaption b{color:#1c1b19;font-weight:600}
.sev{display:inline-block;padding:0 6px;color:#fff;font:11px ui-monospace,monospace;text-transform:uppercase}${(['high', 'medium', 'low'] as Severity[]).map((s) => `.sev.${s}{background:${SEV_COLOR[s]}}`).join('')}
ul.fs{padding-left:18px;max-width:900px}.ok{color:#1f7a4d}.err{color:#d0021b}code{font:12px ui-monospace,monospace}
</style></head><body>
<h1>demo:review <small style="font-weight:400">${esc(clipsDir)}</small></h1>
<p><b>${count(all, 'high')}</b> high · <b>${count(all, 'medium')}</b> medium · <b>${count(all, 'low')}</b> low across ${clips.length} clips.
Judge: ${judged.length} clip(s) judged this run, ${clips.filter((c) => c.judge?.cached).length} cached; ${(ms / 1000).toFixed(0)}s of judge time; ${tokens.i.toLocaleString()} input + ${tokens.o.toLocaleString()} output tokens; $${cost.toFixed(2)} at list price (billed to the subscription, not an API key).</p>
<table><tr><th>clip</th><th>theme</th><th>shown at</th><th>length</th><th>high</th><th>medium</th><th>low</th><th>judge</th></tr>${rows}</table>
${sections}
</body></html>`;
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'index.html'), html);
  writeFileSync(join(out, 'findings.json'), JSON.stringify({ clips: clips.map((c) => ({ name: c.name, findings: c.findings, judge: c.judge })), totals: { high: count(all, 'high'), medium: count(all, 'medium'), low: count(all, 'low') }, judge: { costUsd: cost, ms, tokens } }, null, 2));
}

async function main() {
  const clipsDir = resolve(arg('clips') ?? '');
  if (!arg('clips') || !existsSync(join(clipsDir, 'manifest.json'))) {
    console.error('usage: bun run demo:review --clips <site dir with manifest.json> [--out <dir>] [--no-judge] [--only a,b] [--copy <site lib/clips.ts>]');
    process.exit(2);
  }
  const out = resolve(arg('out') ?? join(dirname(clipsDir), 'review'));
  const copy = siteCopy(arg('copy') ?? join(process.env.HOME ?? '', 'buildd-worktrees/site-landing-v2/src/lib/clips.ts'));
  const manifest: any[] = JSON.parse(readFileSync(join(clipsDir, 'manifest.json'), 'utf8'));
  const only = arg('only')?.split(',');
  const entries = manifest.filter((e) => !only || only.includes(e.beat) || only.includes(baseOf(e.beat)));
  console.log(`[review] ${entries.length} clip(s) from ${clipsDir}`);
  const clips: ClipReport[] = [];
  for (const e of entries) {
    const t0 = Date.now();
    const c = await measure(e.beat, join(clipsDir, `${e.beat}.mp4`), e, out);
    clips.push(c);
    console.log(`[review] ${c.name}: ${c.samples.length} frames, ${c.findings.length} pixel finding(s), ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  if (!flag('no-judge')) {
    await pool(clips, 4, async (c) => {
      c.judge = await judge(c, copy[baseOf(c.name)], out);
      console.log(`[review] judge ${c.name}: ${c.judge.error ? 'ERROR ' + c.judge.error : `${c.judge.findings.length} finding(s)${c.judge.cached ? ' (cached)' : ` in ${(c.judge.ms / 1000).toFixed(0)}s`}`}`);
    });
  }
  report(clips, clipsDir, out, copy);
  const all = clips.flatMap((c) => [...c.findings, ...(c.judge?.findings ?? [])]);
  const high = all.filter((f) => f.severity === 'high');
  console.log(`[review] ${high.length} high, ${all.filter((f) => f.severity === 'medium').length} medium, ${all.filter((f) => f.severity === 'low').length} low → ${join(out, 'index.html')}`);
  for (const f of high) console.log(`  HIGH ${f.clip} ${f.t !== undefined ? f.t.toFixed(2) + 's ' : ''}[${f.check}] ${f.issue}`);
  process.exit(exitCode(all));
}

if (import.meta.main) await main();
