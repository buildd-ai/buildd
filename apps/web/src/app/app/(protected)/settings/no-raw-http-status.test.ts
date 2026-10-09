/**
 * Settings never shows a bare status code ("HTTP 500") as its error: a failed
 * request with no message from the server reads as a sentence instead.
 */
import { describe, expect, it } from 'bun:test';
import { Glob } from 'bun';

describe('settings error copy', () => {
  it('has no `HTTP ${status}` fallback in any settings component', async () => {
    const offenders: string[] = [];
    for await (const file of new Glob('**/*.tsx').scan({ cwd: import.meta.dir })) {
      if (file.includes('.test.')) continue;
      const src = await Bun.file(`${import.meta.dir}/${file}`).text();
      if (/HTTP \$\{[^}]*status[^}]*\}/.test(src)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
