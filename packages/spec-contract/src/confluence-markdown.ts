/**
 * Confluence storage format (XHTML with `ac:`/`ri:` macros) to Markdown, and a
 * minimal Markdown to storage renderer for proposals. Pure, no DOM library: a
 * small tolerant tokenizer builds a tree, and unknown markup degrades to its
 * text rather than failing.
 *
 * The Markdown is a spec's frozen copy (./hash.ts normalizes and hashes it), so
 * what matters is that the text and the criterion ids survive, not fidelity:
 * - Inline whitespace collapses as HTML renders it, and `&nbsp;` reads as a
 *   space, so a re-save that only moved whitespace hashes the same.
 * - A table whose first column holds criterion ids (`R-1`, `AC-2`, `D-3`,
 *   `I-4`) is rendered as a table AND, after it, as one list line per row,
 *   `- **R-1** <the other cells, joined by " — ">`, because the id parser
 *   (./requirements.ts) reads ids where a line, list item, heading or bold
 *   label starts, never inside a table row.
 *
 * Storage format reference:
 * https://confluence.atlassian.com/doc/confluence-storage-format-790796544.html
 */

type Node =
  | { type: 'el'; name: string; attrs: Record<string, string>; children: Node[] }
  | { type: 'text'; value: string }
  | { type: 'cdata'; value: string };

const VOID = new Set(['br', 'hr', 'img', 'col', 'input', 'meta', 'link', 'wbr']);
const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', middot: '·', copy: '©', reg: '®', trade: '™', rarr: '→', larr: '←',
  euro: '€', pound: '£', yen: '¥', cent: '¢', deg: '°', times: '×', divide: '÷', plusmn: '±', le: '≤', ge: '≥', ne: '≠', check: '✓',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return m;
      return code === 0xa0 ? ' ' : String.fromCodePoint(code);
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

const TOKEN = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z][\w:.-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;
const ATTR = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(ATTR)) out[m[1]!.toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  return out;
}

/** A tolerant parse: an unmatched close tag is ignored, an unclosed element closes at its parent's end. */
export function parseStorage(xhtml: string): Node[] {
  const root: Node = { type: 'el', name: '#root', attrs: {}, children: [] };
  const stack: Array<Extract<Node, { type: 'el' }>> = [root as Extract<Node, { type: 'el' }>];
  const top = () => stack[stack.length - 1]!;
  let last = 0;
  for (const m of xhtml.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) top().children.push({ type: 'text', value: decodeEntities(xhtml.slice(last, at)) });
    last = at + m[0].length;
    if (m[1] !== undefined) { top().children.push({ type: 'cdata', value: m[1] }); continue; }
    const name = m[3]?.toLowerCase();
    if (!name) continue; // comment, processing instruction, doctype
    if (m[2] === '/') {
      const i = stack.map((n) => n.name).lastIndexOf(name);
      if (i > 0) stack.length = i;
      continue;
    }
    const el: Extract<Node, { type: 'el' }> = { type: 'el', name, attrs: parseAttrs(m[4] ?? ''), children: [] };
    top().children.push(el);
    if (m[5] !== '/' && !VOID.has(name)) stack.push(el);
  }
  if (last < xhtml.length) top().children.push({ type: 'text', value: decodeEntities(xhtml.slice(last)) });
  return (root as Extract<Node, { type: 'el' }>).children;
}

// ── Rendering ───────────────────────────────────────────────────────────────

const BLOCK = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'table', 'blockquote', 'pre', 'hr', 'div', 'section',
  'ac:layout', 'ac:layout-section', 'ac:layout-cell', 'ac:rich-text-body', 'ac:task-list',
]);
const CONTAINER = new Set(['div', 'section', 'ac:layout', 'ac:layout-section', 'ac:layout-cell', 'ac:rich-text-body', 'tbody', 'thead', 'tfoot']);
const CALLOUT = new Set(['info', 'note', 'warning', 'tip', 'panel']);
const CRITERION_CELL = /^(R|AC|D|I)-\d+$/;

type El = Extract<Node, { type: 'el' }>;
const isEl = (n: Node): n is El => n.type === 'el';
const macroName = (n: El) => (n.name === 'ac:structured-macro' || n.name === 'ac:macro' ? (n.attrs['ac:name'] ?? '').toLowerCase() : '');
const param = (n: El, key: string) => {
  const p = n.children.find((c) => isEl(c) && c.name === 'ac:parameter' && (c.attrs['ac:name'] ?? '').toLowerCase() === key);
  return p ? rawText(p) : '';
};
const childEl = (n: El, name: string) => n.children.find((c): c is El => isEl(c) && c.name === name);

/** Text exactly as stored (CDATA included), for code bodies and parameters. */
function rawText(n: Node): string {
  if (n.type !== 'el') return n.value;
  return n.children.map(rawText).join('');
}

const collapse = (s: string) => s.replace(/[\s ]+/g, ' ');

function isBlockNode(n: Node): boolean {
  if (!isEl(n)) return false;
  if (BLOCK.has(n.name)) return true;
  const macro = macroName(n);
  return macro !== '' && macro !== 'status' && macro !== 'anchor' && macro !== 'jira';
}

function inline(nodes: Node[]): string {
  let out = '';
  for (const n of nodes) {
    if (n.type === 'text') { out += collapse(n.value); continue; }
    if (n.type === 'cdata') { out += collapse(n.value); continue; }
    out += inlineEl(n);
  }
  return out;
}

function wrap(mark: string, inner: string): string {
  const t = inner.trim();
  if (!t) return inner;
  const lead = inner.startsWith(' ') ? ' ' : '';
  const trail = inner.endsWith(' ') ? ' ' : '';
  return `${lead}${mark}${t}${mark}${trail}`;
}

function inlineEl(n: El): string {
  switch (n.name) {
    case 'strong': case 'b': return wrap('**', inline(n.children));
    case 'em': case 'i': return wrap('*', inline(n.children));
    case 'code': case 'tt': return wrap('`', rawText(n).replace(/`/g, "'"));
    case 's': case 'del': return wrap('~~', inline(n.children));
    case 'br': return '\n';
    case 'a': {
      const text = inline(n.children).trim();
      const href = n.attrs.href;
      return href ? `[${text || href}](${href})` : text;
    }
    case 'ac:link': {
      const body = childEl(n, 'ac:link-body') ?? childEl(n, 'ac:plain-text-link-body');
      const text = body ? inline(body.children).trim() : '';
      const page = childEl(n, 'ri:page');
      const attachment = childEl(n, 'ri:attachment');
      return text || page?.attrs['ri:content-title'] || attachment?.attrs['ri:filename'] || '';
    }
    case 'ac:image': case 'ac:emoticon': case 'ac:placeholder': case 'ac:parameter': case 'ri:page': case 'ri:user': return '';
    case 'ac:structured-macro': case 'ac:macro': {
      const name = macroName(n);
      if (name === 'status') return param(n, 'title');
      if (name === 'anchor') return '';
      return inline(n.children.filter((c) => !(isEl(c) && c.name === 'ac:parameter')));
    }
    default: return inline(n.children);
  }
}

/** Inline content as one or more lines; a `<br>` starts a new line, edges trimmed. */
const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean).join('\n');

function blocks(nodes: Node[]): string[] {
  const out: string[] = [];
  let pending: Node[] = [];
  const flush = () => {
    const text = lines(inline(pending));
    if (text) out.push(text);
    pending = [];
  };
  for (const n of nodes) {
    if (isBlockNode(n)) { flush(); out.push(...block(n as El)); } else pending.push(n);
  }
  flush();
  return out;
}

function block(n: El): string[] {
  const h = /^h([1-6])$/.exec(n.name);
  if (h) { const t = collapse(inline(n.children)).trim(); return t ? [`${'#'.repeat(Number(h[1]))} ${t}`] : []; }
  if (n.name === 'p') { const t = lines(inline(n.children)); return t ? [t] : []; }
  if (n.name === 'hr') return ['---'];
  if (n.name === 'ul' || n.name === 'ol') { const t = list(n, 0); return t ? [t] : []; }
  if (n.name === 'ac:task-list') return [taskList(n)];
  if (n.name === 'table') return table(n);
  if (n.name === 'pre') return [fence(rawText(n), '')];
  if (n.name === 'blockquote') return [quote(blocks(n.children))];
  if (CONTAINER.has(n.name)) return blocks(n.children);
  const macro = macroName(n);
  if (macro === 'code' || macro === 'noformat') {
    const body = childEl(n, 'ac:plain-text-body');
    return [fence(body ? rawText(body) : '', param(n, 'language'))];
  }
  if (CALLOUT.has(macro)) {
    const body = childEl(n, 'ac:rich-text-body');
    const title = param(n, 'title');
    const inner = [...(title ? [`**${title}**`] : []), ...(body ? blocks(body.children) : [])];
    return inner.length ? [quote(inner)] : [];
  }
  if (macro) {
    // Unknown macro (expand, toc, details, ...): keep its body's text.
    const rich = childEl(n, 'ac:rich-text-body');
    if (rich) return blocks(rich.children);
    const plain = childEl(n, 'ac:plain-text-body');
    if (plain) { const t = rawText(plain).trim(); return t ? [t] : []; }
    return blocks(n.children.filter((c) => !(isEl(c) && c.name === 'ac:parameter')));
  }
  return blocks(n.children);
}

function fence(code: string, language: string): string {
  const body = code.replace(/^\n+|\s+$/g, '');
  const ticks = /```/.test(body) ? '~~~' : '```';
  return `${ticks}${language.trim()}\n${body}\n${ticks}`;
}

const quote = (parts: string[]) => parts.join('\n\n').split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');

function list(n: El, depth: number): string {
  const ordered = n.name === 'ol';
  const indent = '  '.repeat(depth);
  const out: string[] = [];
  let i = 0;
  for (const li of n.children) {
    if (!isEl(li) || li.name !== 'li') continue;
    i += 1;
    const nested = li.children.filter((c): c is El => isEl(c) && (c.name === 'ul' || c.name === 'ol'));
    const own = li.children.filter((c) => !(isEl(c) && (c.name === 'ul' || c.name === 'ol')));
    const text = blocks(own).join(' ').replace(/\n+/g, ' ').trim();
    out.push(`${indent}${ordered ? `${i}.` : '-'} ${text}`.trimEnd());
    for (const sub of nested) { const t = list(sub, depth + 1); if (t) out.push(t); }
  }
  return out.join('\n');
}

function taskList(n: El): string {
  return n.children.filter((c): c is El => isEl(c) && c.name === 'ac:task').map((t) => {
    const done = rawText(childEl(t, 'ac:task-status') ?? { type: 'text', value: '' }).trim() === 'complete';
    const body = childEl(t, 'ac:task-body');
    return `- [${done ? 'x' : ' '}] ${body ? collapse(inline(body.children)).trim() : ''}`;
  }).join('\n');
}

function rowsOf(n: El): El[][] {
  const rows: El[][] = [];
  const visit = (x: El) => {
    for (const c of x.children) {
      if (!isEl(c)) continue;
      if (c.name === 'tr') rows.push(c.children.filter((d): d is El => isEl(d) && (d.name === 'td' || d.name === 'th')));
      else if (c.name === 'thead' || c.name === 'tbody' || c.name === 'tfoot') visit(c);
    }
  };
  visit(n);
  return rows.filter((r) => r.length > 0);
}

const cellText = (c: El) => collapse(blocks(c.children).join(' ')).trim().replace(/\|/g, '\\|');

function table(n: El): string[] {
  const rows = rowsOf(n).map((r) => r.map(cellText));
  if (rows.length === 0) return [];
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array(width - r.length).fill('')];
  const [head, ...body] = rows.map(pad);
  const md = [`| ${head!.join(' | ')} |`, `| ${head!.map(() => '---').join(' | ')} |`, ...body.map((r) => `| ${r.join(' | ')} |`)].join('\n');
  // Criterion ids in the first column are restated as list lines the id parser reads.
  const idRows = body.filter((r) => CRITERION_CELL.test(r[0]!.replace(/\*\*/g, '').trim()));
  if (idRows.length === 0) return [md];
  const restated = idRows.map((r) => {
    const id = r[0]!.replace(/\*\*/g, '').trim();
    const rest = r.slice(1).map((c) => c.replace(/\\\|/g, '|')).filter(Boolean).join(' — ');
    return `- **${id}** ${rest}`.trimEnd();
  }).join('\n');
  return [md, restated];
}

/** Confluence storage-format XHTML as Markdown (see the module header for the rules). */
export function storageToMarkdown(xhtml: string): string {
  return blocks(parseStorage(xhtml)).join('\n\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

// ── Markdown to storage (proposals) ─────────────────────────────────────────

const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inlineToStorage(s: string): string {
  const parts = s.split(/(`[^`]+`)/);
  return parts.map((p) => {
    if (/^`[^`]+`$/.test(p)) return `<code>${escapeXml(p.slice(1, -1))}</code>`;
    return escapeXml(p)
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t: string, u: string) => `<a href="${u}">${t}</a>`)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  }).join('');
}

/**
 * Minimal Markdown to storage format, for a proposal page: headings,
 * paragraphs, nested lists, code fences, block quotes, bold, italic, code and
 * links. Anything else is written as a paragraph of its text.
 */
export function markdownToStorage(md: string): string {
  const src = md.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let para: string[] = [];
  const flushPara = () => { if (para.length) out.push(`<p>${para.map(inlineToStorage).join('<br />')}</p>`); para = []; };
  let i = 0;
  while (i < src.length) {
    const line = src[i]!;
    const fenceOpen = /^\s*(```|~~~)\s*([\w+-]*)\s*$/.exec(line);
    if (fenceOpen) {
      flushPara();
      const body: string[] = [];
      i += 1;
      while (i < src.length && !new RegExp(`^\\s*${fenceOpen[1]}\\s*$`).test(src[i]!)) { body.push(src[i]!); i += 1; }
      i += 1;
      const lang = fenceOpen[2] ? `<ac:parameter ac:name="language">${escapeXml(fenceOpen[2])}</ac:parameter>` : '';
      out.push(`<ac:structured-macro ac:name="code">${lang}<ac:plain-text-body><![CDATA[${body.join('\n').replace(/\]\]>/g, ']]]]><![CDATA[>')}]]></ac:plain-text-body></ac:structured-macro>`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) { flushPara(); out.push(`<h${heading[1]!.length}>${inlineToStorage(heading[2]!.trim())}</h${heading[1]!.length}>`); i += 1; continue; }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      flushPara();
      const items: Array<{ depth: number; ordered: boolean; text: string }> = [];
      while (i < src.length && /^\s*([-*+]|\d+\.)\s+/.test(src[i]!)) {
        const m = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(src[i]!)!;
        items.push({ depth: Math.floor(m[1]!.replace(/\t/g, '  ').length / 2), ordered: /\d/.test(m[2]!), text: m[3]! });
        i += 1;
      }
      out.push(renderList(items, 0, 0).html);
      continue;
    }
    if (/^>\s?/.test(line)) {
      flushPara();
      const q: string[] = [];
      while (i < src.length && /^>\s?/.test(src[i]!)) { q.push(src[i]!.replace(/^>\s?/, '')); i += 1; }
      out.push(`<blockquote>${markdownToStorage(q.join('\n'))}</blockquote>`);
      continue;
    }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) { flushPara(); out.push('<hr />'); i += 1; continue; }
    if (line.trim() === '') { flushPara(); i += 1; continue; }
    para.push(line.trim());
    i += 1;
  }
  flushPara();
  return out.join('');
}

function renderList(items: Array<{ depth: number; ordered: boolean; text: string }>, start: number, depth: number): { html: string; next: number } {
  const tag = items[start]?.ordered ? 'ol' : 'ul';
  let html = `<${tag}>`;
  let i = start;
  while (i < items.length && items[i]!.depth >= depth) {
    const item = items[i]!;
    if (item.depth > depth) {
      const sub = renderList(items, i, item.depth);
      html = html.replace(/<\/li>$/, `${sub.html}</li>`);
      i = sub.next;
      continue;
    }
    html += `<li>${inlineToStorage(item.text)}</li>`;
    i += 1;
  }
  return { html: `${html}</${tag}>`, next: i };
}
