'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function extractAsyncFunction(source, name) {
  const marker = 'async function ' + name;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, 'missing production function ' + name);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('unterminated production function ' + name);
}

const swPath = path.join(__dirname, 'service-worker.js');
const swSource = fs.readFileSync(swPath, 'utf8');
const fnSource = extractAsyncFunction(swSource, '_waitChatNavigationWithRecovery');
const waitChatNavigation = vm.runInNewContext('(' + fnSource + ')');

function makeDeps(script) {
  let nowMs = 0;
  const calls = { budgets: [], probes: 0, reclicks: 0 };
  const waits = script.waits.slice();
  const probes = (script.probes || []).slice();
  const reclicks = (script.reclicks || []).slice();
  return {
    calls,
    deps: {
      now: function () { return nowMs; },
      waitReady: async function (budgetMs) {
        calls.budgets.push(budgetMs);
        const step = waits.shift();
        assert.ok(step, 'unexpected waitReady call');
        nowMs += step.elapsedMs;
        return step.ready;
      },
      probe: async function () {
        calls.probes++;
        return probes.shift() || { alreadyChatted: false };
      },
      reclick: async function () {
        calls.reclicks++;
        return reclicks.shift() || { ok: false };
      },
      isStopped: function () { return false; },
      logRecovery: function () {},
    },
  };
}

async function run() {
  // 会话已建但导航丢：2.5s 早探测后立即 reclick，不再先等满15s。
  {
    const h = makeDeps({
      waits: [
        { elapsedMs: 2500, ready: false },
        { elapsedMs: 300, ready: true },
      ],
      probes: [{ alreadyChatted: true }],
      reclicks: [{ ok: true }],
    });
    const result = await waitChatNavigation(7, { jobId: 'a' }, 15000, h.deps);
    assert.deepStrictEqual(h.calls.budgets, [2500, 15000]);
    assert.strictEqual(h.calls.probes, 1);
    assert.strictEqual(h.calls.reclicks, 1);
    assert.strictEqual(result.ready, true);
    assert.strictEqual(result.recovered, true);
  }

  // 早探测未建联：不 reclick，继续等原15s总预算的剩余 12.5s。
  {
    const h = makeDeps({
      waits: [
        { elapsedMs: 2500, ready: false },
        { elapsedMs: 4000, ready: true },
      ],
      probes: [{ alreadyChatted: false }],
    });
    const result = await waitChatNavigation(7, { jobId: 'b' }, 15000, h.deps);
    assert.deepStrictEqual(h.calls.budgets, [2500, 12500]);
    assert.strictEqual(h.calls.probes, 1);
    assert.strictEqual(h.calls.reclicks, 0);
    assert.strictEqual(result.ready, true);
    assert.strictEqual(result.recovered, false);
  }

  // 正常导航在早探测前就绪：不探测、不 reclick。
  {
    const h = makeDeps({ waits: [{ elapsedMs: 900, ready: true }] });
    const result = await waitChatNavigation(7, { jobId: 'c' }, 15000, h.deps);
    assert.deepStrictEqual(h.calls.budgets, [2500]);
    assert.strictEqual(h.calls.probes, 0);
    assert.strictEqual(h.calls.reclicks, 0);
    assert.strictEqual(result.ready, true);
    assert.strictEqual(result.recovered, false);
  }

  // 保留原 F2：早探测未建联，15s到期后才变成已建联，仍 reclick 救济。
  {
    const h = makeDeps({
      waits: [
        { elapsedMs: 2500, ready: false },
        { elapsedMs: 12500, ready: false },
        { elapsedMs: 300, ready: true },
      ],
      probes: [{ alreadyChatted: false }, { alreadyChatted: true }],
      reclicks: [{ ok: true }],
    });
    const result = await waitChatNavigation(7, { jobId: 'd' }, 15000, h.deps);
    assert.deepStrictEqual(h.calls.budgets, [2500, 12500, 15000]);
    assert.strictEqual(h.calls.probes, 2);
    assert.strictEqual(h.calls.reclicks, 1);
    assert.strictEqual(result.ready, true);
    assert.strictEqual(result.recovered, true);
  }

  // 用户停止或 phase 已切换：首段等待返回后立即中止，不再探测或 reclick。
  {
    const h = makeDeps({ waits: [{ elapsedMs: 2500, ready: false }] });
    h.deps.isStopped = function () { return true; };
    const result = await waitChatNavigation(7, { jobId: 'e' }, 15000, h.deps);
    assert.deepStrictEqual(h.calls.budgets, [2500]);
    assert.strictEqual(h.calls.probes, 0);
    assert.strictEqual(h.calls.reclicks, 0);
    assert.strictEqual(result.aborted, true);
  }

  console.log('service-worker chat navigation recovery tests: PASS');
}

run().catch(function (err) {
  console.error(err && err.stack || err);
  process.exitCode = 1;
});
