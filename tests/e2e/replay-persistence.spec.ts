/**
 * Playwright E2E tests for cross-navigation replay persistence.
 *
 * Covers the real-browser paths that jsdom + fake-indexeddb can't
 * exercise authentically: real IndexedDB transactions, real
 * `pagehide` / `visibilitychange` timing, real bfcache eligibility,
 * and real per-tab `sessionStorage` scoping across browser contexts.
 *
 * Maps to the unchecked "Manual:" boxes from PRs #133 / #135 / #136.
 */

// page.evaluate(() => ...) executes in the browser. Most browser
// globals are recognized by the Node ESLint env (document, indexedDB,
// Event) but sessionStorage isn't — declare just that one.
/* global sessionStorage */
import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { pathToFileURL } from 'url';

// file:// URL to the fixture page. We must use a real origin (not
// about:blank) because modern Chromium denies sessionStorage /
// IndexedDB access on opaque origins, which the SDK's tab-scoping
// path depends on. pathToFileURL handles Windows drive letters,
// backslash → forward-slash, and special-char escaping correctly.
const FIXTURE_URL = pathToFileURL(
  path.join(process.cwd(), 'tests/fixtures/replay-persistence-page.html')
).href;

// Separate fixture used as the "navigate away" target in the bfcache
// test. about:blank as the target races Playwright's own internal
// navigation on Firefox + Webkit, producing "Navigation interrupted"
// errors — a real file:// URL is unambiguous.
const FIXTURE_OTHER_URL = pathToFileURL(
  path.join(process.cwd(), 'tests/fixtures/replay-persistence-other.html')
).href;

/** Navigate to the fixture page + inject the built SDK bundle. */
async function loadFixtureAndSdk(page: Page): Promise<void> {
  await page.goto(FIXTURE_URL);
  await injectSdkBundle(page);
}

/**
 * Inject the built SDK bundle into the page. Errors propagate as-is
 * (Playwright surfaces ENOENT clearly for a missing file; wrapping
 * would mask Target-closed / navigation-interrupt errors with a
 * misleading "build first" message).
 */
async function injectSdkBundle(page: Page): Promise<void> {
  await page.addScriptTag({
    path: path.join(process.cwd(), 'dist/bugspotter.min.js'),
  });
}

/**
 * Initialize BugSpotter with replay persistence enabled. Returns the
 * effective `dbName` (host base + per-tab sessionStorage suffix) so
 * tests can probe IDB directly.
 */
async function initWithPersistence(
  page: Page,
  baseDbName: string
): Promise<string> {
  await page.evaluate(async (db) => {
    const BS = (window as any).BugSpotter;
    await BS.init({
      showWidget: false,
      replay: {
        enabled: true,
        persistAcrossNavigation: true,
        dbName: db,
      },
    });
  }, baseDbName);
  // The SDK postfixes a per-tab suffix from sessionStorage.
  const effectiveDbName = await page.evaluate((db) => {
    const tabId = sessionStorage.getItem('__bugspotter_tab_id__');
    return tabId ? `${db}-${tabId}` : db;
  }, baseDbName);
  return effectiveDbName;
}

/**
 * Poll the IDB store until the count condition is met or the timeout
 * expires. Replaces fixed `waitForTimeout` after operations whose
 * effect is observable as a record-count change — resolves the moment
 * the change lands, avoiding the local-fast-CI-slow flake hazard.
 *
 * `op='gte'` waits for count >= target (used after a flush that should
 * land records). `op='eq'` waits for the exact count (used after
 * readAndClear that should leave 0). Returns the final count whether
 * or not the condition was met, so the caller's assertion still
 * surfaces a clear "expected X, got Y" failure on timeout.
 */
async function waitForReplayCount(
  page: Page,
  dbName: string,
  target: number,
  op: 'gte' | 'eq' = 'gte',
  timeoutMs = 2000
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  while (Date.now() < deadline) {
    // page.evaluate can throw "Target closed" / "Execution context
    // was destroyed" if the call lands during a page.reload() or
    // page.goto() — that's the exact window we're polling through
    // in the reload + bfcache tests. Swallow + retry rather than
    // letting transient navigation errors abort the loop.
    try {
      last = await readReplayCount(page, dbName);
      const matched = op === 'gte' ? last >= target : last === target;
      if (matched) return last;
    } catch {
      // Page context unavailable; retry next tick.
    }
    // Node setTimeout (not page.waitForTimeout) because the page
    // may be mid-navigation — waitForTimeout against a closing
    // context would itself throw.
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return last;
}

/**
 * Poll the SDK's in-memory rrweb buffer until at least `minCount`
 * events are present, or the timeout expires. Replaces fixed
 * post-click `waitForTimeout` for "give rrweb a tick to emit" —
 * polls the buffer length directly, no flake risk on slow CI.
 * Returns the final count whether or not the condition was met.
 */
async function waitForBufferEvents(
  page: Page,
  minCount: number,
  timeoutMs = 2000
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  while (Date.now() < deadline) {
    try {
      last = await page.evaluate(() => {
        const inst = (window as any).BugSpotter.getInstance();
        return inst?.captureManager?.domCollector?.getEvents?.().length ?? 0;
      });
      if (last >= minCount) return last;
    } catch {
      // Page context unavailable mid-navigation; retry next tick.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return last;
}

/** Probe the IDB store for record count, or -1 on any failure. */
async function readReplayCount(page: Page, dbName: string): Promise<number> {
  return page.evaluate((db) => {
    return new Promise<number>((resolve) => {
      // indexedDB.open can throw SecurityError synchronously in
      // private-browsing / storage-blocked envs; honor the helper's
      // "-1 on any failure" contract instead of letting the Promise
      // executor reject.
      try {
        const req = indexedDB.open(db);
        // If the DB doesn't exist yet (e.g. probe runs before any
        // SDK flush), indexedDB.open WOULD create an empty DB at
        // version 1 with no object stores. A subsequent SDK init
        // at the same version would then NOT fire onupgradeneeded
        // and assume stores exist — fail with NotFoundError on
        // first tx. Abort the upgrade so we don't leave that
        // phantom. (In current tests SDK init happens first and
        // creates the stores; this is defensive against future
        // tests that probe pre-init.)
        req.onupgradeneeded = () => {
          try {
            req.transaction?.abort();
          } catch {
            // already aborted/finished
          }
        };
        req.onerror = () => resolve(-1);
        req.onsuccess = () => {
          const idbDb = req.result;
          if (!idbDb.objectStoreNames.contains('replay-events')) {
            idbDb.close();
            resolve(0);
            return;
          }
          // idbDb.transaction() / objectStore() / count() can throw
          // synchronously (InvalidStateError on a closing connection,
          // TransactionInactiveError, etc.). Without a try/catch the
          // Promise executor never settles and the polling loop hangs
          // at Playwright's default timeout.
          try {
            const tx = idbDb.transaction('replay-events', 'readonly');
            const store = tx.objectStore('replay-events');
            const countReq = store.count();
            countReq.onsuccess = () => {
              idbDb.close();
              resolve(countReq.result);
            };
            countReq.onerror = () => {
              idbDb.close();
              resolve(-1);
            };
          } catch {
            idbDb.close();
            resolve(-1);
          }
        };
      } catch {
        resolve(-1);
      }
    });
  }, dbName);
}

/** Dispatch a synthetic visibilitychange event with the given state. */
async function dispatchVisibilityChange(
  page: Page,
  state: 'visible' | 'hidden'
): Promise<void> {
  await page.evaluate((s) => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => s,
    });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

/**
 * Tear down any prior SDK instance before each test so state doesn't
 * bleed across the suite, and use a fresh dbName per test to keep
 * IDB scope clean.
 */
test.describe('Replay Persistence — Real Browser', () => {
  test.beforeEach(async ({ page }) => {
    page.on('pageerror', (err) => console.error('[Browser Error]:', err));
  });

  test('full reload restores prior-session events from IDB', async ({
    page,
  }) => {
    await loadFixtureAndSdk(page);
    const dbName = await initWithPersistence(page, 'e2e-reload');

    // Generate replay events the rrweb recorder will buffer. Poll
    // the in-memory buffer until both clicks have landed — no fixed
    // sleep, won't flake on slow CI.
    await page.click('#btn-a');
    await page.click('#btn-b');
    await waitForBufferEvents(page, 2);

    // Trigger pagehide-equivalent flush via visibilitychange (more
    // deterministic than page.reload's pagehide which can race the
    // browser's IDB teardown on close). Poll for the count to land
    // rather than a fixed wait — resolves immediately when the
    // flush chain settles, won't flake on slow CI.
    await dispatchVisibilityChange(page, 'hidden');
    const beforeCount = await waitForReplayCount(page, dbName, 1);
    expect(beforeCount).toBeGreaterThan(0);

    // Real page reload — destroys the in-memory rrweb buffer.
    // page.reload() already reloads FIXTURE_URL; only the SDK
    // bundle injection has to be repeated post-reload. Calling
    // loadFixtureAndSdk here would redundantly page.goto the same
    // URL we just reloaded, racing the post-reload state.
    await page.reload();
    await injectSdkBundle(page);

    // Re-init with same dbName triggers restore(). Restored events
    // land in the buffer; IDB is wiped atomically by readAndClear.
    // Poll for the IDB-empty state rather than a fixed wait.
    await initWithPersistence(page, 'e2e-reload');
    const afterClearCount = await waitForReplayCount(page, dbName, 0, 'eq');
    expect(afterClearCount).toBe(0);

    const replayLen = await page.evaluate(() => {
      const inst = (window as any).BugSpotter.getInstance();
      // Internal access for test inspection; the public capture()
      // would also surface this but adds noise.
      return inst?.captureManager?.domCollector?.getEvents?.().length ?? 0;
    });
    // At least one restored event is present. We don't pin the exact
    // count because rrweb's pruning + CircularBuffer.prune may drop
    // older events relative to the duration window.
    expect(replayLen).toBeGreaterThan(0);
  });

  test('two tabs in same context have isolated dbNames via sessionStorage tab id', async ({
    context,
  }) => {
    // Both pages use the SAME baseDbName but should resolve to
    // DIFFERENT effective dbNames because sessionStorage is per-tab.
    const page1 = await context.newPage();
    await loadFixtureAndSdk(page1);
    const tab1Db = await initWithPersistence(page1, 'e2e-tabs');

    const page2 = await context.newPage();
    await loadFixtureAndSdk(page2);
    const tab2Db = await initWithPersistence(page2, 'e2e-tabs');

    // Different sessionStorage values per tab → different suffixes.
    const tab1Id = await page1.evaluate(() =>
      sessionStorage.getItem('__bugspotter_tab_id__')
    );
    const tab2Id = await page2.evaluate(() =>
      sessionStorage.getItem('__bugspotter_tab_id__')
    );
    expect(tab1Id).not.toBeNull();
    expect(tab2Id).not.toBeNull();
    expect(tab1Id).not.toBe(tab2Id);
    expect(tab1Db).not.toBe(tab2Db);
    // Format pinned by the SDK: `<base>-<8 alphanum chars>`.
    expect(tab1Db).toMatch(/^e2e-tabs-[a-z0-9]{8}$/);
    expect(tab2Db).toMatch(/^e2e-tabs-[a-z0-9]{8}$/);

    // Cross-contamination probe: events from tab 1 must NOT land in
    // tab 2's IDB. Generate events in tab 1 only, flush, then check
    // both IDB stores.
    await page1.click('#btn-a');
    await page1.click('#btn-b');
    await waitForBufferEvents(page1, 2);
    await dispatchVisibilityChange(page1, 'hidden');

    // Tab 1's count polls until the flush lands. Tab 2's count is a
    // negative assertion (should stay 0), so a single read after
    // tab 1 has settled is sufficient — we just need tab 1's flush
    // to have completed without cross-contaminating tab 2.
    const tab1Count = await waitForReplayCount(page1, tab1Db, 1);
    const tab2Count = await readReplayCount(page2, tab2Db);
    expect(tab1Count).toBeGreaterThan(0);
    expect(tab2Count).toBe(0);

    await page1.close();
    await page2.close();
  });

  test('visibilitychange to hidden triggers IDB flush; visible does not', async ({
    page,
  }) => {
    await loadFixtureAndSdk(page);
    const dbName = await initWithPersistence(page, 'e2e-visibility');

    await page.click('#btn-a');
    await page.click('#btn-b');
    await waitForBufferEvents(page, 2);

    // Negative case first: visibilityState='visible' must NOT flush.
    // Negative-assert with a single read after a small settle delay;
    // there's no condition to poll for "stayed 0" beyond waiting a
    // beat.
    await dispatchVisibilityChange(page, 'visible');
    await page.waitForTimeout(200);
    expect(await readReplayCount(page, dbName)).toBe(0);

    // Positive case: hidden → flush lands. Poll for the count to
    // arrive rather than waiting a fixed interval.
    await dispatchVisibilityChange(page, 'hidden');
    const afterHidden = await waitForReplayCount(page, dbName, 1);
    expect(afterHidden).toBeGreaterThan(0);

    // Dedup contract: events already flushed must NOT be re-written
    // by a subsequent flush. The slice 3 watermark guarantees each
    // event lands in IDB exactly once. We can't assert strict count
    // equality because rrweb emits low-frequency background events
    // (mousemove sampling, periodic snapshots) between the two
    // dispatches — those legitimately add to the count. But the
    // count must NOT roughly double, which is what a missing-watermark
    // bug would produce. Keep a fixed wait here: the assertion is
    // "no doubling", which can't be expressed as a polling condition.
    await dispatchVisibilityChange(page, 'hidden');
    await page.waitForTimeout(200);
    const afterSecondHidden = await readReplayCount(page, dbName);
    expect(afterSecondHidden).toBeLessThan(afterHidden * 2);
    expect(afterSecondHidden - afterHidden).toBeLessThanOrEqual(5);
  });

  test('persistAcrossNavigation off = no bugspotter IDB database is created', async ({
    page,
  }) => {
    await loadFixtureAndSdk(page);
    // Same SDK init but WITHOUT persistAcrossNavigation. We use a
    // baseDbName to verify it's harmlessly ignored.
    await page.evaluate(async () => {
      const BS = (window as any).BugSpotter;
      await BS.init({
        showWidget: false,
        replay: {
          enabled: true,
          dbName: 'e2e-disabled', // present but flag is off
        },
      });
    });

    await page.click('#btn-a');
    await waitForBufferEvents(page, 1);
    await dispatchVisibilityChange(page, 'hidden');
    await page.waitForTimeout(200);

    // No tab id should have been written to sessionStorage either
    // (deriveTabScopedDbName never runs without the flag).
    const tabId = await page.evaluate(() =>
      sessionStorage.getItem('__bugspotter_tab_id__')
    );
    expect(tabId).toBeNull();

    // Probe `indexedDB.databases()` where supported. Skip the
    // negative-list assertion on browsers that don't expose it
    // (Safari was the laggard; modern Webkit supports it but older
    // builds may not).
    const dbs = await page.evaluate(async () => {
      if (typeof (indexedDB as any).databases !== 'function') return null;
      const list = await indexedDB.databases();
      return list.map((d) => d.name).filter((n): n is string => !!n);
    });
    if (dbs === null) {
      test.info().annotations.push({
        type: 'skip-detail',
        description:
          'indexedDB.databases() not supported; cannot assert no-db negative',
      });
      return;
    }
    expect(dbs.filter((n) => n.startsWith('e2e-disabled'))).toEqual([]);
    expect(dbs.filter((n) => n.startsWith('bugspotter'))).toEqual([]);
  });

  test('back-forward navigation does not duplicate events on next flush', async ({
    context,
  }) => {
    // bfcache behavior is browser- and configuration-dependent
    // (HTTPS or localhost, no unload listener, etc.). file:// and
    // about:blank typically disqualify, but the watermark + chain
    // mechanisms protect against the duplication scenario whether
    // bfcache activated or not — that's what we assert.
    const page = await context.newPage();
    await loadFixtureAndSdk(page);
    const dbName = await initWithPersistence(page, 'e2e-bfcache');

    await page.click('#btn-a');
    await waitForBufferEvents(page, 1);
    await dispatchVisibilityChange(page, 'hidden');
    const initialCount = await waitForReplayCount(page, dbName, 1);
    expect(initialCount).toBeGreaterThan(0);

    // Navigate to a different fixture (real navigation, triggers
    // real pagehide). Using a file:// URL rather than about:blank
    // because Firefox + Webkit can race Playwright's own internal
    // navigation on about:blank, producing "interrupted" errors.
    await page.goto(FIXTURE_OTHER_URL);

    // Navigate back. If bfcache activated, page is restored from
    // memory; otherwise this is a cold reload. Playwright's goBack
    // returns when the navigation completes (no fixed wait needed).
    await page.goBack();

    // Whether bfcache hit or cold reload, the page is alive again.
    // Re-inject + re-init in case it was a cold reload (no-op on
    // bfcache restore where window.BugSpotter still exists).
    const sdkAlive = await page.evaluate(
      () => typeof (window as any).BugSpotter !== 'undefined'
    );
    if (!sdkAlive) {
      await injectSdkBundle(page);
      await initWithPersistence(page, 'e2e-bfcache');
    }

    // Trigger another flush. The dedup watermark + bfcache pageshow
    // reset (slice 3) should prevent duplication regardless of which
    // path the browser took. Kept as a fixed wait because the IDB
    // count trajectory differs across bfcache-hit (monotonic growth)
    // vs cold-reload (dip to 0 via readAndClear, then back up) — no
    // single polling target captures "the flush has settled" for
    // both paths.
    // Wait for the NEW click to land relative to pre-click state —
    // bfcache-hit means buffer already has many events, so polling
    // for ">= 1" alone would resolve instantly without actually
    // waiting for btn-b. Snapshot before, poll for the delta.
    const preClickCount = await page.evaluate(() => {
      const inst = (window as any).BugSpotter.getInstance();
      return inst?.captureManager?.domCollector?.getEvents?.().length ?? 0;
    });
    await page.click('#btn-b');
    await waitForBufferEvents(page, preClickCount + 1);
    await dispatchVisibilityChange(page, 'hidden');
    await page.waitForTimeout(300);

    const finalCount = await readReplayCount(page, dbName);
    // We don't pin the exact count (bfcache hit vs cold reload
    // produce different totals), but the count must NOT be a
    // multiple-of-initial blow-up indicating duplication.
    // Sanity bound: a single button click is on the order of 5-15
    // rrweb events; doubling would be ~2x initialCount + new clicks.
    // We assert the final count is bounded by initialCount + a
    // reasonable delta for the new button click.
    expect(finalCount).toBeLessThan(initialCount + 50);
    await page.close();
  });
});
