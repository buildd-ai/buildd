import { describe, it, expect } from 'bun:test';
import { posix, win32 } from 'path';
import { isUnderHome } from './test-store-guard-path';

/**
 * The store guard compared `resolve(target)` with `${home}/`. On Windows
 * `resolve` returns backslashes, so no write under the real runner home ever
 * matched and the guard refused nothing: its own probe test wrote `{}` into the
 * operator's real `~/.buildd/workers/probe.json`, and only the run-level
 * tripwire noticed, unable to name a culprit.
 */
describe('isUnderHome', () => {
  describe('Windows paths', () => {
    const home = 'C:\\Users\\op\\.buildd';

    it('matches a file under the home', () => {
      expect(isUnderHome('C:\\Users\\op\\.buildd\\workers\\probe.json', home, win32)).toBe(true);
    });

    it('matches the home itself', () => {
      expect(isUnderHome('C:\\Users\\op\\.buildd', home, win32)).toBe(true);
    });

    it('ignores case, as the file system does', () => {
      expect(isUnderHome('c:\\users\\OP\\.Buildd\\workers\\w.json', home, win32)).toBe(true);
    });

    it('matches a forward-slash spelling of the same path', () => {
      expect(isUnderHome('C:/Users/op/.buildd/workers/w.json', home, win32)).toBe(true);
    });

    it('does not match a sibling that only shares the prefix', () => {
      expect(isUnderHome('C:\\Users\\op\\.buildd-other\\w.json', home, win32)).toBe(false);
    });

    it('does not match a temp home', () => {
      expect(isUnderHome('C:\\Users\\op\\AppData\\Local\\Temp\\buildd-home-1\\workers\\w.json', home, win32)).toBe(false);
    });
  });

  describe('POSIX paths', () => {
    const home = '/home/op/.buildd';

    it('matches a file under the home and the home itself', () => {
      expect(isUnderHome('/home/op/.buildd/workers/w.json', home, posix)).toBe(true);
      expect(isUnderHome('/home/op/.buildd', home, posix)).toBe(true);
    });

    it('stays case-sensitive', () => {
      expect(isUnderHome('/home/op/.Buildd/workers/w.json', home, posix)).toBe(false);
    });

    it('does not match a sibling that only shares the prefix', () => {
      expect(isUnderHome('/home/op/.buildd-other/w.json', home, posix)).toBe(false);
    });
  });
});
