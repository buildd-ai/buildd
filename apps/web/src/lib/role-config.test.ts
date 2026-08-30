import { describe, it, expect, beforeEach, mock } from 'bun:test';

const mockUploadBuffer = mock(() => Promise.resolve());
const mockDeleteObject = mock(() => Promise.resolve());

mock.module('@buildd/core/db', () => ({
  db: { select: () => ({ from: () => ({ where: () => [] }) }) },
}));

mock.module('@buildd/core/db/schema', () => ({
  workspaceSkills: { workspaceId: 'workspaceId', slug: 'slug', name: 'name', content: 'content' },
}));

mock.module('drizzle-orm', () => ({
  eq: () => ({}),
  and: () => ({}),
  inArray: () => ({}),
}));

mock.module('./storage', () => ({
  uploadBuffer: mockUploadBuffer,
  deleteObject: mockDeleteObject,
}));

const { uploadRoleConfig } = await import('./role-config');

function bundle(slug: string) {
  return {
    slug,
    type: 'service' as const,
    claudeMd: '# role',
    mcpConfig: {},
    envMapping: {},
    skills: [],
    repoUrl: null,
  };
}

describe('uploadRoleConfig', () => {
  beforeEach(() => {
    mockUploadBuffer.mockClear();
  });

  it('writes the bundle under a fixed-depth key derived from the slug and content hash', async () => {
    const result = await uploadRoleConfig(bundle('builder'));

    expect(result.configStorageKey).toBe(`roles/builder/${result.configHash}.json`);
    expect(result.configStorageKey.split('/')).toHaveLength(3);
    expect(mockUploadBuffer.mock.calls[0][0]).toBe(result.configStorageKey);
  });

  it('refuses to write a bundle whose slug is not a single safe segment', async () => {
    // Runners load these bundles, so the key must not be steerable by the slug.
    for (const slug of ['../escape', 'a/b', '..', '', '.hidden', 'a b']) {
      await expect(uploadRoleConfig(bundle(slug))).rejects.toThrow();
    }
    expect(mockUploadBuffer).not.toHaveBeenCalled();
  });
});
