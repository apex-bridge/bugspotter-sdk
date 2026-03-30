import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BugSpotter } from '../../src/index';
import type { BugSpotterConfig } from '../../src/index';

describe('Deduplication Integration Tests', () => {
  let bugSpotter: BugSpotter;
  let fetchMock: ReturnType<typeof vi.fn>;
  let apiCallCount: number;

  const baseConfig: BugSpotterConfig = {
    endpoint: 'https://api.example.com',
    auth: {
      apiKey: 'test-key',
    },
    showWidget: false,
    deduplication: {
      enabled: true,
      windowMs: 5000, // 5 seconds for faster tests
      maxCacheSize: 10,
    },
  };

  /**
   * Create default fetch mock that handles API calls and S3 uploads
   */
  function setupDefaultFetchMock() {
    apiCallCount = 0;
    fetchMock = vi.fn((url: string) => {
      // API calls (bug report creation and confirmation)
      if (url.includes('api.example.com')) {
        apiCallCount++;

        // Confirmation endpoint
        if (url.includes('/confirm')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ success: true }),
            text: async () => 'OK',
          });
        }

        // Bug report creation endpoint
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: {
              id: `bug-${apiCallCount}`,
              presignedUrls: {
                screenshot: {
                  uploadUrl: 'https://s3.example.com/screenshot',
                  storageKey: 'screenshots/test.png',
                },
                replay: {
                  uploadUrl: 'https://s3.example.com/replay',
                  storageKey: 'replays/test.json',
                },
              },
            },
          }),
          text: async () => 'OK',
        });
      }

      // S3 upload calls
      if (url.includes('s3.example.com')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: async () => 'OK',
        });
      }

      return Promise.reject(new Error('Unexpected URL: ' + url));
    });

    global.fetch = fetchMock;
  }

  beforeEach(() => {
    setupDefaultFetchMock();
  });

  afterEach(() => {
    bugSpotter?.destroy();
    vi.restoreAllMocks();
  });

  describe('Duplicate Prevention', () => {
    it('should prevent duplicate submissions of same report', async () => {
      bugSpotter = new BugSpotter(baseConfig);

      const report = await bugSpotter.capture();
      const payload = {
        title: 'Critical Bug',
        description: 'App crashed',
        report,
      };

      // First submission should succeed (creates bug report + confirms upload)
      await bugSpotter.submit(payload);
      const firstSubmitCount = apiCallCount;
      expect(firstSubmitCount).toBeGreaterThan(0);

      // Second submission of same report should be blocked
      await expect(bugSpotter.submit(payload)).rejects.toThrow(
        'Duplicate bug report detected. Please wait 5 seconds before submitting again.'
      );

      // API should not be called again (deduplication prevented it)
      expect(apiCallCount).toBe(firstSubmitCount);
    });

    it('should allow different reports to be submitted', async () => {
      bugSpotter = new BugSpotter(baseConfig);

      const report1 = await bugSpotter.capture();
      const report2 = await bugSpotter.capture();

      await bugSpotter.submit({
        title: 'Bug A',
        description: 'First bug',
        report: report1,
      });
      const firstCount = apiCallCount;

      await bugSpotter.submit({
        title: 'Bug B',
        description: 'Second bug',
        report: report2,
      });

      // Both submissions should succeed (second should add more API calls)
      expect(apiCallCount).toBeGreaterThan(firstCount);
    });

    it('should allow re-submission after time window expires', async () => {
      vi.useFakeTimers();

      bugSpotter = new BugSpotter(baseConfig);

      const report = await bugSpotter.capture();
      const payload = {
        title: 'Critical Bug',
        description: 'App crashed',
        report,
      };

      // First submission
      await bugSpotter.submit(payload);
      const firstCount = apiCallCount;

      // Advance time beyond deduplication window (5 seconds)
      vi.advanceTimersByTime(6000);

      // Second submission should be allowed
      await bugSpotter.submit(payload);
      expect(apiCallCount).toBeGreaterThan(firstCount);

      vi.useRealTimers();
    });

    it('should show correct wait time in error message', async () => {
      bugSpotter = new BugSpotter({
        ...baseConfig,
        deduplication: {
          enabled: true,
          windowMs: 60000, // 60 seconds
        },
      });

      const report = await bugSpotter.capture();
      const payload = {
        title: 'Test Bug',
        description: 'Test',
        report,
      };

      await bugSpotter.submit(payload);

      await expect(bugSpotter.submit(payload)).rejects.toThrow(
        'Duplicate bug report detected. Please wait 60 seconds before submitting again.'
      );
    });
  });

  describe('Double-Click Prevention', () => {
    it('should block concurrent submissions of same report', async () => {
      bugSpotter = new BugSpotter(baseConfig);

      const report = await bugSpotter.capture();
      const payload = {
        title: 'Critical Bug',
        description: 'App crashed',
        report,
      };

      // Start first submission (doesn't await)
      const firstSubmission = bugSpotter.submit(payload);

      // Give it a tiny moment to mark as in-progress
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Second submission should be blocked immediately
      await expect(bugSpotter.submit(payload)).rejects.toThrow('Duplicate bug report detected');

      // Wait for first submission to complete
      await firstSubmission;
    });
  });

  describe('Configuration', () => {
    it('should allow disabling deduplication', async () => {
      bugSpotter = new BugSpotter({
        ...baseConfig,
        deduplication: {
          enabled: false,
        },
      });

      const report = await bugSpotter.capture();
      const payload = {
        title: 'Test Bug',
        description: 'Test',
        report,
      };

      // Both submissions should succeed
      await bugSpotter.submit(payload);
      const firstCount = apiCallCount;

      await bugSpotter.submit(payload);

      // Second submission went through (deduplication disabled)
      expect(apiCallCount).toBeGreaterThan(firstCount);
    });

    it('should use default config when deduplication not specified', async () => {
      bugSpotter = new BugSpotter({
        endpoint: 'https://api.example.com',
        auth: {
          apiKey: 'test-key',
        },
        showWidget: false,
      });

      const report = await bugSpotter.capture();
      const payload = {
        title: 'Test Bug',
        description: 'Test',
        report,
      };

      await bugSpotter.submit(payload);

      // Should block duplicate (deduplication enabled by default)
      await expect(bugSpotter.submit(payload)).rejects.toThrow('Duplicate bug report detected');
    });

    it('should throw error for invalid deduplication config', () => {
      expect(() => {
        new BugSpotter({
          ...baseConfig,
          deduplication: {
            windowMs: -1000, // Invalid
          },
        });
      }).toThrow('deduplication.windowMs must be greater than 0');
    });
  });

  describe('Error Details Fingerprinting', () => {
    it('should differentiate reports with different error stacks', async () => {
      bugSpotter = new BugSpotter(baseConfig);

      const report1 = await bugSpotter.capture();
      const report2 = await bugSpotter.capture();

      // Add different error logs
      report1.console.push({
        level: 'error',
        message: 'TypeError',
        timestamp: Date.now(),
        stack: 'at page1.js:10',
      });

      report2.console.push({
        level: 'error',
        message: 'TypeError',
        timestamp: Date.now(),
        stack: 'at page2.js:20',
      });

      // Both should be allowed (different stack traces)
      await bugSpotter.submit({
        title: 'TypeError',
        description: 'Null reference',
        report: report1,
      });
      const firstCount = apiCallCount;

      await bugSpotter.submit({
        title: 'TypeError',
        description: 'Null reference',
        report: report2,
      });

      // Second submission went through (different error stacks)
      expect(apiCallCount).toBeGreaterThan(firstCount);
    });

    it('should detect duplicates with same error stacks', async () => {
      bugSpotter = new BugSpotter(baseConfig);

      const report = await bugSpotter.capture();

      // Add same error log
      const errorLog = {
        level: 'error',
        message: 'TypeError',
        timestamp: Date.now(),
        stack: 'at app.js:100',
      };

      report.console.push(errorLog);

      await bugSpotter.submit({
        title: 'TypeError',
        description: 'Null reference',
        report,
      });
      const firstCount = apiCallCount;

      // Should be blocked (same error stack with same report)
      await expect(
        bugSpotter.submit({
          title: 'TypeError',
          description: 'Null reference',
          report, // Same report object
        })
      ).rejects.toThrow('Duplicate bug report detected');

      // API was not called again (deduplication prevented it)
      expect(apiCallCount).toBe(firstCount);
    });
  });
});
