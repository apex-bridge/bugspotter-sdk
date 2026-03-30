import { describe, it, expect, vi, beforeEach } from 'vitest';
import { submitWithAuth, type AuthConfig } from '../../src/core/transport';
import { validateAuthConfig } from '../../src/utils/config-validator';
import { OfflineQueue } from '../../src/core/offline-queue';
import { InsecureEndpointError } from '../../src/utils/url-helpers';

const TEST_AUTH: AuthConfig = {
  apiKey: 'test-api-key',
};

const INSECURE_ENDPOINT = 'http://api.example.com';
const LOCALHOST_ENDPOINT = 'http://localhost:3000/bugs';
const SECURE_ENDPOINT = 'https://api.example.com';

describe('HTTPS Enforcement', () => {
  describe('validateAuthConfig', () => {
    it('should throw InsecureEndpointError for http endpoint', () => {
      expect(() =>
        validateAuthConfig({
          endpoint: INSECURE_ENDPOINT,
          auth: TEST_AUTH,
        })
      ).toThrow(InsecureEndpointError);
    });

    it('should not throw for https endpoint', () => {
      expect(() =>
        validateAuthConfig({
          endpoint: SECURE_ENDPOINT,
          auth: TEST_AUTH,
        })
      ).not.toThrow();
    });

    it('should not throw for localhost http endpoint (dev exception)', () => {
      expect(() =>
        validateAuthConfig({
          endpoint: LOCALHOST_ENDPOINT,
          auth: TEST_AUTH,
        })
      ).not.toThrow();
    });
  });

  describe('submitWithAuth', () => {
    beforeEach(() => {
      global.fetch = vi.fn();
    });

    it('should throw InsecureEndpointError and not call fetch for http endpoint', async () => {
      await expect(
        submitWithAuth(
          INSECURE_ENDPOINT,
          JSON.stringify({ test: 'data' }),
          {},
          { auth: TEST_AUTH }
        )
      ).rejects.toThrow(InsecureEndpointError);

      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should call fetch for https endpoint', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
      });

      await submitWithAuth(
        SECURE_ENDPOINT,
        JSON.stringify({ test: 'data' }),
        {},
        { auth: TEST_AUTH }
      );

      expect(global.fetch).toHaveBeenCalledWith(
        SECURE_ENDPOINT,
        expect.anything()
      );
    });
  });

  describe('OfflineQueue', () => {
    let queue: OfflineQueue;
    let loggerMock: any;
    let storageMock: any;
    let storedItems: any[] = [];

    beforeEach(() => {
      storedItems = [];
      loggerMock = {
        log: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      storageMock = {
        getItem: vi.fn().mockImplementation(() => JSON.stringify(storedItems)),
        setItem: vi.fn().mockImplementation((_, val) => {
          storedItems = JSON.parse(val);
        }),
        removeItem: vi.fn(),
      };

      queue = new OfflineQueue({ enabled: true }, loggerMock, storageMock);

      global.fetch = vi.fn();
    });

    it('should not process queued item with insecure endpoint', async () => {
      storedItems = [
        {
          id: 'req_1',
          endpoint: INSECURE_ENDPOINT,
          body: '{}',
          headers: {},
          timestamp: Date.now(),
          attempts: 0,
        },
      ];

      await queue.processWithAuth([], {});

      expect(global.fetch).not.toHaveBeenCalled();
      expect(loggerMock.error).toHaveBeenCalledWith(
        expect.stringContaining(
          'Refusing to send offline request to insecure endpoint'
        )
      );
    });

    it('should process queued item with secure endpoint', async () => {
      storedItems = [
        {
          id: 'req_1',
          endpoint: SECURE_ENDPOINT,
          body: '{}',
          headers: {},
          timestamp: Date.now(),
          attempts: 0,
        },
      ];

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      await queue.processWithAuth([], {});

      expect(global.fetch).toHaveBeenCalledWith(
        SECURE_ENDPOINT,
        expect.anything()
      );
    });
  });
});
