import { describe, it, expect, mock, beforeEach } from 'bun:test';

let installationId: number | null = 42;
const tokenFor: number[] = [];

mock.module('@/lib/workspace-installation', () => ({
  installationIdForRepo: async () => installationId,
}));
mock.module('@/lib/github', () => ({
  getInstallationToken: async (id: number) => {
    tokenFor.push(id);
    return 'installation-token';
  },
}));

const { tuningInstallationToken } = await import('./tuning');

describe('tuningInstallationToken', () => {
  beforeEach(() => {
    installationId = 42;
    tokenFor.length = 0;
  });

  it('mints a token from the repo-mediated installation', async () => {
    expect(await tuningInstallationToken('example-org/example-private')).toBe('installation-token');
    expect(tokenFor).toEqual([42]);
  });

  it('returns null when the App has no installation covering the repo', async () => {
    installationId = null;
    expect(await tuningInstallationToken('example-org/example-private')).toBeNull();
    expect(tokenFor).toEqual([]);
  });
});
