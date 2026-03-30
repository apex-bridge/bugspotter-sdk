/**
 * DirectUploader
 * Handles direct client-to-storage uploads using presigned URLs
 */

export interface DirectUploadConfig {
  apiEndpoint: string;
  apiKey: string;
  bugId: string;
}

export interface UploadProgress {
  loaded: number;
  total: number;
  percentage: number;
}

export type UploadProgressCallback = (progress: UploadProgress) => void;

export interface UploadResult {
  success: boolean;
  storageKey?: string;
  error?: string;
}

/**
 * DirectUploader handles uploading files directly to storage using presigned URLs
 * This bypasses the API server for file data, reducing memory usage and improving performance
 */
export class DirectUploader {
  private readonly config: DirectUploadConfig;

  constructor(config: DirectUploadConfig) {
    this.config = config;
  }

  /**
   * Upload a screenshot file directly to storage
   * @param file - Screenshot file or Blob
   * @param onProgress - Optional progress callback
   * @returns Upload result with storage key
   */
  async uploadScreenshot(
    file: File | Blob,
    onProgress?: UploadProgressCallback
  ): Promise<UploadResult> {
    return this.uploadFile(file, 'screenshot', 'screenshot.png', onProgress);
  }

  /**
   * Upload a compressed session replay directly to storage
   * @param compressedData - Gzip-compressed replay data
   * @param onProgress - Optional progress callback
   * @returns Upload result with storage key
   */
  async uploadReplay(
    compressedData: Blob,
    onProgress?: UploadProgressCallback
  ): Promise<UploadResult> {
    return this.uploadFile(compressedData, 'replay', 'replay.gz', onProgress);
  }

  /**
   * Upload an attachment file directly to storage
   * @param file - Attachment file
   * @param onProgress - Optional progress callback
   * @returns Upload result with storage key
   */
  async uploadAttachment(
    file: File,
    onProgress?: UploadProgressCallback
  ): Promise<UploadResult> {
    return this.uploadFile(file, 'attachment', file.name, onProgress);
  }

  /**
   * Generic file upload method
   * 1. Request presigned URL from API
   * 2. Upload file directly to storage using presigned URL
   * 3. Confirm upload with API
   */
  private async uploadFile(
    file: File | Blob,
    fileType: 'screenshot' | 'replay' | 'attachment',
    filename: string,
    onProgress?: UploadProgressCallback
  ): Promise<UploadResult> {
    try {
      // Step 1: Get presigned upload URL
      const presignedUrlResponse = await this.requestPresignedUrl(
        fileType,
        filename
      );

      if (!presignedUrlResponse.success) {
        return {
          success: false,
          error: presignedUrlResponse.error || 'Failed to get presigned URL',
        };
      }

      const { uploadUrl, storageKey } = presignedUrlResponse.data!;

      // Step 2: Upload file to storage using presigned URL
      const uploadSuccess = await this.uploadToStorage(
        uploadUrl,
        file,
        onProgress
      );

      if (!uploadSuccess) {
        return {
          success: false,
          error: 'Failed to upload file to storage',
        };
      }

      // Step 3: Confirm upload with API
      const confirmSuccess = await this.confirmUpload(fileType);

      if (!confirmSuccess) {
        return {
          success: false,
          error: 'Failed to confirm upload',
        };
      }

      return {
        success: true,
        storageKey,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Request a presigned URL from the API
   */
  private async requestPresignedUrl(
    fileType: 'screenshot' | 'replay' | 'attachment',
    filename: string
  ): Promise<{
    success: boolean;
    data?: { uploadUrl: string; storageKey: string };
    error?: string;
  }> {
    try {
      const response = await fetch(
        `${this.config.apiEndpoint}/api/v1/uploads/presigned-url`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.config.apiKey,
          },
          body: JSON.stringify({
            bugId: this.config.bugId,
            fileType,
            filename,
          }),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        return {
          success: false,
          error: `HTTP ${response.status}: ${errorText}`,
        };
      }

      const result = await response.json();
      return {
        success: result.success,
        data: result.data,
        error: result.error,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Network error',
      };
    }
  }

  /**
   * Upload file to storage using presigned URL
   * Uses XMLHttpRequest for progress tracking
   */
  private async uploadToStorage(
    uploadUrl: string,
    file: File | Blob,
    onProgress?: UploadProgressCallback
  ): Promise<boolean> {
    // Convert File/Blob to ArrayBuffer to prevent browser from auto-setting Content-Type header
    // This is critical for CORS compatibility with B2/S3 presigned URLs
    const arrayBuffer = await this.fileToArrayBuffer(file);

    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();

      // Track upload progress
      if (onProgress) {
        xhr.upload.addEventListener('progress', (event) => {
          if (event.lengthComputable) {
            onProgress({
              loaded: event.loaded,
              total: event.total,
              percentage: Math.round((event.loaded / event.total) * 100),
            });
          }
        });
      }

      // Handle completion
      xhr.addEventListener('load', () => {
        resolve(xhr.status >= 200 && xhr.status < 300);
      });

      // Handle errors
      xhr.addEventListener('error', () => {
        resolve(false);
      });

      xhr.addEventListener('abort', () => {
        resolve(false);
      });

      // Send file as ArrayBuffer (no Content-Type header)
      // The presigned URL signature does NOT include Content-Type
      xhr.open('PUT', uploadUrl);
      xhr.send(arrayBuffer);
    });
  }

  /**
   * Convert File/Blob to ArrayBuffer
   */
  private fileToArrayBuffer(file: File | Blob): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        resolve(reader.result as ArrayBuffer);
      };
      reader.onerror = () => {
        reject(new Error('Failed to read file'));
      };
      reader.readAsArrayBuffer(file);
    });
  }

  /**
   * Confirm successful upload with the API
   */
  private async confirmUpload(
    fileType: 'screenshot' | 'replay' | 'attachment'
  ): Promise<boolean> {
    try {
      const response = await fetch(
        `${this.config.apiEndpoint}/api/v1/reports/${this.config.bugId}/confirm-upload`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.config.apiKey,
          },
          body: JSON.stringify({
            fileType,
          }),
        }
      );

      return response.ok;
    } catch {
      return false;
    }
  }
}
