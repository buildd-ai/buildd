/**
 * Guard: every route that writes a model credential goes through the one write
 * path. A route that called the storage functions itself would be a second
 * write path for the same (provider, shape, scope), the drift the provider
 * registry exists to end.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const API = join(import.meta.dir, '../../app/api');
const read = (rel: string) => readFileSync(join(API, rel), 'utf8');

const ADAPTERS: Record<string, { uses: string[]; never: string[] }> = {
  'providers/route.ts': { uses: ['@/lib/providers/credentials'], never: ['replaceScoped', 'setProviderKey', 'setTeamGateway', 'setTeamAgentEndpoint'] },
  'inference-keys/route.ts': { uses: ['writeChatKey', 'writeTeamChatKey', 'removeChatKey', 'sharedWritePermissions'], never: ['setProviderKey', 'deleteProviderKey', 'requeueAuthFailedTasks'] },
  'teams/[id]/litellm-gateway/route.ts': { uses: ['writeGateway', 'removeGateway'], never: ['setTeamGateway', 'deleteTeamGateway'] },
  'teams/[id]/agent-endpoint/route.ts': { uses: ['writeAgentEndpoint', 'removeAgentEndpoint'], never: ['setTeamAgentEndpoint', 'deleteTeamAgentEndpoint'] },
  'secrets/route.ts': { uses: ['writeSharedSecret', 'MODEL_PURPOSES.has(purpose)', 'sharedWritePermissions', 'sharedKeyPrefixRefusal'], never: ['requeueAuthFailedTasks', 'REQUIRED_PREFIX'] },
};

describe('model credential writes go through @/lib/providers/write-path', () => {
  for (const [file, { uses, never }] of Object.entries(ADAPTERS)) {
    it(file, () => {
      const src = read(file);
      for (const u of uses) expect(src.includes(u) ? u : `${file} does not use ${u}`).toBe(u);
      for (const n of never) expect(src.includes(n) ? `${file} calls ${n} directly` : null).toBeNull();
    });
  }
});
