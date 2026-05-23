import { StyleManager } from './components/style-manager';
import { TemplateManager } from './components/template-manager';
import { DOMElementCache } from './components/dom-element-cache';
import { FormValidator, type FormData } from './components/form-validator';
import { PIIDetectionDisplay } from './components/pii-detection-display';
import { RedactionCanvas } from './components/redaction-canvas';
import { ScreenshotProcessor } from './components/screenshot-processor';
import { DeflectionDisplay } from './components/deflection-display';
import { DeflectionApi } from '../core/deflection-api';
import { createSanitizer } from '../utils/sanitize';
import { getLogger } from '../utils/logger';

const logger = getLogger();

export interface BugReportData {
  title: string;
  description?: string;
  /**
   * Set by the deflection panel when the user confirmed "yes, this
   * is the same as #X". Forwarded to the backend's `/api/v1/reports`
   * POST as `deflected_to_canonical_id`. `null` / undefined when the
   * user didn't deflect.
   */
  deflectedToCanonicalId?: string | null;
}

export interface PIIDetection {
  type: string;
  count: number;
}

/**
 * Optional deflection configuration — when provided, the modal wires
 * the title input to a debounced similarity probe and renders an
 * inline match panel. Modal stays fully functional when absent.
 */
export interface DeflectionModalConfig {
  endpoint: string;
  apiKey: string;
  debounceMs?: number;
  maxMatches?: number;
}

export interface BugReportModalOptions {
  onSubmit: (data: BugReportData) => void | Promise<void>;
  onProgress?: (message: string) => void;
  onClose?: () => void;
  /**
   * If set, the modal enables in-widget deflection. Failures in the
   * probe (network, timeout, intelligence disabled) silently render
   * zero matches — the form's input values are NEVER touched by the
   * deflection flow, so user-typed text cannot be lost.
   */
  deflection?: DeflectionModalConfig;
}

/**
 * BugReportModal
 *
 * Refactored to follow SOLID principles
 * Acts as a lightweight coordinator for specialized components
 */
export class BugReportModal {
  private container: HTMLDivElement;
  private shadow: ShadowRoot;
  private options: BugReportModalOptions;

  // Component instances
  private styleManager: StyleManager;
  private templateManager: TemplateManager;
  private domCache: DOMElementCache;
  private validator: FormValidator;
  private piiDisplay: PIIDetectionDisplay;
  private redactionCanvas: RedactionCanvas | null = null;
  private screenshotProcessor: ScreenshotProcessor;

  // Deflection (optional — only initialised when options.deflection set)
  private deflectionApi: DeflectionApi | null = null;
  private deflectionDisplay: DeflectionDisplay | null = null;
  // Tracks which canonical the user confirmed via the deflection
  // chip, if any. Read at submit time. Distinct from form input
  // state — it's never written into the title/description fields.
  private deflectedToCanonicalId: string | null = null;

  // State
  private originalScreenshot: string = '';
  private piiDetections: PIIDetection[] = [];

  // Event handler (bound to this for proper removal)
  private handleEscapeKey: (e: KeyboardEvent) => void;

  constructor(options: BugReportModalOptions) {
    this.options = options;
    this.container = document.createElement('div');
    this.shadow = this.container.attachShadow({ mode: 'open' });

    // Initialize components
    this.styleManager = new StyleManager();
    this.templateManager = new TemplateManager();
    this.domCache = new DOMElementCache();
    this.validator = new FormValidator();
    this.piiDisplay = new PIIDetectionDisplay();
    this.screenshotProcessor = new ScreenshotProcessor();

    // Bind event handler
    this.handleEscapeKey = this.onEscapeKey.bind(this);
  }

  /**
   * Show the modal with optional screenshot
   */
  show(screenshotDataUrl?: string): void {
    if (screenshotDataUrl) {
      this.originalScreenshot = screenshotDataUrl;
    }

    // Generate and inject HTML (includes inline styles in shadow DOM)
    this.shadow.innerHTML = `
      <style>
        ${this.styleManager.generateStyles()}
      </style>
      ${this.templateManager.generateModalHTML(this.originalScreenshot)}
    `;

    // Cache DOM elements
    this.domCache.initialize(this.shadow);

    // Initialize error display states
    const elements = this.domCache.get();
    elements.titleError.style.display = 'none';
    elements.descriptionError.style.display = 'none';
    elements.submitError.style.display = 'none';
    elements.progressStatus.textContent = '';

    // Setup components
    this.setupRedactionCanvas();
    this.setupDeflection();
    this.attachEventListeners();

    // Add to DOM
    document.body.appendChild(this.container);

    // Focus first input
    elements.titleInput.focus();
  }

  /**
   * Close and cleanup the modal
   */
  close(): void {
    // Remove keyboard listener
    document.removeEventListener('keydown', this.handleEscapeKey);

    // Cancel any in-flight or pending similarity probe so the modal
    // doesn't try to render into a detached DOM on a slow response.
    if (this.deflectionApi) {
      this.deflectionApi.cancel();
    }
    if (this.deflectionDisplay) {
      this.deflectionDisplay.clear();
    }
    this.deflectedToCanonicalId = null;

    // Cleanup components
    if (this.redactionCanvas) {
      this.redactionCanvas.destroy();
      this.redactionCanvas = null;
    }

    // Remove from DOM
    if (this.container.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }

    // Clear cache
    this.domCache.clear();

    // Call onClose callback
    if (this.options.onClose) {
      this.options.onClose();
    }
  }

  /**
   * Destroy the modal (alias for close)
   */
  destroy(): void {
    this.close();
  }

  // Private helper methods

  private setupRedactionCanvas(): void {
    const elements = this.domCache.get();

    if (!elements.redactionCanvas || !elements.screenshotImg) {
      return;
    }

    try {
      this.redactionCanvas = new RedactionCanvas(elements.redactionCanvas);
      this.redactionCanvas.initializeCanvas(elements.screenshotImg);
    } catch (error) {
      // Canvas 2D context not available (e.g., in test environment)
      // Redaction features will be disabled
      getLogger().warn('Canvas redaction not available:', error);
      this.redactionCanvas = null;
    }
  }

  /**
   * Wire the deflection client + display when host opted in.
   * Failure to construct either is silent — the modal continues to
   * work without deflection, matching the no-leak / no-loss
   * contract.
   */
  private setupDeflection(): void {
    if (!this.options.deflection) {
      return;
    }
    const elements = this.domCache.get();
    try {
      this.deflectionApi = new DeflectionApi({
        endpoint: this.options.deflection.endpoint,
        apiKey: this.options.deflection.apiKey,
        debounceMs: this.options.deflection.debounceMs,
        maxMatches: this.options.deflection.maxMatches,
      });
      this.deflectionDisplay = new DeflectionDisplay(
        elements.deflectionSection,
        {
          onConfirmedChange: (canonicalId) => {
            this.deflectedToCanonicalId = canonicalId;
          },
        }
      );
    } catch (error) {
      logger.warn('Deflection setup failed; widget continues without it', {
        error,
      });
      this.deflectionApi = null;
      this.deflectionDisplay = null;
    }
  }

  private attachEventListeners(): void {
    const elements = this.domCache.get();

    // Close button
    elements.closeButton.addEventListener('click', () => {
      return this.close();
    });

    // Escape key to close
    document.addEventListener('keydown', this.handleEscapeKey);

    // Note: Overlay click does NOT close modal (improved UX to prevent accidental data loss)

    // Form submission
    elements.form.addEventListener('submit', (e) => {
      return this.handleSubmit(e);
    });

    // Submit button click (manually trigger form submit for test compatibility)
    elements.submitButton.addEventListener('click', () => {
      const submitEvent = new Event('submit', {
        bubbles: true,
        cancelable: true,
      });
      elements.form.dispatchEvent(submitEvent);
    });

    // Cancel button
    elements.cancelButton.addEventListener('click', () => {
      return this.close();
    });

    // Real-time validation
    elements.titleInput.addEventListener('input', () => {
      this.validateField('title');
      // Deflection probe runs in parallel — never blocks validation
      // and never touches the input value. Module-level AbortController
      // handles in-flight cancellation across rapid keystrokes.
      this.triggerDeflectionProbe(elements.titleInput.value);
    });
    elements.descriptionTextarea.addEventListener('input', () => {
      this.validateField('description');
      this.checkForPII();
    });

    // Redaction controls
    if (elements.redactButton && this.redactionCanvas) {
      elements.redactButton.addEventListener('click', () => {
        return this.toggleRedactionMode();
      });
    }

    if (elements.clearButton && this.redactionCanvas) {
      elements.clearButton.addEventListener('click', () => {
        return this.clearRedactions();
      });
    }

    // PII confirmation
    elements.piiConfirmCheckbox.addEventListener('change', () => {
      return this.updateSubmitButton();
    });
  }

  private validateField(fieldName: keyof FormData): void {
    const elements = this.domCache.get();
    const value =
      fieldName === 'title'
        ? elements.titleInput.value
        : elements.descriptionTextarea.value;
    const error = this.validator.validateField(fieldName, value);

    const errorElement =
      fieldName === 'title' ? elements.titleError : elements.descriptionError;

    if (error) {
      errorElement.textContent = error;
      errorElement.style.display = 'block';
    } else {
      errorElement.textContent = '';
      errorElement.style.display = 'none';
    }
  }

  private checkForPII(): void {
    const elements = this.domCache.get();
    const text = `${elements.titleInput.value} ${elements.descriptionTextarea.value}`;

    // Create temporary sanitizer to detect PII
    const sanitizer = createSanitizer({ enabled: true });
    const detections = sanitizer.detectPII(text);

    // Convert to PIIDetection array
    this.piiDetections = Array.from(detections.entries()).map(
      ([type, count]) => {
        return {
          type,
          count,
        };
      }
    );

    if (this.piiDetections.length > 0) {
      elements.piiSection.style.display = 'block';
      this.piiDisplay.render(this.piiDetections, elements.piiContent);
    } else {
      elements.piiSection.style.display = 'none';
      elements.piiConfirmCheckbox.checked = false;
    }

    this.updateSubmitButton();
  }

  private updateSubmitButton(): void {
    const elements = this.domCache.get();
    const hasPII = this.piiDetections.length > 0;
    const piiConfirmed = elements.piiConfirmCheckbox.checked;

    elements.submitButton.disabled = hasPII && !piiConfirmed;
  }

  private toggleRedactionMode(): void {
    const elements = this.domCache.get();

    if (!this.redactionCanvas || !elements.redactButton) {
      return;
    }

    const isActive = this.redactionCanvas.toggleRedactionMode();

    if (isActive) {
      elements.redactButton.classList.add('active');
      elements.redactButton.textContent = '✓ Redacting...';
    } else {
      elements.redactButton.classList.remove('active');
      elements.redactButton.textContent = '✏️ Redact Area';
    }
  }

  private clearRedactions(): void {
    if (this.redactionCanvas) {
      this.redactionCanvas.clearRedactions();
    }
  }

  /**
   * Fire a debounced similarity probe and render the matches. All
   * failure paths inside `DeflectionApi.query` resolve to `[]`, so
   * no try/catch needed here — the worst case is "no matches shown".
   * Returns early when deflection is disabled (no host config).
   */
  private triggerDeflectionProbe(title: string): void {
    if (!this.deflectionApi || !this.deflectionDisplay) {
      return;
    }
    const display = this.deflectionDisplay;
    void this.deflectionApi.query(title).then((matches) => {
      // The display owns its own state for which chip the user
      // confirmed; here we just hand it the latest match set.
      display.render(matches);
    });
  }

  private async handleSubmit(e: Event): Promise<void> {
    e.preventDefault();

    const elements = this.domCache.get();

    // Prevent double submission
    if (elements.submitButton.disabled) {
      return;
    }

    const formData: FormData = {
      title: elements.titleInput.value,
      description: elements.descriptionTextarea.value,
      piiDetected: this.piiDetections.length > 0,
      piiConfirmed: elements.piiConfirmCheckbox.checked,
    };

    const validation = this.validator.validate(formData);

    if (!validation.isValid) {
      // Display errors
      if (validation.errors.title) {
        elements.titleError.textContent = validation.errors.title;
        elements.titleError.style.display = 'block';
      } else {
        elements.titleError.textContent = '';
        elements.titleError.style.display = 'none';
      }

      if (validation.errors.description) {
        elements.descriptionError.textContent = validation.errors.description;
        elements.descriptionError.style.display = 'block';
      } else {
        elements.descriptionError.textContent = '';
        elements.descriptionError.style.display = 'none';
      }

      if (validation.errors.piiConfirmation) {
        alert(validation.errors.piiConfirmation);
      }

      return;
    }

    // Clear any previous error messages on successful validation
    elements.titleError.style.display = 'none';
    elements.descriptionError.style.display = 'none';
    elements.submitError.style.display = 'none';

    // Disable submit button and show loading state
    const originalButtonText =
      elements.submitButton.textContent || 'Submit Bug Report';
    elements.submitButton.disabled = true;
    elements.submitButton.textContent = 'Preparing...';
    elements.submitButton.classList.add('loading');

    // Helper to update progress
    const updateProgress = (message: string) => {
      elements.submitButton.textContent = message;
      elements.progressStatus.textContent = message; // Announce to screen readers
      if (this.options.onProgress) {
        this.options.onProgress(message);
      }
    };

    updateProgress('Preparing screenshot...');

    // Prepare screenshot with redactions
    let finalScreenshot = this.originalScreenshot;

    if (
      this.redactionCanvas &&
      this.redactionCanvas.getRedactions().length > 0
    ) {
      try {
        finalScreenshot = await this.screenshotProcessor.mergeRedactions(
          this.originalScreenshot,
          this.redactionCanvas.getCanvas()
        );
      } catch (mergeError) {
        logger.error('Failed to merge redactions:', mergeError);
        finalScreenshot = this.originalScreenshot;
      }
    }

    // Update original screenshot for submission
    this.originalScreenshot = finalScreenshot;

    // Submit
    const bugReportData: BugReportData = {
      title: formData.title.trim(),
      description: formData.description?.trim(),
      // When the deflection panel was used and the user confirmed a
      // chip, surface the canonical id on the submit payload. Stays
      // undefined otherwise so the backend's optional field handler
      // doesn't tag this as a deflected submission.
      deflectedToCanonicalId: this.deflectedToCanonicalId ?? undefined,
    };

    try {
      updateProgress('Uploading report...');
      await this.options.onSubmit(bugReportData);
      this.close();
    } catch (error) {
      getLogger().error('Error submitting bug report:', error);

      // Show error message in modal instead of blocking alert
      elements.submitError.textContent =
        'Failed to submit bug report. Please try again.';
      elements.submitError.style.display = 'block';

      // Clear stale progress status for screen readers
      elements.progressStatus.textContent = '';

      // Re-enable submit button on error
      elements.submitButton.disabled = false;
      elements.submitButton.textContent = originalButtonText;
      elements.submitButton.classList.remove('loading');
    }
  }

  /**
   * Get the final screenshot (with redactions applied)
   */
  getScreenshot(): string {
    return this.originalScreenshot;
  }

  /**
   * Handle Escape key press to close modal
   */
  private onEscapeKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      this.close();
    }
  }
}
