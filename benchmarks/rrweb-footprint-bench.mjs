// Real benchmark for BugSpotter SDK + rrweb resource footprint.
// Run: node benchmarks/rrweb-footprint-bench.mjs
// Output: JSON to stdout with raw measurements (multi-run, median + min/max).

import { chromium } from '@playwright/test';

const URL = 'https://demo.kz.bugspotter.io/buggy-app.html';
const SDK_URL = 'https://cdn.bugspotter.io/sdk/bugspotter-latest.min.js';
const RUNS = 5;          // measurements per scenario (after warmup discard)
const WARMUP = 1;        // additional run discarded as JIT warmup
const IDLE_SECONDS = 10;
const HEADLESS = false;  // headful: real Chrome window, more representative of production user runtime

const log = (...a) => console.error('[bench]', ...a);
const median = arr => {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const stats = arr => ({
  n: arr.length,
  median: median(arr),
  min: Math.min(...arr),
  max: Math.max(...arr),
  raw: arr,
});

async function waitForSDK(page, timeout = 15000) {
  return page.waitForFunction(
    () => typeof window.BugSpotter !== 'undefined'
            && (typeof window.BugSpotter.getInstance === 'function')
            && window.BugSpotter.getInstance() !== null,
    null,
    { timeout },
  ).catch(() => false);
}

async function maybeGC(page) {
  try {
    await page.evaluate(() => { if (typeof window.gc === 'function') window.gc(); });
  } catch {}
}

async function measureBundle(browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('about:blank');

  const result = await page.evaluate(async (sdkUrl) => {
    const t0 = performance.now();
    const r = await fetch(sdkUrl);
    const t1 = performance.now();
    const buf = await r.arrayBuffer();
    const gz = await new Response(
      new Blob([buf]).stream().pipeThrough(new CompressionStream('gzip'))
    ).arrayBuffer();
    return {
      cdn_status: r.status,
      cdn_content_encoding: r.headers.get('content-encoding'),
      cdn_content_length_header: r.headers.get('content-length'),
      cdn_fetch_ms: t1 - t0,
      raw_bytes: buf.byteLength,        // uncompressed after browser decodes
      gz_bytes_local: gz.byteLength,    // CompressionStream level-6 result
    };
  }, SDK_URL);

  await ctx.close();
  return result;
}

async function measureHeapDelta(browser) {
  const withoutResults = [];
  const withResults = [];

  for (let i = 0; i < RUNS + WARMUP; i++) {
    // A: page with SDK BLOCKED (route abort)
    const ctxA = await browser.newContext();
    await ctxA.route('**/bugspotter*.js*', route => route.abort());
    await ctxA.route('**/cdn.bugspotter.io/**', route => route.abort());
    const pageA = await ctxA.newPage();
    await pageA.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
    await pageA.waitForTimeout(500);
    await maybeGC(pageA);
    await pageA.waitForTimeout(200);
    const heapA = await pageA.evaluate(() =>
      performance.memory ? performance.memory.usedJSHeapSize : null
    );
    await ctxA.close();

    // B: page with SDK loading normally
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await pageB.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
    const sdkOk = await waitForSDK(pageB);
    await pageB.waitForTimeout(1000); // let initial snapshot settle
    await maybeGC(pageB);
    await pageB.waitForTimeout(200);
    const heapB = await pageB.evaluate(() =>
      performance.memory ? performance.memory.usedJSHeapSize : null
    );
    await ctxB.close();

    if (i < WARMUP) {
      log(`heap warmup run ${i + 1}: without=${heapA} with=${heapB} (discarded)`);
      continue;
    }
    log(`heap run ${i - WARMUP + 1}: without=${heapA} with=${heapB} delta=${heapB - heapA}`);
    withoutResults.push(heapA);
    withResults.push(heapB);
  }

  return {
    without_sdk_bytes: stats(withoutResults),
    with_sdk_bytes: stats(withResults),
    delta_bytes: stats(withResults.map((b, i) => b - withoutResults[i])),
    note: 'performance.memory is Chrome-only and reported in coarse buckets; differences <0.5 MB are below instrument resolution.',
  };
}

async function measureLongTasksIdle(browser) {
  const observations = [];

  for (let i = 0; i < RUNS + WARMUP; i++) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'networkidle' });
    const sdkOk = await waitForSDK(page);

    await page.evaluate(() => {
      window.__lt = [];
      const obs = new PerformanceObserver(list => {
        for (const e of list.getEntries()) window.__lt.push(e.duration);
      });
      try { obs.observe({ entryTypes: ['longtask'] }); } catch {}
    });

    await page.waitForTimeout(IDLE_SECONDS * 1000);
    const lt = await page.evaluate(() => window.__lt || []);
    await ctx.close();

    if (i < WARMUP) {
      log(`idle warmup run ${i + 1}: long_tasks=${lt.length} (discarded)`);
      continue;
    }
    log(`idle run ${i - WARMUP + 1}: long_tasks=${lt.length} max_duration_ms=${lt.length ? Math.max(...lt) : 0}`);
    observations.push({
      count: lt.length,
      max_ms: lt.length ? Math.max(...lt) : 0,
      total_ms: lt.reduce((a, b) => a + b, 0),
      durations_ms: lt,
    });
  }

  return {
    idle_seconds: IDLE_SECONDS,
    runs: observations,
    summary: {
      median_count: median(observations.map(o => o.count)),
      max_observed_count: Math.max(...observations.map(o => o.count)),
      median_total_ms: median(observations.map(o => o.total_ms)),
    },
    caveat: 'Long Tasks API by spec only catches tasks ≥50 ms. Sub-50 ms work is invisible to this measurement.',
  };
}

async function measureLongTasksInteraction(browser) {
  const observations = [];

  for (let i = 0; i < RUNS + WARMUP; i++) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'networkidle' });
    const sdkOk = await waitForSDK(page);

    await page.evaluate(() => {
      window.__lt = [];
      const obs = new PerformanceObserver(list => {
        for (const e of list.getEntries()) window.__lt.push(e.duration);
      });
      try { obs.observe({ entryTypes: ['longtask'] }); } catch {}
    });

    // ~30 seconds of scripted activity: clicks, mouse moves, scrolls
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      const x = 100 + Math.floor(Math.random() * 600);
      const y = 100 + Math.floor(Math.random() * 400);
      try {
        await page.mouse.move(x, y);
        if (Math.random() < 0.3) await page.mouse.click(x, y, { delay: 5 });
        if (Math.random() < 0.2) await page.evaluate(() => window.scrollBy(0, 30));
      } catch {}
      await page.waitForTimeout(150 + Math.floor(Math.random() * 100));
    }

    await page.waitForTimeout(500); // settle
    const lt = await page.evaluate(() => window.__lt || []);
    await ctx.close();

    if (i < WARMUP) {
      log(`interaction warmup ${i + 1}: long_tasks=${lt.length} (discarded)`);
      continue;
    }
    log(`interaction run ${i - WARMUP + 1}: long_tasks=${lt.length} max_ms=${lt.length ? Math.max(...lt).toFixed(1) : 0}`);
    observations.push({
      count: lt.length,
      max_ms: lt.length ? Math.max(...lt) : 0,
      total_ms: lt.reduce((a, b) => a + b, 0),
      durations_ms: lt,
    });
  }

  return {
    interaction_seconds: 30,
    runs: observations,
    summary: {
      median_count: median(observations.map(o => o.count)),
      max_observed_count: Math.max(...observations.map(o => o.count)),
      median_total_ms: median(observations.map(o => o.total_ms)),
      median_max_ms: median(observations.map(o => o.max_ms)),
    },
    caveat: 'Long Tasks API only catches tasks ≥50 ms. Activity was scripted via Playwright mouse/scroll APIs; real users generate higher event frequency.',
  };
}

async function measureEventsAndSnapshot(browser) {
  const observations = [];

  for (let i = 0; i < RUNS + WARMUP; i++) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'networkidle' });
    const sdkOk = await waitForSDK(page);

    await page.waitForTimeout(1000);

    // Generate some events
    for (let j = 0; j < 15; j++) {
      const x = 150 + j * 25;
      const y = 150 + (j % 3) * 50;
      try {
        await page.mouse.move(x, y);
        await page.mouse.click(x, y, { delay: 5 });
      } catch {}
      await page.waitForTimeout(150);
    }
    for (let j = 0; j < 5; j++) {
      await page.evaluate(() => window.scrollBy(0, 40));
      await page.waitForTimeout(200);
    }
    await page.waitForTimeout(1000);

    const data = await page.evaluate(async () => {
      const inst = window.BugSpotter.getInstance();
      if (!inst) return { error: 'no instance' };
      const cm = inst.captureManager;
      if (!cm) return { error: 'no captureManager' };
      const dc = cm.domCollector;
      if (!dc) return { error: 'no domCollector' };

      let events = [];
      try { events = dc.getEvents(); } catch (e) { return { error: 'getEvents threw: ' + e.message }; }

      // rrweb event types: 0=DomContentLoaded, 1=Load, 2=FullSnapshot, 3=IncrementalSnapshot, 4=Meta, 5=Custom, 6=Plugin
      const snapshotEvent = events.find(e => e && e.type === 2);
      const incrementalEvents = events.filter(e => e && e.type === 3);
      const metaEvents = events.filter(e => e && e.type === 4);
      const otherEvents = events.filter(e => e && e.type !== 2 && e.type !== 3 && e.type !== 4);

      const gz = async (str) => {
        const buf = await new Response(
          new Blob([str]).stream().pipeThrough(new CompressionStream('gzip'))
        ).arrayBuffer();
        return buf.byteLength;
      };

      const snapshotRaw = snapshotEvent ? JSON.stringify(snapshotEvent).length : 0;
      const snapshotGz = snapshotEvent ? await gz(JSON.stringify(snapshotEvent)) : 0;
      const incrementalJson = incrementalEvents.length ? JSON.stringify(incrementalEvents) : '[]';
      const incrementalRaw = incrementalEvents.length ? incrementalJson.length : 0;
      const incrementalGz = incrementalEvents.length ? await gz(incrementalJson) : 0;
      const allJson = JSON.stringify(events);
      const allGz = await gz(allJson);

      // Per-type counts for transparency
      const typeBreakdown = {};
      for (const e of events) {
        if (!e) continue;
        typeBreakdown[e.type] = (typeBreakdown[e.type] || 0) + 1;
      }

      return {
        total_events: events.length,
        event_type_breakdown: typeBreakdown,
        full_snapshot: {
          present: !!snapshotEvent,
          raw_bytes: snapshotRaw,
          gz_bytes: snapshotGz,
        },
        meta_events: metaEvents.length,
        other_events: otherEvents.length,
        incremental: {
          count: incrementalEvents.length,
          total_raw_bytes: incrementalRaw,
          total_gz_bytes: incrementalGz,
          avg_raw_per_event: incrementalEvents.length ? Math.round(incrementalRaw / incrementalEvents.length) : 0,
          avg_gz_per_event_batched: incrementalEvents.length ? Math.round(incrementalGz / incrementalEvents.length) : 0,
        },
        all_events: {
          total_raw_bytes: allJson.length,
          total_gz_bytes: allGz,
        },
      };
    });

    await ctx.close();

    if (i < WARMUP) {
      log(`events warmup ${i + 1}: ${JSON.stringify(data)} (discarded)`);
      continue;
    }
    log(`events run ${i - WARMUP + 1}: total=${data.total_events} snapshot_raw=${data.full_snapshot?.raw_bytes}B incr=${data.incremental?.count} gz_batched=${data.incremental?.avg_gz_per_event_batched}B/event types=${JSON.stringify(data.event_type_breakdown)}`);
    observations.push(data);
  }

  return {
    runs: observations,
    summary: {
      total_events: stats(observations.map(o => o.total_events)),
      full_snapshot_raw_bytes: stats(observations.map(o => o.full_snapshot?.raw_bytes ?? 0)),
      full_snapshot_gz_bytes: stats(observations.map(o => o.full_snapshot?.gz_bytes ?? 0)),
      incremental_count: stats(observations.map(o => o.incremental?.count ?? 0)),
      incremental_avg_raw_per_event: stats(observations.map(o => o.incremental?.avg_raw_per_event ?? 0)),
      incremental_avg_gz_per_event_batched: stats(observations.map(o => o.incremental?.avg_gz_per_event_batched ?? 0)),
      all_events_total_gz_bytes: stats(observations.map(o => o.all_events?.total_gz_bytes ?? 0)),
    },
    caveat: 'Per-event gzip values are batch averages — gzip dictionary reuse amortizes per-event cost across an event stream. Quoting "per-event gzipped" is meaningful only with batch context.',
  };
}

async function main() {
  const startTs = new Date().toISOString();
  log(`Starting benchmark — URL=${URL} runs=${RUNS} (+${WARMUP} warmup) headless=${HEADLESS}`);

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ['--js-flags=--expose-gc', '--no-sandbox'],
  });

  const results = { meta: { url: URL, runs_per_measurement: RUNS, warmup_runs: WARMUP, started: startTs } };

  try {
    log('1/5 measuring bundle size...');
    results.bundle = await measureBundle(browser);

    log('2/5 measuring heap delta (multi-run with route abort vs normal)...');
    results.heap = await measureHeapDelta(browser);

    log('3/5 measuring Long Tasks during 10s idle...');
    results.long_tasks_idle = await measureLongTasksIdle(browser);

    log('4/5 measuring Long Tasks during 30s scripted interaction...');
    results.long_tasks_interaction = await measureLongTasksInteraction(browser);

    log('5/5 measuring events captured + DOM snapshot size...');
    results.events_and_snapshot = await measureEventsAndSnapshot(browser);
  } catch (err) {
    log(`benchmark failed: ${err.message}`);
    results.error = err.stack;
  } finally {
    await browser.close();
  }

  results.meta.finished = new Date().toISOString();
  console.log(JSON.stringify(results, null, 2));
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
