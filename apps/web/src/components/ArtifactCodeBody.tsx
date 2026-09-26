import MarkdownContent from '@/components/MarkdownContent';

/**
 * First-line shapes of raw diff/patch output: `git diff` (incl. merge
 * `--cc` / `--combined`), `git format-patch` (`From <sha> `), `git show` /
 * `git log -p` (`commit <sha>`), svn (`Index: `), and bare unified hunks.
 * `--- ` / `+++ ` need the trailing space: a bare `---` is markdown front
 * matter or a rule, not a diff.
 */
const RAW_DIFF_START = /^(diff --(git|cc|combined) |From [0-9a-f]{40} |commit [0-9a-f]{7,}\b|Index: |--- |\+\+\+ |@@ )/;

/** True when the content is a raw unified diff (first non-blank line is a diff header). */
export function isRawUnifiedDiff(content: string): boolean {
  const first = content.split('\n').find(line => line.trim() !== '') ?? '';
  return RAW_DIFF_START.test(first);
}

// Wraps below md so a phone never gets a thousands-of-px line to pan along;
// at md+ keeps exact columns and scrolls inside the card, not the page.
const PRE_CLS =
  'max-w-full overflow-x-auto text-sm font-mono whitespace-pre-wrap [overflow-wrap:anywhere] md:whitespace-pre md:[overflow-wrap:normal]';

/**
 * Body of a `data` or `diff` artifact, on the artifact page and the public
 * share page. Writers often file a markdown summary
 * of a change as a `diff`; that renders as markdown. A raw diff or JSON stays
 * monospace.
 */
export function ArtifactCodeBody({
  type,
  content,
  textClassName = 'text-text-secondary',
}: {
  type: 'data' | 'diff';
  content: string;
  /** Monospace text colour; the public share page supplies its own palette. */
  textClassName?: string;
}) {
  if (type === 'diff' && !isRawUnifiedDiff(content)) {
    return <MarkdownContent content={content} />;
  }
  let text = content;
  if (type === 'data') {
    try {
      text = JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      // not JSON: show as-is
    }
  }
  return <pre className={`${PRE_CLS} ${textClassName}`}>{text}</pre>;
}
