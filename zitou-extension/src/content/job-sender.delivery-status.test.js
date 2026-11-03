'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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

const sourcePath = path.join(__dirname, 'job-sender.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const functionSource = extractAsyncFunction(source, 'waitForDeliveryStatus');

function bubble(text, statusClass) {
  return {
    textContent: text,
    querySelector(selector) {
      assert.equal(selector, '.message-status');
      return statusClass == null ? null : { className: statusClass };
    },
  };
}

function makeHarness(sequence) {
  let nowMs = 0;
  let pollIndex = 0;
  const context = {
    SELECTORS: { chatDetail: { messageSent: '.item-myself' } },
    document: {
      querySelectorAll(selector) {
        assert.equal(selector, '.item-myself');
        const index = Math.min(pollIndex, sequence.length - 1);
        pollIndex++;
        return sequence[index] || [];
      },
    },
    Date: { now: () => nowMs },
    sleep: async (ms) => { nowMs += ms; },
    Math,
  };
  vm.createContext(context);
  const waitForDeliveryStatus = vm.runInContext('(' + functionSource + ')', context);
  return { waitForDeliveryStatus, get polls() { return pollIndex; } };
}

test('no new bubble remains timeout and reports sanitized observation', async () => {
  const h = makeHarness([[], []]);
  const result = await h.waitForDeliveryStatus(600, 0, '本条招呼语内容用于生成16字符指纹', 2);
  assert.equal(result.status, 'timeout');
  assert.equal(result.meta.attempt, 2);
  assert.equal(result.meta.sawNewBubble, false);
  assert.equal(result.meta.matchedFingerprintBubble, false);
  assert.equal(result.meta.lastMatchedStatus, 'none');
  assert.equal(result.meta.newBubbleCount, 0);
  assert.equal(result.meta.matchedBubbleCount, 0);
  assert.equal(result.meta.pollCount, 2);
  assert.equal(result.meta.elapsedMs, 600);
});

test('matching loading bubble remains timeout without changing verdict', async () => {
  const text = '本条招呼语内容用于生成16字符指纹';
  const h = makeHarness([[bubble(text, 'message-status status-loading')]]);
  const result = await h.waitForDeliveryStatus(600, 0, text, 1);
  assert.equal(result.status, 'timeout');
  assert.equal(result.meta.sawNewBubble, true);
  assert.equal(result.meta.matchedFingerprintBubble, true);
  assert.equal(result.meta.lastMatchedStatus, 'loading');
  assert.equal(result.meta.newBubbleCount, 1);
  assert.equal(result.meta.matchedBubbleCount, 1);
  assert.equal(result.meta.pollCount, 2);
  assert.equal(result.meta.elapsedMs, 600);
});

test('matching delivery bubble remains delivery and returns immediately', async () => {
  const text = '本条招呼语内容用于生成16字符指纹';
  const h = makeHarness([[bubble(text, 'message-status status-delivery')]]);
  const result = await h.waitForDeliveryStatus(600, 0, text, 3);
  assert.equal(result.status, 'delivery');
  assert.equal(result.meta.attempt, 3);
  assert.equal(result.meta.sawNewBubble, true);
  assert.equal(result.meta.matchedFingerprintBubble, true);
  assert.equal(result.meta.lastMatchedStatus, 'delivery');
  assert.equal(result.meta.newBubbleCount, 1);
  assert.equal(result.meta.matchedBubbleCount, 1);
  assert.equal(result.meta.pollCount, 1);
  assert.equal(result.meta.elapsedMs, 0);
  assert.equal(JSON.stringify(result.meta).includes(text.slice(0, 16)), false);
  assert.equal(h.polls, 1);
});
