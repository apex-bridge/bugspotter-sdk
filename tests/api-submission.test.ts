import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import { BugSpotter } from '../src/index';
import { TEST_SCREENSHOT_DATA_URL } from './fixtures/test-images';

// Mock constants for presigned URL flow
const TEST_API_KEY = 'bgs_test_api_key';
const TEST_PROJECT_ID = 'proj-12345678-1234-1234-1234-123456789abc';
const TEST_BUG_ID = 'bug-87654321-4321-4321-4321-987654321cba';

describe('API Submission', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    // Clean up any existing instance
    const instance = BugSpotter.getInstance();
    if (instance) {
      instance.destroy();
    }

    // Mock fetch - handle both API calls AND data URLs
    originalFetch = global.fetch;
    const baseFetchMock = vi.fn();
    fetchMock = baseFetchMock;

    const mockFetchFn = vi.fn((url: string, ...args: any[]) => {
      // Handle data URLs (for screenshot/replay blob conversion)
      if (typeof url === 'string' && url.startsWith('data:')) {
        const base64Data = url.split(',')[1];
        const binaryString = Buffer.from(base64Data, 'base64').toString(
          'binary'
        );
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        const blob = new Blob([bytes], { type: 'image/png' });
        return Promise.resolve({
          ok: true,
          status: 200,
          blob: async () => blob,
          json: async () => ({}),
          text: async () => '',
        } as Response);
      }
      // Delegate to mockable fetch for API calls
      return baseFetchMock(url, ...args);
    }) as any;

    global.fetch = mockFetchFn;
    (window as any).fetch = mockFetchFn; // Ensure window.fetch is also mocked
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

  describe('Successful submission', () => {
    it('should submit bug report to configured endpoint', async () => {
      // Optimized flow: Create bug report WITH presigned URLs in response
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          status: 201,
          json: async () => ({
            success: true,
            data: {
              id: TEST_BUG_ID,
              presignedUrls: {
                screenshot: {
                  uploadUrl: 'https://s3.example.com/presigned-screenshot-url',
                  storageKey: `screenshots/${TEST_PROJECT_ID}/${TEST_BUG_ID}/screenshot.png`,
                },
              },
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({}), // S3 presigned URL upload
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ success: true }), // Screenshot confirmation
        });

      const bugSpotter = await BugSpotter.init({
        apiKey: TEST_API_KEY,
        endpoint: 'https://api.example.com',
        showWidget: false,
        replay: { enabled: false },
      });

      const report = await bugSpotter.capture();
      report._screenshotPreview = TEST_SCREENSHOT_DATA_URL;

      const payload = {
        title: 'Test Bug',
        description: 'Bug description',
        report,
      };

      await bugSpotter.submit(payload);

      // Should have made 3 API calls (create + S3 upload + confirm)
      expect(fetchMock).toHaveBeenCalledTimes(3);

      // Check bug report creation call
      const createCall = fetchMock.mock.calls[0];
      expect(createCall[0]).toBe('https://api.example.com/api/v1/reports');
      expect(createCall[1].method).toBe('POST');
      expect(createCall[1].headers['X-API-Key']).toBe(TEST_API_KEY);

      // Body can be Blob (compressed) or JSON string (uncompressed)
      const requestBody = createCall[1].body;
      if (requestBody instanceof Blob) {
        // Compressed - just verify it's a Blob with gzip type
        expect(createCall[1].headers['Content-Encoding']).toBe('gzip');
      } else {
        // Uncompressed JSON
        const body = JSON.parse(requestBody);
        expect(body).toHaveProperty('title', 'Test Bug');
        expect(body).toHaveProperty('description', 'Bug description');
      }

      // S3 upload happens via fetch (mocked above), not XHR
    });

    it('should throw error when submitting without API key', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ success: true, data: { id: TEST_BUG_ID } }),
      });

      const bugSpotter = await BugSpotter.init({
        endpoint: 'https://api.example.com',
        showWidget: false,
        replay: { enabled: false },
        apiKey: undefined as any,
      });

      const report = await bugSpotter.capture();
      report._screenshotPreview = TEST_SCREENSHOT_DATA_URL;

      const payload = { title: 'Test', description: 'Test', report };

      await expect(bugSpotter.submit(payload)).rejects.toThrow(
        'API key is required'
      );
    });

    it('should complete upload flow successfully', async () => {
      // Optimized flow: create with presigned URL + confirm upload
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          status: 201,
          json: async () => ({
            success: true,
            data: {
              id: TEST_BUG_ID,
              presignedUrls: {
                screenshot: {
                  uploadUrl: 'https://s3.example.com/presigned-url',
                  storageKey: 'key',
                },
              },
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ success: true }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ success: true }), // Screenshot confirmation
        });

      const bugSpotter = await BugSpotter.init({
        apiKey: TEST_API_KEY,
        endpoint: 'https://api.example.com',
        showWidget: false,
        replay: { enabled: false },
      });

      const report = await bugSpotter.capture();
      report._screenshotPreview = 'data:image/png;base64,iVBORw0KGgo=';
      const payload = { title: 'Test', description: 'Test', report };

      // Should not throw
      await expect(bugSpotter.submit(payload)).resolves.not.toThrow();
    });

    it('should upload replay events when replay is enabled', async () => {
      // Optimized flow: create (with presigned URLs) + S3 uploads + confirmations
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
          status: 201,
          json: async () => ({
            success: true,
            data: {
              id: TEST_BUG_ID,
              presignedUrls: {
                screenshot: {
                  uploadUrl: 'https://s3.example.com/presigned-screenshot-url',
                  storageKey: 'screenshots/key',
                },
                replay: {
                  uploadUrl: 'https://s3.example.com/presigned-replay-url',
                  storageKey: 'replays/key',
                },
              },
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({}), // S3 screenshot upload
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({}), // S3 replay upload
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ success: true }), // Screenshot confirmation
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ success: true }), // Replay confirmation
        });

      const bugSpotter = await BugSpotter.init({
        apiKey: TEST_API_KEY,
        endpoint: 'https://api.example.com',
        showWidget: false,
        replay: { enabled: true }, // Enable replay!
      });

      // Wait for some replay events to be recorded
      document.body.innerHTML = '<div>Test content for replay</div>';
      await new Promise((resolve) => setTimeout(resolve, 100));

      const report = await bugSpotter.capture();
      report._screenshotPreview = 'data:image/png;base64,iVBORw0KGgo=';
      const payload = {
        title: 'Test with Replay',
        description: 'Test',
        report,
      };

      await expect(bugSpotter.submit(payload)).resolves.not.toThrow();

      // Should have made 6 fetch calls: settings + create + 2 S3 uploads + 2 confirmations
      expect(fetchMock).toHaveBeenCalledTimes(6);

      bugSpotter.destroy();
    });

    it('should handle bug report creation without screenshot', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ success: true, data: { id: TEST_BUG_ID } }),
      });

      const bugSpotter = await BugSpotter.init({
        apiKey: TEST_API_KEY,
        endpoint: 'https://api.example.com',
        showWidget: false,
        replay: { enabled: false },
      });

      const report = await bugSpotter.capture();
      // Explicitly remove screenshot preview to test no-upload scenario
      report._screenshotPreview = undefined;
      const payload = { title: 'Test', description: 'Test', report };

      await expect(bugSpotter.submit(payload)).resolves.not.toThrow();

      // Only bug report creation, no screenshot/replay uploads
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('Error handling', () => {
    it('should throw error if no endpoint is configured', async () => {
      const bugSpotter = await BugSpotter.init({
        apiKey: TEST_API_KEY,
        showWidget: false,
        replay: { enabled: false },
      });

      const report = await bugSpotter.capture();
      const payload = { title: 'Test', description: 'Test', report };

      await expect(bugSpotter.submit(payload)).rejects.toThrow(
        'No endpoint configured for bug report submission'
      );

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('should throw error on HTTP 4xx error', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () => {
          return 'Invalid payload';
        },
      });

      const bugSpotter = await BugSpotter.init({
        apiKey: TEST_API_KEY,
        endpoint: 'https://api.example.com',
        showWidget: false,
        replay: { enabled: false },
      });

      const report = await bugSpotter.capture();
      const payload = { title: 'Test', description: 'Test', report };

      await expect(bugSpotter.submit(payload)).rejects.toThrow(
        'Failed to submit bug report: 400 Bad Request. Invalid payload'
      );
    });

    it('should throw error on HTTP 5xx error', async () => {
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
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          text: async () => {
            return 'Server error occurred';
          },
        });

      const bugSpotter = await BugSpotter.init({
        apiKey: TEST_API_KEY,
        endpoint: 'https://api.example.com',
        showWidget: false,
      });

      const report = await bugSpotter.capture();
      const payload = { title: 'Test', description: 'Test', report };

      await expect(bugSpotter.submit(payload)).rejects.toThrow(
        'Failed to submit bug report: 500 Internal Server Error. Server error occurred'
      );
    });

    it('should handle network errors', async () => {
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
      fetchMock.mockRejectedValueOnce(new Error('Network error'));

      const bugSpotter = await BugSpotter.init({
        apiKey: TEST_API_KEY,
        endpoint: 'https://api.example.com',
        showWidget: false,
        retry: { maxRetries: 0 }, // Disable retries for this test
      });

      const report = await bugSpotter.capture();
      const payload = { title: 'Test', description: 'Test', report };

      await expect(bugSpotter.submit(payload)).rejects.toThrow('Network error');
    });

    it('should handle error response with no text body', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        text: async () => {
          throw new Error('No body');
        },
      });

      const bugSpotter = await BugSpotter.init({
        apiKey: TEST_API_KEY,
        endpoint: 'https://api.example.com',
        showWidget: false,
        replay: { enabled: false },
      });

      const report = await bugSpotter.capture();
      const payload = { title: 'Test', description: 'Test', report };

      await expect(bugSpotter.submit(payload)).rejects.toThrow(
        'Failed to submit bug report: 403'
      );
    });

    it('should handle timeout errors', async () => {
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
      fetchMock.mockImplementationOnce(() => {
        return new Promise((_, reject) => {
          return setTimeout(() => {
            return reject(new Error('Request timeout'));
          }, 100);
        });
      });

      const bugSpotter = await BugSpotter.init({
        apiKey: TEST_API_KEY,
        endpoint: 'https://api.example.com',
        showWidget: false,
        retry: { maxRetries: 0 }, // Disable retries for this test
      });

      const report = await bugSpotter.capture();
      const payload = { title: 'Test', description: 'Test', report };

      await expect(bugSpotter.submit(payload)).rejects.toThrow(
        'Request timeout'
      );
    });
  });

  describe('Payload structure', () => {
    it('should send complete bug report payload', async () => {
      // Optimized flow: create (with presigned URL) + S3 upload + confirm
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          status: 201,
          json: async () => ({
            success: true,
            data: {
              id: TEST_BUG_ID,
              presignedUrls: {
                screenshot: {
                  uploadUrl: 'https://s3.example.com/presigned-url',
                  storageKey: 'key',
                },
              },
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({}), // S3 upload
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ success: true }), // Screenshot confirmation
        });

      const bugSpotter = await BugSpotter.init({
        apiKey: TEST_API_KEY,
        endpoint: 'https://api.example.com',
        showWidget: false,
        replay: { enabled: false },
      });

      // Add some console logs
      console.log('Test log for payload');
      console.error('Test error for payload');

      await new Promise((resolve) => setTimeout(resolve, 50));

      const report = await bugSpotter.capture();
      // Add screenshot for upload
      report._screenshotPreview = TEST_SCREENSHOT_DATA_URL;
      const payload = {
        title: 'Complete Test Bug',
        description: 'This is a detailed description',
        report,
      };

      await bugSpotter.submit(payload);

      // Verify bug report creation call
      const call = fetchMock.mock.calls[0];
      expect(call[0]).toBe('https://api.example.com/api/v1/reports');

      // Handle both compressed and uncompressed payloads
      const requestBody = call[1].body;
      if (!(requestBody instanceof Blob)) {
        const sentBody = JSON.parse(requestBody);
        expect(sentBody).toHaveProperty('title', 'Complete Test Bug');
        expect(sentBody).toHaveProperty(
          'description',
          'This is a detailed description'
        );
        expect(sentBody).toHaveProperty('report');
        expect(sentBody.report).toHaveProperty('console');
        expect(sentBody.report).toHaveProperty('metadata');
      }
    });
  });

  describe('Different endpoint configurations', () => {
    it('should work with different endpoint URLs', async () => {
      const endpoints = [
        'https://api.bugspotter.com/reports',
        'https://localhost:3000/api/bugs',
        'https://custom-domain.io/v1/bug-reports',
      ];

      for (const endpoint of endpoints) {
        // Optimized flow: create (with presigned URL) + S3 upload + confirm
        fetchMock
          .mockResolvedValueOnce({
            ok: true,
            status: 201,
            json: async () => ({
              success: true,
              data: {
                id: TEST_BUG_ID,
                presignedUrls: {
                  screenshot: {
                    uploadUrl: 'https://s3.example.com/presigned-url',
                    storageKey: 'key',
                  },
                },
              },
            }),
          })
          .mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({}), // S3 upload
          })
          .mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ success: true }), // Screenshot confirmation
          });

        const bugSpotter = await BugSpotter.init({
          apiKey: TEST_API_KEY,
          endpoint,
          showWidget: false,
          replay: { enabled: false },
        });

        const report = await bugSpotter.capture();
        report._screenshotPreview = TEST_SCREENSHOT_DATA_URL;
        const payload = { title: 'Test', description: 'Test', report };

        await bugSpotter.submit(payload);

        expect(fetchMock).toHaveBeenCalled();
        const call = fetchMock.mock.calls[0];
        expect(call[0]).toBe(endpoint + '/api/v1/reports');

        bugSpotter.destroy();
        fetchMock.mockClear();
      }
    });
  });
});
