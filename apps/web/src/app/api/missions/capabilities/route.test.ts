import { describe, expect, it } from 'bun:test';
import { GET } from './route';

describe('GET /api/missions/capabilities', () => {
  it('advertises the safety-critical controls supported by the missions API', async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      version: 1,
      capabilities: ['startMode', 'pacing'],
    });
  });
});
