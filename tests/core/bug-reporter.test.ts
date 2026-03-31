/**
 * Tests for BugReporter module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BugReporter } from '../../src/core/bug-reporter';
import type { BugSpotterConfig, BugReportPayload } from '../../src/index';

// Access to private type guard for testing
// We'll test it indirectly through the public API

describe('BugReporter', () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    mockFetch = vi.fn();
    global.fetch = mockFetch as any;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.clearAllMocks();
  });

  const createConfig = (overrides?: Partial<BugSpotterConfig>): BugSpotterConfig => ({
    endpoint: 'https://api.example.com',
    apiKey: 'test-key',
    deduplication: {
      enabled: false, // Disable for most tests
    },
    ...overrides,
  });

  const createPayload = (): BugReportPayload => ({
    title: 'Test Bug',
    description: 'Test Description',
    report: {
      console: [],
      network: [],
      metadata: {
        url: 'https://example.com',
        userAgent: 'Test Agent',
        timestamp: Date.now(),
        viewport: { width: 1920, height: 1080 },
        browser: 'Chrome',
        os: 'Windows',
      },
      replay: [],
    },
  });

  describe('Type Guard - Valid Response Validation', () => {
    it('should accept valid response with success=true and data.id', async () => {
      const config = createConfig();
      const bugReporter = new BugReporter(config);
      const payload = createPayload();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: {
            id: 'bug-123',
          },
        }),
      });

      await expect(bugReporter.submit(payload)).resolves.not.toThrow();
      bugReporter.destroy();
    });

    it('should accept valid response with presignedUrls', async () => {
      const config = createConfig();
      const bugReporter = new BugReporter(config);
      const payload = createPayload();
      // Don't actually include screenshot to avoid upload complexity in unit test
      // Just verify the type guard accepts valid presignedUrls structure

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: {
            id: 'bug-123',
            presignedUrls: {
              screenshot: 'https://s3.example.com/screenshot',
              replay: 'https://s3.example.com/replay',
            },
          },
        }),
      });

      await expect(bugReporter.submit(payload)).resolves.not.toThrow();
      bugReporter.destroy();
    });

    it('should accept response with success=false (no data required)', async () => {
      const config = createConfig();
      const bugReporter = new BugReporter(config);
      const payload = createPayload();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: false,
        }),
      });

      await expect(bugReporter.submit(payload)).rejects.toThrow(
        'Bug report creation failed on server'
      );
      bugReporter.destroy();
    });
  });

  describe('Type Guard - Invalid Response Rejection', () => {
    it('should reject response without success property', async () => {
      const config = createConfig();
      const bugReporter = new BugReporter(config);
      const payload = createPayload();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: { id: 'bug-123' },
        }),
      });

      await expect(bugReporter.submit(payload)).rejects.toThrow('Invalid server response format');
      bugReporter.destroy();
    });

    it('should reject response with non-boolean success', async () => {
      const config = createConfig();
      const bugReporter = new BugReporter(config);
      const payload = createPayload();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: 'true',
          data: { id: 'bug-123' },
        }),
      });

      await expect(bugReporter.submit(payload)).rejects.toThrow('Invalid server response format');
      bugReporter.destroy();
    });

    it('should reject response with success=true but missing data', async () => {
      const config = createConfig();
      const bugReporter = new BugReporter(config);
      const payload = createPayload();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
        }),
      });

      await expect(bugReporter.submit(payload)).rejects.toThrow('Invalid server response format');
      bugReporter.destroy();
    });

    it('should reject response with success=true but data is not an object', async () => {
      const config = createConfig();
      const bugReporter = new BugReporter(config);
      const payload = createPayload();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: 'invalid',
        }),
      });

      await expect(bugReporter.submit(payload)).rejects.toThrow('Invalid server response format');
      bugReporter.destroy();
    });

    it('should reject response with success=true but missing data.id', async () => {
      const config = createConfig();
      const bugReporter = new BugReporter(config);
      const payload = createPayload();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: {
            presignedUrls: {},
          },
        }),
      });

      await expect(bugReporter.submit(payload)).rejects.toThrow('Invalid server response format');
      bugReporter.destroy();
    });

    it('should reject response with success=true but data.id is not a string', async () => {
      const config = createConfig();
      const bugReporter = new BugReporter(config);
      const payload = createPayload();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: {
            id: 123,
          },
        }),
      });

      await expect(bugReporter.submit(payload)).rejects.toThrow('Invalid server response format');
      bugReporter.destroy();
    });

    it('should reject response with invalid presignedUrls (not an object)', async () => {
      const config = createConfig();
      const bugReporter = new BugReporter(config);
      const payload = createPayload();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: {
            id: 'bug-123',
            presignedUrls: 'invalid',
          },
        }),
      });

      await expect(bugReporter.submit(payload)).rejects.toThrow('Invalid server response format');
      bugReporter.destroy();
    });

    it('should reject response with null presignedUrls', async () => {
      const config = createConfig();
      const bugReporter = new BugReporter(config);
      const payload = createPayload();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: {
            id: 'bug-123',
            presignedUrls: null,
          },
        }),
      });

      await expect(bugReporter.submit(payload)).rejects.toThrow('Invalid server response format');
      bugReporter.destroy();
    });

    it('should reject non-object response', async () => {
      const config = createConfig();
      const bugReporter = new BugReporter(config);
      const payload = createPayload();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => 'invalid',
      });

      await expect(bugReporter.submit(payload)).rejects.toThrow('Invalid server response format');
      bugReporter.destroy();
    });

    it('should reject null response', async () => {
      const config = createConfig();
      const bugReporter = new BugReporter(config);
      const payload = createPayload();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => null,
      });

      await expect(bugReporter.submit(payload)).rejects.toThrow('Invalid server response format');
      bugReporter.destroy();
    });
  });

  describe('HTTP Error Handling', () => {
    it('should reject when server returns non-OK status', async () => {
      const config = createConfig();
      const bugReporter = new BugReporter(config);
      const payload = createPayload();

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: async () => 'Server error details',
      });

      await expect(bugReporter.submit(payload)).rejects.toThrow(
        'Failed to submit bug report: 500 Internal Server Error'
      );
      bugReporter.destroy();
    });

    it('should handle text() failure gracefully', async () => {
      const config = createConfig();
      const bugReporter = new BugReporter(config);
      const payload = createPayload();

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: async () => {
          throw new Error('Cannot read response');
        },
      });

      await expect(bugReporter.submit(payload)).rejects.toThrow(
        'Failed to submit bug report: 500 Internal Server Error. Unknown error'
      );
      bugReporter.destroy();
    });
  });
});
