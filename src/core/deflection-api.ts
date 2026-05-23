/**
 * SDK-side client for the deflection similarity probe.
 *
 * Wraps `/api/v1/sdk/similar` with the data-loss-proof contract:
 *   - Debounced fetch (default 400ms) — feels like autocomplete
 *   - AbortController cancels prior request when a new one arrives,
 *     so stale results from earlier keystrokes never overwrite
 *     newer ones (out-of-order responses on slow networks would
 *     otherwise flicker the match list)
 *   - All failures are silent: timeout, network, 4xx, 5xx all
 *     resolve to `{ matches: [] }`. The widget should never surface
 *     a probe error to the end-user.
 *   - Form input DOM values are NEVER touched by this module.
 */
import { getApiBaseUrl } from '../utils/url-helpers';
import { getAuthHeaders } from './transport';
import { getLogger } from '../utils/logger';

const logger = getLogger();

// Hard cap on a single probe — the network call must not stretch the
// user's perceived feedback window. Backend SLO is ~300ms p95, this
// gives ~3x headroom and bails on stalls.
const PROBE_TIMEOUT_MS = 2_000;

export interface DeflectionMatch {
  canonical_id: string;
  title: string;
  status: string;
  similarity: number;
}

export interface DeflectionApiOptions {
  endpoint: string;
  apiKey: string;
  /** Default 400. Set to 0 to disable debouncing (for tests). */
  debounceMs?: number;
  /** Default 3. Clamped to 1..5 by the backend. */
  maxMatches?: number;
}

/**
 * Stateful client — one instance per widget session. Owns the
 * debounce timer and the in-flight AbortController.
 */
export class DeflectionApi {
  private readonly options: Required<DeflectionApiOptions>;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: AbortController | null = null;

  constructor(options: DeflectionApiOptions) {
    this.options = {
      debounceMs: options.debounceMs ?? 400,
      maxMatches: options.maxMatches ?? 3,
      endpoint: options.endpoint,
      apiKey: options.apiKey,
    };
  }

  /**
   * Schedule a similarity probe for the given title text. Cancels
   * any pending probe (debounce) AND any in-flight HTTP request
   * (AbortController). Resolves to the matches when the latest probe
   * lands, or to [] on any failure.
   *
   * The contract: only the MOST RECENT call's promise will receive
   * non-empty results. Earlier calls that get cancelled resolve to
   * [] so consumers don't accidentally render stale matches.
   */
  query(title: string): Promise<DeflectionMatch[]> {
    return new Promise((resolve) => {
      // Drop the in-flight network request first — it might still be
      // racing the new debounce timer. Without this, a slow earlier
      // request could land after a faster newer one and overwrite.
      if (this.inFlight) {
        this.inFlight.abort();
        this.inFlight = null;
      }
      if (this.debounceTimer !== null) {
        clearTimeout(this.debounceTimer);
      }

      // Below the embedding model's useful floor — don't waste a
      // round trip. Matches the backend's own minLength check.
      if (title.trim().length < 5) {
        resolve([]);
        return;
      }

      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        void this.fetchOnce(title).then(resolve);
      }, this.options.debounceMs);
    });
  }

  /**
   * Cancel any pending or in-flight probe. Call on modal close so we
   * don't leak abortable requests across modal sessions.
   */
  cancel(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.inFlight) {
      this.inFlight.abort();
      this.inFlight = null;
    }
  }

  private async fetchOnce(title: string): Promise<DeflectionMatch[]> {
    const controller = new AbortController();
    this.inFlight = controller;
    const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

    try {
      const apiBaseUrl = getApiBaseUrl(this.options.endpoint);
      const url = `${apiBaseUrl}/api/v1/sdk/similar`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders({ apiKey: this.options.apiKey }),
        },
        body: JSON.stringify({
          title,
          limit: this.options.maxMatches,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        // Backend treats most failure modes as `{ matches: [] }` at
        // 200, so a non-2xx here usually means auth / schema / 5xx.
        // All silent.
        logger.debug('Deflection probe non-2xx', { status: response.status });
        return [];
      }

      const data = (await response.json()) as
        | { success?: boolean; data?: { matches?: DeflectionMatch[] } }
        | undefined;
      const matches = data?.data?.matches ?? [];
      // Defensive: if the backend ever returns more than asked for,
      // clamp client-side. Shouldn't happen, but we never want to
      // flood the modal with chips.
      return matches.slice(0, this.options.maxMatches);
    } catch (error) {
      // AbortError fires both on timeout and on cancellation by the
      // next debounce tick — both are expected, no need to log loudly.
      const isAbort = error instanceof Error && error.name === 'AbortError';
      if (!isAbort) {
        logger.debug('Deflection probe failed', {
          errorType: error instanceof Error ? error.name : 'NonErrorThrown',
        });
      }
      return [];
    } finally {
      clearTimeout(timeoutId);
      // Only null out if WE'RE still the in-flight one — a newer
      // probe could have already replaced us.
      if (this.inFlight === controller) {
        this.inFlight = null;
      }
    }
  }
}
