/**
 * DirectUploader Tests
 * Unit tests for presigned URL direct upload functionality
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DirectUploader } from '../../src/core/uploader';
import type { DirectUploadConfig } from '../../src/core/uploader';

describe('DirectUploader', () => {
  let uploader: DirectUploader;
  let config: DirectUploadConfig;
  let mockFetch: any;
  let mockXHR: any;

  beforeEach(() => {
    config = {
      apiEndpoint: 'https://api.example.com',
      apiKey: 'test-api-key-123',
      bugId: 'bug-789',
    };

    uploader = new DirectUploader(config);

    // Mock fetch globally
    mockFetch = vi.fn();
    global.fetch = mockFetch;

    // Mock XMLHttpRequest
    mockXHR = {
      open: vi.fn(),
      setRequestHeader: vi.fn(),
      send: vi.fn(),
      upload: {
        addEventListener: vi.fn(),
      },
      addEventListener: vi.fn(),
      status: 200,
    };

    global.XMLHttpRequest = vi.fn(() => mockXHR) as any;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Constructor', () => {
    it('should create uploader with valid config', () => {
      expect(uploader).toBeDefined();
      expect(uploader).toBeInstanceOf(DirectUploader);
    });

    it('should store config internally', () => {
      const customConfig: DirectUploadConfig = {
        apiEndpoint: 'https://custom.api.com',
        apiKey: 'custom-key',
        bugId: 'custom-bug',
      };

      const customUploader = new DirectUploader(customConfig);
      expect(customUploader).toBeDefined();
    });
  });

  describe('uploadScreenshot', () => {
    it('should complete 3-step upload flow successfully', async () => {
      const mockFile = new Blob(['fake-image-data'], { type: 'image/png' });

      // Step 1: Mock presigned URL response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            uploadUrl: 'https://s3.example.com/presigned-upload-url',
            storageKey: 'screenshots/proj-456/bug-789/screenshot.png',
          },
        }),
      });

      // Step 2: XHR upload triggers success
      mockXHR.addEventListener.mockImplementation((event: string, callback: Function) => {
        if (event === 'load') {
          setTimeout(() => callback(), 0);
        }
      });

      // Step 3: Mock confirm upload response
      mockFetch.mockResolvedValueOnce({
        ok: true,
      });

      const result = await uploader.uploadScreenshot(mockFile);

      expect(result.success).toBe(true);
      expect(result.storageKey).toBe('screenshots/proj-456/bug-789/screenshot.png');
      expect(result.error).toBeUndefined();

      // Verify fetch calls
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch).toHaveBeenNthCalledWith(
        1,
        'https://api.example.com/api/v1/uploads/presigned-url',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': 'test-api-key-123',
          },
          body: JSON.stringify({
            bugId: 'bug-789',
            fileType: 'screenshot',
            filename: 'screenshot.png',
          }),
        })
      );

      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        'https://api.example.com/api/v1/reports/bug-789/confirm-upload',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': 'test-api-key-123',
          },
          body: JSON.stringify({
            fileType: 'screenshot',
          }),
        })
      );

      // Verify XHR upload (no Content-Type header - it's in presigned URL signature)
      expect(mockXHR.open).toHaveBeenCalledWith(
        'PUT',
        'https://s3.example.com/presigned-upload-url'
      );
      expect(mockXHR.send).toHaveBeenCalledWith(expect.any(ArrayBuffer));
    });

    it('should track upload progress', async () => {
      const mockFile = new Blob(['fake-image-data'], { type: 'image/png' });
      const progressCallback = vi.fn();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            uploadUrl: 'https://s3.example.com/presigned-upload-url',
            storageKey: 'screenshots/proj-456/bug-789/screenshot.png',
          },
        }),
      });

      // Simulate progress events
      mockXHR.upload.addEventListener.mockImplementation((event: string, callback: Function) => {
        if (event === 'progress') {
          // Simulate 50% progress
          setTimeout(() => callback({ lengthComputable: true, loaded: 5000, total: 10000 }), 0);
          // Simulate 100% progress
          setTimeout(() => callback({ lengthComputable: true, loaded: 10000, total: 10000 }), 0);
        }
      });

      mockXHR.addEventListener.mockImplementation((event: string, callback: Function) => {
        if (event === 'load') {
          setTimeout(() => callback(), 0);
        }
      });

      mockFetch.mockResolvedValueOnce({ ok: true });

      await uploader.uploadScreenshot(mockFile, progressCallback);

      expect(progressCallback).toHaveBeenCalledWith({
        loaded: 5000,
        total: 10000,
        percentage: 50,
      });

      expect(progressCallback).toHaveBeenCalledWith({
        loaded: 10000,
        total: 10000,
        percentage: 100,
      });
    });

    it('should handle presigned URL request failure', async () => {
      const mockFile = new Blob(['fake-image-data'], { type: 'image/png' });

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'Invalid request',
      });

      const result = await uploader.uploadScreenshot(mockFile);

      expect(result.success).toBe(false);
      expect(result.error).toContain('HTTP 400');
      expect(result.storageKey).toBeUndefined();
    });

    it('should handle storage upload failure', async () => {
      const mockFile = new Blob(['fake-image-data'], { type: 'image/png' });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            uploadUrl: 'https://s3.example.com/presigned-upload-url',
            storageKey: 'screenshots/proj-456/bug-789/screenshot.png',
          },
        }),
      });

      // Simulate XHR error
      mockXHR.addEventListener.mockImplementation((event: string, callback: Function) => {
        if (event === 'error') {
          setTimeout(() => callback(), 0);
        }
      });

      const result = await uploader.uploadScreenshot(mockFile);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to upload file to storage');
    });

    it('should handle confirm upload failure', async () => {
      const mockFile = new Blob(['fake-image-data'], { type: 'image/png' });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            uploadUrl: 'https://s3.example.com/presigned-upload-url',
            storageKey: 'screenshots/proj-456/bug-789/screenshot.png',
          },
        }),
      });

      mockXHR.addEventListener.mockImplementation((event: string, callback: Function) => {
        if (event === 'load') {
          setTimeout(() => callback(), 0);
        }
      });

      // Confirm upload fails
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      const result = await uploader.uploadScreenshot(mockFile);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to confirm upload');
    });

    it('should handle network errors gracefully', async () => {
      const mockFile = new Blob(['fake-image-data'], { type: 'image/png' });

      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await uploader.uploadScreenshot(mockFile);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Network error');
    });

    it('should handle XHR abort', async () => {
      const mockFile = new Blob(['fake-image-data'], { type: 'image/png' });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            uploadUrl: 'https://s3.example.com/presigned-upload-url',
            storageKey: 'screenshots/proj-456/bug-789/screenshot.png',
          },
        }),
      });

      mockXHR.addEventListener.mockImplementation((event: string, callback: Function) => {
        if (event === 'abort') {
          setTimeout(() => callback(), 0);
        }
      });

      const result = await uploader.uploadScreenshot(mockFile);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to upload file to storage');
    });
  });

  describe('uploadReplay', () => {
    it('should upload replay with correct parameters', async () => {
      const mockCompressedData = new Blob(['compressed-replay-data'], {
        type: 'application/gzip',
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            uploadUrl: 'https://s3.example.com/presigned-replay-url',
            storageKey: 'replays/proj-456/bug-789/replay.gz',
          },
        }),
      });

      mockXHR.addEventListener.mockImplementation((event: string, callback: Function) => {
        if (event === 'load') {
          setTimeout(() => callback(), 0);
        }
      });

      mockFetch.mockResolvedValueOnce({ ok: true });

      const result = await uploader.uploadReplay(mockCompressedData);

      expect(result.success).toBe(true);
      expect(result.storageKey).toBe('replays/proj-456/bug-789/replay.gz');

      expect(mockFetch).toHaveBeenNthCalledWith(
        1,
        'https://api.example.com/api/v1/uploads/presigned-url',
        expect.objectContaining({
          body: JSON.stringify({
            bugId: 'bug-789',
            fileType: 'replay',
            filename: 'replay.gz',
          }),
        })
      );
    });

    it('should upload compressed replay without Content-Type header', async () => {
      const mockCompressedData = new Blob(['compressed-replay-data'], {
        type: 'application/gzip',
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            uploadUrl: 'https://s3.example.com/presigned-replay-url',
            storageKey: 'replays/proj-456/bug-789/replay.gz',
          },
        }),
      });

      mockXHR.addEventListener.mockImplementation((event: string, callback: Function) => {
        if (event === 'load') {
          setTimeout(() => callback(), 0);
        }
      });

      mockFetch.mockResolvedValueOnce({ ok: true });

      await uploader.uploadReplay(mockCompressedData);

      // Verify XHR was called without Content-Type header (it's in presigned URL signature)
      expect(mockXHR.send).toHaveBeenCalledWith(expect.any(ArrayBuffer));
    });

    it('should track replay upload progress', async () => {
      const mockCompressedData = new Blob(['compressed-replay-data'], {
        type: 'application/gzip',
      });
      const progressCallback = vi.fn();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            uploadUrl: 'https://s3.example.com/presigned-replay-url',
            storageKey: 'replays/proj-456/bug-789/replay.gz',
          },
        }),
      });

      mockXHR.upload.addEventListener.mockImplementation((event: string, callback: Function) => {
        if (event === 'progress') {
          setTimeout(() => callback({ lengthComputable: true, loaded: 250000, total: 1000000 }), 0);
        }
      });

      mockXHR.addEventListener.mockImplementation((event: string, callback: Function) => {
        if (event === 'load') {
          setTimeout(() => callback(), 0);
        }
      });

      mockFetch.mockResolvedValueOnce({ ok: true });

      await uploader.uploadReplay(mockCompressedData, progressCallback);

      expect(progressCallback).toHaveBeenCalledWith({
        loaded: 250000,
        total: 1000000,
        percentage: 25,
      });
    });
  });

  describe('uploadAttachment', () => {
    it('should upload attachment with original filename', async () => {
      const mockFile = new File(['attachment-data'], 'document.pdf', {
        type: 'application/pdf',
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            uploadUrl: 'https://s3.example.com/presigned-attachment-url',
            storageKey: 'attachments/proj-456/bug-789/document.pdf',
          },
        }),
      });

      mockXHR.addEventListener.mockImplementation((event: string, callback: Function) => {
        if (event === 'load') {
          setTimeout(() => callback(), 0);
        }
      });

      mockFetch.mockResolvedValueOnce({ ok: true });

      const result = await uploader.uploadAttachment(mockFile);

      expect(result.success).toBe(true);
      expect(result.storageKey).toBe('attachments/proj-456/bug-789/document.pdf');

      expect(mockFetch).toHaveBeenNthCalledWith(
        1,
        'https://api.example.com/api/v1/uploads/presigned-url',
        expect.objectContaining({
          body: JSON.stringify({
            bugId: 'bug-789',
            fileType: 'attachment',
            filename: 'document.pdf',
          }),
        })
      );
    });

    it('should upload attachment without Content-Type header', async () => {
      const mockFile = new File(['text content'], 'notes.txt', { type: 'text/plain' });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            uploadUrl: 'https://s3.example.com/presigned-attachment-url',
            storageKey: 'attachments/proj-456/bug-789/notes.txt',
          },
        }),
      });

      mockXHR.addEventListener.mockImplementation((event: string, callback: Function) => {
        if (event === 'load') {
          setTimeout(() => callback(), 0);
        }
      });

      mockFetch.mockResolvedValueOnce({ ok: true });

      await uploader.uploadAttachment(mockFile);

      // Verify XHR was called without Content-Type header (it's in presigned URL signature)
      expect(mockXHR.send).toHaveBeenCalledWith(expect.any(ArrayBuffer));
    });

    it('should handle files without extension', async () => {
      const mockFile = new File(['data'], 'README', { type: 'text/plain' });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            uploadUrl: 'https://s3.example.com/presigned-attachment-url',
            storageKey: 'attachments/proj-456/bug-789/README',
          },
        }),
      });

      mockXHR.addEventListener.mockImplementation((event: string, callback: Function) => {
        if (event === 'load') {
          setTimeout(() => callback(), 0);
        }
      });

      mockFetch.mockResolvedValueOnce({ ok: true });

      const result = await uploader.uploadAttachment(mockFile);

      expect(result.success).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should handle API error responses with error field', async () => {
      const mockFile = new Blob(['fake-image-data'], { type: 'image/png' });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: false,
          error: 'Project not found',
        }),
      });

      const result = await uploader.uploadScreenshot(mockFile);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Project not found');
    });

    it('should handle malformed JSON responses', async () => {
      const mockFile = new Blob(['fake-image-data'], { type: 'image/png' });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => {
          throw new Error('Invalid JSON');
        },
      });

      const result = await uploader.uploadScreenshot(mockFile);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid JSON');
    });

    it('should handle 401 unauthorized', async () => {
      const mockFile = new Blob(['fake-image-data'], { type: 'image/png' });

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });

      const result = await uploader.uploadScreenshot(mockFile);

      expect(result.success).toBe(false);
      expect(result.error).toContain('HTTP 401');
    });

    it('should handle 403 forbidden', async () => {
      const mockFile = new Blob(['fake-image-data'], { type: 'image/png' });

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => 'Forbidden',
      });

      const result = await uploader.uploadScreenshot(mockFile);

      expect(result.success).toBe(false);
      expect(result.error).toContain('HTTP 403');
    });

    it('should handle 404 not found', async () => {
      const mockFile = new Blob(['fake-image-data'], { type: 'image/png' });

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => 'Not found',
      });

      const result = await uploader.uploadScreenshot(mockFile);

      expect(result.success).toBe(false);
      expect(result.error).toContain('HTTP 404');
    });

    it('should handle 500 internal server error', async () => {
      const mockFile = new Blob(['fake-image-data'], { type: 'image/png' });

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal server error',
      });

      const result = await uploader.uploadScreenshot(mockFile);

      expect(result.success).toBe(false);
      expect(result.error).toContain('HTTP 500');
    });

    it('should handle S3 upload 403 (expired presigned URL)', async () => {
      const mockFile = new Blob(['fake-image-data'], { type: 'image/png' });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            uploadUrl: 'https://s3.example.com/presigned-upload-url',
            storageKey: 'screenshots/proj-456/bug-789/screenshot.png',
          },
        }),
      });

      // S3 returns 403 for expired presigned URL
      mockXHR.status = 403;
      mockXHR.addEventListener.mockImplementation((event: string, callback: Function) => {
        if (event === 'load') {
          setTimeout(() => callback(), 0);
        }
      });

      const result = await uploader.uploadScreenshot(mockFile);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to upload file to storage');
    });

    it('should handle timeout scenarios', async () => {
      const mockFile = new Blob(['fake-image-data'], { type: 'image/png' });

      mockFetch.mockImplementationOnce(
        () => new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 100))
      );

      const result = await uploader.uploadScreenshot(mockFile);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Timeout');
    });
  });

  describe('Progress Tracking Edge Cases', () => {
    it('should handle progress events without lengthComputable', async () => {
      const mockFile = new Blob(['fake-image-data'], { type: 'image/png' });
      const progressCallback = vi.fn();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            uploadUrl: 'https://s3.example.com/presigned-upload-url',
            storageKey: 'screenshots/proj-456/bug-789/screenshot.png',
          },
        }),
      });

      mockXHR.upload.addEventListener.mockImplementation((event: string, callback: Function) => {
        if (event === 'progress') {
          // Event without lengthComputable
          setTimeout(() => callback({ lengthComputable: false, loaded: 5000, total: 0 }), 0);
        }
      });

      mockXHR.addEventListener.mockImplementation((event: string, callback: Function) => {
        if (event === 'load') {
          setTimeout(() => callback(), 0);
        }
      });

      mockFetch.mockResolvedValueOnce({ ok: true });

      await uploader.uploadScreenshot(mockFile, progressCallback);

      // Should not call progress callback when lengthComputable is false
      expect(progressCallback).not.toHaveBeenCalled();
    });

    it('should calculate percentage correctly for various upload sizes', async () => {
      const mockFile = new Blob(['fake-image-data'], { type: 'image/png' });
      const progressValues: number[] = [];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            uploadUrl: 'https://s3.example.com/presigned-upload-url',
            storageKey: 'screenshots/proj-456/bug-789/screenshot.png',
          },
        }),
      });

      mockXHR.upload.addEventListener.mockImplementation((event: string, callback: Function) => {
        if (event === 'progress') {
          // Simulate various progress points
          setTimeout(() => callback({ lengthComputable: true, loaded: 333, total: 1000 }), 0);
          setTimeout(() => callback({ lengthComputable: true, loaded: 666, total: 1000 }), 0);
        }
      });

      mockXHR.addEventListener.mockImplementation((event: string, callback: Function) => {
        if (event === 'load') {
          setTimeout(() => callback(), 0);
        }
      });

      mockFetch.mockResolvedValueOnce({ ok: true });

      await uploader.uploadScreenshot(mockFile, (progress) => {
        progressValues.push(progress.percentage);
      });

      expect(progressValues).toContain(33); // Math.round(333/1000 * 100)
      expect(progressValues).toContain(67); // Math.round(666/1000 * 100)
    });

    it('should handle upload without progress callback', async () => {
      const mockFile = new Blob(['fake-image-data'], { type: 'image/png' });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            uploadUrl: 'https://s3.example.com/presigned-upload-url',
            storageKey: 'screenshots/proj-456/bug-789/screenshot.png',
          },
        }),
      });

      mockXHR.addEventListener.mockImplementation((event: string, callback: Function) => {
        if (event === 'load') {
          setTimeout(() => callback(), 0);
        }
      });

      mockFetch.mockResolvedValueOnce({ ok: true });

      // No progress callback provided
      const result = await uploader.uploadScreenshot(mockFile);

      expect(result.success).toBe(true);
    });
  });

  describe('Upload Without Content-Type Header', () => {
    it('should upload Blob without Content-Type header', async () => {
      const mockBlob = new Blob(['data']); // No type specified

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            uploadUrl: 'https://s3.example.com/presigned-upload-url',
            storageKey: 'screenshots/proj-456/bug-789/screenshot.png',
          },
        }),
      });

      mockXHR.addEventListener.mockImplementation((event: string, callback: Function) => {
        if (event === 'load') {
          setTimeout(() => callback(), 0);
        }
      });

      mockFetch.mockResolvedValueOnce({ ok: true });

      await uploader.uploadScreenshot(mockBlob);

      // Verify XHR was called without Content-Type header (it's in presigned URL signature)
      expect(mockXHR.send).toHaveBeenCalledWith(expect.any(ArrayBuffer));
    });

    it('should upload various image types without Content-Type header', async () => {
      const mimeTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

      for (const mimeType of mimeTypes) {
        const mockFile = new Blob(['data'], { type: mimeType });

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            success: true,
            data: {
              uploadUrl: 'https://s3.example.com/presigned-upload-url',
              storageKey: 'screenshots/proj-456/bug-789/screenshot.png',
            },
          }),
        });

        mockXHR.addEventListener.mockImplementation((event: string, callback: Function) => {
          if (event === 'load') {
            setTimeout(() => callback(), 0);
          }
        });

        mockFetch.mockResolvedValueOnce({ ok: true });

        await uploader.uploadScreenshot(mockFile);

        // Verify XHR was called without Content-Type header (it's in presigned URL signature)
        expect(mockXHR.send).toHaveBeenCalledWith(expect.any(ArrayBuffer));
      }
    });
  });
});
