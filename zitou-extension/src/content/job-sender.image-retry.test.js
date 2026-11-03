'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function extractAsyncMethod(source, name) {
  const marker = 'async ' + name + '(';
  const start = source.indexOf(marker);
  assert.ok(start >= 0, 'missing production method ' + name);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('unterminated production method ' + name);
}

function extractFunction(source, name) {
  const marker = 'function ' + name + '(';
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
const methodSource = extractAsyncMethod(source, 'sendImage')
  .replace(/^async sendImage\(/, 'async function sendImage(');
const sendOnceSource = extractAsyncMethod(source, '_sendImageOnce')
  .replace(/^async _sendImageOnce\(/, 'async function sendImageOnce(');
const inspectSource = extractFunction(source, 'inspectNewImageBubble');

function makeHarness(options) {
  options = options || {};
  const sendOnceResults = (options.sendOnceResults || []).slice();
  const confirmResults = (options.confirmResults || []).slice();
  const observedResults = (options.observedResults || []).slice();
  const deliveredPrechecks = (options.deliveredPrechecks || []).slice();
  const baselineCounts = (options.baselineCounts || []).slice();
  let sendOnceCalls = 0;
  let confirmCalls = 0;
  let precheckCalls = 0;
  let observeCalls = 0;
  const attemptBaselines = [];
  const context = {
    SELECTORS: { chatDetail: { messageSent: '.item-myself' } },
    document: {
      querySelectorAll: () => new Array(baselineCounts.length ? baselineCounts.shift() : 0),
    },
    findDeliveredImageBubble() {
      precheckCalls++;
      return deliveredPrechecks.length ? deliveredPrechecks.shift() : false;
    },
    inspectNewImageBubble() {
      observeCalls++;
      return observedResults.shift() || { found: false, status: 'pending', seen: 'none' };
    },
    sleep: async () => {},
    waitForImageDelivered: async () => {
      confirmCalls++;
      return confirmResults.shift() || { status: 'timeout', seen: 'cdn' };
    },
    CONFIG: { IMG_UPLOAD_TIMEOUT_MS: 15000 },
  };
  vm.createContext(context);
  const sendImage = vm.runInContext('(' + methodSource + ')', context);
  const sender = {
    async _sendImageOnce(_blob, _filename, _jobId, attemptBaseline) {
      sendOnceCalls++;
      attemptBaselines.push(attemptBaseline);
      return sendOnceResults.shift() || { success: false, status: 'timeout', seen: 'none' };
    },
  };
  return {
    run: (opts) => sendImage.call(sender, {}, 'resume.jpg', 'job-1', opts),
    get sendOnceCalls() { return sendOnceCalls; },
    get confirmCalls() { return confirmCalls; },
    get precheckCalls() { return precheckCalls; },
    get observeCalls() { return observeCalls; },
    get attemptBaselines() { return attemptBaselines; },
  };
}

test('cdn timeout then delayed delivery confirms without second dispatch', async () => {
  const h = makeHarness({
    sendOnceResults: [{ success: false, status: 'timeout', seen: 'cdn' }],
    confirmResults: [{ status: 'delivery', seen: 'cdn' }],
  });
  const result = await h.run({ timeoutMs: 5000, maxAttempts: 2, retryDelayMs: 600 });
  assert.equal(result.success, true);
  assert.equal(result.status, 'delivery');
  assert.equal(h.sendOnceCalls, 1);
  assert.equal(h.confirmCalls, 1);
  assert.equal(h.precheckCalls, 1);
});

test('cdn timeout that stays timeout fails without second dispatch', async () => {
  const h = makeHarness({
    sendOnceResults: [{ success: false, status: 'timeout', seen: 'cdn' }],
    confirmResults: [{ status: 'timeout', seen: 'cdn' }],
  });
  const result = await h.run({ timeoutMs: 5000, maxAttempts: 3, retryDelayMs: 600 });
  assert.equal(result.success, false);
  assert.equal(result.status, 'timeout');
  assert.equal(result.seen, 'cdn');
  assert.equal(h.sendOnceCalls, 1);
  assert.equal(h.confirmCalls, 1);
});

test('blob timeout uses confirmation-only and never redispatches', async () => {
  const h = makeHarness({
    sendOnceResults: [{ success: false, status: 'timeout', seen: 'blob' }],
    confirmResults: [{ status: 'delivery', seen: 'cdn' }],
  });
  const result = await h.run({ timeoutMs: 5000, maxAttempts: 2, retryDelayMs: 600 });
  assert.equal(result.success, true);
  assert.equal(h.sendOnceCalls, 1);
  assert.equal(h.confirmCalls, 1);
});

test('bubble_no_img timeout uses confirmation-only and never redispatches', async () => {
  const h = makeHarness({
    sendOnceResults: [{ success: false, status: 'timeout', seen: 'bubble_no_img' }],
    confirmResults: [{ status: 'timeout', seen: 'blob' }],
  });
  const result = await h.run({ timeoutMs: 5000, maxAttempts: 2, retryDelayMs: 600 });
  assert.equal(result.success, false);
  assert.equal(result.seen, 'blob');
  assert.equal(h.sendOnceCalls, 1);
  assert.equal(h.confirmCalls, 1);
});

test('none timeout switches to confirmation-only when bubble appears during retry delay', async () => {
  const h = makeHarness({
    sendOnceResults: [{ success: false, status: 'timeout', seen: 'none' }],
    observedResults: [{ found: true, status: 'pending', seen: 'blob' }],
    confirmResults: [{ status: 'delivery', seen: 'cdn' }],
  });
  const result = await h.run({ timeoutMs: 5000, maxAttempts: 2, retryDelayMs: 600 });
  assert.equal(result.success, true);
  assert.equal(h.sendOnceCalls, 1);
  assert.equal(h.confirmCalls, 1);
  assert.equal(h.observeCalls, 1);
});

test('none timeout with late explicit error safely redispatches from a fresh baseline', async () => {
  const h = makeHarness({
    sendOnceResults: [
      { success: false, status: 'timeout', seen: 'none' },
      { success: true, status: 'delivery', seen: 'cdn' },
    ],
    observedResults: [{ found: true, status: 'error', seen: 'error' }],
    baselineCounts: [0, 0, 1],
  });
  const result = await h.run({ timeoutMs: 5000, maxAttempts: 2, retryDelayMs: 600 });
  assert.equal(result.success, true);
  assert.equal(result.seen, 'cdn');
  assert.equal(h.sendOnceCalls, 2);
  assert.equal(h.confirmCalls, 0);
  assert.deepEqual(h.attemptBaselines, [0, 1]);
});

test('pure observation helper recognizes late blob and bubble_without_img', () => {
  let items = [];
  const context = {
    SELECTORS: { chatDetail: { messageSent: '.item-myself' } },
    document: { querySelectorAll: () => items },
  };
  vm.createContext(context);
  const inspect = vm.runInContext('(' + inspectSource + ')', context);
  const makeBubble = (src) => ({
    querySelector(selector) {
      if (selector === '.message-status') return { className: 'message-status status-loading' };
      if (selector === 'img') return src == null ? null : { src };
      throw new Error('unexpected selector ' + selector);
    },
  });
  items = [makeBubble(null), makeBubble('blob:late-image')];
  let observed = inspect(1);
  assert.equal(observed.found, true);
  assert.equal(observed.status, 'pending');
  assert.equal(observed.seen, 'blob');
  items = [makeBubble(null), makeBubble(null)];
  observed = inspect(1);
  assert.equal(observed.found, true);
  assert.equal(observed.seen, 'bubble_no_img');
});

test('explicit error keeps existing retry dispatch', async () => {
  const h = makeHarness({
    sendOnceResults: [
      { success: false, status: 'error', seen: 'error' },
      { success: true, status: 'delivery', seen: 'cdn' },
    ],
    baselineCounts: [0, 0, 1],
  });
  const result = await h.run({ timeoutMs: 5000, maxAttempts: 2, retryDelayMs: 600 });
  assert.equal(result.success, true);
  assert.equal(result.status, 'delivery');
  assert.equal(h.sendOnceCalls, 2);
  assert.equal(h.confirmCalls, 0);
  assert.deepEqual(h.attemptBaselines, [0, 1]);
});

test('timeout with seen none keeps existing retry dispatch', async () => {
  const h = makeHarness({
    sendOnceResults: [
      { success: false, status: 'timeout', seen: 'none' },
      { success: true, status: 'delivery', seen: 'cdn' },
    ],
  });
  const result = await h.run({ timeoutMs: 5000, maxAttempts: 2, retryDelayMs: 600 });
  assert.equal(result.success, true);
  assert.equal(result.status, 'delivery');
  assert.equal(h.sendOnceCalls, 2);
  assert.equal(h.confirmCalls, 0);
});

test('_sendImageOnce really propagates seen metadata from confirmation', async () => {
  let dispatched = 0;
  class FakeInput {}
  Object.defineProperty(FakeInput.prototype, 'files', {
    set(value) { this.assignedFiles = value; },
  });
  const input = new FakeInput();
  input.dispatchEvent = () => { dispatched++; };
  class FakeDataTransfer {
    constructor() {
      this.files = [];
      this.items = { add: (file) => { this.files.push(file); } };
    }
  }
  const context = {
    SELECTORS: { chatDetail: { imageUpload: '.upload', messageSent: '.item-myself' } },
    document: {
      querySelector: () => input,
      querySelectorAll: () => [],
    },
    waitForImageDelivered: async () => ({ status: 'timeout', seen: 'blob' }),
    File: class FakeFile {},
    DataTransfer: FakeDataTransfer,
    HTMLInputElement: FakeInput,
    Event: class FakeEvent {},
    CONFIG: { IMG_UPLOAD_TIMEOUT_MS: 15000 },
    console: { warn() {} },
  };
  vm.createContext(context);
  const sendImageOnce = vm.runInContext('(' + sendOnceSource + ')', context);
  const result = await sendImageOnce.call({}, {}, 'resume.jpg', 'job-1', 0, 5000);
  assert.equal(result.success, false);
  assert.equal(result.status, 'timeout');
  assert.equal(result.seen, 'blob');
  assert.equal(dispatched, 2);
});
