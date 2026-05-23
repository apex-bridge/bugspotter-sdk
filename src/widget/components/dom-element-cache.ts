/**
 * DOMElementCache
 *
 * Responsibility: Cache DOM element references to avoid repeated querySelector calls
 * Follows SRP: Only handles element reference management
 * Improves Performance: Single querySelector per element
 */

export interface ModalElements {
  overlay: HTMLElement;
  modal: HTMLElement;
  closeButton: HTMLElement;
  form: HTMLFormElement;
  titleInput: HTMLInputElement;
  titleError: HTMLElement;
  descriptionTextarea: HTMLTextAreaElement;
  descriptionError: HTMLElement;
  screenshotImg?: HTMLImageElement;
  redactionCanvas?: HTMLCanvasElement;
  redactButton?: HTMLButtonElement;
  clearButton?: HTMLButtonElement;
  piiSection: HTMLElement;
  piiContent: HTMLElement;
  piiConfirmCheckbox: HTMLInputElement;
  submitError: HTMLElement;
  cancelButton: HTMLButtonElement;
  submitButton: HTMLButtonElement;
  progressStatus: HTMLElement;
  /**
   * Deflection panel container — always in the DOM (the template
   * emits an empty hidden div), populated only when deflection is
   * enabled and the similarity probe returns matches.
   */
  deflectionSection: HTMLElement;
}

export class DOMElementCache {
  private elements: ModalElements | null = null;
  private container: HTMLElement | ShadowRoot | null = null;

  /**
   * Initialize cache from a container element or shadow root
   */
  initialize(container: HTMLElement | ShadowRoot): ModalElements {
    this.container = container;

    const overlay = this.getRequiredElement('.overlay', container);
    const modal = this.getRequiredElement('.modal', overlay);
    const form = this.getRequiredElement('.form', modal) as HTMLFormElement;

    this.elements = {
      overlay,
      modal,
      closeButton: this.getRequiredElement('.close', modal),
      form,
      titleInput: this.getRequiredElement('#title', form) as HTMLInputElement,
      titleError: this.getRequiredElement('#title-error', form),
      descriptionTextarea: this.getRequiredElement(
        '#description',
        form
      ) as HTMLTextAreaElement,
      descriptionError: this.getRequiredElement('#description-error', form),
      screenshotImg: this.getOptionalElement('#screenshot', modal) as
        | HTMLImageElement
        | undefined,
      redactionCanvas: this.getOptionalElement('#redaction-canvas', modal) as
        | HTMLCanvasElement
        | undefined,
      redactButton: this.getOptionalElement('#btn-redact', modal) as
        | HTMLButtonElement
        | undefined,
      clearButton: this.getOptionalElement('#btn-clear', modal) as
        | HTMLButtonElement
        | undefined,
      piiSection: this.getRequiredElement('#pii-section', modal),
      piiContent: this.getRequiredElement('#pii-content', modal),
      piiConfirmCheckbox: this.getRequiredElement(
        '#pii-confirm',
        modal
      ) as HTMLInputElement,
      submitError: this.getRequiredElement('#submit-error', modal),
      cancelButton: this.getRequiredElement(
        '#btn-cancel',
        modal
      ) as HTMLButtonElement,
      submitButton: this.getRequiredElement(
        '#btn-submit',
        modal
      ) as HTMLButtonElement,
      progressStatus: this.getRequiredElement('#progress-status', modal),
      deflectionSection: this.getRequiredElement('#deflection-section', modal),
    };

    return this.elements;
  }

  /**
   * Get cached elements (throws if not initialized)
   */
  get(): ModalElements {
    if (!this.elements) {
      throw new Error(
        'DOMElementCache not initialized. Call initialize() first.'
      );
    }
    return this.elements;
  }

  /**
   * Check if cache is initialized
   */
  isInitialized(): boolean {
    return this.elements !== null;
  }

  /**
   * Clear the cache
   */
  clear(): void {
    this.elements = null;
    this.container = null;
  }

  /**
   * Get a required element (throws if not found)
   */
  private getRequiredElement(
    selector: string,
    parent?: HTMLElement | Document | ShadowRoot
  ): HTMLElement {
    const searchParent = parent || this.container || document;
    const element = searchParent.querySelector(selector) as HTMLElement;
    if (!element) {
      throw new Error(`Required element not found: ${selector}`);
    }
    return element;
  }

  /**
   * Get an optional element (returns undefined if not found)
   */
  private getOptionalElement(
    selector: string,
    parent?: HTMLElement | Document | ShadowRoot
  ): HTMLElement | undefined {
    const searchParent = parent || this.container || document;
    const element = searchParent.querySelector(selector) as HTMLElement;
    return element || undefined;
  }

  /**
   * Refresh a specific element in the cache
   */
  refreshElement(key: keyof ModalElements, selector: string): void {
    if (!this.elements || !this.container) {
      throw new Error('DOMElementCache not initialized');
    }

    const element = this.container.querySelector(selector) as HTMLElement;
    if (element) {
      (this.elements[key] as unknown) = element;
    }
  }

  /**
   * Get container element
   */
  getContainer(): HTMLElement | ShadowRoot | null {
    return this.container;
  }
}
