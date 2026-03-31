/**
 * Integration tests for SDK presigned URL upload flow
 * Tests the complete flow: create report → upload screenshot → upload replay → confirm
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import { BugSpotter } from '../../src/index';
import { TEST_SCREENSHOT_DATA_URL } from '../fixtures/test-images';

// Mock configuration
const MOCK_ENDPOINT = 'https://api.example.com/api/v1/reports';
const MOCK_API_KEY = 'bgs_test_api_key_12345';
const MOCK_BUG_ID = 'bug-87654321-4321-4321-4321-987654321cba';

// Mock responses
const mockBugReportResponse = {
  success: true,
  data: {
    id: MOCK_BUG_ID,
    title: 'Test Bug',
    status: 'open',
    created_at: new Date().toISOString(),
  },
};

const mockCreateBugReportWithPresignedUrls = (options: {
  screenshot?: boolean;
  replay?: boolean;
}) => ({
  success: true,
  data: {
    id: MOCK_BUG_ID,
    presignedUrls: {
      ...(options.screenshot && {
        screenshot: {
          uploadUrl: 'https://s3.example.com/presigned-screenshot',
          storageKey: 'screenshots/test-key',
        },
      }),
      ...(options.replay && {
        replay: {
          uploadUrl: 'https://s3.example.com/presigned-replay',
          storageKey: 'replays/test-key',
        },
      }),
    },
  },
});

const mockConfirmResponse = {
  success: true,
  data: {
    message: 'Upload confirmed successfully',
  },
};

describe('SDK Presigned URL Upload Flow', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let xhrInstances: XMLHttpRequest[] = [];

  beforeEach(() => {
    // Reset instances
    xhrInstances = [];

    // Mock fetch for API calls AND data URLs
    const originalFetchMock = vi.fn();
    fetchMock = originalFetchMock;

    global.fetch = vi.fn((url: string, ...args: any[]) => {
      // Handle data URLs (for screenshot conversion)
      if (typeof url === 'string' && url.startsWith('data:')) {
        const base64Data = url.split(',')[1];
        const buffer = Buffer.from(base64Data, 'base64');
        const blob = new Blob([buffer], { type: 'image/png' });
        return Promise.resolve({
          ok: true,
          status: 200,
          blob: () => Promise.resolve(blob),
        });
      }
      // Handle S3 presigned URL uploads (PUT requests)
      if (typeof url === 'string' && url.includes('s3.example.com/presigned')) {
        return Promise.resolve({
          ok: true,
          status: 200,
        });
      }
      // Delegate to the mockable fetch for API calls
      return originalFetchMock(url, ...args);
    }) as any;

    // Mock XMLHttpRequest for presigned URL uploads
    const MockXHR = vi.fn().mockImplementation(() => {
      const instance = {
        open: vi.fn(),
        send: vi.fn(),
        setRequestHeader: vi.fn(),
        upload: {
          addEventListener: vi.fn(),
        },
        addEventListener: vi.fn((event: string, callback: () => void) => {
          // Auto-trigger load event for successful uploads
          if (event === 'load') {
            setTimeout(() => {
              (instance as any).status = 200;
              (instance as any).readyState = 4;
              callback();
            }, 0);
          }
        }),
        status: 200,
        readyState: 4,
      };

      xhrInstances.push(instance as any);
      return instance;
    });

    global.XMLHttpRequest = MockXHR as any;

    // Mock CompressionStream for replay compression
    if (typeof CompressionStream === 'undefined') {
      (global as any).CompressionStream = class MockCompressionStream {
        readable: ReadableStream;
        writable: WritableStream;

        constructor(_format: string) {
          const transformStream = new TransformStream();
          this.readable = transformStream.readable;
          this.writable = transformStream.writable;
        }
      };
    }
  });

  afterEach(() => {
    // Clean up BugSpotter instance
    const instance = BugSpotter.getInstance();
    if (instance) {
      instance.destroy();
    }

    vi.restoreAllMocks();
  });

  it('should complete full bug report submission with screenshot and replay', async () => {
    // Mock settings endpoint
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

    // Optimized flow: Create (with presigned URLs) + S3 uploads (handled by global fetch) + confirmations
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          success: true,
          data: {
            id: MOCK_BUG_ID,
            presignedUrls: {
              screenshot: {
                uploadUrl: 'https://s3.example.com/presigned-screenshot',
                storageKey: 'screenshots/test-key',
              },
              replay: {
                uploadUrl: 'https://s3.example.com/presigned-replay',
                storageKey: 'replays/test-key',
              },
            },
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockConfirmResponse,
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockConfirmResponse,
      });

    // Initialize SDK
    const sdk = await BugSpotter.init({
      endpoint: MOCK_ENDPOINT,
      showWidget: false,
      apiKey: MOCK_API_KEY,
      replay: {
        enabled: true,
        duration: 15,
      },
    });

    // Capture data
    const report = await sdk.capture();

    // Add screenshot preview (simulate modal capture)
    report._screenshotPreview = TEST_SCREENSHOT_DATA_URL;

    // Submit bug report
    await sdk['submit']({
      title: 'Test Bug Report',
      description: 'Testing presigned URL flow',
      report,
    });

    // Optimized flow: 4 API calls (settings + create with URLs + 2 confirms)
    expect(fetchMock).toHaveBeenCalledTimes(4);

    // Verify bug report creation (call 1, after settings at 0)
    const createCall = fetchMock.mock.calls[1];
    expect(createCall[0]).toBe(MOCK_ENDPOINT);

    // Verify confirmation calls (calls 2 and 3)
    const screenshotConfirmCall = fetchMock.mock.calls[2];
    expect(screenshotConfirmCall[0]).toContain('/confirm-upload');

    const replayConfirmCall = fetchMock.mock.calls[3];
    expect(replayConfirmCall[0]).toContain('/confirm-upload');
  });

  it('should handle bug report creation without screenshot', async () => {
    // No settings mock needed - replay is disabled so settings aren't fetched
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({
        success: true,
        data: {
          id: MOCK_BUG_ID,
        },
      }),
    });

    const sdk = await BugSpotter.init({
      endpoint: MOCK_ENDPOINT,
      showWidget: false,
      apiKey: MOCK_API_KEY,
      replay: {
        enabled: false,
      },
    });

    const report = await sdk.capture();
    // No screenshot - clear the internal preview from the report
    report._screenshotPreview = undefined;

    await sdk['submit']({
      title: 'Test Bug Without Screenshot',
      description: 'Testing without screenshot',
      report,
    });

    // Only bug report creation call, no settings (replay disabled) or uploads
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(xhrInstances.length).toBe(0);
  });

  it('should handle screenshot upload failure gracefully', async () => {
    // Mock settings endpoint
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

    // Bug report succeeds, screenshot presigned URL fails
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => mockBugReportResponse,
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal server error',
      });

    const sdk = await BugSpotter.init({
      endpoint: MOCK_ENDPOINT,
      showWidget: false,
      apiKey: MOCK_API_KEY,
    });

    const report = await sdk.capture();
    report._screenshotPreview = TEST_SCREENSHOT_DATA_URL;

    // Should throw when presigned URL request fails
    await expect(
      sdk['submit']({
        title: 'Test Bug',
        description: 'Testing upload failure',
        report,
      })
    ).rejects.toThrow();

    // Bug report created, screenshot presigned URL attempted
    expect(fetchMock).toHaveBeenCalled();
  });

  it('should handle replay upload with compressed events', async () => {
    // Mock settings endpoint
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

    // Optimized flow: Create (with presigned URL for replay) + confirm
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () =>
          mockCreateBugReportWithPresignedUrls({ replay: true }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockConfirmResponse,
      });

    const sdk = await BugSpotter.init({
      endpoint: MOCK_ENDPOINT,
      showWidget: false,
      apiKey: MOCK_API_KEY,
      replay: {
        enabled: true,
        duration: 15,
      },
    });

    const report = await sdk.capture();
    report._screenshotPreview = undefined;
    report.replay = [
      {
        type: 4,
        data: { href: 'https://example.com', width: 1920, height: 1080 },
        timestamp: Date.now(),
      },
      {
        type: 2,
        data: {
          node: { id: 1, type: 1, tagName: 'div' } as any,
          initialOffset: { top: 0, left: 0 },
        },
        timestamp: Date.now() + 100,
      },
    ];

    await sdk['submit']({
      title: 'Test Bug',
      description: 'Testing replay upload',
      report,
    });

    // Verify replay upload was attempted (settings + create + confirm)
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('should handle both screenshot and replay uploads concurrently', async () => {
    // Mock settings endpoint
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

    // Optimized flow: Create (with presigned URLs) + S3 uploads (handled by global fetch) + confirmations
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          success: true,
          data: {
            id: MOCK_BUG_ID,
            presignedUrls: {
              screenshot: {
                uploadUrl: 'https://s3.example.com/presigned-screenshot',
                storageKey: 'screenshots/test-key',
              },
              replay: {
                uploadUrl: 'https://s3.example.com/presigned-replay',
                storageKey: 'replays/test-key',
              },
            },
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockConfirmResponse,
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockConfirmResponse,
      });

    const sdk = await BugSpotter.init({
      endpoint: MOCK_ENDPOINT,
      showWidget: false,
      apiKey: MOCK_API_KEY,
      replay: {
        enabled: true,
      },
    });

    const report = await sdk.capture();
    report._screenshotPreview = TEST_SCREENSHOT_DATA_URL;
    report.replay = [
      {
        type: 4,
        data: { href: 'https://example.com', width: 1920, height: 1080 },
        timestamp: Date.now(),
      },
    ];

    await sdk['submit']({
      title: 'Test Bug',
      description: 'Testing both uploads',
      report,
    });

    // Optimized flow: 4 API calls (settings + create with URLs + 2 confirms)
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('should handle bug report creation failure', async () => {
    // Mock settings endpoint
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
      ok: false,
      status: 400,
      text: async () => 'Invalid request',
    });

    const sdk = await BugSpotter.init({
      endpoint: MOCK_ENDPOINT,
      showWidget: false,
      apiKey: MOCK_API_KEY,
    });

    const report = await sdk.capture();

    await expect(
      sdk['submit']({
        title: 'Test Bug',
        description: 'Testing creation failure',
        report,
      })
    ).rejects.toThrow('Failed to submit bug report');

    // No uploads should be attempted (settings + failed create)
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(xhrInstances.length).toBe(0);
  });

  it('should handle missing bug report ID in response', async () => {
    // Mock settings endpoint
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
      status: 201,
      json: async () => ({
        success: true,
        data: {
          // Missing 'id' field
          title: 'Test Bug',
        },
      }),
    });

    const sdk = await BugSpotter.init({
      endpoint: MOCK_ENDPOINT,
      showWidget: false,
      apiKey: MOCK_API_KEY,
    });

    const report = await sdk.capture();
    report._screenshotPreview = 'data:image/png;base64,test';

    await expect(
      sdk['submit']({
        title: 'Test Bug',
        description: 'Testing missing ID',
        report,
      })
    ).rejects.toThrow('Invalid server response format');

    // No uploads should be attempted
    expect(xhrInstances.length).toBe(0);
  });

  describe('Auth Validation', () => {
    it('should throw error when auth is missing', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => mockBugReportResponse,
      });

      // Initialize SDK without auth
      const sdk = await BugSpotter.init({
        endpoint: MOCK_ENDPOINT,
        showWidget: false,
        apiKey: undefined as any,
        replay: { enabled: true },
      });

      const report = await sdk.capture();
      report._screenshotPreview = 'data:image/png;base64,iVBORw0KGgo=';

      // Should throw when trying to submit
      await expect(
        sdk['submit']({
          title: 'Test Bug',
          description: 'Testing missing auth',
          report,
        })
      ).rejects.toThrow('API key is required');
    });

    it('should throw error when auth is missing apiKey', async () => {
      const sdk = await BugSpotter.init({
        endpoint: MOCK_ENDPOINT,
        showWidget: false,
        apiKey: ''  as any,
        replay: { enabled: true },
      });

      const report = await sdk.capture();

      await expect(
        sdk['submit']({
          title: 'Test Bug',
          description: 'Testing missing apiKey',
          report,
        })
      ).rejects.toThrow('API key is required');
    });

    it('should throw error when apiKey is missing', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => mockBugReportResponse,
      });

      // Initialize SDK without apiKey
      const sdk = await BugSpotter.init({
        endpoint: MOCK_ENDPOINT,
        showWidget: false,
        apiKey: undefined as any,
        replay: { enabled: true },
      });

      const report = await sdk.capture();
      report._screenshotPreview = 'data:image/png;base64,iVBORw0KGgo=';

      await expect(
        sdk['submit']({
          title: 'Test Bug',
          description: 'Testing missing apiKey',
          report,
        })
      ).rejects.toThrow('API key is required');
    });

    it('should throw error when screenshot upload fails', async () => {
      // Mock settings endpoint
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

      // Setup mocks: create report with presigned URL (optimized flow)
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () =>
          mockCreateBugReportWithPresignedUrls({ screenshot: true }),
      });

      // Override global fetch to simulate S3 upload failure
      const originalGlobalFetch = global.fetch;
      global.fetch = vi.fn((url: string, ...args: any[]) => {
        // Handle data URLs (for screenshot conversion)
        if (typeof url === 'string' && url.startsWith('data:')) {
          const base64Data = url.split(',')[1];
          const buffer = Buffer.from(base64Data, 'base64');
          const blob = new Blob([buffer], { type: 'image/png' });
          return Promise.resolve({
            ok: true,
            status: 200,
            blob: () => Promise.resolve(blob),
          });
        }
        // S3 upload fails
        if (
          typeof url === 'string' &&
          url.includes('s3.example.com/presigned')
        ) {
          return Promise.resolve({
            ok: false,
            status: 500,
          });
        }
        // API calls use fetchMock
        return fetchMock(url, ...args);
      }) as any;

      const sdk = await BugSpotter.init({
        endpoint: MOCK_ENDPOINT,
        showWidget: false,
        apiKey: MOCK_API_KEY,
        replay: { enabled: true },
      });

      const report = await sdk.capture();
      report._screenshotPreview = 'data:image/png;base64,iVBORw0KGgo=';
      report.replay = []; // Disable replay upload to test screenshot failure only

      await expect(
        sdk['submit']({
          title: 'Test Bug',
          description: 'Testing upload failure',
          report,
        })
      ).rejects.toThrow('Screenshot upload failed');

      // Restore original fetch
      global.fetch = originalGlobalFetch;
    });
  });
});
