'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function extractFunction(source, name) {
  const asyncMarker = 'async function ' + name;
  const syncMarker = 'function ' + name;
  let start = source.indexOf(asyncMarker);
  if (start < 0) start = source.indexOf(syncMarker);
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

function loadPreflight(script) {
  const sameJobDetailUrl = vm.runInNewContext(
    '(' + extractFunction(swSource, '_sameJobDetailUrl') + ')'
  );
  const context = {
    chrome: {
      windows: {
        create: async function (opts) {
          script.windowCreateOpts = opts;
          return { id: 23, tabs: [{ id: 17, url: opts.url, active: true }] };
        },
        remove: async function () {},
      },
      tabs: {
        query: async function () { return []; },
        remove: async function () {},
        create: async function (opts) { return { id: 17, url: opts.url }; },
        get: async function () { return script.tabState; },
        sendMessage: async function () { return { ok: true, enabled: false }; },
      },
    },
    state: {},
    MSG: { DISABLE_GREETING_SETTING: 'DISABLE_GREETING_SETTING' },
    DiagLogger: { info: function () {}, warn: function () {} },
    _diagMarkSelfTabOps: function () {},
    _waitTabUrlReady: async function () { return !!script.contentReady; },
    _sameJobDetailUrl: sameJobDetailUrl,
  };
  return vm.runInNewContext('(' + extractFunction(swSource, '_preflightV7') + ')', context);
}

async function run() {
  const firstUrl = 'https://www.zhipin.com/job_detail/abc.html';
  const getReadyPreNavUrl = vm.runInNewContext(
    '(' + extractFunction(swSource, '_getReadyPreNavUrl') + ')'
  );
  const sameJobDetailUrl = vm.runInNewContext(
    '(' + extractFunction(swSource, '_sameJobDetailUrl') + ')'
  );

  assert.strictEqual(sameJobDetailUrl(firstUrl, firstUrl + '?from=preflight#x'), true);
  assert.strictEqual(sameJobDetailUrl(firstUrl + '?securityId=1', firstUrl), true);
  assert.strictEqual(sameJobDetailUrl('https://www.zhipin.com/job_detail/other.html', firstUrl), false);

  // preflight 已确认相同首岗详情页 + CS ready：交回 URL 给循环复用，跳过重复 update。
  {
    const scenario = {
      contentReady: true,
      tabState: { id: 17, url: firstUrl, status: 'complete' },
    };
    const preflight = loadPreflight(scenario);
    const result = await preflight(firstUrl);
    assert.strictEqual(result.loopTabId, 17);
    assert.strictEqual(result.loopWindowId, 23);
    assert.strictEqual(scenario.windowCreateOpts.url, firstUrl);
    assert.strictEqual(scenario.windowCreateOpts.focused, false);
    assert.strictEqual(scenario.windowCreateOpts.state, 'minimized');
    assert.strictEqual(result.firstDetailReady, true);
    assert.strictEqual(getReadyPreNavUrl(result, firstUrl), firstUrl);
  }

  // CS/URL 未真正 ready：不交回预导航 URL，循环会继续现有 update + 15s + 失败重导航。
  {
    const preflight = loadPreflight({
      contentReady: false,
      tabState: { id: 17, url: firstUrl, status: 'complete' },
    });
    const result = await preflight(firstUrl);
    assert.strictEqual(result.firstDetailReady, false);
    assert.strictEqual(getReadyPreNavUrl(result, firstUrl), null);
  }

  // 即使 CS ready，URL 不同也不得复用。
  assert.strictEqual(getReadyPreNavUrl({
    firstDetailReady: true,
    firstDetailUrl: 'https://www.zhipin.com/job_detail/other.html',
  }, firstUrl), null);

  // 静态锁住集成点与首岗状态轮询/原循环 15s 守卫，防止只加 helper 却没接入。
  assert.match(swSource, /var _preflight = await _preflightV7\(firstUrl\);/);
  assert.match(swSource, /var loopTabId = _preflight\.loopTabId;/);
  assert.match(swSource, /var preNavUrl = _getReadyPreNavUrl\(_preflight, firstUrl\);/);
  assert.match(swSource, /var ready = await _waitTabUrlReady\(tab\.id, '\/job_detail\/', 15000\);/);
  assert.match(swSource, /_sameJobDetailUrl\(readyTab\.url, firstDetailUrl\)/);
  assert.doesNotMatch(extractFunction(swSource, '_preflightV7'), /await\s+waitForTabLoad\s*\(/);
  assert.match(swSource, /var detailReady = await _waitTabUrlReady\(loopTabId, '\/job_detail\/', 15000\);/);
  assert.match(swSource, /await chrome\.tabs\.update\(loopTabId, \{ url: detailUrl \}\);[\s\S]*detailReady = await _waitTabUrlReady\(loopTabId, '\/job_detail\/', 15000\);/);

  console.log('service-worker preflight first-detail tests: PASS');
}

run().catch(function (err) {
  console.error(err && err.stack || err);
  process.exitCode = 1;
});
