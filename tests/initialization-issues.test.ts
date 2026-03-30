/**
 * Tests demonstrating initialization issues in BugSpotter
 * These tests should FAIL initially, then PASS after fixes are applied
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { BugSpotter } from '../src/index';
import type { BugSpotterConfig } from '../src/index';

describe('BugSpotter Initialization Issues', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Reset singleton
    const instance = BugSpotter.getInstance();
    if (instance) {
      instance.destroy();
    }

    // Setup fetch mock
    fetchMock = vi.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Issue 1: Multiple init() calls with different configs', () => {
    it('should warn when init() is called multiple times', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Mock settings endpoint
      fetchMock.mockResolvedValue({
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

      const config1: BugSpotterConfig = {
        endpoint: 'https://api1.example.com',
        showWidget: false,
        apiKey: 'key1',
      };

      const config2: BugSpotterConfig = {
        endpoint: 'https://api2.example.com',
        showWidget: false,
        apiKey: 'key2',
      };

      // First init
      const sdk1 = await BugSpotter.init(config1);

      // Second init with different config - should warn
      const sdk2 = await BugSpotter.init(config2);

      // ISSUE: This test will FAIL initially - no warning is logged
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('BugSpotter.init() called multiple times')
      );

      // Both should return same instance
      expect(sdk1).toBe(sdk2);
    });

    it('should return existing instance without fetching settings again', async () => {
      fetchMock.mockResolvedValue({
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

      const config: BugSpotterConfig = {
        endpoint: 'https://api.example.com',
        showWidget: false,
        apiKey: 'test-key',
      };

      // First init - fetches settings
      await BugSpotter.init(config);
      const firstCallCount = fetchMock.mock.calls.length;

      // Second init - should NOT fetch settings again
      await BugSpotter.init(config);
      const secondCallCount = fetchMock.mock.calls.length;

      // ISSUE: This test will PASS - expected behavior
      expect(secondCallCount).toBe(firstCallCount); // No additional fetch
    });

    it('should keep original config when init() called twice', async () => {
      fetchMock.mockResolvedValue({
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

      const config1: BugSpotterConfig = {
        endpoint: 'https://api1.example.com',
        showWidget: false,
        apiKey: 'key1',
      };

      const config2: BugSpotterConfig = {
        endpoint: 'https://api2.example.com',
        showWidget: false,
        apiKey: 'key2',
      };

      await BugSpotter.init(config1);
      await BugSpotter.init(config2);

      const instance = BugSpotter.getInstance();
      const instanceConfig = instance?.getConfig();

      // ISSUE: This test will PASS - original config is preserved (expected)
      expect(instanceConfig?.endpoint).toBe('https://api1.example.com');
      expect(instanceConfig?.auth.apiKey).toBe('key1');
    });
  });

  describe('Issue 2: Missing API key validation', () => {
    it('should warn when endpoint is provided but no API key', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: {},
        }),
      });

      const config: BugSpotterConfig = {
        endpoint: 'https://api.example.com',
        showWidget: false,
        auth: {
          // apiKey is missing but endpoint is provided
        } as any, // Type cast to bypass TS validation
      };

      await BugSpotter.init(config);

      // ISSUE: This test will FAIL initially - no warning about missing API key
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('no API key configured'));

      // Should not have attempted fetch without API key
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('should skip settings fetch when API key is undefined', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: {},
        }),
      });

      const config: BugSpotterConfig = {
        endpoint: 'https://api.example.com',
        showWidget: false,
        apiKey: undefined as any, // Explicitly undefined
      };

      await BugSpotter.init(config);

      // ISSUE: Currently fetch IS called with undefined apiKey
      // After fix: should NOT call fetch
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('Issue 3: Race condition with concurrent init() calls', () => {
    it('should handle concurrent init() calls safely', async () => {
      let settingsFetchCount = 0;

      fetchMock.mockImplementation(async () => {
        settingsFetchCount++;
        // Simulate network delay
        await new Promise((resolve) => setTimeout(resolve, 100));
        return {
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
        };
      });

      const config: BugSpotterConfig = {
        endpoint: 'https://api.example.com',
        showWidget: false,
        apiKey: 'test-key',
      };

      // Call init() three times concurrently
      const [sdk1, sdk2, sdk3] = await Promise.all([
        BugSpotter.init(config),
        BugSpotter.init(config),
        BugSpotter.init(config),
      ]);

      // All should return the same instance
      expect(sdk1).toBe(sdk2);
      expect(sdk2).toBe(sdk3);

      // ISSUE: This will likely FAIL - multiple fetches happen
      // After fix: Should only fetch settings once
      expect(settingsFetchCount).toBe(1);
    });
  });

  describe('Expected behaviors (should pass)', () => {
    it('should fetch settings with valid config', async () => {
      fetchMock.mockResolvedValue({
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

      const config: BugSpotterConfig = {
        endpoint: 'https://api.example.com',
        showWidget: false,
        apiKey: 'test-key',
      };

      await BugSpotter.init(config);

      expect(fetchMock).toHaveBeenCalledWith('https://api.example.com/api/v1/settings/replay', {
        headers: { 'x-api-key': 'test-key' },
      });
    });

    it('should skip settings fetch when replay is disabled', async () => {
      const config: BugSpotterConfig = {
        endpoint: 'https://api.example.com',
        showWidget: false,
        apiKey: 'test-key',
        replay: {
          enabled: false,
        },
      };

      await BugSpotter.init(config);

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('should skip settings fetch when no endpoint provided', async () => {
      const config: BugSpotterConfig = {
        showWidget: false,
        apiKey: 'test-key',
      };

      await BugSpotter.init(config);

      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
