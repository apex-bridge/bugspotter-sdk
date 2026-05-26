/**
 * DeflectionDisplay
 *
 * Renders the "we may already know about this" panel inline in the
 * widget. Owns a small piece of state: which canonical the user
 * confirmed (if any). Exposes that to the modal at submit time.
 *
 * Data-loss-proof contract: this component never touches the title
 * input or description textarea. It only mutates its own subtree
 * (the deflection container passed in at construction).
 */

import { statusLabel, type DeflectionMatch } from '@bugspotter/common';

export interface DeflectionDisplayCallbacks {
  /**
   * Fired when the user clicks "Yes, this is the same as #X" on a
   * match chip. Modal uses this to set the confirmed canonical for
   * submit. Called with `null` when the user clicks "No, different"
   * to clear a prior confirmation.
   */
  onConfirmedChange: (canonicalId: string | null) => void;
}

export class DeflectionDisplay {
  private container: HTMLElement;
  private callbacks: DeflectionDisplayCallbacks;
  private confirmedCanonicalId: string | null = null;

  constructor(container: HTMLElement, callbacks: DeflectionDisplayCallbacks) {
    this.container = container;
    this.callbacks = callbacks;
  }

  /**
   * Render the matches list. Replaces any prior content but does NOT
   * touch the rest of the form. An empty matches array hides the
   * panel entirely.
   */
  render(matches: DeflectionMatch[]): void {
    // If the user already confirmed and the new match set no longer
    // includes that canonical, drop the confirmation so we don't
    // submit a stale duplicate_of.
    if (
      this.confirmedCanonicalId &&
      !matches.some((m) => m.canonical_id === this.confirmedCanonicalId)
    ) {
      this.confirmedCanonicalId = null;
      this.callbacks.onConfirmedChange(null);
    }

    if (matches.length === 0) {
      this.container.style.display = 'none';
      this.container.innerHTML = '';
      return;
    }

    const cards = matches
      .map((m) =>
        this.renderCard(m, m.canonical_id === this.confirmedCanonicalId)
      )
      .join('');

    this.container.style.display = 'block';
    this.container.innerHTML = `
      <div class="deflection-header">We may already know about this</div>
      <div class="deflection-list">${cards}</div>
    `;

    this.attachListeners(matches);
  }

  /**
   * Force-clear the panel. Called on modal close / reset.
   */
  clear(): void {
    this.confirmedCanonicalId = null;
    this.container.style.display = 'none';
    this.container.innerHTML = '';
  }

  /**
   * Read-only accessor for the modal's submit path. `null` means the
   * user didn't confirm any match.
   */
  getConfirmedCanonicalId(): string | null {
    return this.confirmedCanonicalId;
  }

  private renderCard(match: DeflectionMatch, isConfirmed: boolean): string {
    return `
      <div class="deflection-card${isConfirmed ? ' confirmed' : ''}" data-canonical-id="${this.escapeHtml(
        match.canonical_id
      )}">
        <div class="deflection-card-body">
          <div class="deflection-card-title">${this.escapeHtml(match.title)}</div>
          <div class="deflection-card-status">${this.escapeHtml(statusLabel(match.status))}</div>
        </div>
        <div class="deflection-card-actions">
          <button type="button" class="deflection-btn-same" data-action="confirm">
            ${isConfirmed ? '✓ Same' : 'Same'}
          </button>
          <button type="button" class="deflection-btn-different" data-action="reject">
            Different
          </button>
        </div>
      </div>
    `;
  }

  private attachListeners(matches: DeflectionMatch[]): void {
    const cards =
      this.container.querySelectorAll<HTMLElement>('.deflection-card');
    cards.forEach((card) => {
      const canonicalId = card.dataset.canonicalId;
      if (!canonicalId) return;
      const confirmBtn = card.querySelector<HTMLButtonElement>(
        '[data-action="confirm"]'
      );
      const rejectBtn = card.querySelector<HTMLButtonElement>(
        '[data-action="reject"]'
      );
      confirmBtn?.addEventListener('click', () => {
        this.handleConfirm(canonicalId, matches);
      });
      rejectBtn?.addEventListener('click', () => {
        this.handleReject(canonicalId, matches);
      });
    });
  }

  private handleConfirm(canonicalId: string, matches: DeflectionMatch[]): void {
    // Single-select: confirming a card clears any prior confirmation.
    // Confirming the SAME card again toggles it off — the user can
    // back out without typing "different" or closing the modal.
    if (this.confirmedCanonicalId === canonicalId) {
      this.confirmedCanonicalId = null;
    } else {
      this.confirmedCanonicalId = canonicalId;
    }
    this.callbacks.onConfirmedChange(this.confirmedCanonicalId);
    this.render(matches);
  }

  private handleReject(canonicalId: string, matches: DeflectionMatch[]): void {
    // "Different" hides this specific match from the current panel.
    // Useful when one chip is clearly wrong but others might still
    // match. We don't propagate this signal back to the API in v1.
    const filtered = matches.filter((m) => m.canonical_id !== canonicalId);
    this.render(filtered);
  }

  private escapeHtml(text: string): string {
    // Must escape quotes too: interpolated into attribute values
    // (data-canonical-id) where unescaped " would break out.
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}
