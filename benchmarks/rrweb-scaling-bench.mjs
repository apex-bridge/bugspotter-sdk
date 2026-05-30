// Scaling + CPU-throttle benchmark for BugSpotter SDK + rrweb.
// Tests how footprint scales with DOM size, with and without 4× CPU throttling
// (simulates mid-tier mobile / older laptop).
//
// Run from bugspotter-sdk/: pnpm exec node benchmarks/rrweb-scaling-bench.mjs

import { chromium } from '@playwright/test';

const URL = 'https://demo.kz.bugspotter.io/buggy-app.html';
const RUNS_PER_SCENARIO = 3;
const HEADLESS = false;
const INTERACTION_SECONDS = 10;

// Scenarios: [injected_node_count, cpu_throttle_rate]
// 0 injected = demo as-is (~274 nodes). Throttle 1 = no throttle, 4 = 4× slower CPU.
const SCENARIOS = [
  { injected: 0, throttle: 1, label: 'baseline (274 nodes), no throttle' },
  { injected: 0, throttle: 4, label: 'baseline (274 nodes), 4× CPU throttle' },
  { injected: 1000, throttle: 1, label: '1000 injected rows, no throttle' },
  { injected: 1000, throttle: 4, label: '1000 injected rows, 4× CPU throttle' },
  { injected: 5000, throttle: 1, label: '5000 injected rows, no throttle' },
  { injected: 5000, throttle: 4, label: '5000 injected rows, 4× CPU throttle' },
  { injected: 10000, throttle: 1, label: '10000 injected rows, no throttle' },
  { injected: 10000, throttle: 4, label: '10000 injected rows, 4× CPU throttle' },
  { injected: 20000, throttle: 1, label: '20000 injected rows, no throttle' },
  { injected: 20000, throttle: 4, label: '20000 injected rows, 4× CPU throttle' },
];

const log = (...a) => console.error('[scaling]', ...a);
const median = arr => {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

async function setupCPUThrottle(context, page, rate) {
  if (rate <= 1) return;
  const session = await context.newCDPSession(page);
  await session.send('Emulation.setCPUThrottlingRate', { rate });
}

async function waitForSDK(page, timeout = 30000) {
  return page.waitForFunction(
    () => typeof window.BugSpotter !== 'undefined'
            && typeof window.BugSpotter.getInstance === 'function'
            && window.BugSpotter.getInstance() !== null,
    null,
    { timeout },
  ).catch(() => false);
}

async function injectNodes(page, count) {
  if (count <= 0) return;
  await page.evaluate(N => {
    const container = document.createElement('div');
    container.id = 'bench-heavy-injected';
    container.style.cssText = 'position:absolute;left:-9999px;width:1px;';
    const frag = document.createDocumentFragment();
    for (let i = 0; i < N; i++) {
      const row = document.createElement('div');
      row.className = 'bench-row';
      const span = document.createElement('span');
      span.textContent = `r${i}`;
      const a = document.createElement('a');
      a.href = '#';
      a.textContent = `link ${i}`;
      const p = document.createElement('p');
      p.textContent = `content for row ${i} lorem ipsum`;
      row.appendChild(span);
      row.appendChild(a);
      row.appendChild(p);
      frag.appendChild(row);
    }
    container.appendChild(frag);
    document.body.appendChild(container);
  }, count);
  await page.waitForTimeout(200);
}

async function restartRecording(page) {
  return page.evaluate(() => {
    try {
      const inst = window.BugSpotter.getInstance();
      const dc = inst?.captureManager?.domCollector;
      if (!dc) return { error: 'no domCollector' };
      const methods = {};
      methods.has_stop = typeof dc.stopRecording === 'function';
      methods.has_start = typeof dc.startRecording === 'function';
      methods.has_clear = typeof dc.clearBuffer === 'function';
      if (methods.has_stop) dc.stopRecording();
      if (methods.has_clear) dc.clearBuffer();
      if (methods.has_start) dc.startRecording();
      return { ok: true, methods };
    } catch (e) {
      return { error: e.message };
    }
  });
}

async function scriptedInteraction(page, seconds) {
  const t0 = Date.now();
  while (Date.now() - t0 < seconds * 1000) {
    const x = 100 + Math.floor(Math.random() * 600);
    const y = 100 + Math.floor(Math.random() * 400);
    try {
      await page.mouse.move(x, y);
      if (Math.random() < 0.3) await page.mouse.click(x, y, { delay: 5 });
      if (Math.random() < 0.2) await page.evaluate(() => window.scrollBy(0, 30));
    } catch {}
    await page.waitForTimeout(200 + Math.floor(Math.random() * 100));
  }
}

async function measureScenario(browser, scenario) {
  const results = [];
  for (let run = 0; run < RUNS_PER_SCENARIO; run++) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await setupCPUThrottle(ctx, page, scenario.throttle);

    let phase = 'goto';
    try {
      const t0 = Date.now();
      await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
      const sdkOk = await waitForSDK(page);
      if (!sdkOk) {
        await ctx.close();
        results.push({ run: run + 1, error: 'SDK never ready' });
        continue;
      }

      phase = 'inject';
      await injectNodes(page, scenario.injected);

      phase = 'restart-recording';
      const restartInfo = await restartRecording(page);
      await page.waitForTimeout(1500); // let new FullSnapshot capture

      // Long Tasks observer (after restart, includes interaction window)
      phase = 'setup-observer';
      await page.evaluate(() => {
        window.__lt = [];
        const obs = new PerformanceObserver(list => {
          for (const e of list.getEntries()) window.__lt.push(e.duration);
        });
        try { obs.observe({ entryTypes: ['longtask'] }); } catch {}
      });

      phase = 'interact';
      await scriptedInteraction(page, INTERACTION_SECONDS);
      await page.waitForTimeout(500);

      phase = 'collect';
      const data = await page.evaluate(async () => {
        const inst = window.BugSpotter.getInstance();
        const dc = inst?.captureManager?.domCollector;
        const events = dc ? dc.getEvents() : [];

        const totalDomNodes = document.querySelectorAll('*').length;
        const heap = performance.memory ? performance.memory.usedJSHeapSize : null;
        const lt = window.__lt || [];

        const snapshot = events.find(e => e && e.type === 2);
        const incremental = events.filter(e => e && e.type === 3);

        const gz = async (str) => {
          const buf = await new Response(
            new Blob([str]).stream().pipeThrough(new CompressionStream('gzip'))
          ).arrayBuffer();
          return buf.byteLength;
        };

        const snapshotRaw = snapshot ? JSON.stringify(snapshot).length : 0;
        const snapshotGz = snapshot ? await gz(JSON.stringify(snapshot)) : 0;
        const incrementalJson = incremental.length ? JSON.stringify(incremental) : '[]';
        const incrementalRaw = incremental.length ? incrementalJson.length : 0;
        const incrementalGz = incremental.length ? await gz(incrementalJson) : 0;

        const typeBreakdown = {};
        for (const e of events) if (e) typeBreakdown[e.type] = (typeBreakdown[e.type] || 0) + 1;

        return {
          total_dom_nodes: totalDomNodes,
          heap_bytes: heap,
          total_events: events.length,
          event_types: typeBreakdown,
          snapshot_present: !!snapshot,
          snapshot_raw_bytes: snapshotRaw,
          snapshot_gz_bytes: snapshotGz,
          incremental_count: incremental.length,
          incremental_total_raw_bytes: incrementalRaw,
          incremental_total_gz_bytes: incrementalGz,
          incremental_avg_raw: incremental.length ? Math.round(incrementalRaw / incremental.length) : 0,
          incremental_avg_gz_batched: incremental.length ? Math.round(incrementalGz / incremental.length) : 0,
          long_tasks_count: lt.length,
          long_tasks_max_ms: lt.length ? Math.max(...lt) : 0,
          long_tasks_total_ms: lt.reduce((a, b) => a + b, 0),
          long_tasks_durations: lt,
        };
      });

      const elapsed = Date.now() - t0;
      results.push({
        run: run + 1,
        elapsed_ms: elapsed,
        restart_info: restartInfo,
        ...data,
      });
      log(`  run ${run + 1}/${RUNS_PER_SCENARIO}: nodes=${data.total_dom_nodes} heap=${(data.heap_bytes / 1024 / 1024).toFixed(2)}MB snap=${data.snapshot_raw_bytes}B snap_gz=${data.snapshot_gz_bytes}B incr=${data.incremental_count} long_tasks=${data.long_tasks_count} max_lt=${data.long_tasks_max_ms.toFixed(1)}ms`);
    } catch (err) {
      results.push({ run: run + 1, error: `${phase}: ${err.message}` });
      log(`  run ${run + 1} failed at ${phase}: ${err.message}`);
    } finally {
      await ctx.close();
    }
  }

  // Aggregate
  const okRuns = results.filter(r => !r.error && r.heap_bytes != null);
  const agg = (key) => {
    const vals = okRuns.map(r => r[key]).filter(v => typeof v === 'number');
    if (!vals.length) return null;
    return { median: median(vals), min: Math.min(...vals), max: Math.max(...vals) };
  };

  return {
    scenario,
    runs: results,
    aggregated: {
      total_dom_nodes: agg('total_dom_nodes'),
      heap_bytes: agg('heap_bytes'),
      snapshot_raw_bytes: agg('snapshot_raw_bytes'),
      snapshot_gz_bytes: agg('snapshot_gz_bytes'),
      incremental_count: agg('incremental_count'),
      incremental_avg_raw: agg('incremental_avg_raw'),
      incremental_avg_gz_batched: agg('incremental_avg_gz_batched'),
      long_tasks_count: agg('long_tasks_count'),
      long_tasks_max_ms: agg('long_tasks_max_ms'),
      long_tasks_total_ms: agg('long_tasks_total_ms'),
    },
  };
}

async function main() {
  const startTs = new Date().toISOString();
  log(`Starting scaling+throttle benchmark — URL=${URL} runs_per_scenario=${RUNS_PER_SCENARIO} headless=${HEADLESS}`);
  log(`Scenarios: ${SCENARIOS.length} total`);

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ['--js-flags=--expose-gc', '--no-sandbox'],
  });

  const results = {
    meta: {
      url: URL,
      runs_per_scenario: RUNS_PER_SCENARIO,
      interaction_seconds: INTERACTION_SECONDS,
      started: startTs,
    },
    scenarios: [],
  };

  try {
    for (let i = 0; i < SCENARIOS.length; i++) {
      const sc = SCENARIOS[i];
      log(`\nScenario ${i + 1}/${SCENARIOS.length}: ${sc.label}`);
      const result = await measureScenario(browser, sc);
      results.scenarios.push(result);
    }
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
