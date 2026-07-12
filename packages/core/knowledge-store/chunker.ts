// Dependency-free chunkers for the KnowledgeStore.
//
// Phase 2 splits source files into multiple retrievable chunks. We avoid heavy
// AST/MDX parsers: a line-window splitter with overlap is language-agnostic and
// robust, and markdown gets a heading-aware pass so each chunk carries its
// section context. Each piece tracks its line range so callers can build stable
// composite ids (`path#startLine`) and deep links.

export interface ChunkOptions {
  /** Soft upper bound on chunk size in characters. */
  maxChars: number;
  /** Approximate characters of trailing context shared with the next chunk. */
  overlap: number;
}

export interface ChunkPiece {
  content: string;
  /** 1-based, inclusive. */
  startLine: number;
  /** 1-based, inclusive. */
  endLine: number;
  /** Ancestor + current heading titles (markdown only). */
  headingPath: string[];
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;

/**
 * Generic line-window splitter. Accumulates whole lines up to `maxChars`, then
 * starts the next window a few lines back so ~`overlap` characters are shared.
 * Never drops content; a single line longer than `maxChars` becomes its own
 * (oversized) chunk rather than being truncated.
 */
export function chunkText(text: string, opts: ChunkOptions): ChunkPiece[] {
  if (!text || !text.trim()) return [];
  const { maxChars, overlap } = opts;
  const lines = text.split('\n');
  const pieces: ChunkPiece[] = [];

  let i = 0;
  while (i < lines.length) {
    let size = 0;
    let j = i;
    while (j < lines.length) {
      const add = lines[j].length + (j > i ? 1 : 0); // +1 for the joining newline
      if (j > i && size + add > maxChars) break;
      size += add;
      j++;
    }
    if (j === i) j = i + 1; // always make progress on an oversized line

    const content = lines.slice(i, j).join('\n');
    if (content.trim()) {
      pieces.push({ content, startLine: i + 1, endLine: j, headingPath: [] });
    }
    if (j >= lines.length) break;

    // Walk back from the window end until ~overlap chars are covered.
    let overlapChars = 0;
    let k = j;
    while (k > i + 1 && overlapChars < overlap) {
      overlapChars += lines[k - 1].length + 1;
      k--;
    }
    i = Math.max(k, i + 1); // guarantee forward progress
  }

  return pieces;
}

interface RawSection {
  headingPath: string[];
  lines: string[];
  startLine: number; // 1-based line of the first line in `lines`
}

/**
 * Heading-aware markdown/MDX splitter. Each `#`..`######` heading opens a new
 * section; the section's chunks inherit the full ancestor heading path. Sections
 * larger than `maxChars` are sub-split with `chunkText` while keeping the path.
 */
export function chunkMarkdown(text: string, opts: ChunkOptions): ChunkPiece[] {
  if (!text || !text.trim()) return [];
  const lines = text.split('\n');

  const sections: RawSection[] = [];
  const stack: Array<{ level: number; title: string }> = [];
  let current: RawSection | null = null;

  lines.forEach((line, idx) => {
    const m = line.match(HEADING_RE);
    if (m) {
      const level = m[1].length;
      const title = m[2].trim();
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, title });
      current = { headingPath: stack.map(s => s.title), lines: [line], startLine: idx + 1 };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    } else {
      // Preamble before the first heading.
      current = { headingPath: [], lines: [line], startLine: idx + 1 };
      sections.push(current);
    }
  });

  const pieces: ChunkPiece[] = [];
  for (const section of sections) {
    const body = section.lines.join('\n');
    if (!body.trim()) continue;

    if (body.length <= opts.maxChars) {
      pieces.push({
        content: body,
        startLine: section.startLine,
        endLine: section.startLine + section.lines.length - 1,
        headingPath: section.headingPath,
      });
    } else {
      for (const sub of chunkText(body, opts)) {
        pieces.push({
          content: sub.content,
          startLine: section.startLine + sub.startLine - 1,
          endLine: section.startLine + sub.endLine - 1,
          headingPath: section.headingPath,
        });
      }
    }
  }

  return pieces;
}

/**
 * Code splitter. Language-agnostic line-window splitting — keeps whole lines
 * together so functions/blocks rarely get cut mid-token, with overlap so a
 * definition spanning a boundary still appears whole in one chunk.
 */
export function chunkCode(text: string, opts: ChunkOptions): ChunkPiece[] {
  return chunkText(text, opts);
}

// ── Symbol-boundary chunking (spec §4, B1) ───────────────────────────────────

/**
 * Minimal span a chunkable symbol needs — structurally satisfied by
 * `ExtractedSymbol` from symbol-extractor.ts. Kept loose so this module stays
 * dependency-free (the ast-grep call happens in ingest.ts, not here).
 */
export interface SymbolSpan {
  /** 1-based, inclusive. */
  startLine: number;
  /** 1-based, inclusive. */
  endLine: number;
}

interface Segment {
  start: number; // 1-based, inclusive
  end: number;   // 1-based, inclusive
}

/**
 * Symbol-boundary code splitter. Given the file text and its top-level
 * declaration spans (pre-extracted — no ast-grep dependency here), produces
 * chunks aligned to declaration boundaries:
 *
 * - Each chunk covers one or more consecutive declarations, greedily packed
 *   up to the `maxChars` budget.
 * - Gap lines between declarations (imports header, loose statements,
 *   comments) attach to the adjacent chunk: leading/inter-declaration gaps to
 *   the following declaration, the trailing gap to the last chunk.
 * - A single declaration larger than the budget falls back to the line-window
 *   splitter internally (with overlap), so nothing is ever dropped.
 * - No symbols at all degrades to plain `chunkText`.
 */
export function chunkCodeSymbols(
  text: string,
  symbols: SymbolSpan[],
  opts: ChunkOptions,
): ChunkPiece[] {
  if (!text || !text.trim()) return [];
  const lines = text.split('\n');
  const lineCount = lines.length;

  // Sanitize: clamp to file bounds, drop inverted spans, sort by start.
  const spans = symbols
    .map(s => ({
      startLine: Math.max(1, Math.min(s.startLine, lineCount)),
      endLine: Math.max(1, Math.min(s.endLine, lineCount)),
    }))
    .filter(s => s.endLine >= s.startLine)
    .sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);

  if (spans.length === 0) return chunkText(text, opts);

  // Build contiguous segments: each ends at a declaration end; the gap before
  // a declaration (imports, loose statements) rides along with it.
  const segments: Segment[] = [];
  let cursor = 1;
  for (const span of spans) {
    const end = Math.max(span.endLine, cursor);
    if (segments.length > 0 && span.startLine <= segments[segments.length - 1].end) {
      // Overlapping/nested span (defensive) — extend the previous segment.
      segments[segments.length - 1].end = Math.max(segments[segments.length - 1].end, end);
    } else {
      segments.push({ start: cursor, end });
    }
    cursor = segments[segments.length - 1].end + 1;
  }
  // Trailing gap after the last declaration attaches to the last segment.
  if (cursor <= lineCount) segments[segments.length - 1].end = lineCount;

  const segmentChars = (seg: Segment): number => {
    let size = 0;
    for (let l = seg.start; l <= seg.end; l++) {
      size += lines[l - 1].length + (l > seg.start ? 1 : 0);
    }
    return size;
  };

  const pieces: ChunkPiece[] = [];
  const pushPiece = (start: number, end: number) => {
    const content = lines.slice(start - 1, end).join('\n');
    if (content.trim()) pieces.push({ content, startLine: start, endLine: end, headingPath: [] });
  };

  // Greedy packing of consecutive segments up to the char budget.
  let packStart: number | null = null;
  let packEnd = 0;
  let packSize = 0;
  const flush = () => {
    if (packStart !== null) pushPiece(packStart, packEnd);
    packStart = null;
    packSize = 0;
  };

  for (const seg of segments) {
    const size = segmentChars(seg);

    if (size > opts.maxChars) {
      // Oversized single declaration: flush the current pack, then fall back
      // to line-window splitting inside the segment (offsetting line numbers).
      flush();
      const body = lines.slice(seg.start - 1, seg.end).join('\n');
      for (const sub of chunkText(body, opts)) {
        pieces.push({
          content: sub.content,
          startLine: seg.start + sub.startLine - 1,
          endLine: seg.start + sub.endLine - 1,
          headingPath: [],
        });
      }
      continue;
    }

    if (packStart !== null && packSize + 1 + size > opts.maxChars) flush();
    if (packStart === null) {
      packStart = seg.start;
      packSize = size;
    } else {
      packSize += 1 + size; // +1 for the joining newline
    }
    packEnd = seg.end;
  }
  flush();

  return pieces;
}
