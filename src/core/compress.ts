import pako from 'pako';
import { getLogger } from '../utils/logger';

/**
 * Compression utilities for BugSpotter SDK
 * Handles payload and image compression using browser-native APIs
 */

const logger = getLogger();

// Configuration constants
const COMPRESSION_DEFAULTS = {
  GZIP_LEVEL: 6, // Balanced speed/size ratio (0-9)
  IMAGE_MAX_WIDTH: 2560, // Increased from 1920 to support 2K displays
  IMAGE_MAX_HEIGHT: 1440, // Increased from 1080 to support 2K displays
  IMAGE_WEBP_QUALITY: 0.92, // Increased from 0.8 for better detail preservation
  IMAGE_JPEG_QUALITY: 0.92, // Increased from 0.85 for better fallback quality
  IMAGE_LOAD_TIMEOUT: 3000, // milliseconds
} as const;

// Compression configuration type
export interface CompressionConfig {
  gzipLevel?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | -1; // -1 = default compression
  imageMaxWidth?: number;
  imageMaxHeight?: number;
  webpQuality?: number;
  jpegQuality?: number;
  verbose?: boolean;
}

// Singleton instances for performance
let textEncoder: TextEncoder | null = null;
let textDecoder: TextDecoder | null = null;
let webpSupportCache: boolean | null = null;

/**
 * Get or create TextEncoder instance
 */
function getTextEncoder(): TextEncoder {
  if (!textEncoder) {
    textEncoder = new TextEncoder();
  }
  return textEncoder;
}

/**
 * Get or create TextDecoder instance
 */
function getTextDecoder(): TextDecoder {
  if (!textDecoder) {
    textDecoder = new TextDecoder();
  }
  return textDecoder;
}

/**
 * Convert data to string representation
 */
function dataToString(data: unknown): string {
  return typeof data === 'string' ? data : JSON.stringify(data);
}

/**
 * Compress JSON or string data using gzip
 * @param data - Data to compress (will be JSON stringified if object)
 * @param config - Optional compression configuration
 * @returns Compressed data as Uint8Array
 */
export async function compressData(
  data: unknown,
  config?: CompressionConfig
): Promise<Uint8Array> {
  try {
    const jsonString = dataToString(data);
    const encoder = getTextEncoder();
    const uint8Data = encoder.encode(jsonString);

    const gzipLevel = config?.gzipLevel ?? COMPRESSION_DEFAULTS.GZIP_LEVEL;

    // pako.gzip already returns Uint8Array, no need to wrap it
    const compressed = pako.gzip(uint8Data, { level: gzipLevel });
    return compressed;
  } catch (error) {
    logger.error('Compression failed:', error);
    throw error;
  }
}

/**
 * Try to parse string as JSON, return string if not valid JSON
 */
function tryParseJSON(jsonString: string): unknown {
  try {
    return JSON.parse(jsonString);
  } catch {
    return jsonString;
  }
}

/**
 * Decompress gzipped data back to original format
 * Useful for testing and verification
 * @param compressed - Compressed Uint8Array data
 * @param config - Optional configuration
 * @returns Decompressed and parsed data (or string if input was string)
 */
export function decompressData(
  compressed: Uint8Array,
  config?: Pick<CompressionConfig, 'verbose'>
): unknown {
  try {
    const decompressed = pako.ungzip(compressed);
    const decoder = getTextDecoder();
    const jsonString = decoder.decode(decompressed);

    return tryParseJSON(jsonString);
  } catch (error) {
    if (config?.verbose !== false) {
      getLogger().error('Decompression failed:', error);
    }
    throw new Error(
      `Failed to decompress data: ${error instanceof Error ? error.message : 'Unknown error'}`,
      { cause: error }
    );
  }
}

/**
 * Check if code is running in browser environment
 */
function isBrowserEnvironment(): boolean {
  return (
    typeof document !== 'undefined' &&
    typeof Image !== 'undefined' &&
    typeof HTMLCanvasElement !== 'undefined'
  );
}

/**
 * Check if browser supports WebP format (cached result)
 */
function supportsWebP(): boolean {
  if (webpSupportCache !== null) {
    return webpSupportCache;
  }

  if (!isBrowserEnvironment()) {
    webpSupportCache = false;
    return false;
  }

  try {
    const canvas = document.createElement('canvas');
    webpSupportCache =
      canvas.toDataURL('image/webp').indexOf('data:image/webp') === 0;
  } catch {
    webpSupportCache = false;
  }

  return webpSupportCache;
}

/**
 * Load image from base64 string with timeout
 */
function loadImage(base64: string, timeout: number): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timer = setTimeout(() => {
      reject(new Error(`Image load timeout after ${timeout}ms`));
    }, timeout);

    img.onload = () => {
      clearTimeout(timer);
      resolve(img);
    };

    img.onerror = () => {
      clearTimeout(timer);
      reject(new Error('Failed to load image'));
    };

    img.src = base64;
  });
}

/**
 * Calculate resized dimensions maintaining aspect ratio
 */
function calculateResizedDimensions(
  width: number,
  height: number,
  maxWidth: number,
  maxHeight: number
): { width: number; height: number } {
  let newWidth = width;
  let newHeight = height;

  if (newWidth > maxWidth) {
    newHeight = (newHeight * maxWidth) / newWidth;
    newWidth = maxWidth;
  }

  if (newHeight > maxHeight) {
    newWidth = (newWidth * maxHeight) / newHeight;
    newHeight = maxHeight;
  }

  return { width: newWidth, height: newHeight };
}

/**
 * Optimize and compress screenshot image
 * Converts to WebP if supported, resizes if too large, then compresses
 * @param base64 - Base64 encoded image (PNG or other format)
 * @param config - Optional compression configuration
 * @returns Optimized base64 image string
 */
export async function compressImage(
  base64: string,
  config?: CompressionConfig
): Promise<string> {
  try {
    if (!isBrowserEnvironment()) {
      return base64;
    }

    const maxWidth =
      config?.imageMaxWidth ?? COMPRESSION_DEFAULTS.IMAGE_MAX_WIDTH;
    const maxHeight =
      config?.imageMaxHeight ?? COMPRESSION_DEFAULTS.IMAGE_MAX_HEIGHT;
    const webpQuality =
      config?.webpQuality ?? COMPRESSION_DEFAULTS.IMAGE_WEBP_QUALITY;
    const jpegQuality =
      config?.jpegQuality ?? COMPRESSION_DEFAULTS.IMAGE_JPEG_QUALITY;
    const timeout = COMPRESSION_DEFAULTS.IMAGE_LOAD_TIMEOUT;

    const img = await loadImage(base64, timeout);

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to get 2D canvas context');
    }

    const { width, height } = calculateResizedDimensions(
      img.width,
      img.height,
      maxWidth,
      maxHeight
    );

    canvas.width = width;
    canvas.height = height;

    // Enable high-quality image smoothing for better resize quality
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    ctx.drawImage(img, 0, 0, width, height);

    if (supportsWebP()) {
      return canvas.toDataURL('image/webp', webpQuality);
    } else {
      return canvas.toDataURL('image/jpeg', jpegQuality);
    }
  } catch (error) {
    if (config?.verbose !== false) {
      getLogger().error('Image compression failed:', error);
    }
    return base64;
  }
}

/**
 * Calculate compression ratio for analytics
 * @param originalSize - Original data size in bytes
 * @param compressedSize - Compressed data size in bytes
 * @returns Compression ratio as percentage (0-100)
 */
export function getCompressionRatio(
  originalSize: number,
  compressedSize: number
): number {
  if (originalSize <= 0) {
    return 0;
  }
  return Math.round((1 - compressedSize / originalSize) * 100);
}

/**
 * Estimate payload size before compression
 * @param data - Data to estimate
 * @returns Estimated size in bytes
 */
export function estimateSize(data: unknown): number {
  const jsonString = dataToString(data);
  return getTextEncoder().encode(jsonString).length;
}

/**
 * Reset cached instances (useful for testing)
 * @internal
 */
export function resetCompressionCache(): void {
  textEncoder = null;
  textDecoder = null;
  webpSupportCache = null;
}
