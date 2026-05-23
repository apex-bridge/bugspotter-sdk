/**
 * Tests for the SDK deflection-similarity client.
 *
 * The load-bearing contract this guards:
 *   - Debounce: rapid queries collapse to ONE network call
 *   - AbortController cancellation: in-flight requests are aborted
 *     when a newer query arrives, so stale results never overwrite
 *     newer ones (out-of-order responses on slow networks)
 *   - Soft-fail surface: 4xx, 5xx, network errors, AbortError all
 *     resolve to `[]` — never throw, never reject. The widget must
 *     stay usable.
 *   - Too-short titles (< 5 chars) short-circuit without hitting
 *     the network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DeflectionApi } from '../../src/core/deflection-api';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('DeflectionApi', () => {
  let api: DeflectionApi;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    api = new DeflectionApi({
      endpoint: 'https://api.example.com',
      apiKey: 'bgs_test',
      debounceMs: 100,
      maxMatches: 3,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    api.cancel();
  });

  it('returns matches from the backend on the happy path', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: {
          matches: [
            { canonical_id: 'a', title: 'A', status: 'open', similarity: 0.9 },
          ],
        },
      })
    );

    const p = api.query('login bug');
    await vi.advanceTimersByTimeAsync(150);
    const result = await p;

    expect(result).toEqual([
      { canonical_id: 'a', title: 'A', status: 'open', similarity: 0.9 },
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toContain('/api/v1/sdk/similar');
    expect(init?.method).toBe('POST');
    const body = JSON.parse((init?.body as string) ?? '{}');
    expect(body).toEqual({ title: 'login bug', limit: 3 });
  });

  it('debounces rapid queries to a single fetch (last value wins)', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({ success: true, data: { matches: [] } })
    );

    void api.query('first');
    void api.query('second');
    void api.query('third');
    await vi.advanceTimersByTimeAsync(150);
    // Drain any microtasks the resolved fetch might have queued
    await Promise.resolve();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (fetchSpy.mock.calls[0][1] as RequestInit).body as string
    );
    expect(body.title).toBe('third');
  });

  it('short-circuits to [] for titles below the 5-char minimum', async () => {
    const p = api.query('hi');
    await vi.advanceTimersByTimeAsync(150);
    const result = await p;
    expect(result).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('soft-fails to [] on a non-2xx response (never throws)', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    const p = api.query('valid title');
    await vi.advanceTimersByTimeAsync(150);
    const result = await p;
    expect(result).toEqual([]);
  });

  it('soft-fails to [] on a network error', async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError('Network down'));
    const p = api.query('valid title');
    await vi.advanceTimersByTimeAsync(150);
    const result = await p;
    expect(result).toEqual([]);
  });

  it('cancels the in-flight request when a new query arrives (newer query wins)', async () => {
    // First fetch hangs — newer query should abort it before it resolves.
    let firstAborted = false;
    fetchSpy.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            firstAborted = true;
            // Real fetch rejects with a DOMException named
            // 'AbortError', but a plain Error with that `.name`
            // covers the same code path in our soft-fail check.
            const abortErr = new Error('aborted');
            abortErr.name = 'AbortError';
            reject(abortErr);
          });
        })
    );
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: {
          matches: [
            { canonical_id: 'b', title: 'B', status: 'open', similarity: 0.8 },
          ],
        },
      })
    );

    void api.query('older title');
    await vi.advanceTimersByTimeAsync(150);
    // First fetch is in flight; firing a second should abort it.
    const second = api.query('newer title');
    await vi.advanceTimersByTimeAsync(150);
    const result = await second;

    expect(firstAborted).toBe(true);
    expect(result).toEqual([
      { canonical_id: 'b', title: 'B', status: 'open', similarity: 0.8 },
    ]);
  });

  it('cancel() drops the pending debounce timer (no fetch fires)', async () => {
    void api.query('about to be cancelled');
    api.cancel();
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('clamps result count to maxMatches even if backend over-returns', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: {
          matches: [
            { canonical_id: '1', title: '1', status: 'open', similarity: 0.9 },
            { canonical_id: '2', title: '2', status: 'open', similarity: 0.8 },
            { canonical_id: '3', title: '3', status: 'open', similarity: 0.7 },
            { canonical_id: '4', title: '4', status: 'open', similarity: 0.65 },
            { canonical_id: '5', title: '5', status: 'open', similarity: 0.61 },
          ],
        },
      })
    );
    const p = api.query('legit query');
    await vi.advanceTimersByTimeAsync(150);
    const result = await p;
    expect(result).toHaveLength(3);
  });
});
