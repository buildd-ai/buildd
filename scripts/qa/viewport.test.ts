import { describe, expect, test } from 'bun:test';
import { resolveTheme, resolveViewport } from './viewport';

describe('resolveViewport', () => {
  test('defaults to the desktop viewport when unset', () => {
    expect(resolveViewport(undefined)).toEqual({ viewport: { width: 1280, height: 900 } });
    expect(resolveViewport('')).toEqual({ viewport: { width: 1280, height: 900 } });
  });

  test('"mobile" is a 390x844 touch phone', () => {
    expect(resolveViewport('mobile')).toEqual({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    });
  });

  test('WxH narrower than 768 emulates a touch phone', () => {
    expect(resolveViewport('375x667')).toEqual({
      viewport: { width: 375, height: 667 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    });
  });

  test('WxH 768 or wider is a plain desktop viewport', () => {
    expect(resolveViewport('1440x900')).toEqual({ viewport: { width: 1440, height: 900 } });
  });

  test('"desktop" is an alias for the 1280x900 default', () => {
    expect(resolveViewport('desktop')).toEqual({ viewport: { width: 1280, height: 900 } });
  });

  test('rejects malformed values instead of silently shooting desktop', () => {
    expect(() => resolveViewport('390')).toThrow(/QA_VIEWPORT/);
    expect(() => resolveViewport('0x844')).toThrow(/QA_VIEWPORT/);
    expect(() => resolveViewport('phone')).toThrow(/QA_VIEWPORT/);
  });
});

describe('resolveTheme', () => {
  test('unset keeps the app default: no emulation, no theme recorded', () => {
    expect(resolveTheme(undefined)).toBeNull();
    expect(resolveTheme('  ')).toBeNull();
  });

  test('light and dark, case-insensitive', () => {
    expect(resolveTheme('light')).toBe('light');
    expect(resolveTheme(' DARK ')).toBe('dark');
  });

  test('rejects anything else instead of shooting the default theme under the wrong label', () => {
    expect(() => resolveTheme('sepia')).toThrow(/QA_THEME/);
    expect(() => resolveTheme('both')).toThrow(/QA_THEME/);
  });
});
