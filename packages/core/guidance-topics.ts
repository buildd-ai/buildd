/**
 * Workflow guidance a tools-only MCP client can read: `help {topic}`.
 *
 * Each topic is one markdown file in packages/core/mcp-guidance/, named
 * `<topic>.md`, SKILL.md-style (frontmatter `name` + `description`, then the
 * body). The topics are whatever files exist: nothing here names one, so a new
 * file is a new topic with no code change. README.md is the directory's own
 * note, not a topic.
 *
 * A reply is only text for the model to read. It does not activate a host
 * skill and never assumes one is installed.
 */
import { createHash } from 'crypto';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

export interface GuidanceTopic {
  topic: string;
  name: string | null;
  description: string | null;
  /** First 12 hex characters of the file's sha256. */
  digest: string;
  body: string;
}

const TOPIC_FILE = /^([a-z0-9][a-z0-9-]*)\.md$/;

/**
 * Where the files are: apps/web's cwd on a deployment (outputFileTracingIncludes
 * in apps/web/next.config.ts ships them), or the repo root under tests and
 * scripts. BUILDD_MCP_GUIDANCE_DIR overrides both.
 */
export function guidanceDir(): string | null {
  const candidates = [
    process.env.BUILDD_MCP_GUIDANCE_DIR,
    join(process.cwd(), '..', '..', 'packages', 'core', 'mcp-guidance'),
    join(process.cwd(), 'packages', 'core', 'mcp-guidance'),
    join(process.cwd(), '..', 'core', 'mcp-guidance'),
  ].filter((d): d is string => !!d);
  return candidates.find(d => existsSync(d)) ?? null;
}

/** `key: value` lines of a leading `---` block; `>` / `|` values fold their indented lines. */
export function parseFrontmatter(source: string): { fields: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
  if (!m) return { fields: {}, body: source };
  const fields: Record<string, string> = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let value = kv[2].trim();
    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      const block: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) block.push(lines[++i].trim());
      value = block.join(value.startsWith('>') ? ' ' : '\n');
    }
    fields[kv[1]] = value.replace(/^(["'])([\s\S]*)\1$/, '$2');
  }
  return { fields, body: source.slice(m[0].length) };
}

export function listGuidanceTopics(dir: string | null = guidanceDir()): GuidanceTopic[] {
  if (!dir) return [];
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  return files
    .map(f => TOPIC_FILE.exec(f)?.[1])
    .filter((t): t is string => !!t && t !== 'readme')
    .sort()
    .flatMap(topic => {
      try {
        const source = readFileSync(join(dir, `${topic}.md`), 'utf8');
        const { fields, body } = parseFrontmatter(source);
        return [{
          topic,
          name: fields.name ?? null,
          description: fields.description ?? null,
          digest: createHash('sha256').update(source).digest('hex').slice(0, 12),
          body: body.trim(),
        }];
      } catch {
        return [];
      }
    });
}

/** How to ask for one topic, per surface. */
export type HelpCall = (topic: string) => string;

/** The topic list `help {}` ends with. */
export function guidanceTopicsText(call: HelpCall, dir?: string | null): string {
  const topics = listGuidanceTopics(dir === undefined ? guidanceDir() : dir);
  if (topics.length === 0) return 'Guidance topics: none on this server.';
  return `Guidance topics (read one with ${call('<topic>')}):\n${topics.map(t => `- ${t.topic}: ${t.description ?? t.name ?? '(no description)'}`).join('\n')}`;
}

/** The reply to `help {topic}`: the body with a digest line, or the topics that exist. */
export function guidanceTopicReply(topic: unknown, dir?: string | null): { text: string; isError: boolean } {
  const topics = listGuidanceTopics(dir === undefined ? guidanceDir() : dir);
  const found = typeof topic === 'string' ? topics.find(t => t.topic === topic.trim().toLowerCase()) : undefined;
  if (!found) {
    const available = topics.length ? topics.map(t => t.topic).join(', ') : 'none';
    return { isError: true, text: `No guidance topic "${String(topic)}". Available: ${available}.` };
  }
  return { isError: false, text: `Guidance: ${found.topic} (sha256 ${found.digest})\n\n${found.body}` };
}
