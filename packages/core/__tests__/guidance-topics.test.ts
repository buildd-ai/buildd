/**
 * help {topic}: workflow guidance served from packages/core/mcp-guidance/*.md.
 * Fixture files only: the real topics are written elsewhere and any set of
 * files must work.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { createHash } from 'crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { guidanceTopicReply, guidanceTopicsText, listGuidanceTopics, parseFrontmatter } from '../guidance-topics';
import { builddHelp } from '../mcp-tools';

const dir = mkdtempSync(join(tmpdir(), 'guidance-'));
const ALPHA = '---\nname: alpha-flow\ndescription: How alpha work is done.\n---\n\n# Alpha\n\nDo the alpha thing.\n';
const BETA = '---\nname: beta\ndescription: >\n  Folded beta\n  description.\n---\nBeta body.\n';
writeFileSync(join(dir, 'alpha.md'), ALPHA);
writeFileSync(join(dir, 'beta.md'), BETA);
writeFileSync(join(dir, 'README.md'), 'Not a topic.');
writeFileSync(join(dir, 'notes.txt'), 'Not a topic either.');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('guidance topics', () => {
  it('lists the .md files, README excluded, with their frontmatter', () => {
    const topics = listGuidanceTopics(dir);
    expect(topics.map(t => t.topic)).toEqual(['alpha', 'beta']);
    expect(topics[0]).toMatchObject({ name: 'alpha-flow', description: 'How alpha work is done.' });
    expect(topics[1].description).toBe('Folded beta description.');
  });

  it('answers a topic with its body and a sha256 digest line', () => {
    const r = guidanceTopicReply('alpha', dir);
    expect(r.isError).toBe(false);
    const digest = createHash('sha256').update(ALPHA).digest('hex').slice(0, 12);
    expect(r.text.split('\n')[0]).toBe(`Guidance: alpha (sha256 ${digest})`);
    expect(r.text).toContain('Do the alpha thing.');
    expect(r.text).not.toContain('description:');
  });

  it('refuses an unknown topic naming the ones that exist', () => {
    expect(guidanceTopicReply('../alpha', dir)).toEqual({ isError: true, text: 'No guidance topic "../alpha". Available: alpha, beta.' });
    expect(guidanceTopicReply('nope', join(dir, 'missing'))).toEqual({ isError: true, text: 'No guidance topic "nope". Available: none.' });
  });

  it('lists topics with descriptions for help {}', () => {
    const t = guidanceTopicsText(x => `help {topic:"${x}"}`, dir);
    expect(t).toContain('- alpha: How alpha work is done.');
    expect(t).toContain('- beta: Folded beta description.');
    expect(guidanceTopicsText(x => x, null)).toBe('Guidance topics: none on this server.');
  });

  it('parses frontmatter only when it leads the file', () => {
    expect(parseFrontmatter('no frontmatter').fields).toEqual({});
    expect(parseFrontmatter('---\nname: "q"\n---\nbody').fields.name).toBe('q');
  });

  it('buildd action=help serves the same guidance and docs', () => {
    const prev = process.env.BUILDD_MCP_GUIDANCE_DIR;
    process.env.BUILDD_MCP_GUIDANCE_DIR = dir;
    try {
      expect(builddHelp({ topic: 'beta' }).content[0].text).toContain('Beta body.');
      expect(builddHelp({ topic: 'gamma' }).isError).toBe(true);
      expect(builddHelp({}).content[0].text).toContain('- alpha: How alpha work is done.');
      expect(builddHelp({ action: 'manage_specs' }).content[0].text).toContain('"create_draft"');
      expect(builddHelp({ action: 'nope' }).isError).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.BUILDD_MCP_GUIDANCE_DIR;
      else process.env.BUILDD_MCP_GUIDANCE_DIR = prev;
    }
  });
});
