import { describe, expect, test, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';
import {
  readCanvas,
  parseBoard,
  screenIdFor,
  exportCanvas,
  writeExport,
  uploadDesign,
  parseArgs,
} from './export-canvas';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function board(opts: { title: string; width: number; height: number; style: string; body: string; props?: Record<string, unknown> }) {
  const props = JSON.stringify({ $preview: { width: opts.width, height: opts.height }, ...(opts.props ?? {}) });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${opts.title}</title>
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter&display=swap">
<style>
body{margin:0}
${opts.style}
</style>
</helmet>
${opts.body}
</x-dc>
<script type="text/x-dc" data-dc-script data-props='${props}'>
class Component extends DCLogic { renderVals() { return {}; } }
</script>
</body>
</html>`;
}

/** A canvas with two boards, one link between them and one placeholder. */
function fixtureCanvas(extra: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'canvas-'));
  dirs.push(root);
  const project = join(root, 'project');
  mkdirSync(project);
  writeFileSync(join(project, 'canvas.json'), JSON.stringify({
    boards: [
      { file: 'MissionList.dc.html', title: 'Mission list', x: 0, y: 0, width: 390, height: 844 },
      { file: 'TaskDetail.dc.html', title: 'Task detail', x: 500, y: 0, width: 1440, height: 900 },
    ],
  }));
  writeFileSync(join(project, 'MissionList.dc.html'), board({
    title: 'Mission list', width: 390, height: 844,
    style: '.row{padding:12px}',
    body: '<div style="width: 390px"><a href="TaskDetail.dc.html">Open task</a><span>{{count}} running</span></div>',
  }));
  writeFileSync(join(project, 'TaskDetail.dc.html'), board({
    title: 'Task detail', width: 1440, height: 900,
    style: '.row{padding:12px}\n.wide{gap:24px}',
    body: '<div style="width: 1440px"><a href="./MissionList.dc.html">‹ Missions</a></div>',
  }));
  for (const [name, content] of Object.entries(extra)) writeFileSync(join(project, name), content);
  return project;
}

const withValues = { 'placeholders.json': JSON.stringify({ 'MissionList.dc.html': { count: '3' } }) };

describe('readCanvas', () => {
  test('reads board order, titles and sizes from canvas.json', () => {
    const project = fixtureCanvas();
    expect(readCanvas(project)).toEqual([
      { file: 'MissionList.dc.html', title: 'Mission list', width: 390, height: 844 },
      { file: 'TaskDetail.dc.html', title: 'Task detail', width: 1440, height: 900 },
    ]);
  });

  test('takes the project dir or its parent', () => {
    const project = fixtureCanvas();
    expect(readCanvas(join(project, '..')).map(b => b.file)).toEqual(['MissionList.dc.html', 'TaskDetail.dc.html']);
  });

  test('tolerates other shapes: a bare list, project/ paths, nested size, and $preview when the size is missing', () => {
    const project = fixtureCanvas();
    writeFileSync(join(project, 'canvas.json'), JSON.stringify([
      { path: 'project/TaskDetail.dc.html', name: 'Task', size: { width: 1440, height: 900 } },
      { src: 'MissionList.dc.html', label: 'List' },
    ]));
    expect(readCanvas(project)).toEqual([
      { file: 'TaskDetail.dc.html', title: 'Task', width: 1440, height: 900 },
      { file: 'MissionList.dc.html', title: 'List', width: 390, height: 844 },
    ]);
  });

  test('reads a v3 canvas: boards keyed by file name, in `order`, frame sizes as w/h', () => {
    const project = fixtureCanvas();
    writeFileSync(join(project, 'canvas.json'), JSON.stringify({
      v: 3,
      title: 'Redesign',
      boards: {
        'MissionList.dc.html': { x: 0, y: 0, w: 390, h: 844, title: 'Mission list' },
        'TaskDetail.dc.html': { x: 500, y: 0, w: 1440, h: 900, title: 'Task detail', expand: 'fill' },
      },
      order: ['TaskDetail.dc.html', 'MissionList.dc.html'],
      notes: { t: { x: 0, y: -200, text: 'Phone', kind: 'title1' } },
    }));
    expect(readCanvas(project)).toEqual([
      { file: 'TaskDetail.dc.html', title: 'Task detail', width: 1440, height: 900 },
      { file: 'MissionList.dc.html', title: 'Mission list', width: 390, height: 844 },
    ]);
  });

  test('a canvas.json that names no board fails', () => {
    const project = fixtureCanvas();
    writeFileSync(join(project, 'canvas.json'), JSON.stringify({ zoom: 1 }));
    expect(() => readCanvas(project)).toThrow(/names no \.dc\.html board/);
  });
});

describe('parseBoard', () => {
  test('keeps the <x-dc> body and the <helmet> head, drops the runtime script', () => {
    const parsed = parseBoard(board({ title: 't', width: 390, height: 844, style: '.a{b:c}', body: '<p>hi</p>' }));
    expect(parsed.body.trim()).toBe('<p>hi</p>');
    expect(parsed.helmet).toContain('.a{b:c}');
    expect(parsed.helmet).not.toContain('<helmet>');
    expect(parsed.preview).toEqual({ width: 390, height: 844 });
  });

  test('a file without <x-dc> fails', () => {
    expect(() => parseBoard('<html><body>no</body></html>')).toThrow(/<x-dc>/);
  });
});

describe('screenIdFor', () => {
  test('kebab case with a phone-/desktop- prefix from width', () => {
    expect(screenIdFor('MissionList.dc.html', 390)).toBe('phone-mission-list');
    expect(screenIdFor('TaskDetail.dc.html', 1440)).toBe('desktop-task-detail');
    expect(screenIdFor('task detail v2.dc.html', 390)).toBe('phone-task-detail-v2');
  });

  test('does not double a prefix the name already has', () => {
    expect(screenIdFor('PhoneMission.dc.html', 390)).toBe('phone-mission');
    expect(screenIdFor('Desktop-Home.dc.html', 1440)).toBe('desktop-home');
  });
});

describe('exportCanvas', () => {
  test('two sections, the link rewritten, the router, screens metadata', () => {
    const out = exportCanvas(fixtureCanvas(withValues), { title: 'Fixture design' });
    const sections = out.html.match(/<section id="[^"]+" data-screen="[^"]+" data-viewport="[^"]+"/g);
    expect(sections).toEqual([
      '<section id="phone-mission-list" data-screen="phone-mission-list" data-viewport="390x844"',
      '<section id="desktop-task-detail" data-screen="desktop-task-detail" data-viewport="1440x900"',
    ]);
    expect(out.html).toContain('<a href="#desktop-task-detail">Open task</a>');
    expect(out.html).toContain('<a href="#phone-mission-list">‹ Missions</a>');
    expect(out.html).not.toContain('.dc.html');
    expect(out.html).toContain('3 running');
    expect(out.html).toContain("addEventListener('hashchange'");
    expect(out.html).toContain('<nav class="dc-index"');
    expect(out.html).not.toContain('support.js');
    expect(out.html).not.toContain('DCLogic');
    expect(out.metadata).toEqual({
      kind: 'design',
      screens: [
        { id: 'phone-mission-list', name: 'Phone · Mission list', viewport: '390x844' },
        { id: 'desktop-task-detail', name: 'Desktop · Task detail', viewport: '1440x900' },
      ],
    });
  });

  test('dedupes repeated <helmet> styles and links', () => {
    const { html } = exportCanvas(fixtureCanvas(withValues));
    expect(html.match(/\.row\{padding:12px\}/g)).toHaveLength(1);
    expect(html.match(/body\{margin:0\}/g)?.length).toBeLessThanOrEqual(2); // board's once, the shell's own once
    expect(html.match(/fonts\.googleapis\.com\/css2\?family=Inter&display=swap/g)).toHaveLength(1);
    expect(html).toContain('.wide{gap:24px}');
  });

  test('a placeholder without a static value fails, naming the board and the placeholder', () => {
    expect(() => exportCanvas(fixtureCanvas())).toThrow(/MissionList\.dc\.html.*\{\{count\}\}/);
  });

  test('"*" values apply to every board; a board\'s own win', () => {
    const out = exportCanvas(fixtureCanvas({ 'placeholders.json': JSON.stringify({ '*': { count: '9' } }) }));
    expect(out.html).toContain('9 running');
    const own = exportCanvas(fixtureCanvas({ 'placeholders.json': JSON.stringify({ '*': { count: '9' }, MissionList: { count: '4' } }) }));
    expect(own.html).toContain('4 running');
  });

  test('values are HTML-escaped', () => {
    const out = exportCanvas(fixtureCanvas({ 'placeholders.json': JSON.stringify({ '*': { count: '<b>' } }) }));
    expect(out.html).toContain('&lt;b&gt; running');
  });

  test('screens.json overrides an id and a name', () => {
    const out = exportCanvas(fixtureCanvas({
      ...withValues,
      'screens.json': JSON.stringify({ 'TaskDetail.dc.html': { id: 'coverage', name: 'Coverage map' }, MissionList: 'phone-mission' }),
    }));
    expect(out.metadata.screens.map(s => s.id)).toEqual(['phone-mission', 'coverage']);
    expect(out.metadata.screens[1].name).toBe('Coverage map');
    expect(out.html).toContain('<a href="#coverage">Open task</a>');
  });

  test('screens.json can say a board is a component and name its code', () => {
    const out = exportCanvas(fixtureCanvas({
      ...withValues,
      'screens.json': JSON.stringify({ TaskDetail: { id: 'c-row', kind: 'component', code: 'apps/web/src/components/X.tsx' } }),
    }));
    expect(out.metadata.screens.find(s => s.id === 'c-row')).toMatchObject({ kind: 'component', code: 'apps/web/src/components/X.tsx' });
    expect(out.metadata.screens.find(s => s.id !== 'c-row')).not.toHaveProperty('kind');
    expect(() => exportCanvas(fixtureCanvas({ ...withValues, 'screens.json': JSON.stringify({ TaskDetail: { kind: 'widget' } }) }))).toThrow(/kind/);
  });

  test('two boards that come out with one id fail', () => {
    expect(() => exportCanvas(fixtureCanvas({ ...withValues, 'screens.json': JSON.stringify({ TaskDetail: 'same', MissionList: 'same' }) })))
      .toThrow(/"same"/);
  });

  test('a link to a board the canvas does not list is reported, not rewritten', () => {
    const project = fixtureCanvas(withValues);
    writeFileSync(join(project, 'TaskDetail.dc.html'), board({ title: 't', width: 1440, height: 900, style: '', body: '<a href="Ghost.dc.html">x</a>' }));
    const out = exportCanvas(project);
    expect(out.warnings.join('\n')).toMatch(/Ghost\.dc\.html/);
  });

  test('a source URL goes into the metadata', () => {
    const out = exportCanvas(fixtureCanvas(withValues), { source: 'https://claude.ai/artifact/abc' });
    expect(out.metadata.source).toBe('https://claude.ai/artifact/abc');
  });
});

describe('writeExport', () => {
  test('writes the HTML and its metadata JSON alongside', () => {
    const project = fixtureCanvas(withValues);
    const outPath = join(project, '..', 'design.html');
    const out = exportCanvas(project);
    const metaPath = writeExport(outPath, out);
    expect(metaPath).toBe(join(project, '..', 'design.metadata.json'));
    expect(readFileSync(outPath, 'utf8')).toBe(out.html);
    expect(JSON.parse(readFileSync(metaPath, 'utf8')).screens).toHaveLength(2);
    expect(existsSync(metaPath)).toBe(true);
  });
});

describe('parseArgs', () => {
  const M = '11111111-1111-4111-8111-111111111111';
  test('positional dirs and upload flags', () => {
    expect(parseArgs(['p', 'o.html', '--upload', '--mission', M, '--source', 'u'])).toMatchObject({ projectDir: 'p', outPath: 'o.html', upload: true, missionId: M, source: 'u' });
  });
  test('--upload needs a mission, spec or artifact', () => {
    expect(() => parseArgs(['p', 'o.html', '--upload'])).toThrow(/--mission/);
  });
  test('ids must be uuids', () => {
    expect(() => parseArgs(['p', 'o.html', '--upload', '--mission', 'abc'])).toThrow(/uuid/);
  });
});

describe('uploadDesign', () => {
  const M = '11111111-1111-4111-8111-111111111111';
  const S = '22222222-2222-4222-8222-222222222222';
  const A = '33333333-3333-4333-8333-333333333333';
  const html = '<!doctype html><p>design</p>';
  const metadata = { kind: 'design' as const, screens: [{ id: 'phone-a', name: 'Phone · A', viewport: '390x844' }] };

  function fakeFetch() {
    const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: any }> = [];
    const fn = async (url: string, init: RequestInit = {}) => {
      const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
      const raw = init.body;
      calls.push({ url, method: init.method ?? 'GET', headers, body: typeof raw === 'string' && url.startsWith('https://srv') ? JSON.parse(raw) : raw });
      if (url.endsWith('/api/artifacts/upload-url')) return Response.json({ artifactId: A, uploadUrl: 'https://r2/put', revision: 2 });
      if (url === 'https://r2/put') return new Response(null, { status: 200 });
      if (url.endsWith(`/api/artifacts/${A}/finalize`)) return Response.json({ artifactId: A, state: 'ready' });
      return new Response('nope', { status: 404 });
    };
    return { fn: fn as unknown as typeof fetch, calls };
  }

  test('a new design: one upload call scoped to the mission, attached to mission and spec, then PUT and finalize with the sha', async () => {
    const { fn, calls } = fakeFetch();
    const res = await uploadDesign({ server: 'https://srv', apiKey: 'bld_x', html, filename: 'nav.html', title: 'Nav', metadata, missionId: M, specId: S }, fn);
    expect(res.artifactId).toBe(A);
    expect(calls.map(c => `${c.method} ${c.url}`)).toEqual([
      'POST https://srv/api/artifacts/upload-url',
      'PUT https://r2/put',
      `POST https://srv/api/artifacts/${A}/finalize`,
    ]);
    expect(calls[0].headers.Authorization).toBe('Bearer bld_x');
    expect(calls[0].body).toEqual({
      filename: 'nav.html', mimeType: 'text/html', sizeBytes: Buffer.byteLength(html), title: 'Nav', type: 'file', metadata,
      missionId: M,
      attach: [{ subjectKind: 'mission', subjectId: M }, { subjectKind: 'spec', subjectId: S }],
    });
    expect(calls[1].headers['Content-Type']).toBe('text/html');
    expect(calls[1].headers['Content-Length']).toBe(String(Buffer.byteLength(html)));
    expect(calls[2].body).toEqual({ sha256: createHash('sha256').update(html).digest('hex') });
  });

  test('only a spec: the spec is the scope', async () => {
    const { fn, calls } = fakeFetch();
    await uploadDesign({ server: 'https://srv', apiKey: 'k', html, filename: 'nav.html', metadata, specId: S }, fn);
    expect(calls[0].body.specId).toBe(S);
    expect(calls[0].body.missionId).toBeUndefined();
  });

  test('--artifact: a new revision of that artifact, no scope', async () => {
    const { fn, calls } = fakeFetch();
    const res = await uploadDesign({ server: 'https://srv', apiKey: 'k', html, filename: 'nav.html', metadata, artifactId: A, missionId: M }, fn);
    expect(res.revision).toBe(2);
    expect(calls[0].body.artifactId).toBe(A);
    expect(calls[0].body.missionId).toBeUndefined();
    expect(calls[0].body.attach).toEqual([{ subjectKind: 'mission', subjectId: M }]);
  });

  test('a refused upload fails with the server message', async () => {
    const fn = (async () => Response.json({ error: 'metadata.screens[0].id must be …' }, { status: 400 })) as unknown as typeof fetch;
    await expect(uploadDesign({ server: 'https://srv', apiKey: 'k', html, filename: 'n.html', metadata, missionId: M }, fn)).rejects.toThrow(/400.*metadata\.screens/);
  });
});

describe('exportCanvas: live components', () => {
  const script = (props: Record<string, unknown>, cls: string) =>
    `<script type="text/x-dc" data-dc-script data-props='${JSON.stringify(props)}'>\n${cls}\n</script>`;
  const comp = (name: string, body: string, props: Record<string, unknown>, cls: string, style = '') =>
    `<x-dc><helmet><style>${style}</style></helmet>${body}</x-dc>\n${script(props, cls)}`;

  function liveCanvas(files: Record<string, string>, screens?: Record<string, unknown>): string {
    const root = mkdtempSync(join(tmpdir(), 'canvas-live-'));
    dirs.push(root);
    const project = join(root, 'project');
    mkdirSync(project);
    writeFileSync(join(project, 'canvas.json'), JSON.stringify({
      v: 3,
      boards: {
        'Page.dc.html': { w: 390, h: 600, title: 'Page' },
        'Row.dc.html': { w: 390, h: 60, title: 'Row' },
      },
    }));
    for (const [f, c] of Object.entries(files)) writeFileSync(join(project, f), c);
    if (screens) writeFileSync(join(project, 'screens.json'), JSON.stringify(screens));
    return root;
  }

  const row = comp(
    'Row',
    '<div class="row"><b class="s" style="{{sty}}"></b>{{title}}<sc-if value="{{hasFix}}"><i>{{fixText}}</i></sc-if></div>',
    { title: { editor: 'text', default: 'Default title' }, fixes: { editor: 'int', default: 0 }, $preview: { width: 390, height: 60 } },
    `class Component extends DCLogic { renderVals() { const f = this.props.fixes ?? 0; return { title: this.props.title ?? 'Default title', sty: 'color:red', hasFix: f > 0, fixText: '↻' + f }; } }`,
    '.row{display:flex}',
  );
  const page = comp(
    'Page',
    `<h1>{{heading}}</h1>
<sc-for list="{{groups}}" as="g"><h2>{{g.label}} {{g.count}}</h2><sc-for list="{{g.rows}}" as="r"><dc-import name="Row" title="{{r.title}}" fixes="{{r.fixes}}" hint-size="100%,64px"></dc-import></sc-for></sc-for>
<dc-import name="Row"></dc-import>
<sc-if value="{{showFooter}}"><footer>shown</footer></sc-if><sc-if value="{{hideFooter}}"><footer>hidden</footer></sc-if>`,
    { $preview: { width: 390, height: 600 } },
    `class Component extends DCLogic { renderVals() {
      const groups = [{ label: 'Build', rows: [{ title: 'One', fixes: 2 }, { title: 'Two', fixes: 0 }] }, { label: 'Done', rows: [{ title: 'Three', fixes: 0 }] }].map(g => ({ ...g, count: g.rows.length }));
      return { heading: 'Now', groups, showFooter: true, hideFooter: false };
    } }`,
  );
  const files = { 'Page.dc.html': page, 'Row.dc.html': row };

  test('expands dc-import, sc-for and sc-if from the component\'s own logic and defaults', () => {
    const { html } = exportCanvas(liveCanvas(files));
    const section = html.slice(html.indexOf('id="phone-page"'), html.indexOf('id="phone-row"'));
    expect(section).toContain('<h1>Now</h1>');
    expect(section).toContain('Build 2');
    expect(section).toContain('Done 1');
    for (const t of ['One', 'Two', 'Three']) expect(section).toContain(t);
    expect(section).toContain('Default title'); // an import with no props takes the component's defaults
    expect(section).toContain('↻2');
    expect(section).not.toContain('↻0');
    expect(section).toContain('<footer>shown</footer>');
    expect(section).not.toContain('hidden');
    expect(section).not.toMatch(/dc-import|sc-for|sc-if|\{\{/);
    expect(section).toContain('style="color:red"');
  });

  test('each board stays its own screen, ids from screens.json, the component\'s css is merged', () => {
    const out = exportCanvas(liveCanvas(files, { Page: 'phone-page-x', Row: { id: 'c-row', kind: 'component' } }));
    expect(out.metadata.screens.map(s => s.id)).toEqual(['phone-page-x', 'c-row']);
    expect(out.html.match(/data-screen="/g)).toHaveLength(2);
    expect(out.html).toContain('.row{display:flex}');
  });

  test('a board with its own props renders their defaults', () => {
    const out = exportCanvas(liveCanvas(files));
    const rowSection = out.html.slice(out.html.indexOf('id="phone-row"'));
    expect(rowSection).toContain('Default title');
    expect(rowSection).not.toContain('↻');
  });

  test('values stay escaped', () => {
    const evil = { ...files, 'Row.dc.html': row.replace('"default":"Default title"', '"default":"<b>x</b>"').replace('"default": "Default title"', '"default": "<b>x</b>"') };
    const { html } = exportCanvas(liveCanvas(evil));
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  test('an import of a component the canvas does not have warns and renders nothing', () => {
    const f = { ...files, 'Page.dc.html': page.replace('<dc-import name="Row"></dc-import>', '<dc-import name="Ghost"></dc-import>') };
    const out = exportCanvas(liveCanvas(f));
    expect(out.warnings.join('\n')).toContain('Ghost');
  });

  test('a placeholder the logic does not supply still falls back to placeholders.json, then fails', () => {
    const f = { ...files, 'Page.dc.html': page.replace('<h1>{{heading}}</h1>', '<h1>{{heading}}</h1><p>{{nope}}</p>') };
    expect(() => exportCanvas(liveCanvas(f))).toThrow(/nope/);
  });
});
