import { expect, test } from 'bun:test';
import { bootFailure, isModuleLoadError } from './boot';

test('5xx document response is a boot failure', () => {
  expect(bootFailure(500, [])).toContain('500');
  expect(bootFailure(200, [])).toBeNull();
  expect(bootFailure(null, [])).toBeNull();
  expect(bootFailure(404, [])).toBeNull();
});

test('module-load page error is a boot failure', () => {
  const msg = 'Failed to load external module typescript-abc123: Cannot find module';
  expect(isModuleLoadError(msg)).toBe(true);
  expect(isModuleLoadError('Hydration failed')).toBe(false);
  expect(bootFailure(200, [msg])).toContain('typescript');
});
