/**
 * StyleManager
 *
 * Responsibility: Generate and manage CSS styles for the bug report modal
 * Follows SRP: Only handles style generation and theming
 */

export interface StyleConfig {
  primaryColor?: string;
  dangerColor?: string;
  borderRadius?: string;
  fontFamily?: string;
  zIndex?: number;
}

export class StyleManager {
  private config: Required<StyleConfig>;

  // ============================================================================
  // SPACING & SIZING CONSTANTS
  // ============================================================================
  private readonly SPACING = {
    xs: 8,
    sm: 12,
    md: 16,
    lg: 20,
  };

  private readonly BREAKPOINTS = {
    tablet: 768,
    mobile: 480,
  };

  private readonly MODAL_SIZES = {
    desktop: '600px',
    tablet: '500px',
    mobilePercent: '98%',
    headerHeight: '30px',
  };

  // ============================================================================
  // FONT & LAYOUT CONSTANTS
  // ============================================================================
  private readonly FONT_SIZES = {
    h2: '20px',
    h2Mobile: '18px',
    label: '14px',
    labelMobile: '13px',
    body: '14px',
    small: '12px',
    sr: '13px',
  };

  private readonly BORDER_STYLES = {
    primary: '1px solid #e0e0e0',
    light: '1px solid #ddd',
  };

  private readonly SHADOW_STYLES = {
    modal: '0 4px 6px rgba(0, 0, 0, 0.1)',
  };

  constructor(config: StyleConfig = {}) {
    this.config = {
      primaryColor: config.primaryColor || '#007bff',
      dangerColor: config.dangerColor || '#dc3545',
      borderRadius: config.borderRadius || '4px',
      fontFamily:
        config.fontFamily ||
        '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      zIndex: config.zIndex || 999999,
    };
  }

  /**
   * Generate complete CSS stylesheet for the modal
   */
  generateStyles(): string {
    return `
      ${this.generateOverlayStyles()}
      ${this.generateModalStyles()}
      ${this.generateHeaderStyles()}
      ${this.generateBodyStyles()}
      ${this.generateFormStyles()}
      ${this.generateButtonStyles()}
      ${this.generatePIIStyles()}
      ${this.generateDeflectionStyles()}
      ${this.generateLoadingStyles()}
      ${this.generateAccessibilityStyles()}
      ${this.generateTabletResponsiveStyles()}
      ${this.generateMobileResponsiveStyles()}
    `;
  }

  // ============================================================================
  // COMPONENT STYLES - OVERLAY & MODAL
  // ============================================================================
  private generateOverlayStyles(): string {
    return `
      .overlay {
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.5);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: ${this.config.zIndex};
        font-family: ${this.config.fontFamily};
      }
    `;
  }

  private generateModalStyles(): string {
    return `
      .modal {
        background: white;
        border-radius: 8px;
        width: 90%;
        max-width: ${this.MODAL_SIZES.desktop};
        max-height: 90vh;
        overflow-y: auto;
        box-shadow: ${this.SHADOW_STYLES.modal};
        scrollbar-width: none;
        -ms-overflow-style: none;
      }
      
      .modal::-webkit-scrollbar {
        display: none;
      }
    `;
  }

  // ============================================================================
  // COMPONENT STYLES - HEADER
  // ============================================================================
  private generateHeaderStyles(): string {
    return `
      .header {
        padding: ${this.SPACING.lg}px;
        border-bottom: ${this.BORDER_STYLES.primary};
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      
      .header h2 {
        margin: 0;
        font-size: ${this.FONT_SIZES.h2};
        font-weight: 600;
      }
      
      .close {
        background: none;
        border: none;
        font-size: 24px;
        cursor: pointer;
        color: #666;
        padding: 0;
        width: ${this.MODAL_SIZES.headerHeight};
        height: ${this.MODAL_SIZES.headerHeight};
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: ${this.config.borderRadius};
      }
      
      .close:hover {
        background: #f0f0f0;
      }
    `;
  }

  // ============================================================================
  // COMPONENT STYLES - BODY & FORM
  // ============================================================================
  private generateBodyStyles(): string {
    return `
      .body {
        padding: ${this.SPACING.lg}px;
      }
    `;
  }

  private generateFormStyles(): string {
    return `
      .form-group {
        margin-bottom: ${this.SPACING.lg}px;
      }
      
      .label {
        display: block;
        margin-bottom: ${this.SPACING.xs}px;
        font-weight: 500;
        font-size: ${this.FONT_SIZES.label};
      }
      
      .input,
      .textarea {
        width: 100%;
        padding: ${this.SPACING.xs}px;
        border: ${this.BORDER_STYLES.light};
        border-radius: ${this.config.borderRadius};
        font-size: ${this.FONT_SIZES.body};
        font-family: ${this.config.fontFamily};
        box-sizing: border-box;
      }
      
      .input:focus,
      .textarea:focus {
        outline: none;
        border-color: ${this.config.primaryColor};
      }
      
      .textarea {
        min-height: 100px;
        resize: vertical;
      }
      
      .checkbox-group {
        display: flex;
        align-items: center;
        gap: ${this.SPACING.xs}px;
        margin-top: ${this.SPACING.md}px;
      }
      
      .checkbox {
        width: 18px;
        height: 18px;
        cursor: pointer;
      }
      
      .checkbox-label {
        margin: 0;
        font-size: ${this.FONT_SIZES.body};
        cursor: pointer;
        user-select: none;
      }
      
      .error {
        color: ${this.config.dangerColor};
        font-size: ${this.FONT_SIZES.small};
        margin-top: 4px;
      }
    `;
  }

  // ============================================================================
  // COMPONENT STYLES - BUTTONS & CONTROLS
  // ============================================================================
  private generateButtonStyles(): string {
    return `
      .footer {
        padding: ${this.SPACING.lg}px;
        border-top: ${this.BORDER_STYLES.primary};
        display: flex;
        justify-content: flex-end;
        gap: ${this.SPACING.xs}px;
      }
      
      .btn {
        padding: ${this.SPACING.xs}px ${this.SPACING.md}px;
        border: none;
        border-radius: ${this.config.borderRadius};
        cursor: pointer;
        font-size: ${this.FONT_SIZES.body};
        font-weight: 500;
      }
      
      .btn-primary {
        background: ${this.config.primaryColor};
        color: white;
      }
      
      .btn-primary:hover {
        opacity: 0.9;
      }
      
      .btn-primary:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      
      .btn-secondary {
        background: #6c757d;
        color: white;
      }
      
      .btn-secondary:hover {
        opacity: 0.9;
      }
      
      .redaction-controls {
        margin-top: ${this.SPACING.xs}px;
        display: flex;
        gap: ${this.SPACING.xs}px;
      }
      
      .btn-redact,
      .btn-clear {
        padding: ${this.SPACING.xs}px ${this.SPACING.md}px;
        border: ${this.BORDER_STYLES.light};
        border-radius: ${this.config.borderRadius};
        background: white;
        cursor: pointer;
        font-size: ${this.FONT_SIZES.body};
      }
      
      .btn-redact:hover,
      .btn-clear:hover {
        background: #f5f5f5;
      }
      
      .btn-redact.active {
        background: ${this.config.primaryColor};
        color: white;
        border-color: ${this.config.primaryColor};
      }
      
      .screenshot-container {
        margin-top: ${this.SPACING.xs}px;
        position: relative;
      }
      
      .screenshot {
        max-width: 100%;
        border: ${this.BORDER_STYLES.light};
        border-radius: ${this.config.borderRadius};
      }
      
      .redaction-canvas {
        position: absolute;
        top: 0;
        left: 0;
        cursor: crosshair;
        border: 2px solid ${this.config.primaryColor};
        border-radius: ${this.config.borderRadius};
      }
    `;
  }

  // ============================================================================
  // COMPONENT STYLES - DEFLECTION PANEL
  // ============================================================================
  private generateDeflectionStyles(): string {
    return `
      .deflection-section {
        margin: ${this.SPACING.sm}px 0 ${this.SPACING.md}px 0;
        padding: ${this.SPACING.md}px;
        background: #eef6ff;
        border: 1px solid #c5e0ff;
        border-radius: ${this.config.borderRadius};
      }
      .deflection-header {
        font-size: ${this.FONT_SIZES.sr};
        font-weight: 600;
        color: #0b5394;
        margin-bottom: ${this.SPACING.sm}px;
      }
      .deflection-list {
        display: flex;
        flex-direction: column;
        gap: ${this.SPACING.xs}px;
      }
      .deflection-card {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: ${this.SPACING.sm}px;
        background: #ffffff;
        border: 1px solid #d6e6f7;
        border-radius: ${this.config.borderRadius};
      }
      .deflection-card.confirmed {
        background: #e8f4ec;
        border-color: #5fa97a;
      }
      .deflection-card-body {
        flex: 1;
        min-width: 0;
      }
      .deflection-card-title {
        font-size: ${this.FONT_SIZES.body};
        color: #1a1a1a;
        font-weight: 500;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .deflection-card-status {
        font-size: ${this.FONT_SIZES.small};
        color: #5a5a5a;
        margin-top: 2px;
      }
      .deflection-card-actions {
        display: flex;
        gap: ${this.SPACING.xs}px;
        margin-left: ${this.SPACING.sm}px;
      }
      .deflection-btn-same,
      .deflection-btn-different {
        padding: 4px 10px;
        font-size: ${this.FONT_SIZES.small};
        border-radius: ${this.config.borderRadius};
        border: 1px solid #c8c8c8;
        background: #fff;
        cursor: pointer;
      }
      .deflection-btn-same {
        border-color: #5fa97a;
        color: #2a6b46;
      }
      .deflection-btn-same:hover {
        background: #e8f4ec;
      }
      .deflection-btn-different:hover {
        background: #f4f3ef;
      }
    `;
  }

  // ============================================================================
  // COMPONENT STYLES - PII DETECTION
  // ============================================================================
  private generatePIIStyles(): string {
    return `
      .pii-section {
        margin-top: ${this.SPACING.lg}px;
        padding: ${this.SPACING.md}px;
        background: #fff3cd;
        border: 1px solid #ffc107;
        border-radius: ${this.config.borderRadius};
      }
      
      .pii-title {
        margin: 0 0 ${this.SPACING.xs}px 0;
        font-size: ${this.FONT_SIZES.body};
        font-weight: 600;
        color: #856404;
      }
      
      .pii-list {
        margin: 0;
        padding-left: 20px;
        font-size: ${this.FONT_SIZES.sr};
        color: #856404;
      }
      
      .pii-badge {
        display: inline-block;
        padding: 2px 8px;
        margin: 2px;
        background: #ffc107;
        color: #856404;
        border-radius: 12px;
        font-size: ${this.FONT_SIZES.small};
        font-weight: 500;
      }
    `;
  }

  // ============================================================================
  // COMPONENT STYLES - LOADING STATE
  // ============================================================================
  private generateLoadingStyles(): string {
    return `
      .btn.loading {
        position: relative;
        padding-left: 2.5rem;
      }
      
      .btn.loading::after {
        content: '';
        position: absolute;
        width: 16px;
        height: 16px;
        top: 50%;
        left: 1rem;
        margin-top: -8px;
        border: 2px solid transparent;
        border-top-color: currentColor;
        border-radius: 50%;
        animation: spinner 0.6s linear infinite;
      }
      
      @keyframes spinner {
        to { transform: rotate(360deg); }
      }
    `;
  }

  // ============================================================================
  // COMPONENT STYLES - ACCESSIBILITY
  // ============================================================================
  private generateAccessibilityStyles(): string {
    return `
      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border-width: 0;
      }
    `;
  }

  // ============================================================================
  // RESPONSIVE STYLES - TABLET (≤768px)
  // ============================================================================
  private generateTabletResponsiveStyles(): string {
    return `
      @media (max-width: ${this.BREAKPOINTS.tablet}px) {
        .modal {
          width: 95%;
          max-width: ${this.MODAL_SIZES.tablet};
        }
        
        .header {
          padding: ${this.SPACING.md}px;
        }
        
        .body {
          padding: ${this.SPACING.md}px;
        }
        
        .footer {
          padding: ${this.SPACING.md}px;
        }
        
        /* Prevent iOS zoom on input focus (requires 16px minimum) */
        .input,
        .textarea {
          padding: ${this.SPACING.xs}px;
          font-size: 16px;
        }
        
        .textarea {
          min-height: 80px;
        }
      }
    `;
  }

  // ============================================================================
  // RESPONSIVE STYLES - MOBILE (≤480px)
  // ============================================================================
  private generateMobileResponsiveStyles(): string {
    return `
      @media (max-width: ${this.BREAKPOINTS.mobile}px) {
        .modal {
          width: ${this.MODAL_SIZES.mobilePercent};
          max-width: 100%;
          max-height: 95vh;
        }
        
        .header {
          padding: ${this.SPACING.sm}px;
        }
        
        .header h2 {
          font-size: ${this.FONT_SIZES.h2Mobile};
        }
        
        .body {
          padding: ${this.SPACING.sm}px;
        }
        
        .footer {
          padding: ${this.SPACING.sm}px;
          flex-direction: column;
        }
        
        .btn {
          width: 100%;
          padding: ${this.SPACING.md}px;
        }
        
        .input,
        .textarea {
          padding: ${this.SPACING.xs}px;
        }
        
        .textarea {
          resize: none;
        }
        
        .redaction-controls {
          flex-direction: column;
        }
        
        .btn-redact,
        .btn-clear {
          width: 100%;
        }
        
        .pii-section {
          padding: ${this.SPACING.sm}px;
          margin-top: ${this.SPACING.md}px;
        }
        
        .label {
          font-size: ${this.FONT_SIZES.labelMobile};
        }
        
        .close {
          width: 28px;
          height: 28px;
          font-size: 20px;
        }
      }
    `;
  }

  /**
   * Inject styles into document head
   */
  injectStyles(): HTMLStyleElement {
    const styleElement = document.createElement('style');
    styleElement.textContent = this.generateStyles();
    document.head.appendChild(styleElement);
    return styleElement;
  }

  /**
   * Remove injected styles
   */
  removeStyles(styleElement: HTMLStyleElement): void {
    if (styleElement && styleElement.parentNode) {
      styleElement.parentNode.removeChild(styleElement);
    }
  }

  /**
   * Update configuration and regenerate styles
   */
  updateConfig(config: Partial<StyleConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration
   */
  getConfig(): Required<StyleConfig> {
    return { ...this.config };
  }
}
