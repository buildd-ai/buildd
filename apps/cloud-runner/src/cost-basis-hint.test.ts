import { describe, expect, test } from 'bun:test';
import { CLOUD_MODEL_AUTH_CONTAINER_ENV } from './lifecycle';
import { plannedModelAuth, resolveModelRoute, type ServerModelEndpoint, type ServerModelEndpointState } from './outbound';
import { OwnerSeatRun, type SeatAcquire } from './owner-seat';
import { CLOUD_MODEL_AUTH_ENV, cloudCostBasis, costBasisForModelAuth } from '../../runner/src/cost-basis';

// docs/specs/real-and-virtual-cost.md: a cloud run's reported cost basis MUST
// agree with the run report's `modelAuth`. The supervisor hands the container
// the route it plans (`plannedModelAuth`), the runner turns that into the basis
// it reports (`cloudCostBasis`), and the run report records what egress did
// (`OwnerSeatRun.modelAuth`). This pins the three together.

const SEAT = 'sk-ant-oat01-owner-seat';
const GATEWAY_ENV = { AI_GATEWAY_ACCOUNT_ID: 'acct123', AI_GATEWAY_ID: 'gw-1', AI_GATEWAY_TOKEN: 'gw-secret-token' };
const seatEnv = { ...GATEWAY_ENV, CLAUDE_CODE_OAUTH_TOKEN: SEAT };
const teamEndpoint: ServerModelEndpoint = { baseUrl: 'https://ep.example', key: 'ep-key', authHeader: 'x-api-key' };
const teamKey: ServerModelEndpoint = { baseUrl: 'https://api.anthropic.com', key: 'sk-ant-api03-team', authHeader: 'x-api-key', source: 'anthropic_api_key' };

const granted: SeatAcquire = { granted: true } as SeatAcquire;
const gate = { acquire: async () => granted, release: async () => {}, wall: async () => {} };

/** What the run report records after egress forwarded one model request. */
async function reportedModelAuth(env: Record<string, string>, server: ServerModelEndpointState) {
  const run = new OwnerSeatRun({ taskId: 't', gate, now: () => 0 } as any);
  await run.acquire();
  await run.noteRoute(resolveModelRoute(env, server ?? undefined).kind === 'owner_seat');
  return run.modelAuth();
}

describe('cloud cost basis agrees with the run report', () => {
  test('the container env var names match on both sides', () => {
    expect(CLOUD_MODEL_AUTH_CONTAINER_ENV).toBe(CLOUD_MODEL_AUTH_ENV);
  });

  const cases: Array<[string, Record<string, string>, ServerModelEndpointState, 'owner_seat' | 'metered']> = [
    ['owner seat, default route', seatEnv, null, 'owner_seat'],
    ['owner seat, team endpoint wins', seatEnv, teamEndpoint, 'metered'],
    ["owner seat, team's own Anthropic key wins", seatEnv, teamKey, 'metered'],
    ['owner seat off on a managed runner', { ...seatEnv, MANAGED_CLOUD_RUNNER: '1' }, null, 'metered'],
    ['no owner seat: the gateway', GATEWAY_ENV, null, 'metered'],
  ];

  for (const [name, env, server, expected] of cases) {
    test(name, async () => {
      const planned = plannedModelAuth(env, server);
      expect(planned).toBe(expected);
      expect(await reportedModelAuth(env, server)).toBe(planned);
      expect(cloudCostBasis({ [CLOUD_MODEL_AUTH_ENV]: planned })).toBe(costBasisForModelAuth(planned));
    });
  }

  test('an unavailable team endpoint plans no route', () => {
    expect(plannedModelAuth(seatEnv, 'unavailable')).toBeNull();
  });
});
