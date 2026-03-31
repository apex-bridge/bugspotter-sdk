/**
 * E2E Configuration Tests for BugSpotter SDK
 * Tests various SDK configuration combinations and authentication types
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BugSpotter } from '../../src/index';
import {
  CONFIG_PRESETS,
  MOCK_BACKEND_RESPONSES,
} from '../fixtures/e2e-fixtures';
import { createFetchMock } from '../utils/fetch-mock-helpers';

describe('E2E Configuration Tests', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    const instance = BugSpotter.getInstance();
    if (instance) {
      instance.destroy();
    }

    originalFetch = global.fetch;
    fetchMock = vi.fn();

    // Use shared fetch mock helper
    global.fetch = createFetchMock({ apiMock: fetchMock }) as any;
  });

  afterEach(() => {
    global.fetch = originalFetch;

    const instance = BugSpotter.getInstance();
    if (instance) {
      instance.destroy();
    }
  });

  describe('Endpoint Configuration', () => {
    it('should work with default cloud endpoint', async () => {
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
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => {
          return MOCK_BACKEND_RESPONSES.success.body;
        },
      });

      const bugspotter = await BugSpotter.init({
        apiKey: 'test-api-key-12345',
        endpoint: 'https://api.bugspotter.io',
        showWidget: false,
      });

      const report = await bugspotter.capture();
      report.replay = []; // Clear replay to avoid presigned URL upload
      const payload = { title: 'Test', description: 'Test', report };

      await bugspotter.submit(payload);

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.bugspotter.io/api/v1/reports',
        expect.any(Object)
      );
    });

    it('should work with self-hosted endpoint', async () => {
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
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => {
          return MOCK_BACKEND_RESPONSES.success.body;
        },
      });

      const bugspotter = await BugSpotter.init({
        ...CONFIG_PRESETS.selfHosted,
      });

      const report = await bugspotter.capture();
      report.replay = []; // Clear replay to avoid presigned URL upload
      const payload = { title: 'Test', description: 'Test', report };

      await bugspotter.submit(payload);

      expect(fetchMock).toHaveBeenCalledWith(
        'https://localhost:4000/api/v1/reports',
        expect.any(Object)
      );
    });

    it('should work with custom domain', async () => {
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
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => {
          return MOCK_BACKEND_RESPONSES.success.body;
        },
      });

      const bugspotter = await BugSpotter.init({
        apiKey: 'test-api-key-12345',
        endpoint: 'https://custom-domain.com/api/v1/reports',
        showWidget: false,
      });

      const report = await bugspotter.capture();
      report.replay = []; // Clear replay to avoid presigned URL upload
      const payload = { title: 'Test', description: 'Test', report };

      await bugspotter.submit(payload);

      expect(fetchMock).toHaveBeenCalledWith(
        'https://custom-domain.com/api/v1/reports',
        expect.any(Object)
      );
    });
  });

  describe('Authentication Types', () => {
    it('should work with API key authentication', async () => {
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
      const payload = { title: 'Test', description: 'Test', report };

      await bugspotter.submit(payload);

      const headers = fetchMock.mock.calls[1][1].headers;
      expect(headers['X-API-Key']).toBe('test-api-key-12345');
    });

    // JWT, Bearer, and Custom auth removed - SDK now only supports API key authentication

    it('should work without custom domain (using default)', async () => {
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
      const payload = { title: 'Test', description: 'Test', report };

      await bugspotter.submit(payload);

      const headers = fetchMock.mock.calls[1][1].headers;
      // Auth is now required - API key should be present
      expect(headers['X-API-Key']).toBe('test-api-key-12345');
    });

    // Token refresh test removed - API keys don't expire
  });

  describe('PII Sanitization Configuration', () => {
    it('should work with PII detection enabled', async () => {
      const bugspotter = await BugSpotter.init({
        apiKey: 'test-api-key-12345',
        showWidget: false,
        sanitize: { enabled: true, patterns: 'all' },
      });

      console.log('Email: test@example.com');
      console.log('Phone: +1-555-123-4567');

      await new Promise((resolve) => {
        return setTimeout(resolve, 100);
      });

      const report = await bugspotter.capture();
      const messages = report.console
        .map((log) => {
          return log.message;
        })
        .join(' ');

      expect(messages).not.toContain('test@example.com');
      expect(messages).not.toContain('+1-555-123-4567');
      expect(messages).toContain('[REDACTED');
    });

    it('should work with PII detection disabled', async () => {
      const bugspotter = await BugSpotter.init({
        apiKey: 'test-api-key-12345',
        showWidget: false,
        sanitize: { enabled: false },
      });

      console.log('Email: test@example.com');
      console.log('Phone: +1-555-123-4567');

      await new Promise((resolve) => {
        return setTimeout(resolve, 100);
      });

      const report = await bugspotter.capture();
      const messages = report.console
        .map((log) => {
          return log.message;
        })
        .join(' ');

      expect(messages).toContain('test@example.com');
      expect(messages).toContain('+1-555-123-4567');
    });

    it('should work with selective PII patterns', async () => {
      const bugspotter = await BugSpotter.init({
        apiKey: 'test-api-key-12345',
        showWidget: false,
        sanitize: { enabled: true, patterns: ['email'] },
      });

      console.log('Email: test@example.com');
      console.log('Phone: +1-555-123-4567');

      await new Promise((resolve) => {
        return setTimeout(resolve, 100);
      });

      const report = await bugspotter.capture();
      const messages = report.console
        .map((log) => {
          return log.message;
        })
        .join(' ');

      // Email should be redacted
      expect(messages).not.toContain('test@example.com');

      // Phone should NOT be redacted (not in patterns)
      expect(messages).toContain('+1-555-123-4567');
    });

    it('should work with minimal PII preset', async () => {
      const bugspotter = await BugSpotter.init({
        apiKey: 'test-api-key-12345',
        showWidget: false,
        sanitize: { enabled: true, patterns: 'minimal' },
      });

      console.log('Email: test@example.com');
      console.log('Credit Card: 4532-1234-5678-9010');

      await new Promise((resolve) => {
        return setTimeout(resolve, 100);
      });

      const report = await bugspotter.capture();
      const messages = report.console
        .map((log) => {
          return log.message;
        })
        .join(' ');

      // Both should be redacted with minimal preset
      expect(messages).not.toContain('test@example.com');
      expect(messages).not.toContain('4532-1234-5678-9010');
    });
  });

  describe('Compression Configuration', () => {
    it('should compress when enabled (default)', async () => {
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

      // Generate large data
      const largeDescription = 'Large data: ' + 'x'.repeat(10000);
      console.log(largeDescription);

      await new Promise((resolve) => {
        return setTimeout(resolve, 100);
      });

      const report = await bugspotter.capture();
      report.replay = []; // Clear replay to avoid presigned URL upload
      const payload = { title: 'Test', description: largeDescription, report };

      await bugspotter.submit(payload);

      const call = fetchMock.mock.calls[0];
      const headers = call[1].headers;

      // Check if compression was used
      if (headers['Content-Encoding'] === 'gzip') {
        expect(headers['Content-Type']).toBe('application/gzip');
        expect(call[1].body).toBeInstanceOf(Blob);
      }
    });
  });

  describe('Replay Configuration', () => {
    it('should capture replay when enabled', async () => {
      const bugspotter = await BugSpotter.init({
        apiKey: 'test-api-key-12345',
        showWidget: false,
        replay: { enabled: true, duration: 15 },
      });

      // Simulate some DOM interaction
      document.body.innerHTML = '<div>Test content</div>';

      await new Promise((resolve) => {
        return setTimeout(resolve, 100);
      });

      const report = await bugspotter.capture();

      expect(report.replay).toBeDefined();
      expect(Array.isArray(report.replay)).toBe(true);
      expect(report.replay?.length).toBeGreaterThan(0);
    });

    it('should not capture replay when disabled', async () => {
      const bugspotter = await BugSpotter.init({
        apiKey: 'test-api-key-12345',
        showWidget: false,
        replay: { enabled: false },
      });

      document.body.innerHTML = '<div>Test content</div>';

      await new Promise((resolve) => {
        return setTimeout(resolve, 100);
      });

      const report = await bugspotter.capture();

      expect(report.replay).toBeDefined();
      expect(Array.isArray(report.replay)).toBe(true);
      expect(report.replay?.length).toBe(0);
    });

    it('should respect custom replay duration', async () => {
      const bugspotter = await BugSpotter.init({
        apiKey: 'test-api-key-12345',
        showWidget: false,
        replay: { enabled: true, duration: 30 },
      });

      const config = bugspotter.getConfig();
      expect(config.replay?.duration).toBe(30);
    });

    it('should respect replay sampling configuration', async () => {
      const bugspotter = await BugSpotter.init({
        apiKey: 'test-api-key-12345',
        showWidget: false,
        replay: {
          enabled: true,
          duration: 15,
          sampling: { mousemove: 100, scroll: 200 },
        },
      });

      const config = bugspotter.getConfig();
      expect(config.replay?.sampling?.mousemove).toBe(100);
      expect(config.replay?.sampling?.scroll).toBe(200);
    });
  });

  describe('Widget Configuration', () => {
    it('should create widget when showWidget is true', async () => {
      const bugspotter = await BugSpotter.init({
        apiKey: 'test-api-key-12345',
        showWidget: true,
      });

      const button = document.querySelector('button[style*="position: fixed"]');
      expect(button).toBeTruthy();

      bugspotter.destroy();
    });

    it('should not create widget when showWidget is false', async () => {
      const bugspotter = await BugSpotter.init({
        apiKey: 'test-api-key-12345',
        showWidget: false,
      });

      const button = document.querySelector('button[style*="position: fixed"]');
      expect(button).toBeNull();

      bugspotter.destroy();
    });

    it('should apply custom widget options', async () => {
      const bugspotter = await BugSpotter.init({
        apiKey: 'test-api-key-12345',
        showWidget: true,
        widgetOptions: {
          position: 'top-left',
          icon: '🐛',
          backgroundColor: '#ff5722',
          size: 70,
        },
      });

      const button = document.querySelector(
        'button[style*="position: fixed"]'
      ) as HTMLButtonElement;
      expect(button).toBeTruthy();
      expect(button.textContent).toContain('🐛');

      bugspotter.destroy();
    });
  });

  describe('Configuration Combinations', () => {
    it('should work with minimal configuration', async () => {
      const bugspotter = await BugSpotter.init(CONFIG_PRESETS.minimal);

      const report = await bugspotter.capture();

      expect(report).toBeDefined();
      expect(report._screenshotPreview).toBeTruthy();
      expect(report.console).toBeDefined();
      expect(report.metadata).toBeDefined();
    });

    it('should work with full configuration', async () => {
      // Optimized flow: Create (with presigned URL) + Confirm upload
      fetchMock
        .mockResolvedValueOnce({
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
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: {
              id: 'bug-123',
              presignedUrls: {
                replay: {
                  uploadUrl: 'https://s3.example.com/replay.gz',
                  storageKey: 'replays/bug-123/replay.gz',
                },
              },
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ success: true }), // Replay confirmation
        });

      const bugspotter = await BugSpotter.init(CONFIG_PRESETS.full);

      console.log('Test with PII: test@example.com');

      await new Promise((resolve) => {
        return setTimeout(resolve, 100);
      });

      const report = await bugspotter.capture();
      const payload = { title: 'Test', description: 'Test', report };

      await bugspotter.submit(payload);

      expect(fetchMock).toHaveBeenCalled();
      expect(report.replay?.length).toBeGreaterThan(0);

      const messages = report.console
        .map((log) => {
          return log.message;
        })
        .join(' ');
      expect(messages).not.toContain('test@example.com');
    });

    it('should work with API key authentication (auth is now required)', async () => {
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
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => {
          return MOCK_BACKEND_RESPONSES.success.body;
        },
      });

      const bugspotter = await BugSpotter.init(CONFIG_PRESETS.default);

      const report = await bugspotter.capture();
      report.replay = []; // Clear replay to avoid presigned URL upload
      const payload = { title: 'Test', description: 'Test', report };

      await bugspotter.submit(payload);

      const headers = fetchMock.mock.calls[1][1].headers;
      expect(headers['X-API-Key']).toBe('test-api-key-12345');
    });
  });
});
