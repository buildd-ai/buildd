/**
 * Turn a claude.ai Design canvas into one buildd design: a single HTML file
 * with every board as a screen, plus the `metadata.screens` buildd checks.
 *
 *   bun scripts/design/export-canvas.ts <projectDir> <out.html> [flags]
 *
 *   --title <text>            page and artifact title (default: "Design")
 *   --source <url>            the canvas URL, kept in metadata.source
 *   --expect-screens <ids>    fail unless the screen ids are exactly these
 *                             (comma list, or @file.json: a list of ids or a
 *                             metadata object with screens)
 *   --upload                  store it in buildd (env BUILDD_API_KEY, BUILDD_SERVER)
 *   --mission <id>            a new design on this mission, attached to it
 *   --spec <id>               attach to this spec too (alone: the spec is the scope)
 *   --artifact <id>           a new revision of this design instead of a new one
 *
 * <projectDir> is the canvas's `project/` folder (or its parent): canvas.json
 * plus one `<Board>.dc.html` per board, as the Artifact tool lists them. Two
 * optional files beside canvas.json steer the export:
 *
 *   screens.json       { "<Board>": "screen-id" | { id?, name? } }
 *   placeholders.json  { "<Board>" | "*": { "<expr>": "static value" } }
 *
 * A board is keyed by its file name with or without `.dc.html`. How to get the
 * files, and what to do with the result: scripts/design/README.md.
 */
import { readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import { basename, dirname, join, extname } from 'path';
import { createHash } from 'crypto';
import { validateDesignMetadata } from '../../apps/web/src/lib/artifact-design';

export type CanvasBoard = { file: string; title: string; width: number; height: number };
export type DesignScreen = { id: string; name: string; viewport: string; kind?: string; code?: string };
export type DesignMetadata = { kind: 'design'; screens: DesignScreen[]; source?: string };
export type CanvasExport = { html: string; metadata: DesignMetadata; warnings: string[] };

const BOARD_FILE_RE = /\.dc\.html$/i;
/** Below this width a board is a phone screen. */
const DESKTOP_MIN_WIDTH = 768;

/** The folder holding canvas.json: the dir itself, or its `project/`. */
export function resolveProjectDir(dir: string): string {
  if (existsSync(join(dir, 'canvas.json'))) return dir;
  if (existsSync(join(dir, 'project', 'canvas.json'))) return join(dir, 'project');
  throw new Error(`No canvas.json in ${dir} or ${join(dir, 'project')}`);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${(err as Error).message}`);
  }
}

function readOptionalJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const v = readJson(path);
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${path} must be a JSON object`);
  return v as Record<string, unknown>;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const stem = (file: string) => basename(file).replace(BOARD_FILE_RE, '');

/**
 * Boards in canvas order. canvas.json's exact shape is the canvas's, not ours,
 * so this reads any object that names a `.dc.html` file (under file, path,
 * src, href or board), in document order, and takes its title and size from
 * the usual keys. A board with no size there falls back to its own `$preview`.
 */
/**
 * A v3 canvas keys `boards` by file name ({ "Main.dc.html": { w, h, title } })
 * and lists them back to front in `order`. Turn that into entries naming their
 * file, in `order` (boards it leaves out follow in key order), or null when the
 * canvas is not that shape.
 */
function v3Boards(canvas: unknown): Array<Record<string, unknown>> | null {
  if (!canvas || typeof canvas !== 'object' || Array.isArray(canvas)) return null;
  const { boards, order } = canvas as Record<string, unknown>;
  if (!boards || typeof boards !== 'object' || Array.isArray(boards)) return null;
  const keyed = boards as Record<string, unknown>;
  const files = Object.keys(keyed).filter(k => BOARD_FILE_RE.test(k));
  if (files.length === 0) return null;
  const ordered = Array.isArray(order) ? order.filter((f): f is string => typeof f === 'string' && files.includes(f)) : [];
  return [...new Set([...ordered, ...files])].map(file => ({ ...(keyed[file] as Record<string, unknown>), file }));
}

export function readCanvas(dir: string): CanvasBoard[] {
  const project = resolveProjectDir(dir);
  const canvas = readJson(join(project, 'canvas.json'));
  const found: Array<{ file: string; title?: string; width?: number; height?: number }> = [];
  const seen = new Set<string>();

  const visit = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    const o = node as Record<string, unknown>;
    const ref = ['file', 'path', 'src', 'href', 'board'].map(k => str(o[k])).find(v => v && BOARD_FILE_RE.test(v));
    if (ref) {
      const file = basename(ref);
      if (!seen.has(file)) {
        seen.add(file);
        const size = (o.size ?? o.frame ?? o.bounds) as Record<string, unknown> | undefined;
        found.push({
          file,
          title: str(o.title) ?? str(o.label) ?? (str(o.name) && !BOARD_FILE_RE.test(o.name as string) ? str(o.name) : undefined),
          width: num(o.width) ?? num(o.w) ?? num(size?.width) ?? num(size?.w),
          height: num(o.height) ?? num(o.h) ?? num(size?.height) ?? num(size?.h),
        });
      }
    }
    for (const v of Object.values(o)) if (v && typeof v === 'object') visit(v);
  };
  visit(v3Boards(canvas) ?? canvas);
  if (found.length === 0) throw new Error(`${join(project, 'canvas.json')} names no .dc.html board`);

  return found.map(b => {
    const path = join(project, b.file);
    if (!existsSync(path)) throw new Error(`canvas.json lists ${b.file}, but ${path} does not exist`);
    let { width, height } = b;
    if (!width || !height) {
      const preview = parseBoard(readFileSync(path, 'utf8'), b.file).preview;
      width ??= preview?.width;
      height ??= preview?.height;
    }
    if (!width || !height) throw new Error(`${b.file}: no size in canvas.json and no $preview in the board`);
    return { file: b.file, title: b.title ?? stem(b.file), width, height };
  });
}

/** A board's `<helmet>` contents, its `<x-dc>` body without the helmet, and its `$preview` size. */
export function parseBoard(html: string, file = 'board'): { helmet: string; body: string; preview?: { width: number; height: number } } {
  const xdc = html.match(/<x-dc\b[^>]*>([\s\S]*)<\/x-dc>/i);
  if (!xdc) throw new Error(`${file}: no <x-dc> … </x-dc> body`);
  let body = xdc[1];
  let helmet = '';
  body = body.replace(/<helmet\b[^>]*>([\s\S]*?)<\/helmet>/gi, (_, inner: string) => {
    helmet += inner;
    return '';
  });

  let preview: { width: number; height: number } | undefined;
  const props = html.match(/data-props='([^']*)'/) ?? html.match(/data-props="([^"]*)"/);
  if (props) {
    try {
      const p = JSON.parse(props[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')) as { $preview?: { width?: unknown; height?: unknown } };
      const width = num(p.$preview?.width);
      const height = num(p.$preview?.height);
      if (width && height) preview = { width, height };
    } catch {
      // A board whose props are not JSON just has no preview size.
    }
  }
  return { helmet, body, preview };
}

const kebab = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** `TaskDetail.dc.html` at 390 wide → `phone-task-detail`; a name that already says phone/desktop keeps it. */
export function screenIdFor(file: string, width: number): string {
  const id = kebab(stem(file));
  if (/^(phone|desktop)(-|$)/.test(id)) return id;
  return `${width < DESKTOP_MIN_WIDTH ? 'phone' : 'desktop'}-${id}`;
}

function formFactor(width: number) {
  return width < DESKTOP_MIN_WIDTH ? 'Phone' : 'Desktop';
}

/** A per-board entry of screens.json / placeholders.json, by file name or stem. */
function boardEntry(map: Record<string, unknown>, file: string): unknown {
  return map[file] ?? map[stem(file)];
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Top-level CSS rules (an @media block is one rule), comments dropped. */
export function splitCssRules(css: string): string[] {
  const rules: string[] = [];
  let cur = '';
  let depth = 0;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end < 0 ? css.length : end + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = css.indexOf(c, i + 1);
      const to = end < 0 ? css.length : end;
      cur += css.slice(i, to + 1);
      i = to;
      continue;
    }
    cur += c;
    if (c === '{') depth++;
    else if (c === '}' && --depth <= 0) {
      depth = 0;
      rules.push(cur.trim());
      cur = '';
    } else if (c === ';' && depth === 0) {
      rules.push(cur.trim());
      cur = '';
    }
  }
  if (cur.trim()) rules.push(cur.trim());
  return rules.filter(Boolean);
}

/**
 * Every board's helmet, merged: identical tags (font links, meta) once, and one
 * `<style>` holding each distinct CSS rule once, in first-seen order. Boards on
 * one canvas share their base rules; a rule two boards define differently
 * still both apply, as they did on the canvas page by page.
 */
export function mergeHelmets(helmets: string[]): string {
  const tags: string[] = [];
  const seenTags = new Set<string>();
  const rules: string[] = [];
  const seenRules = new Set<string>();
  for (const helmet of helmets) {
    const rest = helmet.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_, css: string) => {
      for (const rule of splitCssRules(css)) {
        const key = rule.replace(/\s+/g, ' ');
        if (!seenRules.has(key)) {
          seenRules.add(key);
          rules.push(rule);
        }
      }
      return '\n';
    });
    for (const tag of rest.match(/<(script|noscript)\b[\s\S]*?<\/\1>|<[a-z][^>]*>/gi) ?? []) {
      const key = tag.replace(/\s+/g, ' ').trim();
      if (!seenTags.has(key)) {
        seenTags.add(key);
        tags.push(tag.trim());
      }
    }
  }
  return [...tags, rules.length ? `<style>\n${rules.join('\n')}\n</style>` : ''].filter(Boolean).join('\n');
}

const SHELL_CSS = `body{margin:0}
.dc-index{padding:24px 32px;display:flex;flex-wrap:wrap;gap:8px 20px;font:14px system-ui,sans-serif}
.dc-index strong{width:100%;font-size:18px}
section[data-screen]{padding:24px 32px 48px;overflow-x:auto}
.screen-label{font:500 14px system-ui,sans-serif;color:#6B655C;margin:0 0 12px}
.frame{border:1px solid #CFC9BE;border-radius:12px;overflow:hidden}
body.single .dc-index,body.single .screen-label{display:none}
body.single section[data-screen]{display:none;padding:0}
body.single section[data-screen].on{display:block}
body.single .frame{border:0;border-radius:0}`;

/** `#<screen>` shows that one screen at its size; no hash lists them all. */
const ROUTER = `<script>
function show(){var id=location.hash.slice(1),s=id&&document.getElementById(id);if(s&&!s.hasAttribute('data-screen'))s=null;document.body.classList.toggle('single',!!s);document.querySelectorAll('section[data-screen]').forEach(function(x){x.classList.toggle('on',x===s)});}
addEventListener('hashchange',show);show();
</script>`;

export function exportCanvas(dir: string, opts: { title?: string; source?: string } = {}): CanvasExport {
  const project = resolveProjectDir(dir);
  const boards = readCanvas(project);
  const overrides = readOptionalJson(join(project, 'screens.json'));
  const values = readOptionalJson(join(project, 'placeholders.json'));
  const shared = (values['*'] ?? {}) as Record<string, unknown>;
  const warnings: string[] = [];

  const screens = boards.map(b => {
    const o = boardEntry(overrides, b.file);
    const ov = typeof o === 'string' ? { id: o } : ((o ?? {}) as { id?: unknown; name?: unknown; kind?: unknown; code?: unknown });
    return {
      board: b,
      id: str(ov.id) ?? screenIdFor(b.file, b.width),
      name: str(ov.name) ?? `${formFactor(b.width)} · ${b.title}`,
      viewport: `${b.width}x${b.height}`,
      // A component board and the code it specifies (validated below with the rest).
      ...(ov.kind !== undefined ? { kind: ov.kind as string } : {}),
      ...(ov.code !== undefined ? { code: ov.code as string } : {}),
    };
  });

  const ids = new Map<string, string>();
  for (const s of screens) {
    const prev = ids.get(s.id);
    if (prev) throw new Error(`${prev} and ${s.board.file} both come out as screen "${s.id}": give one another id in screens.json`);
    ids.set(s.id, s.board.file);
  }
  const idByFile = new Map(screens.map(s => [s.board.file.toLowerCase(), s.id]));

  const helmets: string[] = [];
  const sections: string[] = [];
  const unresolved: string[] = [];
  for (const s of screens) {
    const file = s.board.file;
    const parsed = parseBoard(readFileSync(join(project, file), 'utf8'), file);
    helmets.push(parsed.helmet);
    const own = (boardEntry(values, file) ?? {}) as Record<string, unknown>;

    let body = parsed.body.replace(/href=(["'])(?:\.\/)?(?:project\/)?([^"'#?]+?\.dc\.html)(?:[?#][^"']*)?\1/gi, (m, q: string, target: string) => {
      const id = idByFile.get(basename(target).toLowerCase());
      if (!id) {
        warnings.push(`${file} links to ${target}, which canvas.json does not list; left as is`);
        return m;
      }
      return `href=${q}#${id}${q}`;
    });
    const missing = new Set<string>();
    body = body.replace(/\{\{\s*([\s\S]+?)\s*\}\}/g, (m, expr: string) => {
      const v = expr in own ? own[expr] : shared[expr];
      if (v === undefined || v === null) {
        missing.add(`{{${expr}}}`);
        return m;
      }
      return escapeHtml(String(v));
    });
    if (missing.size) unresolved.push(`${file}: ${[...missing].join(', ')}`);

    sections.push(`<section id="${s.id}" data-screen="${s.id}" data-viewport="${s.viewport}" aria-label="${escapeHtml(s.name)}">
<h2 class="screen-label">${escapeHtml(s.name)}</h2>
<div class="frame" style="width:${s.board.width}px">
${body.trim()}
</div>
</section>`);
  }
  if (unresolved.length) {
    throw new Error(
      `Live placeholders with no static value (add them to ${join(project, 'placeholders.json')} under the board or "*"):\n  ${unresolved.join('\n  ')}`,
    );
  }

  const title = opts.title ?? 'Design';
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
${SHELL_CSS}
</style>
${mergeHelmets(helmets)}
</head>
<body>
<nav class="dc-index" aria-label="Screens"><strong>${escapeHtml(title)}</strong>
${screens.map(s => `<a href="#${s.id}">${escapeHtml(s.name)}</a>`).join('\n')}
</nav>
${sections.join('\n')}
${ROUTER}
</body>
</html>
`;

  const metadata: DesignMetadata = { kind: 'design', screens: screens.map(({ id, name, viewport, kind, code }) => ({ id, name, viewport, ...(kind !== undefined ? { kind } : {}), ...(code !== undefined ? { code } : {}) })) };
  if (opts.source) metadata.source = opts.source;
  const invalid = validateDesignMetadata(metadata);
  if (invalid) throw new Error(`buildd would refuse these screens: ${invalid}`);
  return { html, metadata, warnings };
}

/** Writes the HTML, and `<name>.metadata.json` beside it. Returns the metadata path. */
export function writeExport(outPath: string, out: CanvasExport): string {
  writeFileSync(outPath, out.html);
  const metaPath = join(dirname(outPath), `${basename(outPath, extname(outPath))}.metadata.json`);
  writeFileSync(metaPath, JSON.stringify(out.metadata, null, 2) + '\n');
  return metaPath;
}

export type UploadInput = {
  server: string;
  apiKey: string;
  html: string;
  filename: string;
  title?: string;
  metadata: DesignMetadata;
  missionId?: string;
  specId?: string;
  artifactId?: string;
};

async function call(fetchFn: typeof fetch, url: string, init: RequestInit): Promise<any> {
  const res = await fetchFn(url, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${url} → ${res.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

/**
 * Stores the export the way upload_artifact does (POST /api/artifacts/upload-url,
 * PUT the bytes, finalize with their sha256). With `artifactId` it is the next
 * revision of that design; otherwise a new design scoped to the mission (or the
 * spec when there is no mission). Mission and spec are attached either way.
 */
export async function uploadDesign(input: UploadInput, fetchFn: typeof fetch = fetch): Promise<{ artifactId: string; revision?: number; downloadUrl?: string }> {
  const server = input.server.replace(/\/+$/, '');
  const auth = { Authorization: `Bearer ${input.apiKey}`, 'Content-Type': 'application/json' };
  const bytes = Buffer.from(input.html, 'utf8');
  const attach = [
    ...(input.missionId ? [{ subjectKind: 'mission', subjectId: input.missionId }] : []),
    ...(input.specId ? [{ subjectKind: 'spec', subjectId: input.specId }] : []),
  ];
  const scope = input.artifactId
    ? { artifactId: input.artifactId }
    : input.missionId
      ? { missionId: input.missionId }
      : { specId: input.specId };
  const body = {
    filename: input.filename,
    mimeType: 'text/html',
    sizeBytes: bytes.byteLength,
    ...(input.title ? { title: input.title } : {}),
    ...(input.artifactId ? {} : { type: 'file' }),
    metadata: input.metadata,
    ...scope,
    ...(attach.length ? { attach } : {}),
  };
  const started = await call(fetchFn, `${server}/api/artifacts/upload-url`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
  const put = await fetchFn(started.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/html', 'Content-Length': String(bytes.byteLength) },
    body: bytes,
  });
  if (!put.ok) throw new Error(`PUT of the design bytes → ${put.status}: ${(await put.text()).slice(0, 500)}`);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await call(fetchFn, `${server}/api/artifacts/${started.artifactId}/finalize`, { method: 'POST', headers: auth, body: JSON.stringify({ sha256 }) });
  return { artifactId: started.artifactId, revision: started.revision, downloadUrl: started.downloadUrl };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Args = {
  projectDir: string;
  outPath: string;
  upload: boolean;
  missionId?: string;
  specId?: string;
  artifactId?: string;
  source?: string;
  title?: string;
  expectScreens?: string;
  server?: string;
};

export function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--upload') flags.upload = true;
    else if (a.startsWith('--')) {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      flags[a.slice(2)] = v;
    } else positional.push(a);
  }
  if (positional.length !== 2) throw new Error('usage: export-canvas.ts <projectDir> <out.html> [--upload --mission <id> [--spec <id>] [--artifact <id>]]');
  const known = new Set(['upload', 'mission', 'spec', 'artifact', 'source', 'title', 'expect-screens', 'server']);
  for (const k of Object.keys(flags)) if (!known.has(k)) throw new Error(`unknown flag --${k}`);
  const get = (k: string) => (typeof flags[k] === 'string' ? (flags[k] as string) : undefined);
  for (const k of ['mission', 'spec', 'artifact']) {
    const v = get(k);
    if (v !== undefined && !UUID_RE.test(v)) throw new Error(`--${k} must be a full uuid`);
  }
  const args: Args = {
    projectDir: positional[0],
    outPath: positional[1],
    upload: flags.upload === true,
    missionId: get('mission'),
    specId: get('spec'),
    artifactId: get('artifact'),
    source: get('source'),
    title: get('title'),
    expectScreens: get('expect-screens'),
    server: get('server'),
  };
  if (args.upload && !args.missionId && !args.specId && !args.artifactId) {
    throw new Error('--upload needs --mission <id>, --spec <id> or --artifact <id>');
  }
  return args;
}

/** `a,b,c`, or `@file.json` holding a list of ids or a metadata object with screens. */
export function readExpectedScreens(spec: string): string[] {
  if (!spec.startsWith('@')) return spec.split(',').map(s => s.trim()).filter(Boolean);
  const v = readJson(spec.slice(1)) as unknown;
  const list = Array.isArray(v) ? v : (v as { screens?: unknown[] })?.screens;
  if (!Array.isArray(list)) throw new Error(`${spec.slice(1)}: expected a list of ids or { screens: [...] }`);
  return list.map(s => (typeof s === 'string' ? s : String((s as { id?: unknown }).id)));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.projectDir) || !statSync(args.projectDir).isDirectory()) throw new Error(`${args.projectDir} is not a directory`);
  const out = exportCanvas(args.projectDir, { title: args.title, source: args.source });
  for (const w of out.warnings) console.error(`warning: ${w}`);

  const ids = out.metadata.screens.map(s => s.id);
  if (args.expectScreens) {
    const want = readExpectedScreens(args.expectScreens);
    if (want.join('\n') !== ids.join('\n')) {
      const missing = want.filter(id => !ids.includes(id));
      const extra = ids.filter(id => !want.includes(id));
      throw new Error(`screen ids differ from --expect-screens\n  missing: ${missing.join(', ') || '-'}\n  extra: ${extra.join(', ') || '-'}\n  got (in order): ${ids.join(', ')}`);
    }
  }

  const metaPath = writeExport(args.outPath, out);
  console.log(`${args.outPath}: ${ids.length} screens, ${Buffer.byteLength(out.html)} bytes`);
  console.log(`${metaPath}: ${ids.join(', ')}`);

  if (!args.upload) {
    console.log('Not uploaded (pass --upload). Or store it over MCP: upload_artifact with this metadata, PUT, then upload_artifact { artifactId }.');
    return;
  }
  const apiKey = process.env.BUILDD_API_KEY;
  if (!apiKey) throw new Error('--upload needs BUILDD_API_KEY (a bld_ key with write access to the mission or spec)');
  const server = args.server ?? process.env.BUILDD_SERVER ?? 'https://buildd.dev';
  const res = await uploadDesign({
    server,
    apiKey,
    html: out.html,
    filename: basename(args.outPath),
    title: args.title,
    metadata: out.metadata,
    missionId: args.missionId,
    specId: args.specId,
    artifactId: args.artifactId,
  });
  console.log(`Stored design ${res.artifactId}${res.revision ? ` revision ${res.revision}` : ''}${res.downloadUrl ? `: ${res.downloadUrl}` : ''}`);
}

if (import.meta.main) {
  main().catch(err => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
