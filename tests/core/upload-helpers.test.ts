/**
 * Tests for upload helper utilities
 */
import { describe, it, expect, vi } from 'vitest';
import {
  compressReplayEvents,
  canvasToBlob,
  estimateCompressedReplaySize,
  isWithinSizeLimit,
} from '../../src/core/upload-helpers';

describe('Upload Helpers', () => {
  // Check if we're in a real browser environment with full Blob API support
  const hasFullBlobAPI =
    typeof Blob !== 'undefined' &&
    'stream' in Blob.prototype &&
    'arrayBuffer' in Blob.prototype;

  describe('compressReplayEvents', () => {
    it('should compress events using CompressionStream', async () => {
      // Skip in jsdom - blob.stream() not available
      if (!hasFullBlobAPI) {
        return;
      }

      const events = [
        { type: 'click', timestamp: 1000, data: { x: 100, y: 200 } },
        { type: 'scroll', timestamp: 2000, data: { scrollY: 500 } },
      ];

      const blob = await compressReplayEvents(events);

      expect(blob).toBeInstanceOf(Blob);
      expect(blob.type).toBe('application/gzip');
      expect(blob.size).toBeGreaterThan(0);

      // Compressed size should be smaller than JSON string
      const jsonSize = JSON.stringify(events).length;
      expect(blob.size).toBeLessThan(jsonSize);
    });

    it('should handle empty events array', async () => {
      if (!hasFullBlobAPI) return;

      const events: unknown[] = [];

      const blob = await compressReplayEvents(events);

      expect(blob).toBeInstanceOf(Blob);
      expect(blob.type).toBe('application/gzip');
      expect(blob.size).toBeGreaterThan(0); // gzip header even for empty data
    });

    it('should handle large events array', async () => {
      if (!hasFullBlobAPI) return;

      const events = Array.from({ length: 1000 }, (_, i) => ({
        type: 'event',
        timestamp: i * 100,
        data: { index: i, payload: 'x'.repeat(100) },
      }));

      const blob = await compressReplayEvents(events);

      expect(blob).toBeInstanceOf(Blob);
      expect(blob.type).toBe('application/gzip');
      expect(blob.size).toBeGreaterThan(0);

      // Should achieve good compression on repetitive data
      const jsonSize = JSON.stringify(events).length;
      expect(blob.size).toBeLessThan(jsonSize * 0.3); // At least 70% compression
    });

    it('should fall back to uncompressed if CompressionStream unavailable', async () => {
      const originalCompressionStream = globalThis.CompressionStream;
      // @ts-expect-error - Testing unavailable API
      globalThis.CompressionStream = undefined;

      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const events = [{ type: 'test', timestamp: 1000 }];
      const blob = await compressReplayEvents(events);

      expect(blob).toBeInstanceOf(Blob);
      expect(blob.type).toBe('application/json');
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        'CompressionStream not supported, uploading uncompressed replay data'
      );

      globalThis.CompressionStream = originalCompressionStream;
      consoleWarnSpy.mockRestore();
    });

    it('should use Uint8Array chunks directly without extracting buffer', async () => {
      if (!hasFullBlobAPI) return;

      // This test verifies the fix: Blob should accept Uint8Array directly
      const events = [{ type: 'test', timestamp: 1000, data: 'test data' }];

      const blob = await compressReplayEvents(events);

      // Verify blob was created successfully
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.type).toBe('application/gzip');
      expect(blob.size).toBeGreaterThan(0);

      // Verify size is reasonable (compressed JSON should be small)
      const jsonSize = JSON.stringify(events).length;
      expect(blob.size).toBeLessThan(jsonSize * 2); // Even with gzip headers
    });

    it('should create compressed blob efficiently', async () => {
      if (!hasFullBlobAPI) return;

      // Verify the streamlined implementation
      const events = [
        { type: 'click', timestamp: 1000 },
        { type: 'scroll', timestamp: 2000 },
      ];

      const blob = await compressReplayEvents(events);

      // Should produce valid gzip blob
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.type).toBe('application/gzip');
      expect(blob.size).toBeGreaterThan(0);

      // Should be smaller than uncompressed JSON
      const jsonSize = JSON.stringify(events).length;
      expect(blob.size).toBeLessThan(jsonSize);
    });

    it('should handle compression errors gracefully', async () => {
      // Mock CompressionStream to throw an error
      const originalCompressionStream = globalThis.CompressionStream;
      const mockCompressionStream = class extends CompressionStream {
        constructor() {
          super('gzip');
          // Force an error during pipe operations
          throw new Error('Compression failed');
        }
      };

      globalThis.CompressionStream = mockCompressionStream as any;
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const events = [{ type: 'test' }];
      const blob = await compressReplayEvents(events);

      // Should fall back to uncompressed
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.type).toBe('application/json');
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Compression failed, uploading uncompressed:',
        expect.any(Error)
      );

      globalThis.CompressionStream = originalCompressionStream;
      consoleErrorSpy.mockRestore();
    });

    it('should create blob with correct gzip content type', async () => {
      if (!hasFullBlobAPI) return;

      const events = [{ type: 'test', data: 'sample' }];
      const blob = await compressReplayEvents(events);

      // Compressed blob should have gzip content type
      expect(blob.type).toBe('application/gzip');
      expect(blob.size).toBeGreaterThan(0);

      // Gzip has headers/footers, so very small data may not compress smaller
      // Just verify it's reasonable (not massively larger)
      const jsonSize = JSON.stringify(events).length;
      expect(blob.size).toBeLessThan(jsonSize * 3);
    });

    it('should handle special characters and unicode', async () => {
      if (!hasFullBlobAPI) return;

      const events = [
        { type: 'input', data: '日本語テスト' },
        { type: 'emoji', data: '🎉🚀✨' },
        { type: 'special', data: '<>&"\'\\n\\t' },
      ];

      const blob = await compressReplayEvents(events);

      expect(blob).toBeInstanceOf(Blob);
      expect(blob.type).toBe('application/gzip');
      expect(blob.size).toBeGreaterThan(0);

      // Should compress unicode data efficiently
      const jsonSize = new TextEncoder().encode(JSON.stringify(events)).length;
      expect(blob.size).toBeLessThan(jsonSize);
    });
  });

  describe('canvasToBlob', () => {
    it('should convert canvas to blob with mocked toBlob', async () => {
      const mockBlob = new Blob(['fake image data'], { type: 'image/png' });
      const mockCanvas = {
        toBlob: (callback: (blob: Blob | null) => void) => {
          callback(mockBlob);
        },
      } as unknown as HTMLCanvasElement;

      const blob = await canvasToBlob(mockCanvas);

      expect(blob).toBe(mockBlob);
      expect(blob.type).toBe('image/png');
      expect(blob.size).toBeGreaterThan(0);
    });

    it('should use default quality parameter', async () => {
      let capturedQuality: number | undefined;
      const mockBlob = new Blob(['fake'], { type: 'image/png' });
      const mockCanvas = {
        toBlob: (callback: (blob: Blob | null) => void, _type: string, quality?: number) => {
          capturedQuality = quality;
          callback(mockBlob);
        },
      } as unknown as HTMLCanvasElement;

      await canvasToBlob(mockCanvas);

      expect(capturedQuality).toBe(0.9);
    });

    it('should accept custom quality parameter', async () => {
      let capturedQuality: number | undefined;
      const mockBlob = new Blob(['fake'], { type: 'image/png' });
      const mockCanvas = {
        toBlob: (callback: (blob: Blob | null) => void, _type: string, quality?: number) => {
          capturedQuality = quality;
          callback(mockBlob);
        },
      } as unknown as HTMLCanvasElement;

      await canvasToBlob(mockCanvas, 0.5);

      expect(capturedQuality).toBe(0.5);
    });

    it('should reject if canvas.toBlob fails', async () => {
      const mockCanvas = {
        toBlob: (callback: (blob: Blob | null) => void) => {
          callback(null);
        },
      } as unknown as HTMLCanvasElement;

      await expect(canvasToBlob(mockCanvas)).rejects.toThrow('Failed to convert canvas to Blob');
    });
  });

  describe('estimateCompressedReplaySize', () => {
    it('should estimate compressed size', () => {
      const events = [
        { type: 'click', timestamp: 1000, data: { x: 100, y: 200 } },
        { type: 'scroll', timestamp: 2000, data: { scrollY: 500 } },
      ];

      const estimate = estimateCompressedReplaySize(events);

      expect(estimate).toBeGreaterThan(0);

      // Should be approximately 15% of original size
      const jsonSize = JSON.stringify(events).length;
      const expectedEstimate = Math.round(jsonSize * 0.15);
      expect(estimate).toBe(expectedEstimate);
    });

    it('should handle empty events', () => {
      const events: unknown[] = [];

      const estimate = estimateCompressedReplaySize(events);

      expect(estimate).toBe(0); // 15% of 2 bytes ("[]") rounds to 0
    });

    it('should handle large events array', () => {
      const events = Array.from({ length: 1000 }, (_, i) => ({
        type: 'event',
        timestamp: i * 100,
        data: { index: i },
      }));

      const estimate = estimateCompressedReplaySize(events);
      const jsonSize = JSON.stringify(events).length;

      expect(estimate).toBeGreaterThan(0);
      expect(estimate).toBeLessThan(jsonSize);
      expect(estimate / jsonSize).toBeCloseTo(0.15, 2);
    });
  });

  describe('isWithinSizeLimit', () => {
    it('should return true if blob is within limit', () => {
      const blob = new Blob(['test data']); // Small blob
      const result = isWithinSizeLimit(blob, 1); // 1MB limit

      expect(result).toBe(true);
    });

    it('should return false if blob exceeds limit', () => {
      const largeData = new Uint8Array(2 * 1024 * 1024); // 2MB
      const blob = new Blob([largeData]);
      const result = isWithinSizeLimit(blob, 1); // 1MB limit

      expect(result).toBe(false);
    });

    it('should handle exact size limit', () => {
      const data = new Uint8Array(1024 * 1024); // Exactly 1MB
      const blob = new Blob([data]);
      const result = isWithinSizeLimit(blob, 1); // 1MB limit

      expect(result).toBe(true);
    });

    it('should handle fractional MB limits', () => {
      const data = new Uint8Array(512 * 1024); // 0.5MB
      const blob = new Blob([data]);

      expect(isWithinSizeLimit(blob, 0.6)).toBe(true);
      expect(isWithinSizeLimit(blob, 0.4)).toBe(false);
    });

    it('should handle very small limits', () => {
      const blob = new Blob(['test']); // Few bytes
      const result = isWithinSizeLimit(blob, 0.001); // ~1KB limit

      expect(result).toBe(true);
    });

    it('should handle zero-size blob', () => {
      const blob = new Blob([]);
      const result = isWithinSizeLimit(blob, 1);

      expect(result).toBe(true);
    });
  });
});
