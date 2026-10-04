/**
 * Default role bodies resolve through the versioned prompts table: an active
 * row changes the text seeded, resynced and delivered at claim time, and an
 * unedited seeded row follows the resolved text as it changes (a row going
 * active, a new version, its removal), with no code change or version bump.
 */
import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';

let updates: Array<{ set: Record<string, unknown> }> = [];

mock.module('@buildd/core/db', () => ({
  db: {
    // The policy-override record read: no record.
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    update: () => ({
      set: (set: Record<string, unknown>) => ({
        where: async () => { updates.push({ set }); },
      }),
    }),
    insert: () => ({ values: () => ({ onConflictDoNothing: async () => {} }) }),
  },
}));

const {
  DEFAULT_ROLES, ROLE_PROMPT_IDS, deliverSeededRoleContent, planDefaultRoleResync, resolveDefaultRoles, roleContentHash, rolePromptId,
} = await import('./default-roles');
const { installPrompts, resetPrompts } = await import('@buildd/core/prompts');
const { promptContentHash } = await import('@buildd/core/prompts-source');
const { resetPolicyOverrides } = await import('./policy-overrides');
const { resetPolicyOverridesLoader } = await import('./policy-overrides-source');

const builder = DEFAULT_ROLES.find(r => r.slug === 'builder')!;
const prompt = (body: string, version = 1) => ({ id: rolePromptId('builder'), version, body, contentHash: promptContentHash(body) });
const seeded = (over: Record<string, unknown> = {}) => ({
  id: 'row-1', slug: 'builder', source: 'system', content: builder.content,
  contentHash: roleContentHash(builder.content), metadata: { defaultRoleVersion: builder.version }, ...over,
});
const flush = () => new Promise(r => setTimeout(r, 0));

let warn: ReturnType<typeof spyOn>;
beforeEach(() => {
  updates = [];
  resetPrompts();
  resetPolicyOverrides();
  resetPolicyOverridesLoader();
  warn = spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  resetPrompts();
  warn.mockRestore();
});

describe('default roles through the prompts table', () => {
  it('names one prompt id per default role', () => {
    expect(ROLE_PROMPT_IDS).toHaveLength(DEFAULT_ROLES.length);
    expect(ROLE_PROMPT_IDS).toContain('buildd.role.builder');
  });

  it('with no row, the resolved roles are the public text', () => {
    expect(resolveDefaultRoles().map(r => r.content)).toEqual(DEFAULT_ROLES.map(r => r.content));
  });

  it('an active row replaces the body, on top of a policy override', () => {
    installPrompts([prompt('# Builder (private)')]);
    const roles = resolveDefaultRoles({ builder: { content: 'override text', description: 'override description' } });
    const b = roles.find(r => r.slug === 'builder')!;
    expect(b.content).toBe('# Builder (private)');
    expect(b.description).toBe('override description');
    expect(b.fromPrompt).toBe(true);
    expect(roles.find(r => r.slug === 'organizer')!.content).toBe(DEFAULT_ROLES.find(r => r.slug === 'organizer')!.content);
  });

  it('an active row changes the role text delivered at claim, and moves the unedited row to it', async () => {
    installPrompts([prompt('# Builder (private)')]);
    expect(await deliverSeededRoleContent(seeded())).toBe('# Builder (private)');
    await flush();
    expect(updates).toHaveLength(1);
    expect(updates[0].set.content).toBe('# Builder (private)');
    expect(updates[0].set.contentHash).toBe(roleContentHash('# Builder (private)'));
    expect((updates[0].set.metadata as Record<string, unknown>).defaultRolePromptHash).toBe(roleContentHash('# Builder (private)'));
  });

  it('a row a team edited keeps its edit and is delivered as stored', async () => {
    installPrompts([prompt('# Builder (private)')]);
    const edited = seeded({ content: '# Our builder', contentHash: roleContentHash('# Our builder') });
    expect(await deliverSeededRoleContent(edited)).toBe('# Our builder');
    expect(await deliverSeededRoleContent(seeded({ source: 'user' }))).toBe(builder.content);
    await flush();
    expect(updates).toEqual([]);
  });

  it('a new row version reaches a row holding the previous one; removing the row reverts it', () => {
    const v1 = '# Builder v1 (private)';
    const v1Row = seeded({ content: v1, contentHash: roleContentHash(v1), metadata: { defaultRoleVersion: builder.version, defaultRolePromptHash: roleContentHash(v1) } });

    installPrompts([prompt('# Builder v2 (private)', 2)]);
    const [toV2] = planDefaultRoleResync([v1Row], resolveDefaultRoles());
    expect(toV2.content).toBe('# Builder v2 (private)');

    resetPrompts();
    const [back] = planDefaultRoleResync([v1Row], resolveDefaultRoles());
    expect(back.content).toBe(builder.content);

    // An edit made after the platform wrote v1 leaves the stamp behind: untouched.
    installPrompts([prompt('# Builder v2 (private)', 2)]);
    const editedAfter = { ...v1Row, contentHash: roleContentHash('# edited') };
    expect(planDefaultRoleResync([editedAfter], resolveDefaultRoles())).toEqual([]);
  });

  it('without a prompts row, a code or override change still needs a version bump (unchanged behaviour)', () => {
    const roles = resolveDefaultRoles({ builder: { content: 'override text' } });
    expect(planDefaultRoleResync([seeded()], roles)).toEqual([]);
  });
});
