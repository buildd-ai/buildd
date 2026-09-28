import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';

describe('instrumentation', () => {
  describe('register - OTel registration gating', () => {
    let registerOTelMock: any;
    let originalVercelEnv: string | undefined;
    let originalOtelDebug: string | undefined;

    beforeEach(() => {
      originalVercelEnv = process.env.VERCEL_ENV;
      originalOtelDebug = process.env.OTEL_DEBUG;
      delete process.env.VERCEL_ENV;
      delete process.env.OTEL_DEBUG;

      registerOTelMock = mock(() => {});
      mock.module('@vercel/otel', () => ({
        registerOTel: registerOTelMock,
      }));
    });

    afterEach(() => {
      if (originalVercelEnv !== undefined) {
        process.env.VERCEL_ENV = originalVercelEnv;
      } else {
        delete process.env.VERCEL_ENV;
      }
      if (originalOtelDebug !== undefined) {
        process.env.OTEL_DEBUG = originalOtelDebug;
      } else {
        delete process.env.OTEL_DEBUG;
      }
    });

    it('does not register when VERCEL_ENV and OTEL_DEBUG are not set', async () => {
      delete process.env.VERCEL_ENV;
      delete process.env.OTEL_DEBUG;

      const { register } = await import('./instrumentation');
      register();

      expect(registerOTelMock).not.toHaveBeenCalled();
    });

    it('registers when VERCEL_ENV is set to production', async () => {
      process.env.VERCEL_ENV = 'production';
      delete process.env.OTEL_DEBUG;

      const { register } = await import('./instrumentation');
      register();

      expect(registerOTelMock).toHaveBeenCalledWith(
        expect.objectContaining({
          serviceName: 'buildd-web',
        }),
      );
    });

    it('registers when VERCEL_ENV is set to preview', async () => {
      process.env.VERCEL_ENV = 'preview';
      delete process.env.OTEL_DEBUG;

      const { register } = await import('./instrumentation');
      register();

      expect(registerOTelMock).toHaveBeenCalledWith(
        expect.objectContaining({
          serviceName: 'buildd-web',
        }),
      );
    });

    it('registers when OTEL_DEBUG is set for local development', async () => {
      delete process.env.VERCEL_ENV;
      process.env.OTEL_DEBUG = 'true';

      const { register } = await import('./instrumentation');
      register();

      expect(registerOTelMock).toHaveBeenCalledWith(
        expect.objectContaining({
          serviceName: 'buildd-web',
        }),
      );
    });
  });
});
