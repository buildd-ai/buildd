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
