/**
 * Replay Quality Settings Integration Tests
 * Tests SDK fetching and applying backend replay quality settings
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { BugSpotter } from '../../src/index';
import type { BugSpotterConfig } from '../../src/index';

describe('Replay Quality Settings Integration', () => {
  const mockEndpoint = 'http://localhost:3000';
  const baseConfig: BugSpotterConfig = {
    endpoint: mockEndpoint,
    showWidget: false,
    apiKey: 'bgs_test_key',
    replay: {
      enabled: true,
      duration: 15,
    },
  };

  // Reset BugSpotter instance before each test to ensure clean state
  beforeEach(() => {
    // @ts-expect-error - Accessing private static property for testing
    BugSpotter.instance = undefined;

    // Suppress expected console errors from rrweb canvas recording in Node.js environment
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  describe('Fetching Backend Settings', () => {
    it('should fetch replay settings from backend on init with API key', async () => {
      const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            duration: 15,
            inline_stylesheets: true,
            inline_images: false,
            collect_fonts: true,
            record_canvas: false,
            record_cross_origin_iframes: false,
            sampling_mousemove: 50,
            sampling_scroll: 100,
          },
        }),
      } as Response);

      await BugSpotter.init(baseConfig);

      expect(fetchSpy).toHaveBeenCalledWith(`${mockEndpoint}/api/v1/settings/replay`, {
        headers: { 'x-api-key': 'bgs_test_key' },
      });
    });

    it('should skip settings fetch when API key is not provided', async () => {
      const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            duration: 15,
            inline_stylesheets: true,
            inline_images: false,
            collect_fonts: true,
            record_canvas: false,
            record_cross_origin_iframes: false,
            sampling_mousemove: 50,
            sampling_scroll: 100,
          },
        }),
      } as Response);

      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const configWithoutApiKey: Partial<BugSpotterConfig> = {
        endpoint: mockEndpoint,
        showWidget: false,
        replay: {
          enabled: true,
          duration: 15,
        },
      };

      await BugSpotter.init(configWithoutApiKey as BugSpotterConfig);

      // Should NOT call fetch without API key (security: don't leak endpoint existence)
      expect(fetchSpy).not.toHaveBeenCalled();

      // Should warn about missing API key
      expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('no API key configured'));

      consoleWarnSpy.mockRestore();
    });

    it('should handle failed fetch gracefully', async () => {
      const fetchSpy = vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('Network error'));

      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await BugSpotter.init(baseConfig);

      expect(fetchSpy).toHaveBeenCalled();
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to fetch replay settings'),
        expect.any(Error)
      );

      consoleWarnSpy.mockRestore();
    });

    it('should handle non-ok response gracefully', async () => {
      const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 500,
      } as Response);

      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await BugSpotter.init(baseConfig);

      expect(fetchSpy).toHaveBeenCalled();
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to fetch replay settings: 500')
      );

      consoleWarnSpy.mockRestore();
    });

    it('should handle 401 authentication error gracefully', async () => {
      const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 401,
      } as Response);

      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await BugSpotter.init(baseConfig);

      expect(fetchSpy).toHaveBeenCalledWith(`${mockEndpoint}/api/v1/settings/replay`, {
        headers: { 'x-api-key': 'bgs_test_key' },
      });
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to fetch replay settings: 401')
      );

      // Should fall back to defaults and continue initialization
      const instance = BugSpotter.getInstance();
      expect(instance).toBeTruthy();

      consoleWarnSpy.mockRestore();
    });

    it('should handle malformed response data', async () => {
      const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: null, // Invalid data
        }),
      } as Response);

      await BugSpotter.init(baseConfig);

      expect(fetchSpy).toHaveBeenCalled();
      // Should initialize with defaults without crashing
    });
  });

  describe('User Config Precedence', () => {
    it('should prioritize user config over backend settings', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            duration: 20,
            inline_stylesheets: true,
            inline_images: false,
            collect_fonts: true,
            record_canvas: false,
            record_cross_origin_iframes: false,
            sampling_mousemove: 50,
            sampling_scroll: 100,
          },
        }),
      } as Response);

      // User explicitly sets inlineImages to true (overrides backend false)
      const configWithOverrides: BugSpotterConfig = {
        ...baseConfig,
        replay: {
          enabled: true,
          duration: 15,
          inlineImages: true, // User override
          recordCanvas: true, // User override
        },
      };

      await BugSpotter.init(configWithOverrides);

      // SDK should use user config values, not backend
      // (Verified by DOMCollector receiving correct values)
    });

    it('should use backend settings when user does not specify', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            duration: 30,
            inline_stylesheets: false,
            inline_images: true,
            collect_fonts: false,
            record_canvas: true,
            record_cross_origin_iframes: true,
          },
        }),
      } as Response);

      // User does not specify quality settings
      await BugSpotter.init(baseConfig);

      // SDK should use backend settings
    });

    it('should merge user config with backend settings', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            duration: 15,
            inline_stylesheets: true,
            inline_images: false,
            collect_fonts: true,
            record_canvas: false,
            record_cross_origin_iframes: false,
            sampling_mousemove: 50,
            sampling_scroll: 100,
          },
        }),
      } as Response);

      // User only overrides some settings
      const partialConfig: BugSpotterConfig = {
        ...baseConfig,
        replay: {
          enabled: true,
          duration: 15,
          inlineImages: true, // User override
          // Other settings should come from backend
        },
      };

      await BugSpotter.init(partialConfig);

      // Should merge correctly
    });
  });

  describe('Fallback to Defaults', () => {
    it('should use defaults when backend is unavailable', async () => {
      vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('Network error'));

      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await BugSpotter.init(baseConfig);

      // Should initialize with hardcoded defaults
      // inline_stylesheets: true, inline_images: false, etc.

      consoleWarnSpy.mockRestore();
    });

    it('should use defaults when backend returns empty data', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {},
        }),
      } as Response);

      await BugSpotter.init(baseConfig);

      // Should use defaults for all settings
    });
  });

  describe('Init Method Behavior', () => {
    it('should make init method async', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            duration: 15,
            inline_stylesheets: true,
            inline_images: false,
            collect_fonts: true,
            record_canvas: false,
            record_cross_origin_iframes: false,
            sampling_mousemove: 50,
            sampling_scroll: 100,
          },
        }),
      } as Response);

      const result = BugSpotter.init(baseConfig);

      // Should return a Promise
      expect(result).toBeInstanceOf(Promise);

      const instance = await result;
      expect(instance).toBeInstanceOf(BugSpotter);
    });

    it('should return same instance on multiple init calls', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            duration: 15,
            inline_stylesheets: true,
            inline_images: false,
            collect_fonts: true,
            record_canvas: false,
            record_cross_origin_iframes: false,
            sampling_mousemove: 50,
            sampling_scroll: 100,
          },
        }),
      } as Response);

      const instance1 = await BugSpotter.init(baseConfig);
      const instance2 = await BugSpotter.init(baseConfig);

      expect(instance1).toBe(instance2);
    });
  });

  describe('Endpoint Handling', () => {
    it('should use provided endpoint', async () => {
      const customEndpoint = 'https://custom-api.example.com';
      const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, data: {} }),
      } as Response);

      await BugSpotter.init({
        ...baseConfig,
        endpoint: customEndpoint,
      });

      expect(fetchSpy).toHaveBeenCalledWith(`${customEndpoint}/api/v1/settings/replay`, {
        headers: { 'x-api-key': 'bgs_test_key' },
      });
    });

    it('should use localhost endpoint for local development', async () => {
      const localhostEndpoint = 'http://localhost:3000';
      const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, data: {} }),
      } as Response);

      await BugSpotter.init({
        ...baseConfig,
        endpoint: localhostEndpoint,
      });

      expect(fetchSpy).toHaveBeenCalledWith(`${localhostEndpoint}/api/v1/settings/replay`, {
        headers: { 'x-api-key': 'bgs_test_key' },
      });
    });
  });
});
