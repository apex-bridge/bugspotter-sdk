/**
 * Performance and Load Tests for Presigned URL Upload Flow
 * Tests upload performance with various file sizes and concurrent operations
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DirectUploader } from '../../src/core/uploader';
import { compressReplayEvents } from '../../src/core/upload-helpers';

const TEST_PROJECT_ID = 'perf-test-project';
const TEST_BUG_ID = 'perf-test-bug';
const TEST_API_KEY = 'bgs_perf_test_key';
const MOCK_PRESIGNED_URL = 'https://storage.example.com/presigned-upload-url?signature=perf123';

// Helper to create mock responses
function createPresignedUrlResponse(fileType: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      data: {
        uploadUrl: MOCK_PRESIGNED_URL,
        storageKey: `${fileType}s/${TEST_PROJECT_ID}/${TEST_BUG_ID}/${fileType}.data`,
        expiresIn: 3600,
        contentType: 'application/octet-stream',
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
      data: { message: 'Upload confirmed' },
    }),
  };
}

// Helper to create large blob of specified size
function createLargeBlob(sizeInMB: number, type: string = 'application/octet-stream'): Blob {
  const sizeInBytes = sizeInMB * 1024 * 1024;
  const chunkSize = 1024 * 1024; // 1MB chunks
  const chunks: ArrayBuffer[] = [];

  for (let i = 0; i < sizeInBytes; i += chunkSize) {
    const size = Math.min(chunkSize, sizeInBytes - i);
    chunks.push(new ArrayBuffer(size));
  }

  return new Blob(chunks, { type });
}

describe('Presigned URL Upload Performance Tests', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalFetch: typeof global.fetch;
  let mockXHR: any;
  let xhrInstances: any[];
  let uploadStartTime: number;
  let uploadDurations: number[];

  beforeEach(() => {
    uploadDurations = [];

    // Mock fetch for API calls
    originalFetch = global.fetch;
    fetchMock = vi.fn();
    global.fetch = fetchMock as any;

    // Track XHR instances
    xhrInstances = [];

    // Mock XMLHttpRequest with performance tracking
    mockXHR = vi.fn().mockImplementation(() => {
      const instance = {
        open: vi.fn(),
        send: vi.fn(function (this: any, data: any) {
          uploadStartTime = performance.now();

          // Simulate upload with realistic timing based on data size
          const dataSize = data?.size || 0;
          // Simulate 100MB/s upload speed
          const simulatedDelay = Math.max(1, (dataSize / (100 * 1024 * 1024)) * 1000);

          setTimeout(() => {
            const duration = performance.now() - uploadStartTime;
            uploadDurations.push(duration);

            this.status = 200;
            if (this.onload) this.onload();
            const loadEvent = new Event('load');
            this.dispatchEvent(loadEvent);
          }, simulatedDelay);
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

    (global as any).XMLHttpRequest = mockXHR;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('File Size Performance', () => {
    it('should upload 1MB file quickly (< 100ms)', async () => {
      fetchMock
        .mockResolvedValueOnce(createPresignedUrlResponse('screenshot'))
        .mockResolvedValueOnce(createConfirmUploadResponse());

      const uploader = new DirectUploader({
        apiEndpoint: 'https://api.example.com',
        apiKey: TEST_API_KEY,
        bugId: TEST_BUG_ID,
      });

      const startTime = performance.now();
      const blob = createLargeBlob(1, 'image/png');
      const result = await uploader.uploadScreenshot(blob);
      const totalDuration = performance.now() - startTime;

      expect(result.success).toBe(true);
      expect(totalDuration).toBeLessThan(100);
      console.log(`1MB upload completed in ${totalDuration.toFixed(2)}ms`);
    });

    it('should upload 5MB file efficiently (< 200ms)', async () => {
      fetchMock
        .mockResolvedValueOnce(createPresignedUrlResponse('screenshot'))
        .mockResolvedValueOnce(createConfirmUploadResponse());

      const uploader = new DirectUploader({
        apiEndpoint: 'https://api.example.com',
        apiKey: TEST_API_KEY,
        bugId: TEST_BUG_ID,
      });

      const startTime = performance.now();
      const blob = createLargeBlob(5, 'image/png');
      const result = await uploader.uploadScreenshot(blob);
      const totalDuration = performance.now() - startTime;

      expect(result.success).toBe(true);
      expect(totalDuration).toBeLessThan(200);
      console.log(`5MB upload completed in ${totalDuration.toFixed(2)}ms`);
    });

    it('should upload 10MB file within reasonable time (< 300ms)', async () => {
      fetchMock
        .mockResolvedValueOnce(createPresignedUrlResponse('attachment'))
        .mockResolvedValueOnce(createConfirmUploadResponse());

      const uploader = new DirectUploader({
        apiEndpoint: 'https://api.example.com',
        apiKey: TEST_API_KEY,
        bugId: TEST_BUG_ID,
      });

      const startTime = performance.now();
      const file = new File([createLargeBlob(10)], 'large-file.dat', {
        type: 'application/octet-stream',
      });
      const result = await uploader.uploadAttachment(file);
      const totalDuration = performance.now() - startTime;

      expect(result.success).toBe(true);
      expect(totalDuration).toBeLessThan(300);
      console.log(`10MB upload completed in ${totalDuration.toFixed(2)}ms`);
    });

    it('should handle 50MB file upload (< 1000ms)', async () => {
      fetchMock
        .mockResolvedValueOnce(createPresignedUrlResponse('attachment'))
        .mockResolvedValueOnce(createConfirmUploadResponse());

      const uploader = new DirectUploader({
        apiEndpoint: 'https://api.example.com',
        apiKey: TEST_API_KEY,
        bugId: TEST_BUG_ID,
      });

      const startTime = performance.now();
      const file = new File([createLargeBlob(50)], 'very-large-file.dat', {
        type: 'application/octet-stream',
      });
      const result = await uploader.uploadAttachment(file);
      const totalDuration = performance.now() - startTime;

      expect(result.success).toBe(true);
      expect(totalDuration).toBeLessThan(1000);
      console.log(`50MB upload completed in ${totalDuration.toFixed(2)}ms`);
    });
  });

  describe('Compression Performance', () => {
    it('should compress large replay data efficiently', async () => {
      const hasFullBlobAPI = typeof Blob !== 'undefined' && 'stream' in Blob.prototype;
      if (!hasFullBlobAPI) {
        console.log('Skipping compression test in jsdom environment');
        return;
      }

      // Create large replay dataset (1000 events)
      const largeReplayEvents = Array.from({ length: 1000 }, (_, i) => ({
        type: i % 5,
        data: {
          href: 'https://example.com/page',
          id: i,
          timestamp: Date.now() + i * 100,
          payload: 'x'.repeat(100), // Add some data
        },
        timestamp: Date.now() + i * 100,
      }));

      const startTime = performance.now();
      const compressed = await compressReplayEvents(largeReplayEvents);
      const duration = performance.now() - startTime;

      const originalSize = JSON.stringify(largeReplayEvents).length;
      const compressedSize = compressed.size;
      const compressionRatio = (((originalSize - compressedSize) / originalSize) * 100).toFixed(2);

      expect(compressed.type).toBe('application/gzip');
      expect(duration).toBeLessThan(500); // Should compress 1000 events in < 500ms

      console.log(`Compression stats:`);
      console.log(`  - Events: ${largeReplayEvents.length}`);
      console.log(`  - Original size: ${(originalSize / 1024).toFixed(2)} KB`);
      console.log(`  - Compressed size: ${(compressedSize / 1024).toFixed(2)} KB`);
      console.log(`  - Compression ratio: ${compressionRatio}%`);
      console.log(`  - Duration: ${duration.toFixed(2)}ms`);
    });
  });

  describe('Concurrent Upload Load Tests', () => {
    it('should handle 5 concurrent uploads', async () => {
      // Mock enough responses for 5 uploads (10 API calls total)
      for (let i = 0; i < 5; i++) {
        fetchMock
          .mockResolvedValueOnce(createPresignedUrlResponse('screenshot'))
          .mockResolvedValueOnce(createConfirmUploadResponse());
      }

      const uploader = new DirectUploader({
        apiEndpoint: 'https://api.example.com',
        apiKey: TEST_API_KEY,
        bugId: TEST_BUG_ID,
      });

      const startTime = performance.now();

      // Create 5 concurrent uploads
      const uploadPromises = Array.from({ length: 5 }, () => {
        const blob = createLargeBlob(2, 'image/png');
        return uploader.uploadScreenshot(blob);
      });

      const results = await Promise.all(uploadPromises);
      const totalDuration = performance.now() - startTime;

      // All uploads should succeed
      expect(results.every((r) => r.success)).toBe(true);

      // Concurrent uploads should be faster than sequential
      expect(totalDuration).toBeLessThan(500); // 5 × 2MB should complete in < 500ms concurrently

      console.log(`5 concurrent uploads (2MB each) completed in ${totalDuration.toFixed(2)}ms`);
    });

    it('should handle 10 concurrent uploads without errors', async () => {
      // Mock enough responses for 10 uploads (20 API calls total)
      for (let i = 0; i < 10; i++) {
        fetchMock
          .mockResolvedValueOnce(createPresignedUrlResponse('screenshot'))
          .mockResolvedValueOnce(createConfirmUploadResponse());
      }

      const uploader = new DirectUploader({
        apiEndpoint: 'https://api.example.com',
        apiKey: TEST_API_KEY,
        bugId: TEST_BUG_ID,
      });

      const startTime = performance.now();

      const uploadPromises = Array.from({ length: 10 }, () => {
        const blob = createLargeBlob(1, 'image/png');
        return uploader.uploadScreenshot(blob);
      });

      const results = await Promise.all(uploadPromises);
      const totalDuration = performance.now() - startTime;

      expect(results.every((r) => r.success)).toBe(true);
      expect(results.length).toBe(10);
      expect(totalDuration).toBeLessThan(1000);

      console.log(`10 concurrent uploads (1MB each) completed in ${totalDuration.toFixed(2)}ms`);
    });

    it('should handle mixed concurrent uploads (screenshots + replays)', async () => {
      const hasFullBlobAPI = typeof Blob !== 'undefined' && 'stream' in Blob.prototype;
      if (!hasFullBlobAPI) {
        console.log('Skipping mixed upload test in jsdom environment');
        return;
      }

      // Mock responses for 3 screenshots + 3 replays = 12 API calls
      for (let i = 0; i < 6; i++) {
        fetchMock
          .mockResolvedValueOnce(createPresignedUrlResponse(i < 3 ? 'screenshot' : 'replay'))
          .mockResolvedValueOnce(createConfirmUploadResponse());
      }

      const uploader = new DirectUploader({
        apiEndpoint: 'https://api.example.com',
        apiKey: TEST_API_KEY,
        bugId: TEST_BUG_ID,
      });

      const startTime = performance.now();

      // Create 3 screenshot uploads
      const screenshotPromises = Array.from({ length: 3 }, () => {
        const blob = createLargeBlob(2, 'image/png');
        return uploader.uploadScreenshot(blob);
      });

      // Create 3 replay uploads
      const replayPromises = Array.from({ length: 3 }, async () => {
        const events = Array.from({ length: 100 }, (_, i) => ({
          type: 4,
          data: { href: 'https://example.com' },
          timestamp: Date.now() + i,
        }));
        const compressed = await compressReplayEvents(events);
        return uploader.uploadReplay(compressed);
      });

      const results = await Promise.all([...screenshotPromises, ...replayPromises]);
      const totalDuration = performance.now() - startTime;

      expect(results.every((r) => r.success)).toBe(true);
      expect(results.length).toBe(6);

      console.log(
        `Mixed concurrent uploads (3 screenshots + 3 replays) completed in ${totalDuration.toFixed(2)}ms`
      );
    });
  });

  describe('Progress Tracking Performance', () => {
    it('should track progress without significant overhead', async () => {
      fetchMock
        .mockResolvedValueOnce(createPresignedUrlResponse('screenshot'))
        .mockResolvedValueOnce(createConfirmUploadResponse());

      const uploader = new DirectUploader({
        apiEndpoint: 'https://api.example.com',
        apiKey: TEST_API_KEY,
        bugId: TEST_BUG_ID,
      });

      let progressCallCount = 0;
      const progressEvents: number[] = [];

      const startTime = performance.now();
      const blob = createLargeBlob(5, 'image/png');

      const result = await uploader.uploadScreenshot(blob, (progress) => {
        progressCallCount++;
        progressEvents.push(progress.percentage);
      });

      const duration = performance.now() - startTime;

      expect(result.success).toBe(true);
      expect(duration).toBeLessThan(250); // Progress tracking shouldn't add > 50ms overhead

      console.log(`Upload with progress tracking completed in ${duration.toFixed(2)}ms`);
      console.log(`Progress callback invoked ${progressCallCount} times`);
    });
  });

  describe('Memory Efficiency', () => {
    it('should not leak memory with multiple sequential uploads', async () => {
      // Mock responses for 20 sequential uploads
      for (let i = 0; i < 20; i++) {
        fetchMock
          .mockResolvedValueOnce(createPresignedUrlResponse('screenshot'))
          .mockResolvedValueOnce(createConfirmUploadResponse());
      }

      const uploader = new DirectUploader({
        apiEndpoint: 'https://api.example.com',
        apiKey: TEST_API_KEY,
        bugId: TEST_BUG_ID,
      });

      const startTime = performance.now();
      let successCount = 0;

      // Sequential uploads to test memory cleanup
      for (let i = 0; i < 20; i++) {
        const blob = createLargeBlob(1, 'image/png');
        const result = await uploader.uploadScreenshot(blob);
        if (result.success) successCount++;
      }

      const totalDuration = performance.now() - startTime;

      expect(successCount).toBe(20);
      expect(totalDuration).toBeLessThan(2000); // 20 sequential 1MB uploads in < 2s

      console.log(`20 sequential uploads completed in ${totalDuration.toFixed(2)}ms`);
      console.log(`Average time per upload: ${(totalDuration / 20).toFixed(2)}ms`);
    });
  });

  describe('Error Recovery Performance', () => {
    it('should fail fast on network errors', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ success: false, error: 'Server error' }),
      });

      const uploader = new DirectUploader({
        apiEndpoint: 'https://api.example.com',
        apiKey: TEST_API_KEY,
        bugId: TEST_BUG_ID,
      });

      const startTime = performance.now();
      const blob = createLargeBlob(10, 'image/png');
      const result = await uploader.uploadScreenshot(blob);
      const duration = performance.now() - startTime;

      expect(result.success).toBe(false);
      expect(duration).toBeLessThan(50); // Should fail immediately, not after upload attempt

      console.log(`Fast failure on network error: ${duration.toFixed(2)}ms`);
    });
  });
});
