import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BugSpotter } from '../src/index';
import BugSpotterDefault from '../src/index';
import type { BugSpotterConfig } from '../src/index';

describe('BugSpotter', () => {
  describe('Module Exports', () => {
    it('should export BugSpotter as named export', () => {
      expect(BugSpotter).toBeDefined();
      expect(typeof BugSpotter.init).toBe('function');
      expect(typeof BugSpotter.getInstance).toBe('function');
    });

    it('should export BugSpotter as default export', () => {
      expect(BugSpotterDefault).toBeDefined();
      expect(typeof BugSpotterDefault.init).toBe('function');
      expect(typeof BugSpotterDefault.getInstance).toBe('function');
    });

    it('should have default export reference the same class as named export', () => {
      expect(BugSpotterDefault).toBe(BugSpotter);
    });
  });

  beforeEach(() => {
    // Clear singleton instance before each test
    const instance = BugSpotter.getInstance();
    if (instance) {
      instance.destroy();
    }
  });

  describe('Singleton Pattern', () => {
    it('should create a singleton instance', async () => {
      const config: BugSpotterConfig = {
        auth: {
          apiKey: '',
        },
      };
      const instance1 = await BugSpotter.init(config);
      const instance2 = await BugSpotter.init(config);

      expect(instance1).toBe(instance2);
    });

    it('should return the same instance from getInstance', async () => {
      const config: BugSpotterConfig = {
        auth: {
          apiKey: '',
        },
      };
      const instance1 = await BugSpotter.init(config);
      const instance2 = BugSpotter.getInstance();

      expect(instance1).toBe(instance2);
    });

    it('should return null from getInstance when not initialized', () => {
      const instance = BugSpotter.getInstance();
      expect(instance).toBeNull();
    });
  });

  describe('Configuration', () => {
    it('should initialize with apiKey only', async () => {
      const config: BugSpotterConfig = {
        auth: {
          apiKey: '',
        },
      };
      const bugspotter = await BugSpotter.init(config);

      expect(bugspotter).toBeDefined();
      expect(bugspotter.getConfig().auth).toEqual(config.auth);
    });

    it('should initialize with endpoint only', async () => {
      // Mock settings endpoint
      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
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
      } as Response);

      const config: BugSpotterConfig = {
        auth: {
          apiKey: 'test-key',
        },
        endpoint: 'https://api.example.com',
      };
      const bugspotter = await BugSpotter.init(config);

      expect(bugspotter).toBeDefined();
      const savedConfig = bugspotter.getConfig();
      expect(savedConfig.auth).toEqual(config.auth);
      expect(savedConfig.endpoint).toBe(config.endpoint);
    });

    it('should initialize with both apiKey and endpoint', async () => {
      // Mock settings endpoint
      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
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
      } as Response);

      const config: BugSpotterConfig = {
        auth: {
          apiKey: '',
        },
        endpoint: 'https://api.example.com',
      };
      const bugspotter = await BugSpotter.init(config);

      expect(bugspotter).toBeDefined();
      const savedConfig = bugspotter.getConfig();
      expect(savedConfig.auth).toEqual(config.auth);
      expect(savedConfig.endpoint).toBe(config.endpoint);
    });

    it('should initialize with minimal config', async () => {
      const config: BugSpotterConfig = {
        auth: {
          apiKey: 'test-key',
        },
      };
      const bugspotter = await BugSpotter.init(config);

      expect(bugspotter).toBeDefined();
      expect(bugspotter.getConfig().auth).toEqual(config.auth);
    });

    it('should return a copy of config (not reference)', async () => {
      const config: BugSpotterConfig = {
        auth: {
          apiKey: '',
        },
      };
      const bugspotter = await BugSpotter.init(config);
      const configCopy = bugspotter.getConfig();

      expect(configCopy.auth).toEqual(config.auth);
      expect(configCopy).not.toBe(config);
    });
  });

  describe('Capture', () => {
    it('should capture all data types', async () => {
      const bugspotter = await BugSpotter.init({
        auth: {
          apiKey: '',
        },
      });

      console.log('Test log');
      console.warn('Test warning');

      const report = await bugspotter.capture();

      expect(report).toHaveProperty('console');
      expect(report).toHaveProperty('network');
      expect(report).toHaveProperty('metadata');
      expect(report).toHaveProperty('replay');

      expect(typeof report._screenshotPreview).toBe('string');
      expect(Array.isArray(report.console)).toBe(true);
      expect(Array.isArray(report.network)).toBe(true);
      expect(typeof report.metadata).toBe('object');
      expect(Array.isArray(report.replay)).toBe(true);
    });

    it('should capture replay events when enabled', async () => {
      const bugspotter = await BugSpotter.init({
        auth: {
          apiKey: '',
        },
        replay: {
          enabled: true,
          duration: 15,
        },
      });

      // Wait a bit for some events to be recorded
      await new Promise((resolve) => {
        return setTimeout(resolve, 100);
      });

      const report = await bugspotter.capture();

      expect(report.replay).toBeDefined();
      expect(Array.isArray(report.replay)).toBe(true);
      // Should have at least initial snapshot events
      expect(report.replay?.length).toBeGreaterThan(0);
    });

    it('should not capture replay events when disabled', async () => {
      const bugspotter = await BugSpotter.init({
        auth: {
          apiKey: '',
        },
        replay: {
          enabled: false,
        },
      });

      const report = await bugspotter.capture();

      expect(report.replay).toBeDefined();
      expect(Array.isArray(report.replay)).toBe(true);
      expect(report.replay?.length).toBe(0);
    });

    it('should respect replay duration configuration', async () => {
      const bugspotter = await BugSpotter.init({
        auth: {
          apiKey: '',
        },
        replay: {
          enabled: true,
          duration: 20,
        },
      });

      const config = bugspotter.getConfig();
      expect(config.replay?.duration).toBe(20);
    });

    it('should capture console logs', async () => {
      const bugspotter = await BugSpotter.init({
        auth: {
          apiKey: '',
        },
      });

      console.log('Test message');
      const report = await bugspotter.capture();

      expect(report.console.length).toBeGreaterThan(0);
      expect(report.console[0]).toHaveProperty('level');
      expect(report.console[0]).toHaveProperty('message');
      expect(report.console[0]).toHaveProperty('timestamp');
    });

    it('should capture metadata with required fields', async () => {
      const bugspotter = await BugSpotter.init({
        auth: {
          apiKey: '',
        },
      });
      const report = await bugspotter.capture();

      expect(report.metadata).toHaveProperty('userAgent');
      expect(report.metadata).toHaveProperty('viewport');
      expect(report.metadata).toHaveProperty('browser');
      expect(report.metadata).toHaveProperty('os');
      expect(report.metadata).toHaveProperty('url');
      expect(report.metadata).toHaveProperty('timestamp');
    });

    it('should return BugReport with correct structure', async () => {
      const bugspotter = await BugSpotter.init({
        auth: {
          apiKey: '',
        },
      });
      const report = await bugspotter.capture();

      // Validate screenshot
      expect(typeof report._screenshotPreview).toBe('string');

      // Validate console array structure
      expect(Array.isArray(report.console)).toBe(true);
      if (report.console.length > 0) {
        expect(report.console[0]).toHaveProperty('level');
        expect(report.console[0]).toHaveProperty('message');
        expect(report.console[0]).toHaveProperty('timestamp');
      }

      // Validate network array structure
      expect(Array.isArray(report.network)).toBe(true);

      // Validate metadata object
      expect(report.metadata).toHaveProperty('userAgent');
      expect(report.metadata.viewport).toHaveProperty('width');
      expect(report.metadata.viewport).toHaveProperty('height');
    });
  });

  describe('Lifecycle', () => {
    it('should destroy and clear singleton instance', async () => {
      const bugspotter = await BugSpotter.init({
        auth: {
          apiKey: '',
        },
      });
      expect(BugSpotter.getInstance()).toBe(bugspotter);

      bugspotter.destroy();

      expect(BugSpotter.getInstance()).toBeNull();
    });

    it('should allow re-initialization after destroy', async () => {
      const config1: BugSpotterConfig = {
        auth: {
          apiKey: '',
        },
      };
      const instance1 = await BugSpotter.init(config1);

      instance1.destroy();

      const config2: BugSpotterConfig = {
        auth: {
          apiKey: '',
        },
      };
      const instance2 = await BugSpotter.init(config2);

      expect(instance2).not.toBe(instance1);
      expect(instance2.getConfig().auth).toEqual(config2.auth);
    });

    it('should clean up console interceptor on destroy', async () => {
      const bugspotter = await BugSpotter.init({
        auth: {
          apiKey: '',
        },
      });

      bugspotter.destroy();

      // After destroy, console should be restored (we can't directly check this,
      // but we can verify no errors occur)
      expect(() => {
        return console.log('test');
      }).not.toThrow();
    });

    it('should clean up network interceptor on destroy', async () => {
      const bugspotter = await BugSpotter.init({
        auth: {
          apiKey: '',
        },
      });

      bugspotter.destroy();

      // After destroy, fetch should be restored
      expect(global.fetch).toBeDefined();
    });
  });

  describe('Multiple Capture Calls', () => {
    it('should handle multiple capture calls', async () => {
      const bugspotter = await BugSpotter.init({
        auth: {
          apiKey: '',
        },
      });

      const report1 = await bugspotter.capture();
      console.log('New log after first capture');
      const report2 = await bugspotter.capture();

      expect(report1).toBeDefined();
      expect(report2).toBeDefined();
      expect(report1).not.toBe(report2);
    });

    it('should accumulate console logs between captures', async () => {
      const bugspotter = await BugSpotter.init({
        auth: {
          apiKey: '',
        },
      });

      console.log('First message');
      const report1 = await bugspotter.capture();
      const firstLogCount = report1.console.length;

      console.log('Second message');
      const report2 = await bugspotter.capture();
      const secondLogCount = report2.console.length;

      expect(secondLogCount).toBeGreaterThanOrEqual(firstLogCount);
    });
  });

  describe('Widget Integration', () => {
    it('should create widget by default', async () => {
      const bugspotter = await BugSpotter.init({
        auth: {
          apiKey: '',
        },
      });

      // Check if button element was added to the body
      const button = document.querySelector('button[style*="position: fixed"]');
      expect(button).toBeTruthy();

      bugspotter.destroy();
    });

    it('should not create widget when showWidget is false', async () => {
      const bugspotter = await BugSpotter.init({
        auth: {
          apiKey: '',
        },
        showWidget: false,
      });

      // Check if button element was NOT added
      const button = document.querySelector('button[style*="position: fixed"]');
      expect(button).toBeNull();

      bugspotter.destroy();
    });

    it('should pass widget options correctly', async () => {
      const bugspotter = await BugSpotter.init({
        auth: {
          apiKey: '',
        },
        widgetOptions: {
          position: 'top-left',
          icon: '🚨',
          backgroundColor: '#8b5cf6',
          size: 70,
        },
      });

      const button = document.querySelector(
        'button[style*="position: fixed"]'
      ) as HTMLButtonElement;
      expect(button).toBeTruthy();
      expect(button.textContent).toContain('🚨');
      expect(button.style.backgroundColor).toBe('rgb(139, 92, 246)'); // #8b5cf6 in rgb

      bugspotter.destroy();
    });

    it('should destroy widget when BugSpotter is destroyed', async () => {
      const bugspotter = await BugSpotter.init({
        auth: {
          apiKey: '',
        },
      });

      const buttonBefore = document.querySelector(
        'button[style*="position: fixed"]'
      );
      expect(buttonBefore).toBeTruthy();

      bugspotter.destroy();

      const buttonAfter = document.querySelector(
        'button[style*="position: fixed"]'
      );
      expect(buttonAfter).toBeNull();
    });

    it('should call capture when widget button is clicked', async () => {
      const bugspotter = await BugSpotter.init({
        auth: {
          apiKey: '',
        },
      });
      const captureSpy = vi.spyOn(bugspotter, 'capture');

      const button = document.querySelector(
        'button[style*="position: fixed"]'
      ) as HTMLButtonElement;
      expect(button).toBeTruthy();

      // Click the button
      button.click();

      // Wait for async capture to be called
      await new Promise((resolve) => {
        return setTimeout(resolve, 0);
      });

      expect(captureSpy).toHaveBeenCalled();

      bugspotter.destroy();
    });

    it('should handle widget configuration with showWidget true explicitly', async () => {
      const bugspotter = await BugSpotter.init({
        auth: {
          apiKey: '',
        },
        showWidget: true,
      });

      const button = document.querySelector('button[style*="position: fixed"]');
      expect(button).toBeTruthy();

      bugspotter.destroy();
    });
  });

  describe('Error Stack Extraction', () => {
    it('should extract error stacks from console logs', () => {
      // Mock bug report with error logs
      const mockReport = {
        console: [
          { level: 'log', message: 'Regular log', timestamp: Date.now() },
          {
            level: 'error',
            message: 'Error 1',
            stack: 'Error: Error 1\n  at line1',
            timestamp: Date.now(),
          },
          { level: 'warn', message: 'Warning', timestamp: Date.now() },
          {
            level: 'error',
            message: 'Error 2',
            stack: 'Error: Error 2\n  at line2',
            timestamp: Date.now(),
          },
        ],
        network: [],
        metadata: {} as any,
      };

      // Extract stacks using the same logic as the submit function
      const extractedStacks = mockReport.console
        .filter((log) => log.level === 'error')
        .map((log) => log.stack || log.message);

      expect(Array.isArray(extractedStacks)).toBe(true);
      expect(extractedStacks.length).toBe(2);
      expect(extractedStacks[0]).toBe('Error: Error 1\n  at line1');
      expect(extractedStacks[1]).toBe('Error: Error 2\n  at line2');
    });

    it('should handle console logs with undefined stack property', () => {
      // Mock bug report with error logs without stacks
      const mockReport = {
        console: [
          {
            level: 'error',
            message: 'Simple error without stack',
            timestamp: Date.now(),
            stack: undefined,
          },
          {
            level: 'error',
            message: 'Another error',
            timestamp: Date.now(),
            stack: undefined,
          },
        ],
        network: [],
        metadata: {} as any,
      };

      // Extract stacks
      const extractedStacks = mockReport.console
        .filter((log) => log.level === 'error')
        .map((log) => log.stack || log.message);

      expect(extractedStacks.length).toBe(2);
      // When stack is undefined, should fall back to message
      expect(extractedStacks[0]).toBe('Simple error without stack');
      expect(extractedStacks[1]).toBe('Another error');
      extractedStacks.forEach((stack) => {
        expect(typeof stack).toBe('string');
        expect(stack.length).toBeGreaterThan(0);
      });
    });

    it('should return empty array when no error-level logs exist', () => {
      // Mock bug report with only non-error logs
      const mockReport = {
        console: [
          {
            level: 'log',
            message: 'Info log',
            timestamp: Date.now(),
            stack: undefined,
          },
          {
            level: 'warn',
            message: 'Warning log',
            timestamp: Date.now(),
            stack: undefined,
          },
        ],
        network: [],
        metadata: {} as any,
      };

      // Extract stacks
      const extractedStacks = mockReport.console
        .filter((log) => log.level === 'error')
        .map((log) => log.stack || log.message);

      expect(Array.isArray(extractedStacks)).toBe(true);
      expect(extractedStacks.length).toBe(0);
    });

    it('should correctly filter only error-level logs', () => {
      // Mock bug report with mixed log levels
      const mockReport = {
        console: [
          {
            level: 'log',
            message: 'Regular log',
            timestamp: Date.now(),
            stack: undefined,
          },
          {
            level: 'warn',
            message: 'Warning log',
            timestamp: Date.now(),
            stack: undefined,
          },
          {
            level: 'error',
            message: 'Error log 1',
            stack: 'Stack 1',
            timestamp: Date.now(),
          },
          {
            level: 'info',
            message: 'Info log',
            timestamp: Date.now(),
            stack: undefined,
          },
          {
            level: 'error',
            message: 'Error log 2',
            stack: 'Stack 2',
            timestamp: Date.now(),
          },
        ],
        network: [],
        metadata: {} as any,
      };

      // Extract stacks
      const extractedStacks = mockReport.console
        .filter((log) => log.level === 'error')
        .map((log) => log.stack || log.message);

      // Should only include error-level logs
      expect(extractedStacks.length).toBe(2);
      expect(extractedStacks[0]).toBe('Stack 1');
      expect(extractedStacks[1]).toBe('Stack 2');
      extractedStacks.forEach((stack) => {
        expect(typeof stack).toBe('string');
      });
    });

    it('should preserve stack trace details when available', () => {
      // Mock bug report with detailed stack trace
      const mockReport = {
        console: [
          {
            level: 'error',
            message: 'Error with stack',
            stack:
              'Error: Test error with detailed stack\n    at function1\n    at function2',
            timestamp: Date.now(),
          },
        ],
        network: [],
        metadata: {} as any,
      };

      // Extract stacks
      const extractedStacks = mockReport.console
        .filter((log) => log.level === 'error')
        .map((log) => log.stack || log.message);

      expect(extractedStacks.length).toBe(1);
      // Should have stack information
      expect(extractedStacks[0]).toContain('Error:');
      expect(extractedStacks[0]).toContain('function1');
      expect(extractedStacks[0]).toContain('function2');
    });

    it('should match extraction logic used in submit validation', () => {
      // Mock bug report matching actual BugReport structure
      const mockReport = {
        console: [
          { level: 'error', message: 'Simple error', timestamp: Date.now() },
          {
            level: 'error',
            message: 'Error with object',
            stack: 'Error: Test error\n    at test',
            timestamp: Date.now(),
          },
        ],
        network: [],
        metadata: {} as any,
      };

      // Extract using the same logic as validateAndExtractErrors
      const extractedStacks = mockReport.console
        .filter((log) => log.level === 'error')
        .map((log) => log.stack || log.message);

      // Verify it produces an array of strings suitable for deduplication
      expect(Array.isArray(extractedStacks)).toBe(true);
      expect(extractedStacks.every((stack) => typeof stack === 'string')).toBe(
        true
      );

      // All extracted stacks should be non-empty strings
      expect(extractedStacks.every((stack) => stack.length > 0)).toBe(true);
      expect(extractedStacks.length).toBe(2);
      expect(extractedStacks[0]).toBe('Simple error');
      expect(extractedStacks[1]).toContain('Error: Test error');
    });
  });

  describe('Bug Report Modal Integration', () => {
    it('should show modal with screenshot when widget button is clicked', async () => {
      const bugspotter = await BugSpotter.init({
        auth: {
          apiKey: '',
        },
      });

      const widgetButton = document.querySelector(
        'button[style*="position: fixed"]'
      ) as HTMLButtonElement;
      expect(widgetButton).toBeTruthy();

      // Click the widget button
      widgetButton.click();

      // Wait for async capture and modal display
      await new Promise((resolve) => {
        return setTimeout(resolve, 100);
      });

      // Check if modal is displayed
      const modalContainer = Array.from(document.body.children).find((el) => {
        return el.shadowRoot?.querySelector('.overlay');
      });
      expect(modalContainer).toBeTruthy();

      // Check if screenshot is displayed in modal
      const shadow = (modalContainer as HTMLElement).shadowRoot;
      const screenshot = shadow?.querySelector(
        '#screenshot'
      ) as HTMLImageElement;
      expect(screenshot).toBeTruthy();
      expect(screenshot.src).toBeTruthy();

      bugspotter.destroy();
    });

    it('should log bug report data when modal is submitted', async () => {
      const consoleLogSpy = vi.spyOn(console, 'log');
      const bugspotter = await BugSpotter.init({
        auth: {
          apiKey: '',
        },
      });

      const widgetButton = document.querySelector(
        'button[style*="position: fixed"]'
      ) as HTMLButtonElement;
      widgetButton.click();

      // Wait for modal to appear
      await new Promise((resolve) => {
        return setTimeout(resolve, 100);
      });

      const modalContainer = Array.from(document.body.children).find((el) => {
        return el.shadowRoot?.querySelector('.overlay');
      }) as HTMLElement;

      const shadow = modalContainer.shadowRoot;
      const titleInput = shadow?.querySelector('#title') as HTMLInputElement;
      const descriptionInput = shadow?.querySelector(
        '#description'
      ) as HTMLTextAreaElement;
      const submitButton = shadow?.querySelector(
        '.submit'
      ) as HTMLButtonElement;

      // Fill in the form
      titleInput.value = 'Test Bug Title';
      descriptionInput.value = 'Test Bug Description';

      // Submit the form
      submitButton.click();

      // Check if console.log was called with bug report data
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '[BugSpotter] Submitting bug:',
        expect.objectContaining({
          title: 'Test Bug Title',
          description: 'Test Bug Description',
          report: expect.objectContaining({
            _screenshotPreview: expect.any(String),
            console: expect.any(Array),
            network: expect.any(Array),
            metadata: expect.any(Object),
          }),
        })
      );

      consoleLogSpy.mockRestore();
      bugspotter.destroy();
    });

    it('should not show modal when showWidget is false', async () => {
      // Count existing modals before test
      const initialModalCount = Array.from(document.body.children).filter(
        (el) => {
          return el.shadowRoot?.querySelector('.overlay');
        }
      ).length;

      const bugspotter = await BugSpotter.init({
        auth: {
          apiKey: '',
        },
        showWidget: false,
      });

      // Manually call capture (no widget to click)
      await bugspotter.capture();

      // Wait a bit to ensure no modal appears
      await new Promise((resolve) => {
        return setTimeout(resolve, 100);
      });

      // Check that no new modal was created
      const finalModalCount = Array.from(document.body.children).filter(
        (el) => {
          return el.shadowRoot?.querySelector('.overlay');
        }
      ).length;
      expect(finalModalCount).toBe(initialModalCount);

      bugspotter.destroy();
    });
  });
});
