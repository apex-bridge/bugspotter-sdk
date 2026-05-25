/**
 * TemplateManager
 *
 * Responsibility: Generate HTML templates for modal components
 * Follows SRP: Only handles HTML structure generation
 */

export interface TemplateConfig {
  title?: string;
  titlePlaceholder?: string;
  descriptionPlaceholder?: string;
  submitButtonText?: string;
  cancelButtonText?: string;
  showScreenshot?: boolean;
}

export class TemplateManager {
  private config: Required<TemplateConfig>;

  constructor(config: TemplateConfig = {}) {
    this.config = {
      title: config.title || 'Report a Bug',
      titlePlaceholder:
        config.titlePlaceholder || 'Brief description of the issue',
      descriptionPlaceholder:
        config.descriptionPlaceholder ||
        'Detailed description of what happened...',
      submitButtonText: config.submitButtonText || 'Submit Bug Report',
      cancelButtonText: config.cancelButtonText || 'Cancel',
      showScreenshot: config.showScreenshot !== false,
    };
  }

  /**
   * Generate complete modal HTML structure
   */
  generateModalHTML(screenshotDataUrl?: string): string {
    return `
      <div class="overlay">
        <div class="modal">
          ${this.generateHeader()}
          ${this.generateBody(screenshotDataUrl)}
          ${this.generateFooter()}
          <div role="status" aria-live="polite" aria-atomic="true" class="sr-only" id="progress-status"></div>
        </div>
      </div>
    `;
  }

  /**
   * Generate the deflection container slot. Sits between the title
   * field and the description field; lives in the DOM regardless of
   * whether deflection is enabled so the cache initializer can find
   * it. `display:none` is the default — `DeflectionDisplay.render`
   * flips it on when matches arrive.
   */
  generateDeflectionSection(): string {
    return `
      <div class="deflection-section" id="deflection-section" style="display: none;"></div>
    `;
  }

  /**
   * Generate modal header
   */
  private generateHeader(): string {
    return `
      <div class="header">
        <h2>${this.escapeHtml(this.config.title)}</h2>
        <button class="close" aria-label="Close">&times;</button>
      </div>
    `;
  }

  /**
   * Generate modal body with form
   */
  private generateBody(screenshotDataUrl?: string): string {
    return `
      <div class="body">
        <form class="form">
          ${this.generateTitleField()}
          ${this.generateDeflectionSection()}
          ${this.generateDescriptionField()}
          ${this.config.showScreenshot && screenshotDataUrl ? this.generateScreenshotSection(screenshotDataUrl) : ''}
          ${this.generatePIISection()}
        </form>
      </div>
    `;
  }

  /**
   * Generate title input field
   */
  private generateTitleField(): string {
    return `
      <div class="form-group">
        <label class="label" for="title">Title *</label>
        <input
          type="text"
          id="title"
          class="input"
          placeholder="${this.escapeHtml(this.config.titlePlaceholder)}"
          required
        />
        <div class="error" id="title-error"></div>
      </div>
    `;
  }

  /**
   * Generate description textarea field
   */
  private generateDescriptionField(): string {
    return `
      <div class="form-group">
        <label class="label" for="description">Description *</label>
        <textarea
          id="description"
          class="textarea"
          placeholder="${this.escapeHtml(this.config.descriptionPlaceholder)}"
          required
        ></textarea>
        <div class="error" id="description-error"></div>
      </div>
    `;
  }

  /**
   * Generate screenshot section with redaction controls
   */
  private generateScreenshotSection(screenshotDataUrl: string): string {
    return `
      <div class="form-group">
        <label class="label">Screenshot</label>
        <div class="screenshot-container">
          <img 
            src="${screenshotDataUrl}" 
            alt="Bug screenshot" 
            class="screenshot"
            id="screenshot"
          />
          <canvas 
            class="redaction-canvas" 
            id="redaction-canvas"
            style="display: none;"
          ></canvas>
        </div>
        <div class="redaction-controls">
          <button 
            type="button" 
            class="btn-redact" 
            id="btn-redact"
          >
            ✏️ Redact Area
          </button>
          <button 
            type="button" 
            class="btn-clear" 
            id="btn-clear"
          >
            🗑️ Clear Redactions
          </button>
        </div>
      </div>
    `;
  }

  /**
   * Generate PII detection section (initially hidden)
   */
  private generatePIISection(): string {
    return `
      <div class="pii-section" id="pii-section" style="display: none;">
        <h3 class="pii-title">⚠️ Potential PII Detected</h3>
        <div id="pii-content"></div>
        <div class="checkbox-group">
          <input 
            type="checkbox" 
            id="pii-confirm" 
            class="checkbox"
          />
          <label for="pii-confirm" class="checkbox-label">
            I have reviewed and redacted sensitive information
          </label>
        </div>
      </div>
    `;
  }

  /**
   * Generate modal footer with action buttons
   */
  private generateFooter(): string {
    return `
      <div class="footer">
        <div class="error" id="submit-error" style="display: none;"></div>
        <button type="button" class="btn btn-secondary" id="btn-cancel">
          ${this.escapeHtml(this.config.cancelButtonText)}
        </button>
        <button type="submit" class="btn btn-primary submit" id="btn-submit">
          ${this.escapeHtml(this.config.submitButtonText)}
        </button>
      </div>
    `;
  }

  /**
   * Generate PII badge HTML
   */
  generatePIIBadge(type: string, count: number): string {
    return `<span class="bugspotter-pii-badge">${this.escapeHtml(type)}: ${count}</span>`;
  }

  /**
   * Escape HTML to prevent XSS
   */
  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<TemplateConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration
   */
  getConfig(): Required<TemplateConfig> {
    return { ...this.config };
  }
}
