/**
 * Tests for `DeflectionDisplay`.
 *
 * Two contracts under guard:
 *  1. Renders matches into ITS OWN container and nothing else (so
 *     the modal's title/description inputs are never touched —
 *     load-bearing "don't lose report data" constraint).
 *  2. User chip interactions surface the right canonical_id via the
 *     onConfirmedChange callback. Same-chip-twice toggles off.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeflectionDisplay } from '../../src/widget/components/deflection-display';
import type { DeflectionMatch } from '@bugspotter/common';

const MATCHES: DeflectionMatch[] = [
  {
    canonical_id: 'bug-1',
    title: 'Login button broken',
    status: 'open',
    similarity: 0.91,
  },
  {
    canonical_id: 'bug-2',
    title: 'Submit form 500s',
    status: 'closed',
    similarity: 0.78,
  },
];

describe('DeflectionDisplay', () => {
  let container: HTMLElement;
  let onConfirmedChange: ReturnType<typeof vi.fn>;
  let display: DeflectionDisplay;
  let sibling: HTMLInputElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    container = document.createElement('div');
    // A sibling element to act as a stand-in for the title input —
    // tests assert this is never touched by render() / confirm /
    // reject. Mirrors the modal's "DOM holds form state" contract.
    sibling = document.createElement('input');
    sibling.id = 'sibling';
    sibling.value = 'user-typed-text';
    document.body.appendChild(sibling);
    document.body.appendChild(container);
    onConfirmedChange = vi.fn();
    display = new DeflectionDisplay(container, { onConfirmedChange });
  });

  it('renders one card per match with title and status', () => {
    display.render(MATCHES);
    const cards = container.querySelectorAll('.deflection-card');
    expect(cards).toHaveLength(2);
    expect(container.textContent).toContain('Login button broken');
    expect(container.textContent).toContain('Submit form 500s');
    // Status label is human-friendly, not the raw value
    expect(container.textContent).toContain('Open');
    expect(container.textContent).toContain('Fixed'); // 'closed' → 'Fixed'
  });

  it('hides the panel when there are zero matches', () => {
    display.render([]);
    expect(container.style.display).toBe('none');
    expect(container.innerHTML).toBe('');
  });

  it('never touches sibling inputs while rendering (the data-loss guard)', () => {
    display.render(MATCHES);
    expect(sibling.value).toBe('user-typed-text');
    display.render([]);
    expect(sibling.value).toBe('user-typed-text');
  });

  it('fires onConfirmedChange with the canonical id when "Same" is clicked', () => {
    display.render(MATCHES);
    const sameBtn = container.querySelector<HTMLButtonElement>(
      '.deflection-card[data-canonical-id="bug-1"] [data-action="confirm"]'
    );
    sameBtn?.click();
    expect(onConfirmedChange).toHaveBeenLastCalledWith('bug-1');
    expect(display.getConfirmedCanonicalId()).toBe('bug-1');
  });

  it('toggles off when the same "Same" chip is clicked twice', () => {
    display.render(MATCHES);
    const sameBtn = container.querySelector<HTMLButtonElement>(
      '.deflection-card[data-canonical-id="bug-1"] [data-action="confirm"]'
    );
    sameBtn?.click();
    // The render after the first confirm replaces buttons — grab the
    // fresh one from the new DOM.
    const sameBtn2 = container.querySelector<HTMLButtonElement>(
      '.deflection-card[data-canonical-id="bug-1"] [data-action="confirm"]'
    );
    sameBtn2?.click();
    expect(onConfirmedChange).toHaveBeenLastCalledWith(null);
    expect(display.getConfirmedCanonicalId()).toBeNull();
  });

  it('switches confirmation when a different chip is clicked', () => {
    display.render(MATCHES);
    container
      .querySelector<HTMLButtonElement>(
        '.deflection-card[data-canonical-id="bug-1"] [data-action="confirm"]'
      )
      ?.click();
    container
      .querySelector<HTMLButtonElement>(
        '.deflection-card[data-canonical-id="bug-2"] [data-action="confirm"]'
      )
      ?.click();
    expect(display.getConfirmedCanonicalId()).toBe('bug-2');
  });

  it('"Different" removes only that chip; others remain', () => {
    display.render(MATCHES);
    container
      .querySelector<HTMLButtonElement>(
        '.deflection-card[data-canonical-id="bug-1"] [data-action="reject"]'
      )
      ?.click();
    const cards = container.querySelectorAll('.deflection-card');
    expect(cards).toHaveLength(1);
    expect(cards[0].getAttribute('data-canonical-id')).toBe('bug-2');
  });

  it('drops a stale confirmation if the new match set no longer includes it', () => {
    display.render(MATCHES);
    container
      .querySelector<HTMLButtonElement>(
        '.deflection-card[data-canonical-id="bug-1"] [data-action="confirm"]'
      )
      ?.click();
    expect(display.getConfirmedCanonicalId()).toBe('bug-1');

    // Backend returns a different match set on the next keystroke —
    // user's prior pick is no longer relevant, must be cleared.
    display.render([
      {
        canonical_id: 'bug-3',
        title: 'Different bug',
        status: 'open',
        similarity: 0.7,
      },
    ]);
    expect(display.getConfirmedCanonicalId()).toBeNull();
    expect(onConfirmedChange).toHaveBeenLastCalledWith(null);
  });

  it('clear() fully resets state (used on modal close)', () => {
    display.render(MATCHES);
    container
      .querySelector<HTMLButtonElement>(
        '.deflection-card[data-canonical-id="bug-1"] [data-action="confirm"]'
      )
      ?.click();
    display.clear();
    expect(container.innerHTML).toBe('');
    expect(display.getConfirmedCanonicalId()).toBeNull();
  });

  it('escapes HTML in titles (no XSS via canonical title)', () => {
    display.render([
      {
        canonical_id: 'bug-x',
        title: '<script>alert(1)</script>',
        status: 'open',
        similarity: 0.9,
      },
    ]);
    // Browser parses the rendered text as text, not as a script tag.
    // The escaped form lands as literal text content.
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
  });
});
