/**
 * Bug Reporter - Handles bug report submission and file uploads
 * @module core/bug-reporter
 */

import type { BugReport, BugReportPayload, BugSpotterConfig } from '../index';
import { getLogger } from '../utils/logger';
import { validateAuthConfig } from '../utils/config-validator';
import { FileUploadHandler } from './file-upload-handler';
import { getApiBaseUrl } from '../utils/url-helpers';
import { BugReportDeduplicator } from '../utils/deduplicator';
import { submitWithAuth } from './transport';

const logger = getLogger();

const TITLE_PREVIEW_LENGTH = 50;

/**
 * Response from bug report creation API
 */
interface BugReportResponse {
  success: boolean;
  data?: {
    id: string;
    presignedUrls?: Record<string, string>;
  };
}

/**
 * Type guard for BugReportResponse
 * Validates the complete response structure including data.id when success is true
 */
function isBugReportResponse(obj: unknown): obj is BugReportResponse {
  if (!obj || typeof obj !== 'object') {
    return false;
  }
  const response = obj as Record<string, unknown>;

  // Must have success property as boolean
  if (!('success' in response) || typeof response.success !== 'boolean') {
    return false;
  }

  // When success is true, data.id must exist
  if (response.success) {
    const data = response.data as Record<string, unknown> | undefined;
    if (
      !data ||
      typeof data !== 'object' ||
      !('id' in data) ||
      typeof data.id !== 'string'
    ) {
      return false;
    }

    // If presignedUrls exists, it must be an object
    if ('presignedUrls' in data && data.presignedUrls !== undefined) {
      if (
        typeof data.presignedUrls !== 'object' ||
        data.presignedUrls === null
      ) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Deduplication context for bug report
 */
export interface DeduplicationContext {
  title: string;
  description: string;
  errorStacks: string[];
}

/**
 * Analysis of files in a bug report
 */
export interface ReportFileAnalysis {
  hasScreenshot: boolean;
  hasReplay: boolean;
  screenshotSize: number;
  replayEventCount: number;
}

/**
 * Extract error stacks from console logs
 */
function extractErrorStacks(report: BugReport): string[] {
  const errorLogs =
    report.console?.filter((log) => log.level === 'error') ?? [];
  return errorLogs.map((log) => log.stack ?? log.message);
}

/**
 * Create deduplication context from bug report payload
 */
function createDeduplicationContext(
  payload: BugReportPayload
): DeduplicationContext {
  return {
    title: payload.title,
    description: payload.description || '',
    errorStacks: extractErrorStacks(payload.report),
  };
}

/**
 * Check if screenshot is valid (must be a data URL for an image)
 */
function hasValidScreenshot(screenshot: string | undefined): boolean {
  return !!screenshot && screenshot.startsWith('data:image/');
}

/**
 * Check if replay is valid
 */
function hasValidReplay(replay: unknown[] | undefined): boolean {
  return !!replay && Array.isArray(replay) && replay.length > 0;
}

/**
 * Analyze files in bug report for upload detection
 */
function analyzeReportFiles(report: BugReport): ReportFileAnalysis {
  return {
    hasScreenshot: hasValidScreenshot(report._screenshotPreview),
    hasReplay: hasValidReplay(report.replay),
    screenshotSize: report._screenshotPreview?.length || 0,
    replayEventCount: report.replay?.length || 0,
  };
}

/**
 * Format submission error message
 */
function formatSubmissionError(context: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${context}: ${message}`;
}

/**
 * Bug Reporter - Handles submission logic, deduplication, and file uploads
 * Follows Single Responsibility Principle - only handles report submission workflow
 */
export class BugReporter {
  private config: BugSpotterConfig;
  private deduplicator: BugReportDeduplicator;

  constructor(config: BugSpotterConfig) {
    this.config = config;
    this.deduplicator = new BugReportDeduplicator(config.deduplication);
  }

  /**
   * Submit a bug report with file uploads via presigned URLs
   */
  async submit(payload: BugReportPayload): Promise<void> {
    const dedupContext = this.validateAndExtractErrors(payload);

    try {
      logger.debug(`Submitting bug report to ${this.config.endpoint}`);
      const bugReportData = await this.createBugReport(payload);
      await this.handleFileUploads(bugReportData, payload, dedupContext);
    } finally {
      // Mark this specific report submission as complete
      this.deduplicator.markComplete(
        dedupContext.title,
        dedupContext.description,
        dedupContext.errorStacks
      );
    }
  }

  /**
   * Validate submission and extract deduplication context
   * @private
   */
  private validateAndExtractErrors(
    payload: BugReportPayload
  ): DeduplicationContext {
    validateAuthConfig({
      endpoint: this.config.endpoint,
      apiKey: this.config.apiKey,
    });
    const dedupContext = createDeduplicationContext(payload);

    if (
      this.deduplicator.isDuplicate(
        dedupContext.title,
        dedupContext.description,
        dedupContext.errorStacks
      )
    ) {
      const waitSeconds = Math.ceil(
        (this.config.deduplication?.windowMs || 60000) / 1000
      );
      logger.warn('Duplicate bug report blocked', {
        title: dedupContext.title.substring(0, TITLE_PREVIEW_LENGTH),
        waitSeconds,
      });
      throw new Error(
        `Duplicate bug report detected. Please wait ${waitSeconds} seconds before submitting again.`
      );
    }

    // Mark this specific report as being submitted
    this.deduplicator.markInProgress(
      dedupContext.title,
      dedupContext.description,
      dedupContext.errorStacks
    );

    return dedupContext;
  }

  /**
   * Create bug report on server and get bug ID with presigned URLs
   * @private
   */
  private async createBugReport(
    payload: BugReportPayload
  ): Promise<{ id: string; presignedUrls?: Record<string, string> }> {
    const { report, ...metadata } = payload;

    const fileAnalysis = analyzeReportFiles(report);

    logger.debug('File upload detection', fileAnalysis);

    const createPayload = {
      ...metadata,
      report: {
        console: report.console,
        network: report.network,
        metadata: report.metadata,
      },
      hasScreenshot: fileAnalysis.hasScreenshot,
      hasReplay: fileAnalysis.hasReplay,
    };

    const apiBaseUrl = getApiBaseUrl(this.config.endpoint!);
    const submitUrl = `${apiBaseUrl}/api/v1/reports`;

    const response = await submitWithAuth(
      submitUrl,
      JSON.stringify(createPayload),
      { 'Content-Type': 'application/json' },
      {
        auth: { apiKey: this.config.apiKey! },
        retry: this.config.retry,
        offline: this.config.offline,
      }
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(
        `Failed to submit bug report: ${response.status} ${response.statusText}. ${errorText}`
      );
    }

    const result = await response.json();

    if (!isBugReportResponse(result)) {
      throw new Error('Invalid server response format');
    }

    if (!result.success) {
      throw new Error('Bug report creation failed on server');
    }

    // TypeScript now knows result.success is true, so result.data exists (validated by type guard)
    const bugData = result.data!;

    logger.debug('Bug report creation response', {
      success: result.success,
      bugId: bugData.id,
      hasPresignedUrls: !!bugData.presignedUrls,
      presignedUrlKeys: bugData.presignedUrls
        ? Object.keys(bugData.presignedUrls)
        : [],
    });

    return bugData;
  }

  /**
   * Handle file uploads using presigned URLs
   * @private
   */
  private async handleFileUploads(
    bugReportData: BugReportResponse['data'],
    payload: BugReportPayload,
    dedupContext: DeduplicationContext
  ): Promise<void> {
    // bugReportData.id is guaranteed to exist by type guard validation in createBugReport
    const bugId = bugReportData!.id;

    const { report } = payload;
    const fileAnalysis = analyzeReportFiles(report);

    if (!fileAnalysis.hasScreenshot && !fileAnalysis.hasReplay) {
      logger.debug('No files to upload, bug report created successfully', {
        bugId,
      });
      this.deduplicator.recordSubmission(
        dedupContext.title,
        dedupContext.description,
        dedupContext.errorStacks
      );
      return;
    }

    if (!bugReportData!.presignedUrls) {
      logger.error(
        'Presigned URLs not returned despite requesting file uploads',
        {
          bugId,
          hasScreenshot: fileAnalysis.hasScreenshot,
          hasReplay: fileAnalysis.hasReplay,
        }
      );
      throw new Error(
        'Server did not provide presigned URLs for file uploads. Check backend configuration.'
      );
    }

    const apiEndpoint = getApiBaseUrl(this.config.endpoint!);
    const uploadHandler = new FileUploadHandler(
      apiEndpoint,
      this.config.apiKey!
    );

    try {
      await uploadHandler.uploadFiles(
        bugId,
        report,
        bugReportData!.presignedUrls
      );
      logger.debug('File uploads completed successfully', { bugId });
      this.deduplicator.recordSubmission(
        dedupContext.title,
        dedupContext.description,
        dedupContext.errorStacks
      );
    } catch (error) {
      logger.error('File upload failed', {
        bugId,
        error: formatSubmissionError('Upload', error),
      });
      throw new Error(
        formatSubmissionError(
          `Bug report created (ID: ${bugId}) but file upload failed`,
          error
        )
      );
    }
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    this.deduplicator.destroy();
  }
}
