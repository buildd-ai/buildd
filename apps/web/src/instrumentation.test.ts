import { describe, it, expect, mock } from 'bun:test';

describe('instrumentation', () => {
  describe('register - OTel registration gating', () => {
    it('registers OTel only when VERCEL_ENV is set', async () => {
      const registerOTelMock = mock(() => {});
      mock.module('@vercel/otel', () => ({
        registerOTel: registerOTelMock,
      }));

      // Clear the module cache to reimport with mocked dependency
      delete require.cache[require.resolve('./instrumentation')];
      const { register } = await import('./instrumentation');

      // Test 1: VERCEL_ENV not set - should not register
      delete process.env.VERCEL_ENV;
      register();
      expect(registerOTelMock).toHaveBeenCalledTimes(0);

      // Test 2: VERCEL_ENV set to 'production' - should register
      process.env.VERCEL_ENV = 'production';
      registerOTelMock.mockClear();
      register();
      expect(registerOTelMock).toHaveBeenCalledTimes(1);
      expect(registerOTelMock).toHaveBeenCalledWith(
        expect.objectContaining({
          serviceName: 'buildd-web',
          environment: 'production',
        }),
      );

      // Test 3: VERCEL_ENV set to 'preview' - should register with that env
      process.env.VERCEL_ENV = 'preview';
      registerOTelMock.mockClear();
      register();
      expect(registerOTelMock).toHaveBeenCalledTimes(1);
      expect(registerOTelMock).toHaveBeenCalledWith(
        expect.objectContaining({
          serviceName: 'buildd-web',
          environment: 'preview',
        }),
      );

      // Cleanup
      delete process.env.VERCEL_ENV;
    });
  });
});
