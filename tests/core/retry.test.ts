import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  submitWithAuth,
  clearOfflineQueue,
  type AuthConfig,
  type RetryConfig,
  type OfflineConfig,
} from '../../src/core/transport';

const TEST_AUTH: AuthConfig = {
  apiKey: 'test-api-key-12345',
};

describe('Retry and Offline Queue', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    fetchMock = vi.fn();
    global.fetch = fetchMock as any;

    // Clear offline queue before each test
    clearOfflineQueue();

    // Clear localStorage
    if (typeof localStorage !== 'undefined') {
      localStorage.clear();
    }
  });

  afterEach(() => {
    global.fetch = originalFetch;
    clearOfflineQueue();
    vi.clearAllTimers();
  });

  describe('Exponential Backoff Retry', () => {
    it('should retry on 502 status with exponential backoff', async () => {
      const retryConfig: RetryConfig = {
        maxRetries: 2,
        baseDelay: 100,
        maxDelay: 1000,
        retryOn: [502, 503, 504, 429],
      };

      // First two attempts fail with 502, third succeeds
      fetchMock
        .mockResolvedValueOnce({
          ok: false,
          status: 502,
          statusText: 'Bad Gateway',
          headers: new Headers(),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 502,
          statusText: 'Bad Gateway',
          headers: new Headers(),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => {
            return { success: true };
          },
          headers: new Headers(),
        });

      const response = await submitWithAuth(
        'https://api.example.com/api/v1/reports',
        JSON.stringify({ test: 'data' }),
        { 'Content-Type': 'application/json' },
        { auth: TEST_AUTH, retry: retryConfig }
      );

      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('should respect Retry-After header', async () => {
      const retryConfig: RetryConfig = {
        maxRetries: 1,
        baseDelay: 100,
        maxDelay: 1000,
        retryOn: [429],
      };

      // Mock response with Retry-After header
      const headers = new Headers();
      headers.set('Retry-After', '1');

      fetchMock
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
          headers,
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers(),
        });

      const start = Date.now();
      await submitWithAuth(
        'https://api.example.com/api/v1/reports',
        JSON.stringify({ test: 'data' }),
        { 'Content-Type': 'application/json' },
        { auth: TEST_AUTH, retry: retryConfig }
      );
      const elapsed = Date.now() - start;

      // Should wait approximately 1 second (Retry-After value)
      expect(elapsed).toBeGreaterThanOrEqual(900);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it(
      'should throw error after max retries exhausted',
      { timeout: 10000 },
      async () => {
        const retryConfig: RetryConfig = {
          maxRetries: 2,
          baseDelay: 1, // Very short delay for testing
          maxDelay: 10,
          retryOn: [502],
        };

        // All attempts fail
        fetchMock.mockResolvedValue({
          ok: false,
          status: 502,
          statusText: 'Bad Gateway',
          headers: new Headers(),
        });

        const response = await submitWithAuth(
          'https://api.example.com/api/v1/reports',
          JSON.stringify({ test: 'data' }),
          { 'Content-Type': 'application/json' },
          { auth: TEST_AUTH, retry: retryConfig }
        );

        // Should return the last failed response
        expect(response.status).toBe(502);
        expect(fetchMock).toHaveBeenCalledTimes(3); // Initial + 2 retries
      }
    );

    it('should not retry on non-retryable status codes', async () => {
      const retryConfig: RetryConfig = {
        maxRetries: 3,
        baseDelay: 100,
        retryOn: [502, 503, 504],
      };

      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        headers: new Headers(),
      });

      const response = await submitWithAuth(
        'https://api.example.com/api/v1/reports',
        JSON.stringify({ test: 'data' }),
        { 'Content-Type': 'application/json' },
        { auth: TEST_AUTH, retry: retryConfig }
      );

      expect(response.status).toBe(400);
      expect(fetchMock).toHaveBeenCalledTimes(1); // No retries
    });

    it('should retry on network errors', { timeout: 10000 }, async () => {
      const retryConfig: RetryConfig = {
        maxRetries: 2,
        baseDelay: 1, // Very short delay for testing
        maxDelay: 10,
        retryOn: [502, 503],
      };

      // First two attempts fail with network error
      fetchMock
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers(),
        });

      const response = await submitWithAuth(
        'https://api.example.com/api/v1/reports',
        JSON.stringify({ test: 'data' }),
        { 'Content-Type': 'application/json' },
        { auth: TEST_AUTH, retry: retryConfig }
      );

      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('should apply jitter to retry delays', async () => {
      const retryConfig: RetryConfig = {
        maxRetries: 1,
        baseDelay: 100,
        maxDelay: 1000,
        retryOn: [502],
      };

      fetchMock
        .mockResolvedValueOnce({
          ok: false,
          status: 502,
          headers: new Headers(),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers(),
        });

      const start = Date.now();
      await submitWithAuth(
        'https://api.example.com/api/v1/reports',
        JSON.stringify({ test: 'data' }),
        { 'Content-Type': 'application/json' },
        { auth: TEST_AUTH, retry: retryConfig }
      );
      const elapsed = Date.now() - start;

      // With jitter, timing can vary, so just verify retry happened
      expect(elapsed).toBeGreaterThanOrEqual(80);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('Offline Queue', () => {
    it(
      'should queue request on network failure when offline enabled',
      { timeout: 10000 },
      async () => {
        const offlineConfig: OfflineConfig = {
          enabled: true,
          maxQueueSize: 10,
        };
        const retryConfig: RetryConfig = {
          maxRetries: 1,
          baseDelay: 1,
          maxDelay: 10,
          retryOn: [502, 503, 504, 429],
        };

        fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

        await expect(
          submitWithAuth(
            'https://api.example.com/api/v1/reports',
            JSON.stringify({ test: 'data' }),
            { 'Content-Type': 'application/json' },
            { auth: TEST_AUTH, offline: offlineConfig, retry: retryConfig }
          )
        ).rejects.toThrow('Failed to fetch');

        // Verify request was queued
        const queue = JSON.parse(
          localStorage.getItem('bugspotter_offline_queue') || '[]'
        );
        expect(queue).toHaveLength(1);
      }
    );

    it(
      'should process offline queue on next request',
      { timeout: 10000 },
      async () => {
        // First, queue a failed request
        fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

        await expect(
          submitWithAuth(
            'https://api.example.com/bugs/1',
            JSON.stringify({ test: 'queued' }),
            { 'Content-Type': 'application/json' },
            {
              auth: TEST_AUTH,
              offline: { enabled: true },
              retry: { maxRetries: 0 },
            }
          )
        ).rejects.toThrow();

        // Verify queue has 1 item
        let queue = JSON.parse(
          localStorage.getItem('bugspotter_offline_queue')!
        );
        expect(queue).toHaveLength(1);

        // Now make a successful request - should process queue
        fetchMock
          .mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: new Headers(),
          }) // Process queued request
          .mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: new Headers(),
          }); // Current request

        await submitWithAuth(
          'https://api.example.com/bugs/2',
          JSON.stringify({ test: 'new' }),
          { 'Content-Type': 'application/json' },
          { auth: TEST_AUTH, offline: { enabled: true } }
        );

        // Give processOfflineQueue time to run (it's async)
        await new Promise((resolve) => {
          return setTimeout(resolve, 100);
        });

        // Queue should be empty now
        const storedAfter = localStorage.getItem('bugspotter_offline_queue');
        if (storedAfter) {
          queue = JSON.parse(storedAfter);
          expect(queue).toHaveLength(0);
        }
      }
    );

    it('should respect maxQueueSize limit', { timeout: 10000 }, async () => {
      const offlineConfig: OfflineConfig = {
        enabled: true,
        maxQueueSize: 2,
      };
      const retryConfig: RetryConfig = {
        maxRetries: 1,
        baseDelay: 1,
        maxDelay: 10,
        retryOn: [502, 503, 504, 429],
      };

      // Queue multiple failed requests
      fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

      for (let i = 0; i < 3; i++) {
        await expect(
          submitWithAuth(
            'https://api.example.com/api/v1/reports',
            JSON.stringify({ test: `data-${i}` }),
            { 'Content-Type': 'application/json' },
            { auth: TEST_AUTH, offline: offlineConfig, retry: retryConfig }
          )
        ).rejects.toThrow('Failed to fetch');
      }

      // Queue should only keep the most recent 2
      const queue = JSON.parse(
        localStorage.getItem('bugspotter_offline_queue') || '[]'
      );
      expect(queue).toHaveLength(2);
    });

    it('should not queue Blob bodies', { timeout: 10000 }, async () => {
      const offlineConfig: OfflineConfig = {
        enabled: true,
        maxQueueSize: 10,
      };
      const retryConfig: RetryConfig = {
        maxRetries: 1,
        baseDelay: 1,
        maxDelay: 10,
        retryOn: [502, 503, 504, 429],
      };

      const blob = new Blob([JSON.stringify({ test: 'data' })], {
        type: 'application/json',
      });

      fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

      await expect(
        submitWithAuth(
          'https://api.example.com/api/v1/reports',
          blob,
          { 'Content-Type': 'application/json' },
          { auth: TEST_AUTH, offline: offlineConfig, retry: retryConfig }
        )
      ).rejects.toThrow('Failed to fetch');

      // Queue should be empty (Blob cannot be serialized)
      const stored = localStorage.getItem('bugspotter_offline_queue');
      expect(stored).toBeFalsy();
    });

    it(
      'should remove expired requests from queue',
      { timeout: 10000 },
      async () => {
        // Manually add an expired request to queue
        const expiredRequest = {
          id: 'req_old',
          endpoint: 'https://api.example.com/api/v1/reports',
          body: JSON.stringify({ test: 'old' }),
          headers: { 'Content-Type': 'application/json' },
          timestamp: Date.now() - 8 * 24 * 60 * 60 * 1000, // 8 days ago
          attempts: 0,
        };

        localStorage.setItem(
          'bugspotter_offline_queue',
          JSON.stringify([expiredRequest])
        );

        // Make a new request to trigger queue processing
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers(),
        });

        await submitWithAuth(
          'https://api.example.com/api/v1/reports',
          JSON.stringify({ test: 'new' }),
          { 'Content-Type': 'application/json' },
          {
            auth: TEST_AUTH,
            offline: { enabled: true },
            retry: {
              maxRetries: 1,
              baseDelay: 1,
              maxDelay: 10,
              retryOn: [502, 503, 504, 429],
            },
          }
        );

        // Give processOfflineQueue time to run
        await new Promise((resolve) => {
          return setTimeout(resolve, 200);
        });

        // Expired request should be removed
        const queue = JSON.parse(
          localStorage.getItem('bugspotter_offline_queue') || '[]'
        );
        expect(queue).toHaveLength(0);
      }
    );

    it('should strip sensitive auth headers before storing in queue', async () => {
      const offlineConfig: OfflineConfig = {
        enabled: true,
        maxQueueSize: 10,
      };
      const retryConfig = {
        maxRetries: 1,
        baseDelay: 10,
        maxDelay: 100,
        retryOn: [502, 503, 504, 429],
      };

      // Mock network failure
      fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

      await expect(
        submitWithAuth(
          'https://api.example.com/api/v1/reports',
          JSON.stringify({ test: 'data' }),
          { 'Content-Type': 'application/json' },
          { auth: TEST_AUTH, offline: offlineConfig, retry: retryConfig }
        )
      ).rejects.toThrow('Failed to fetch');

      // Verify request was queued but without auth headers
      const queue = JSON.parse(
        localStorage.getItem('bugspotter_offline_queue') || '[]'
      );
      expect(queue).toHaveLength(1);

      const queuedRequest = queue[0];
      expect(queuedRequest.headers).toHaveProperty(
        'Content-Type',
        'application/json'
      );

      // SECURITY: Verify sensitive headers are NOT stored
      expect(queuedRequest.headers).not.toHaveProperty('X-API-Key');
      expect(queuedRequest.headers).not.toHaveProperty('authorization');
      expect(queuedRequest.headers).not.toHaveProperty('x-auth-token');
      expect(queuedRequest.headers).not.toHaveProperty('cookie');
    });

    it(
      'should regenerate auth headers when processing queued requests',
      { timeout: 10000 },
      async () => {
        // First, queue a failed request (auth will be stripped)
        fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

        await expect(
          submitWithAuth(
            'https://api.example.com/bugs/auth-test',
            JSON.stringify({ test: 'auth-regen' }),
            { 'Content-Type': 'application/json' },
            {
              auth: TEST_AUTH,
              offline: { enabled: true },
              retry: { maxRetries: 0 },
            }
          )
        ).rejects.toThrow();

        // Verify auth was stripped from queue
        let queue = JSON.parse(
          localStorage.getItem('bugspotter_offline_queue')!
        );
        expect(queue[0].headers).not.toHaveProperty('X-API-Key');

        // Clear mock and set up to capture all requests
        const capturedRequests: Array<{ url: string; headers: Headers }> = [];
        fetchMock.mockImplementation((url, options) => {
          capturedRequests.push({
            url: url as string,
            headers: new Headers(options?.headers),
          });
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
          });
        });

        // Make new request to trigger queue processing
        await submitWithAuth(
          'https://api.example.com/bugs/trigger',
          JSON.stringify({ test: 'trigger' }),
          { 'Content-Type': 'application/json' },
          { auth: TEST_AUTH, offline: { enabled: true } }
        );

        // Give processOfflineQueue time to run
        await new Promise((resolve) => {
          return setTimeout(resolve, 150);
        });

        // Verify auth header was regenerated when processing queued request
        // Find the queued request by URL
        const queuedRequest = capturedRequests.find((req) =>
          req.url.includes('/bugs/auth-test')
        );
        expect(queuedRequest).toBeDefined();
        expect(queuedRequest?.headers.get('X-API-Key')).toBe(TEST_AUTH.apiKey);

        // Queue should be empty (successfully processed)
        const storedAfter = localStorage.getItem('bugspotter_offline_queue');
        if (storedAfter) {
          queue = JSON.parse(storedAfter);
          expect(queue).toHaveLength(0);
        }
      }
    );
  });

  describe('clearOfflineQueue', () => {
    it('should clear the offline queue', () => {
      // Add some items to queue
      const queue = [
        {
          id: 'req_1',
          endpoint: 'https://api.example.com/api/v1/reports',
          body: '{}',
          headers: {},
          timestamp: Date.now(),
          attempts: 0,
        },
      ];
      localStorage.setItem('bugspotter_offline_queue', JSON.stringify(queue));

      clearOfflineQueue();

      const stored = localStorage.getItem('bugspotter_offline_queue');
      expect(stored).toBeFalsy();
    });
  });
});
