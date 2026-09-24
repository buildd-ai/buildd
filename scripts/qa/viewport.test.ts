import { describe, expect, test } from 'bun:test';
import { resolveViewport } from './viewport';

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

  test('rejects malformed values instead of silently shooting desktop', () => {
    expect(() => resolveViewport('390')).toThrow(/QA_VIEWPORT/);
    expect(() => resolveViewport('0x844')).toThrow(/QA_VIEWPORT/);
    expect(() => resolveViewport('phone')).toThrow(/QA_VIEWPORT/);
  });
});
