/**
 * E2E Integration Tests for BugSpotter SDK
 * Tests the complete flow: Init → Capture → Compress → Sanitize → Send
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BugSpotter } from '../../src/index';
import type { BugSpotterConfig } from '../../src/index';
import {
  compressData,
  decompressData,
  estimateSize,
  getCompressionRatio,
} from '../../src/core/compress';
import {
  E2E_PII_DATA,
  MOCK_BACKEND_RESPONSES,
  generateLargePayload,
} from '../fixtures/e2e-fixtures';
import { createFetchMock } from '../utils/fetch-mock-helpers';

describe('E2E Integration Tests', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalFetch: typeof global.fetch;

  /**
   * Helper to mock the settings endpoint response
   * Used by BugSpotter.init() to fetch replay settings
   */
  const mockSettingsEndpoint = () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          inline_stylesheets: true,
          inline_images: false,
          collect_fonts: false,
          record_canvas: false,
          record_cross_origin_iframes: false,
        },
      }),
    });
  };

  beforeEach(() => {
    // Clean up any existing instance
    const instance = BugSpotter.getInstance();
    if (instance) {
      instance.destroy();
    }

    // Mock fetch
    originalFetch = global.fetch;
    fetchMock = vi.fn();

    // Use shared fetch mock helper
    global.fetch = createFetchMock({ apiMock: fetchMock }) as any;
  });

  afterEach(() => {
    // Restore original fetch
    global.fetch = originalFetch;

    // Clean up instance
    const instance = BugSpotter.getInstance();
    if (instance) {
      instance.destroy();
    }
  });

  describe('Complete SDK Flow: Init → Capture → Compress → Sanitize → Send', () => {
    it('should complete full workflow successfully', async () => {
      mockSettingsEndpoint();

      // Mock successful API response
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => {
          return MOCK_BACKEND_RESPONSES.created.body;
        },
      });

      // 1. INIT - Initialize SDK with full configuration
      const config: BugSpotterConfig = {
        apiKey: 'test-api-key',
        endpoint: 'https://api.example.com',
        showWidget: false,
        replay: { enabled: true, duration: 15 },
        sanitize: { enabled: true, patterns: 'all' },
      };

      const bugspotter = await BugSpotter.init(config);
      expect(bugspotter).toBeDefined();

      // Add some test data with PII
      console.log('Test log with email:', E2E_PII_DATA.emails[0]);
      console.error('Error with card:', E2E_PII_DATA.creditCards[0]);
      console.warn('Warning from IP:', E2E_PII_DATA.ipAddresses[0]);

      // Wait for console logs to be captured
      await new Promise((resolve) => {
        return setTimeout(resolve, 100);
      });

      // 2. CAPTURE - Capture bug report
      const report = await bugspotter.capture();

      // Verify capture
      expect(report).toBeDefined();
      expect(report._screenshotPreview).toBeTruthy();
      expect(report.console.length).toBeGreaterThan(0);
      expect(report.metadata).toBeDefined();
      expect(report.replay).toBeDefined();

      // 3. SANITIZE - Verify PII is redacted
      const consoleMessages = report.console.map((log) => {
        return log.message;
      });
      const hasRedaction = consoleMessages.some((msg) => {
        return msg.includes('[REDACTED');
      });
      expect(hasRedaction).toBe(true);

      // Ensure actual PII is not present
      const combinedMessages = consoleMessages.join(' ');
      expect(combinedMessages).not.toContain(E2E_PII_DATA.emails[0]);
      expect(combinedMessages).not.toContain(E2E_PII_DATA.creditCards[0]);
      expect(combinedMessages).not.toContain(E2E_PII_DATA.ipAddresses[0]);

      // 4. COMPRESS - Test compression
      const payload = {
        title: 'E2E Test Bug',
        description: 'Testing full SDK workflow',
        report,
      };

      const originalSize = estimateSize(payload);
      const compressed = await compressData(payload);
      const compressedSize = compressed.byteLength;
      const ratio = getCompressionRatio(originalSize, compressedSize);

      expect(compressedSize).toBeLessThan(originalSize);
      expect(ratio).toBeGreaterThan(0);

      // 5. SEND - Submit to backend
      report.replay = []; // Clear replay to avoid presigned URL upload
      await bugspotter.submit(payload);

      // Verify fetch was called (settings + create)
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const call = fetchMock.mock.calls[1]; // Bug report creation is call 1, settings is call 0
      expect(call[0]).toBe(config.endpoint);

      // Verify auth header
      const headers = call[1].headers;
      expect(headers['X-API-Key']).toBe('test-api-key');
    });

    it('should handle large payloads with compression', async () => {
      mockSettingsEndpoint();

      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => {
          return MOCK_BACKEND_RESPONSES.success.body;
        },
      });

      const bugspotter = await BugSpotter.init({
        apiKey: 'test-api-key-12345',
        endpoint: 'https://api.example.com',
        showWidget: false,
      });

      // Generate large payload (500KB+)
      const largeData = generateLargePayload(500);
      console.log('Large data generated:', largeData.slice(0, 100));

      await new Promise((resolve) => {
        return setTimeout(resolve, 100);
      });

      const report = await bugspotter.capture();
      const payload = {
        title: 'Large Bug Report',
        description: largeData,
        report,
      };

      const originalSize = estimateSize(payload);
      const compressed = await compressData(payload);
      const compressedSize = compressed.byteLength;
      const ratio = getCompressionRatio(originalSize, compressedSize);

      // Verify compression ratio is significant (>70%)
      expect(ratio).toBeGreaterThan(70);
      expect(originalSize).toBeGreaterThan(500 * 1024); // >500KB
      expect(compressedSize).toBeLessThan(originalSize * 0.3); // <30% of original

      report.replay = []; // Clear replay to avoid presigned URL upload
      await bugspotter.submit(payload);
      expect(fetchMock).toHaveBeenCalledTimes(2); // Settings + creation call
    });
  });

  describe('Backend Response Handling', () => {
    it('should handle 200 OK response', async () => {
      mockSettingsEndpoint();

      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => {
          return MOCK_BACKEND_RESPONSES.success.body;
        },
      });

      const bugspotter = await BugSpotter.init({
        apiKey: 'test-api-key-12345',
        endpoint: 'https://api.example.com',
        showWidget: false,
      });

      const report = await bugspotter.capture();
      report.replay = []; // Clear replay to avoid presigned URL upload
      report._screenshotPreview = undefined; // Clear screenshot too
      const payload = { title: 'Test', description: 'Test', report };

      await expect(bugspotter.submit(payload)).resolves.not.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(2); // Settings + creation call
    });

    it('should handle 201 Created response', async () => {
      mockSettingsEndpoint();

      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => {
          return MOCK_BACKEND_RESPONSES.created.body;
        },
      });

      const bugspotter = await BugSpotter.init({
        apiKey: 'test-api-key-12345',
        endpoint: 'https://api.example.com',
        showWidget: false,
      });

      const report = await bugspotter.capture();
      report.replay = []; // Clear replay to avoid presigned URL upload
      report._screenshotPreview = undefined; // Clear screenshot too
      const payload = { title: 'Test', description: 'Test', report };

      await expect(bugspotter.submit(payload)).resolves.not.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(2); // Settings + creation call
    });

    it('should handle 401 Unauthorized response', async () => {
      mockSettingsEndpoint();

      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: async () => {
          return JSON.stringify(MOCK_BACKEND_RESPONSES.unauthorized.body);
        },
      });

      const bugspotter = await BugSpotter.init({
        apiKey: 'invalid-key',
        endpoint: 'https://api.example.com',
        showWidget: false,
        retry: { maxRetries: 0 }, // Disable retries
      });

      const report = await bugspotter.capture();
      report.replay = []; // Clear replay to avoid presigned URL upload
      const payload = { title: 'Test', description: 'Test', report };

      await expect(bugspotter.submit(payload)).rejects.toThrow(/401/);
    });

    it('should handle 400 Bad Request response', async () => {
      mockSettingsEndpoint();

      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () => {
          return JSON.stringify(MOCK_BACKEND_RESPONSES.badRequest.body);
        },
      });

      const bugspotter = await BugSpotter.init({
        apiKey: 'test-api-key-12345',
        endpoint: 'https://api.example.com',
        showWidget: false,
      });

      const report = await bugspotter.capture();
      const payload = { title: '', description: '', report }; // Invalid payload

      await expect(bugspotter.submit(payload)).rejects.toThrow(/400/);
    });

    it('should handle 500 Internal Server Error response', async () => {
      mockSettingsEndpoint();

      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: async () => {
          return JSON.stringify(MOCK_BACKEND_RESPONSES.serverError.body);
        },
      });

      const bugspotter = await BugSpotter.init({
        apiKey: 'test-api-key-12345',
        endpoint: 'https://api.example.com',
        showWidget: false,
        retry: { maxRetries: 0 }, // Disable retries
      });

      const report = await bugspotter.capture();
      const payload = { title: 'Test', description: 'Test', report };

      await expect(bugspotter.submit(payload)).rejects.toThrow(/500/);
    });

    it('should handle 503 Service Unavailable with retry', async () => {
      // First attempt fails with 503
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        text: async () => {
          return JSON.stringify(MOCK_BACKEND_RESPONSES.serviceUnavailable.body);
        },
      });

      // Second attempt succeeds
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => {
          return MOCK_BACKEND_RESPONSES.success.body;
        },
      });

      const bugspotter = await BugSpotter.init({
        apiKey: 'test-api-key-12345',
        endpoint: 'https://api.example.com',
        showWidget: false,
        retry: {
          maxRetries: 3,
          baseDelay: 100,
          retryOn: [503],
        },
      });

      const report = await bugspotter.capture();
      report.replay = []; // Clear replay to avoid presigned URL upload
      report._screenshotPreview = undefined; // Clear screenshot too
      const payload = { title: 'Test', description: 'Test', report };

      await expect(bugspotter.submit(payload)).resolves.not.toThrow();

      // Should have retried and succeeded
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('should handle network errors with retry', async () => {
      // First two attempts fail with network error
      fetchMock
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => {
            return MOCK_BACKEND_RESPONSES.success.body;
          },
        });

      const bugspotter = await BugSpotter.init({
        apiKey: 'test-api-key-12345',
        endpoint: 'https://api.example.com',
        showWidget: false,
        retry: {
          maxRetries: 3,
          baseDelay: 50,
        },
      });

      const report = await bugspotter.capture();
      report.replay = []; // Clear replay to avoid presigned URL upload
      report._screenshotPreview = undefined; // Clear screenshot too
      const payload = { title: 'Test', description: 'Test', report };

      await expect(bugspotter.submit(payload)).resolves.not.toThrow();

      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });

  describe('PII Sanitization Verification', () => {
    it('should properly redact emails in console logs', async () => {
      const bugspotter = await BugSpotter.init({
        apiKey: 'test-api-key-12345',
        showWidget: false,
        sanitize: { enabled: true, patterns: ['email'] },
      });

      E2E_PII_DATA.emails.forEach((email) => {
        console.log(`User email: ${email}`);
      });

      await new Promise((resolve) => {
        return setTimeout(resolve, 100);
      });

      const report = await bugspotter.capture();
      const messages = report.console
        .map((log) => {
          return log.message;
        })
        .join(' ');

      // Should contain redaction marker
      expect(messages).toContain('[REDACTED');

      // Should not contain actual emails
      E2E_PII_DATA.emails.forEach((email) => {
        expect(messages).not.toContain(email);
      });
    });

    it('should properly redact credit cards', async () => {
      const bugspotter = await BugSpotter.init({
        apiKey: 'test-api-key-12345',
        showWidget: false,
        sanitize: { enabled: true, patterns: ['creditcard'] },
      });

      E2E_PII_DATA.creditCards.forEach((card) => {
        console.log(`Payment with card: ${card}`);
      });

      await new Promise((resolve) => {
        return setTimeout(resolve, 100);
      });

      const report = await bugspotter.capture();
      const messages = report.console
        .map((log) => {
          return log.message;
        })
        .join(' ');

      E2E_PII_DATA.creditCards.forEach((card) => {
        expect(messages).not.toContain(card);
      });
    });

    it('should properly redact SSNs and IINs', async () => {
      const bugspotter = await BugSpotter.init({
        apiKey: 'test-api-key-12345',
        showWidget: false,
        sanitize: { enabled: true, patterns: ['ssn', 'iin'] },
      });

      [...E2E_PII_DATA.ssns, ...E2E_PII_DATA.iins].forEach((id) => {
        console.log(`ID: ${id}`);
      });

      await new Promise((resolve) => {
        return setTimeout(resolve, 100);
      });

      const report = await bugspotter.capture();
      const messages = report.console
        .map((log) => {
          return log.message;
        })
        .join(' ');

      [...E2E_PII_DATA.ssns, ...E2E_PII_DATA.iins].forEach((id) => {
        expect(messages).not.toContain(id);
      });
    });

    it('should properly redact IP addresses', async () => {
      const bugspotter = await BugSpotter.init({
        apiKey: 'test-api-key-12345',
        showWidget: false,
        sanitize: { enabled: true, patterns: ['ip'] },
      });

      E2E_PII_DATA.ipAddresses.forEach((ip) => {
        console.log(`Request from IP: ${ip}`);
      });

      await new Promise((resolve) => {
        return setTimeout(resolve, 100);
      });

      const report = await bugspotter.capture();
      const messages = report.console
        .map((log) => {
          return log.message;
        })
        .join(' ');

      E2E_PII_DATA.ipAddresses.forEach((ip) => {
        expect(messages).not.toContain(ip);
      });
    });

    it('should handle multiple PII types simultaneously', async () => {
      const bugspotter = await BugSpotter.init({
        apiKey: 'test-api-key-12345',
        showWidget: false,
        sanitize: { enabled: true, patterns: 'all' },
      });

      console.log(
        `User ${E2E_PII_DATA.emails[0]} with phone ${E2E_PII_DATA.phones[0]} paid with card ${E2E_PII_DATA.creditCards[0]} from IP ${E2E_PII_DATA.ipAddresses[0]}`
      );

      await new Promise((resolve) => {
        return setTimeout(resolve, 100);
      });

      const report = await bugspotter.capture();
      const messages = report.console
        .map((log) => {
          return log.message;
        })
        .join(' ');

      // Should not contain any PII
      expect(messages).not.toContain(E2E_PII_DATA.emails[0]);
      expect(messages).not.toContain(E2E_PII_DATA.phones[0]);
      expect(messages).not.toContain(E2E_PII_DATA.creditCards[0]);
      expect(messages).not.toContain(E2E_PII_DATA.ipAddresses[0]);

      // Should contain redactions
      expect(messages).toContain('[REDACTED');
    });

    it('should allow disabling sanitization', async () => {
      const bugspotter = await BugSpotter.init({
        apiKey: 'test-api-key-12345',
        showWidget: false,
        sanitize: { enabled: false },
      });

      const testEmail = E2E_PII_DATA.emails[0];
      console.log(`Email: ${testEmail}`);

      await new Promise((resolve) => {
        return setTimeout(resolve, 100);
      });

      const report = await bugspotter.capture();
      const messages = report.console
        .map((log) => {
          return log.message;
        })
        .join(' ');

      // Should contain actual PII when sanitization is disabled
      expect(messages).toContain(testEmail);
    });
  });

  describe('Compression Verification', () => {
    it('should compress payloads and reduce size by >70%', async () => {
      const largeData = generateLargePayload(500);

      const originalSize = estimateSize(largeData);
      const compressed = await compressData(largeData);
      const compressedSize = compressed.byteLength;
      const ratio = getCompressionRatio(originalSize, compressedSize);

      expect(ratio).toBeGreaterThan(70);
      console.log(`Compression ratio: ${ratio}% (${originalSize} → ${compressedSize} bytes)`);
    });

    it('should decompress data correctly', async () => {
      const originalData = { test: 'data', values: [1, 2, 3] };

      const compressed = await compressData(originalData);
      const decompressed = decompressData(compressed);

      expect(decompressed).toEqual(originalData);
    });

    it('should handle compression of complex nested objects', async () => {
      const complexData = {
        users: Array(100)
          .fill(null)
          .map((_, i) => {
            return {
              id: i,
              email: `user${i}@example.com`,
              data: { nested: { deep: { values: Array(10).fill('test') } } },
            };
          }),
      };

      const originalSize = estimateSize(complexData);
      const compressed = await compressData(complexData);
      const ratio = getCompressionRatio(originalSize, compressed.byteLength);

      expect(ratio).toBeGreaterThan(50);

      const decompressed = decompressData(compressed);
      expect(decompressed).toEqual(complexData);
    });
  });

  describe('Retry and Offline Queue', () => {
    it('should retry failed requests with exponential backoff', async () => {
      mockSettingsEndpoint();

      // Fail 2 times, then succeed
      fetchMock
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          statusText: 'Service Unavailable',
          text: async () => {
            return 'Service Unavailable';
          },
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          statusText: 'Service Unavailable',
          text: async () => {
            return 'Service Unavailable';
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => {
            return MOCK_BACKEND_RESPONSES.success.body;
          },
        });

      const bugspotter = await BugSpotter.init({
        apiKey: 'test-api-key-12345',
        endpoint: 'https://api.example.com',
        showWidget: false,
        retry: {
          maxRetries: 3,
          baseDelay: 100,
          maxDelay: 5000,
          retryOn: [503],
        },
      });

      const report = await bugspotter.capture();
      report.replay = []; // Clear replay to avoid presigned URL upload
      const payload = { title: 'Test', description: 'Test', report };

      // Capture time just before the request
      const startTime = Date.now();
      await bugspotter.submit(payload);
      const elapsed = Date.now() - startTime;

      // Should have made 4 requests (1 settings + 2 failures + 1 success)
      expect(fetchMock).toHaveBeenCalledTimes(4);

      // Should have taken at least baseDelay time for retries (exponential backoff)
      // With 2 retries at 100ms base delay, should take at least 100ms total
      expect(elapsed).toBeGreaterThanOrEqual(100);
    });

    it('should fail after max retries exhausted', async () => {
      mockSettingsEndpoint();

      // All attempts fail
      fetchMock.mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        text: async () => {
          return 'Service Unavailable';
        },
      });

      const bugspotter = await BugSpotter.init({
        apiKey: 'test-api-key-12345',
        endpoint: 'https://api.example.com',
        showWidget: false,
        retry: {
          maxRetries: 2,
          baseDelay: 50,
          retryOn: [503],
        },
      });

      const report = await bugspotter.capture();
      const payload = { title: 'Test', description: 'Test', report };

      await expect(bugspotter.submit(payload)).rejects.toThrow();

      // Should have attempted 4 times total (1 settings + initial + 2 retries)
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });
  });
});
