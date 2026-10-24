import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DEFAULT_ROLES } from './default-roles';

/**
 * The capability broker is only useful if an agent that lacks access finds it.
 * The server half (request, policy, grant, ledger, invoke) shipped; what an agent
 * read at the moment it needed a provider or a model call said nothing about it,
 * so a builder that could not make a governed model call wrote a script that read
 * a database URL and a key of its own, and called the requirement impossible.
 * Spec: docs/specs/capability-requests.md "Agent reach".
 */
const repoRoot = join(__dirname, '../../../..');
const read = (p: string) => readFileSync(join(repoRoot, p), 'utf8');
const role = (slug: string) => {
  const r = DEFAULT_ROLES.find(x => x.slug === slug);
  if (!r) throw new Error(`no default role ${slug}`);
  return r.content;
};

describe('the path to missing access is taught where agents look', () => {
  for (const file of ['.claude/skills/buildd-mcp-consumer/SKILL.md', '.claude/skills/buildd-workflow/SKILL.md']) {
    it(`${file} names discovery, the request and how to spend a model grant`, () => {
      const body = read(file);
      expect(body).toContain('resolve_capability');
      expect(body).toContain('request_capability');
      expect(body).toContain('invoke_model_inference');
    });
  }

  for (const slug of ['builder', 'researcher']) {
    it(`the ${slug} role asks instead of building around missing access`, () => {
      const body = role(slug);
      expect(body).toContain('request_capability');
      expect(body).toContain('invoke_model_inference');
      expect(body).toMatch(/never .*key of your own/i);
    });
  }

  it('the organizer plans a step that needs access through a request, not a person running it by hand', () => {
    expect(role('organizer')).toContain('request_capability');
  });
});
