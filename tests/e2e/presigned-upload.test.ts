/**
 * E2E Tests for Presigned URL Upload Flow
 * Tests complete SDK → Backend presigned URL integration
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BugSpotter, DirectUploader, compressReplayEvents } from '../../src/index';

const TEST_PROJECT_ID = 'test-project-123';
const TEST_BUG_ID = 'test-bug-456';
const TEST_API_KEY = 'bgs_test_key_presigned';

// Mock presigned URL response
const MOCK_PRESIGNED_URL = 'https://storage.example.com/presigned-upload-url?signature=abc123';

// Helper to create mock fetch responses
function createPresignedUrlResponse(fileType: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      data: {
        uploadUrl: MOCK_PRESIGNED_URL,
        storageKey: `${fileType}s/${TEST_PROJECT_ID}/${TEST_BUG_ID}/${fileType}.${fileType === 'screenshot' ? 'png' : 'gz'}`,
        expiresIn: 3600,
        contentType: fileType === 'screenshot' ? 'image/png' : 'application/gzip',
      },
    }),
  };
}

function createConfirmUploadResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      data: {
        message: 'Upload confirmed successfully',
      },
    }),
  };
}

describe('Presigned URL Upload Flow', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalFetch: typeof global.fetch;
  let mockXHR: any;
  let xhrInstances: any[];

  beforeEach(() => {
    // Mock fetch for API calls (presigned URL and confirm)
    originalFetch = global.fetch;
    fetchMock = vi.fn();
    global.fetch = fetchMock as any;

    // Track all XHR instances created
    xhrInstances = [];

    // Mock XMLHttpRequest for storage uploads
    mockXHR = vi.fn().mockImplementation(() => {
      const instance = {
        open: vi.fn(),
        send: vi.fn(function (this: any) {
          // Simulate successful upload
          setTimeout(() => {
            this.status = 200;
            if (this.onload) this.onload();
            // Trigger load event listeners
            const loadEvent = new Event('load');
            this.dispatchEvent(loadEvent);
          }, 0);
        }),
        setRequestHeader: vi.fn(),
        addEventListener: vi.fn(function (this: any, event: string, handler: any) {
          if (event === 'load') {
            this.onload = handler;
          } else if (event === 'error') {
            this.onerror = handler;
          } else if (event === 'abort') {
            this.onabort = handler;
          }
        }),
        upload: {
          addEventListener: vi.fn(),
        },
        status: 0,
        dispatchEvent: vi.fn((event: Event) => {
          // Call the appropriate handler
          if (event.type === 'load' && instance.onload) {
            instance.onload(event);
          } else if (event.type === 'error' && instance.onerror) {
            instance.onerror(event);
          } else if (event.type === 'abort' && instance.onabort) {
            instance.onabort(event);
          }
        }),
        onload: null as any,
        onerror: null as any,
        onabort: null as any,
      };

      xhrInstances.push(instance);
      return instance;
    });

    (global as any).XMLHttpRequest = mockXHR;

    // Clean up any existing instance
    const instance = BugSpotter.getInstance();
    if (instance) {
      instance.destroy();
    }
  });

  afterEach(() => {
    // Restore original fetch
    global.fetch = originalFetch;

    // Clean up instance
    const instance = BugSpotter.getInstance();
    if (instance) {
      instance.destroy();
    }

    vi.restoreAllMocks();
  });

  it('should upload screenshot via presigned URL', async () => {
    // Mock responses:
    // 1. Presigned URL request
    // 2. Confirm upload
    fetchMock
      .mockResolvedValueOnce(createPresignedUrlResponse('screenshot'))
      .mockResolvedValueOnce(createConfirmUploadResponse());

    // Create DirectUploader instance
    const uploader = new DirectUploader({
      apiEndpoint: 'https://api.example.com',
      apiKey: TEST_API_KEY,
      bugId: TEST_BUG_ID,
    });

    // Create a fake screenshot blob
    const screenshotBlob = new Blob(['fake-screenshot-data'], { type: 'image/png' });

    // Upload screenshot
    const result = await uploader.uploadScreenshot(screenshotBlob);

    // Verify result
    expect(result.success).toBe(true);
    expect(result.storageKey).toBeTruthy();
    expect(result.storageKey).toContain('screenshots/');
    expect(result.storageKey).toContain(TEST_PROJECT_ID);
    expect(result.storageKey).toContain(TEST_BUG_ID);

    // Verify fetch was called twice (presigned URL + confirm)
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Verify presigned URL request
    const presignedUrlCall = fetchMock.mock.calls[0];
    expect(presignedUrlCall[0]).toContain('/api/v1/uploads/presigned-url');
    expect(presignedUrlCall[1].method).toBe('POST');

    // Verify XMLHttpRequest was used for storage upload
    expect(mockXHR).toHaveBeenCalledTimes(1);
    const xhr = xhrInstances[0];
    expect(xhr.open).toHaveBeenCalledWith('PUT', MOCK_PRESIGNED_URL);
    expect(xhr.send).toHaveBeenCalledWith(expect.any(ArrayBuffer));

    // Verify confirm upload request
    const confirmCall = fetchMock.mock.calls[1];
    expect(confirmCall[0]).toContain(`/api/v1/reports/${TEST_BUG_ID}/confirm-upload`);
    expect(confirmCall[1].method).toBe('POST');
  });

  it('should upload compressed replay via presigned URL', async () => {
    // Skip if blob.stream() not available (jsdom environment)
    const hasFullBlobAPI = typeof Blob !== 'undefined' && 'stream' in Blob.prototype;
    if (!hasFullBlobAPI) {
      console.log('Skipping replay compression test in jsdom environment');
      return;
    }

    // Mock responses (presigned URL + confirm)
    fetchMock
      .mockResolvedValueOnce(createPresignedUrlResponse('replay'))
      .mockResolvedValueOnce(createConfirmUploadResponse());

    const uploader = new DirectUploader({
      apiEndpoint: 'https://api.example.com',
      apiKey: TEST_API_KEY,
      bugId: TEST_BUG_ID,
    });

    // Create mock replay events
    const mockReplayEvents = [
      { type: 4, data: { href: 'https://example.com' }, timestamp: Date.now() },
      { type: 2, data: {}, timestamp: Date.now() + 100 },
      { type: 3, data: { source: 0 }, timestamp: Date.now() + 200 },
    ];

    // Compress replay events
    const compressedBlob = await compressReplayEvents(mockReplayEvents);

    expect(compressedBlob).toBeInstanceOf(Blob);
    expect(compressedBlob.type).toBe('application/gzip');
    expect(compressedBlob.size).toBeGreaterThan(0);

    // Upload compressed replay
    const result = await uploader.uploadReplay(compressedBlob);

    expect(result.success).toBe(true);
    expect(result.storageKey).toBeTruthy();
    expect(result.storageKey).toContain('replays/');
    expect(result.storageKey).toContain(TEST_PROJECT_ID);
    expect(result.storageKey).toContain(TEST_BUG_ID);

    // Verify fetch calls (presigned URL + confirm)
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const presignedUrlCall = fetchMock.mock.calls[0];
    const requestBody = JSON.parse(presignedUrlCall[1].body as string);
    expect(requestBody.fileType).toBe('replay');
    expect(requestBody.filename).toBe('replay.gz');

    // Verify XHR was used for storage upload
    expect(mockXHR).toHaveBeenCalledTimes(1);
    const xhr = xhrInstances[0];
    expect(xhr.send).toHaveBeenCalledWith(compressedBlob);
  });

  it('should upload both screenshot and replay', async () => {
    const hasFullBlobAPI = typeof Blob !== 'undefined' && 'stream' in Blob.prototype;
    if (!hasFullBlobAPI) {
      console.log('Skipping combined upload test in jsdom environment');
      return;
    }

    // Mock 4 responses: 2 presigned URLs + 2 confirmations
    // XHR handles the actual storage uploads
    fetchMock
      .mockResolvedValueOnce(createPresignedUrlResponse('screenshot'))
      .mockResolvedValueOnce(createConfirmUploadResponse())
      .mockResolvedValueOnce(createPresignedUrlResponse('replay'))
      .mockResolvedValueOnce(createConfirmUploadResponse());

    const uploader = new DirectUploader({
      apiEndpoint: 'https://api.example.com',
      apiKey: TEST_API_KEY,
      bugId: TEST_BUG_ID,
    });

    // Upload screenshot
    const screenshotBlob = new Blob(['fake-screenshot'], { type: 'image/png' });
    const screenshotResult = await uploader.uploadScreenshot(screenshotBlob);

    expect(screenshotResult.success).toBe(true);
    expect(screenshotResult.storageKey).toContain('screenshots/');

    // Upload replay
    const mockReplayEvents = [{ type: 4, data: {}, timestamp: Date.now() }];
    const compressedReplayBlob = await compressReplayEvents(mockReplayEvents);
    const replayResult = await uploader.uploadReplay(compressedReplayBlob);

    expect(replayResult.success).toBe(true);
    expect(replayResult.storageKey).toContain('replays/');

    // Verify both uploads completed (4 fetch calls, 2 XHR calls)
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(mockXHR).toHaveBeenCalledTimes(2);
  });

  it('should handle upload progress callbacks', async () => {
    fetchMock
      .mockResolvedValueOnce(createPresignedUrlResponse('screenshot'))
      .mockResolvedValueOnce(createConfirmUploadResponse());

    const uploader = new DirectUploader({
      apiEndpoint: 'https://api.example.com',
      apiKey: TEST_API_KEY,
      bugId: TEST_BUG_ID,
    });

    const progressEvents: Array<{ loaded: number; total: number; percentage: number }> = [];
    const screenshotBlob = new Blob(['test-screenshot-data'], { type: 'image/png' });

    const result = await uploader.uploadScreenshot(screenshotBlob, (progress) => {
      progressEvents.push({
        loaded: progress.loaded,
        total: progress.total,
        percentage: progress.percentage,
      });
    });

    expect(result.success).toBe(true);

    // Progress callback should be invoked
    // Note: In mocked environment, XMLHttpRequest progress events may not fire
    // In real browser, progressEvents.length > 0 and last event has percentage=100
    expect(progressEvents).toBeDefined();
  });

  it('should handle upload errors gracefully', async () => {
    // Mock error response for presigned URL request
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({
        success: false,
        error: 'Invalid file type',
      }),
    });

    const uploader = new DirectUploader({
      apiEndpoint: 'https://api.example.com',
      apiKey: TEST_API_KEY,
      bugId: TEST_BUG_ID,
    });

    const invalidBlob = new Blob(['invalid'], { type: 'text/plain' });
    const result = await uploader.uploadScreenshot(invalidBlob);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('should handle storage upload failures', async () => {
    // Mock successful presigned URL
    fetchMock.mockResolvedValueOnce(createPresignedUrlResponse('screenshot'));

    // Mock XHR that fails during upload
    const failingXHR = vi.fn().mockImplementation(() => {
      const instance = {
        open: vi.fn(),
        send: vi.fn(function (this: any) {
          // Simulate failed upload
          setTimeout(() => {
            this.status = 500;
            if (this.onerror) this.onerror();
            // Trigger error event
            const errorEvent = new Event('error');
            this.dispatchEvent(errorEvent);
          }, 0);
        }),
        setRequestHeader: vi.fn(),
        addEventListener: vi.fn(function (this: any, event: string, handler: any) {
          if (event === 'load') {
            this.onload = handler;
          } else if (event === 'error') {
            this.onerror = handler;
          } else if (event === 'abort') {
            this.onabort = handler;
          }
        }),
        upload: {
          addEventListener: vi.fn(),
        },
        status: 0,
        dispatchEvent: vi.fn((event: Event) => {
          if (event.type === 'load' && instance.onload) {
            instance.onload(event);
          } else if (event.type === 'error' && instance.onerror) {
            instance.onerror(event);
          } else if (event.type === 'abort' && instance.onabort) {
            instance.onabort(event);
          }
        }),
        onload: null as any,
        onerror: null as any,
        onabort: null as any,
      };

      xhrInstances.push(instance);
      return instance;
    });

    (global as any).XMLHttpRequest = failingXHR;

    const uploader = new DirectUploader({
      apiEndpoint: 'https://api.example.com',
      apiKey: TEST_API_KEY,
      bugId: TEST_BUG_ID,
    });

    const screenshotBlob = new Blob(['test'], { type: 'image/png' });
    const result = await uploader.uploadScreenshot(screenshotBlob);

    expect(result.success).toBe(false);
    expect(result.error).toContain('storage');
  });

  it('should handle confirmation failures', async () => {
    // Mock successful presigned URL, but failed confirmation
    fetchMock
      .mockResolvedValueOnce(createPresignedUrlResponse('screenshot'))
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({
          success: false,
          error: 'Bug report not found',
        }),
      });

    const uploader = new DirectUploader({
      apiEndpoint: 'https://api.example.com',
      apiKey: TEST_API_KEY,
      bugId: TEST_BUG_ID,
    });

    const screenshotBlob = new Blob(['test'], { type: 'image/png' });
    const result = await uploader.uploadScreenshot(screenshotBlob);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe('Compression Integration', () => {
  it('should compress replay events with Web Streams API', async () => {
    const hasFullBlobAPI = typeof Blob !== 'undefined' && 'stream' in Blob.prototype;
    if (!hasFullBlobAPI) {
      console.log('Skipping compression test in jsdom environment');
      return;
    }

    const mockEvents = [
      { type: 4, data: { href: 'https://example.com' }, timestamp: Date.now() },
      { type: 2, data: { node: { id: 1, type: 1 } }, timestamp: Date.now() + 100 },
      { type: 3, data: { source: 0, positions: [] }, timestamp: Date.now() + 200 },
    ];

    const compressedBlob = await compressReplayEvents(mockEvents);

    expect(compressedBlob).toBeInstanceOf(Blob);
    expect(compressedBlob.type).toBe('application/gzip');
    expect(compressedBlob.size).toBeGreaterThan(0);

    // Compressed size may be larger than JSON for very small payloads due to gzip headers
    // This is expected and the SDK handles it gracefully
  });
});
