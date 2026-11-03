// Local-first service worker: user-configured AI, no hosted account or billing service.
importScripts('/src/shared/constants.js');
importScripts('/src/shared/error-logger.js');
importScripts('/src/shared/diag-logger.js');
importScripts('/src/shared/greeting-prompt.js');
importScripts('/src/shared/ai-client.js');
async function getBossUidSafe() { return ''; }
async function getBossUidFresh() { return ''; }
async function prepareResumeImages(resumeImages) {
  return JitouAI.imagesToDataUrls(resumeImages);
}
async function generateConfiguredGreeting(category, images, timeoutMs = 120000, opts = {}) {
  return JitouAI.greeting(category, images, { ...opts, timeoutMs });
}
async function resolveResumeTextOnce(images) { return JitouAI.resumeText(images); }
async function rewriteConfiguredGreeting(original, instruction) { return JitouAI.rewrite(original, instruction); }
async function trackEvent() { return false; } // No telemetry is sent.

const DIAGNOSTIC_OUTBOX_MAX = 800;
const DIAGNOSTIC_EVENT_KEYS = [
  'event', 'event_id', 'member_id', 'run_id', 'parent_run_id', 'retry_kind',
  'stage', 'action', 'status', 'reason_code', 'raw_error', 'client_at',
  'duration_ms', 'attempt', 'queue_index', 'queue_total', 'extension_version',
  'browser_version', 'job_id', 'job_name', 'company', 'resume_asset_ref',
];
let _diagnosticMemberId = '';
let _diagnosticRun = null;
let _diagnosticOutboxChain = Promise.resolve();
let _diagnosticFlushRunning = false;
let _diagnosticRetryTimer = null;
let _diagnosticAfterPersist = [];

function _diagnosticId(prefix) {
  try { if (self.crypto && self.crypto.randomUUID) return prefix + '_' + self.crypto.randomUUID(); } catch (_) {}
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 12);
}

function _diagnosticText(value, maxLen) {
  if (value == null) return '';
  var s = String(value)
    .replace(/sk-[A-Za-z0-9]{12,}/gi, 'sk-[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]{8,}/gi, 'Bearer [redacted]')
    .replace(/((?:cookie|token|authorization|signature|secret|api[_-]?key)\s*[=:]\s*)[^\s&,;]+/gi, '$1[redacted]')
    .replace(/([?&](?:sign|signature|token|x-cos-security-token|q-sign-[^=]*)=)[^&#\s]+/gi, '$1[redacted]');
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function _diagnosticEvent(fields) {
  if (!_diagnosticRun || !_diagnosticRun.run_id || !fields || !fields.stage || !fields.action || !fields.status) return null;
  var manifestVersion = '';
  try { manifestVersion = (chrome.runtime.getManifest() || {}).version || ''; } catch (_) {}
  var raw = Object.assign({
    event: 'diagnostic_event',
    event_id: _diagnosticId('evt'),
    member_id: _diagnosticMemberId || _diagnosticRun.member_id || '',
    run_id: _diagnosticRun.run_id,
    parent_run_id: _diagnosticRun.parent_run_id || '',
    retry_kind: _diagnosticRun.retry_kind || '',
    client_at: Date.now(),
    extension_version: manifestVersion,
    browser_version: (typeof navigator !== 'undefined' && navigator.userAgent) ? navigator.userAgent : '',
  }, fields);
  var out = {};
  for (var i = 0; i < DIAGNOSTIC_EVENT_KEYS.length; i++) {
    var key = DIAGNOSTIC_EVENT_KEYS[i];
    var value = raw[key];
    if (value === '' || value == null) continue;
    if (key === 'raw_error') value = _diagnosticText(value, 500);
    else if (key === 'job_name' || key === 'company') value = _diagnosticText(value, 120);
    else if (typeof value === 'string') value = _diagnosticText(value, 240);
    out[key] = value;
  }
  return out;
}

function _diagnosticWithOutbox(mutator) {
  var run = _diagnosticOutboxChain.then(async function () {
    try {
      var got = await chrome.storage.local.get(STORAGE_KEYS.DIAG.EVENT_OUTBOX);
      var queue = Array.isArray(got[STORAGE_KEYS.DIAG.EVENT_OUTBOX]) ? got[STORAGE_KEYS.DIAG.EVENT_OUTBOX] : [];
      var result = mutator(queue) || {};
      if (result.changed) {
        if (queue.length > DIAGNOSTIC_OUTBOX_MAX) queue.splice(0, queue.length - DIAGNOSTIC_OUTBOX_MAX);
        await chrome.storage.local.set({ [STORAGE_KEYS.DIAG.EVENT_OUTBOX]: queue });
      }
      return result.value;
    } catch (_) { return null; }
  });
  _diagnosticOutboxChain = run.catch(function () {});
  return run;
}

async function _diagnosticPost() { return 'drop'; }

async function flushDiagnosticEvents() {} // Diagnostic events stay on this device.

function emitDiagnostic(fields) {
  var event = _diagnosticEvent(fields);
  if (!event) return;
  _diagnosticWithOutbox(function (queue) {
    if (queue.some(function (x) { return x && x.event_id === event.event_id; })) return { value: false };
    queue.push(event);
    return { changed: true, value: true };
  }).then(function (saved) {
    if (saved) flushDiagnosticEvents().catch(function () {});
  }).catch(function () {});
}

// 逐岗事件先等现有业务快照成功写入，再进入诊断 outbox；不让诊断 I/O 反向阻塞业务。
function emitDiagnosticAfterBusinessPersist(fields) {
  try {
    var event = _diagnosticEvent(fields);
    if (event) _diagnosticAfterPersist.push(event);
  } catch (_) {}
}

function _flushDiagnosticsAfterBusinessPersist() {
  var pending = _diagnosticAfterPersist;
  _diagnosticAfterPersist = [];
  for (var i = 0; i < pending.length; i++) {
    (function (event) {
      _diagnosticWithOutbox(function (queue) {
        if (queue.some(function (x) { return x && x.event_id === event.event_id; })) return { value: false };
        queue.push(event);
        return { changed: true, value: true };
      }).then(function (saved) {
        if (saved) flushDiagnosticEvents().catch(function () {});
      }).catch(function () {});
    })(pending[i]);
  }
}

async function _diagnosticPersistRun() {
  if (!_diagnosticRun) return;
  try { await chrome.storage.local.set({ [STORAGE_KEYS.DIAG.ACTIVE_RUN]: _diagnosticRun }); } catch (_) {}
}

function startDiagnosticRun(parentRun, retryKind) {
  _diagnosticRun = {
    run_id: _diagnosticId('run'),
    parent_run_id: parentRun && parentRun.run_id ? parentRun.run_id : '',
    retry_kind: retryKind || '',
    member_id: _diagnosticMemberId || '',
    started_at: Date.now(), status: 'running',
  };
  _diagnosticPersistRun().catch(function () {});
  emitDiagnostic({ stage: 'run', action: 'run_created', status: 'started' });
  return _diagnosticRun;
}

function prepareDiagnosticSendRun(retryKind) {
  if (retryKind) return startDiagnosticRun(_diagnosticRun, retryKind);
  // 正常 START_SEND 沿用采集 run；只在旧版/异常直接发送时建一个最小主 run。
  if (!_diagnosticRun || !_diagnosticRun.run_id) startDiagnosticRun(null, '');
  return _diagnosticRun;
}

function finishDiagnosticRun(reason) {
  if (!_diagnosticRun || _diagnosticRun.terminal_at) return;
  var results = state && Array.isArray(state.sendResults) ? state.sendResults : [];
  var ok = results.filter(function (x) { return x && x.success; }).length;
  var failed = results.filter(function (x) { return x && !x.success && !x.skipped; }).length;
  var explicitFailure = /failed|error/.test(String(reason || ''));
  var action = reason === 'interrupted' ? 'run_interrupted' : (reason === 'stopped' ? 'run_interrupted' : ((explicitFailure || failed) ? 'run_failed' : 'run_completed'));
  var status = reason === 'interrupted' || reason === 'stopped' ? 'interrupted' : ((explicitFailure || failed) ? 'failed' : 'completed');
  _diagnosticRun.status = status;
  _diagnosticRun.terminal_at = Date.now();
  _diagnosticPersistRun().catch(function () {});
  if (status === 'failed' || status === 'interrupted') {
    try {
      chrome.storage.local.set({
        [STORAGE_KEYS.DIAG.LAST_ABNORMAL_RUN]: {
          run_id: _diagnosticRun.run_id,
          terminal_at: _diagnosticRun.terminal_at,
          status: status,
        },
      }).catch(function () {});
    } catch (_) {}
  }
  var terminalEvent = { stage: 'run', action: action, status: status, reason_code: reason || '' };
  // finalizeTask 已排队逐岗事件时，终态必须跟在同一次业务落盘之后，保持时间线顺序。
  if (_diagnosticAfterPersist.length) emitDiagnosticAfterBusinessPersist(terminalEvent);
  else emitDiagnostic(terminalEvent);
}

try {
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local' || !changes[STORAGE_KEYS.DIAG.MEMBER_ID]) return;
    _diagnosticMemberId = String(changes[STORAGE_KEYS.DIAG.MEMBER_ID].newValue || '');
    if (_diagnosticRun && _diagnosticMemberId) {
      _diagnosticRun.member_id = _diagnosticMemberId;
      _diagnosticPersistRun().catch(function () {});
    }
    flushDiagnosticEvents().catch(function () {});
  });
} catch (_) {}

function classifyCollectFailure(error) {
  const message = String((error && error.message) || error || '').toLowerCase();
  if (!message) return '';
  if (message.includes('请先打开 boss') || message.includes('未找到 boss') || message.includes('boss 搜索页')) {
    return 'boss_page_not_ready';
  }
  if (message.includes('receiving end does not exist') || message.includes('could not establish connection') ||
      message.includes('content script') || message.includes('message port closed')) {
    return 'content_script_error';
  }
  if ((error && error.name === 'AbortError') || message.includes('failed to fetch') ||
      message.includes('networkerror') || message.includes('err_network')) {
    return 'network_error';
  }
  return '';
}

function trackDeliveryFinished() {}

async function generateGreeting(apiKey, resumeImages, jdSamples, category) {
 const images = await prepareResumeImages(resumeImages);
 const resumeText = await resolveResumeTextOnce(images);
 return generateConfiguredGreeting(category, images, 120000, { resumeText });
}

// ── Resume image cache (原图 Blob，reused across batch calls) ──
let _cachedResumeImages = null;

async function loadResumeImages() {
  if (_cachedResumeImages !== null) return _cachedResumeImages;

  try {
    const { resumeImages: stored } = await chrome.storage.local.get('resumeImages');
    if (!stored || !Array.isArray(stored) || stored.length === 0) {
      _cachedResumeImages = [];
      return [];
    }

    // (options.js 存 Array.from(Uint8Array(arrayBuffer)))→ 转回原图 Blob 直传,保原分辨率。
    const toProcess = stored.slice(0, 2);
    const results = []; // [{ type, blob, size }]，blob 为原图二进制

    for (const s of toProcess) {
      try {
        const bytes = new Uint8Array(s.data);
        const mimeType = s.type || 'image/png';
        const blob = new Blob([bytes], { type: mimeType });
        results.push({ type: mimeType, blob, size: blob.size });
        console.log('[即投] resume image loaded (原图) size=' + (blob.size / 1024).toFixed(1) + 'KB type=' + mimeType);
      } catch (e) {
        // 单张转 Blob 失败:跳过这张(宁可少一张也不阻断招呼语)。
        console.warn('[即投] resume image to-blob failed, skip:', e.message);
        ErrorLogger.logError(e.message || String(e), e?.stack, 'loadResumeImages to-blob');
      }
    }

    _cachedResumeImages = results;
    return results;
  } catch (e) {
    console.warn('[即投] Failed to load resume images:', e);
    ErrorLogger.logError(e.message || String(e), e?.stack, 'loadResumeImages');
    _cachedResumeImages = [];
    return [];
  }
}

async function rewriteGreeting(apiKey, originalGreeting, instruction) { return rewriteConfiguredGreeting(originalGreeting, instruction); }

// ── 状态管理 ──
let state = {
  phase: 'idle',
  jobs: [],
  greetings: {},
  jobCustom: {},            // per-job 自定义（来自 ui:jobCustom）：{[jobId]:{customGreeting,images,...}}，发送前从 storage 灌入；buildSendQueueV6 按 jobId 取 customGreeting 覆盖组级招呼语
  greetingProgress: { done: 0, total: 0 },
  sendProgress: { sent: 0, total: 0 },
  autoReplyCount: 0,
  sendResults: [],
  sendDuration: 0,
  searchUrlParams: null,    // 原始搜索 URL 参数，发送阶段导航回正确搜索结果页
  chatTabId: null,
  sendQueue: [],        // [{jobId, positionName, companyName, jobLink, greeting}]
  sendIndex: 0,
  searchTabId: null,
  sendPhase: '',            // '' | 'stage1' | 'stage2'
  sendQueueV6: [],          // [{jobId, hrName, hrCompany, greeting, positionName, companyName, encBossId, securityId}]
  sendQueueV6Index: 0,
  _v6WorkerTabIds: [],      // worker tab id 数组
  _v6WorkerWindowIds: [],   // worker tab 所在的独立后台窗口 id 数组
  _v6SearchReady: false,    // 搜索 tab CS 就绪标记
  _v6WorkerTabsReady: new Set(),  // 已就绪的 worker tab id 集合
  _v6RepairQueue: [],       // 发送阶段「对话已找到但内容漏发」的岗位，补发阶段单连接逐个补
  _v6MissedJobs: [],        // A1 漏发清单：已建联(hrName非空)但无任何投递结果的岗位（终态时由 finalizeTask 计算，供 review「一键补发」）
  _v7LoopTabId: null,       // v7 详情派 send-on-open 串行循环用的单个 loop tab id（窗口内 active，窗口最小化）
  _v7LoopWindowId: null,    // v7 独立最小化窗口；保持 tab visible，避免 inactive tab 节流丢图片 WS 帧
  _captchaSlowMode: false,  // 风控自适应退避瞬态标志：本批是否走降速档（每批 startSendV6 开头重置）
  originalMainWindowId: null,
  welfareFilter: '不限',        // 福利精筛：'不限'（不筛）| '五险一金'（严格：已知含→留、已知不含→丢、缺失→放行到投递正文终判）
  welfareUnknownCount: 0,       // 因 welfareList 缺失而放行到投递正文终判的岗位数（供 popup 提示）
  restDayFilter: '不限',        // 双休精筛：'不限'（不筛）| '双休'（严格：标题double→置顶、标题no→丢、标题unknown→放行到投递正文终判）
  restDayUnknownCount: 0,       // 因标题未写工作制而放行到投递正文终判的岗位数（供 popup 提示）
};

// ── 统一 activity gate：更新可提前下载，但只能在业务完全空闲后提交 ──
async function runActivity(kind, task) { return task(); }
function rejectActivityStart() { return false; }

// 中断恢复用：发送过的 jobId 集合
const sentJobIds = new Set();

// 发送批次开始时间（计算总耗时用，不持久化）
let sendStartTime = 0;

// 全局停止标记：发送各阶段边界检查，停了立即 bail
let sendAborted = false;

function claimNextJob(state) {
  if (state.sendQueueV6Index >= state.sendQueueV6.length) return null;
  var job = state.sendQueueV6[state.sendQueueV6Index];
  state.sendQueueV6Index++;
  return job;
}

function buildSendQueueV6(state, jobIds) {
  // 用「期望岗位名」作为 greeting key，与 B 页 / clusterJobs 完全一致
  // （旧实现用 job.tags[0]=BOSS卡片标签当 key，与生成时的岗位名 key 错配 → greeting 取空）
  var picker = Array.isArray(state.selectedPositions) ? state.selectedPositions : [];
  var custom = Array.isArray(state.customPositions) ? state.customPositions : [];
  return jobIds
    .filter(function(id) { return !sentJobIds.has(id); })
    .map(function(id) {
      var job = state.jobs.find(function(j) { return (j.jobId || j.id) === id; });
      if (!job) { console.warn('[即投] buildSendQueueV6: 未找到 job id=' + id); }
      var category = job ? matchJobToPosition(job, picker, custom) : '其他';
      var greeting = state.greetings[category] || '';
      // per-job 自定义招呼语优先：该岗设了非空 customGreeting → 覆盖组级招呼语；为空/未设则保持组级 fallback（行为不变）
      var jcEntry = state.jobCustom && state.jobCustom[id];
      var jcGreeting = jcEntry && typeof jcEntry.customGreeting === 'string' ? jcEntry.customGreeting.trim() : '';
      if (jcGreeting) {
        greeting = jcGreeting;
        try { DiagLogger.info('sw.send', 'buildSendQueueV6：jobId=' + id + ' 用 per-job 自定义招呼语 len=' + jcGreeting.length); } catch (_) {}
      }
      // 五险一金严格终判用：列表阶段 welfareList 已确认含五险一金类标签 → true（投递阶段直接放行，不必扫文本）；
      // welfareList 缺失/未确认 → false（投递阶段走标题∪正文三路终判，全不中则跳过）。
      // 匹配集 = 规格 ['五险一金','六险一金','五险二金']（+全角变体 '五险１金'，对齐 content.hasInsuranceFromText）。
      var _wl = job && job.welfareList;
      var _WELFARE_KW = ['五险一金', '六险一金', '五险二金', '五险１金'];
      var welfareConfirmed = Array.isArray(_wl) && _wl.some(function(w) {
        var ws = String(w);
        return _WELFARE_KW.some(function(kw) { return ws.indexOf(kw) !== -1; });
      });
      // daysPerWeekDesc：工作制字段（双休严格①路），透传到投递阶段终判；缺失为空串（安全跳过①）。
      var daysPerWeekDesc = (job && typeof job.daysPerWeekDesc === 'string') ? job.daysPerWeekDesc : '';
      return {
        jobId: id,
        hrName: '',
        hrCompany: '',
        greeting: greeting,
        positionName: job ? (job.name || job.positionName || '') : '',
        companyName: job ? (job.company || job.companyName || '') : '',
        jobLink: job ? (job.jobLink || 'https://www.zhipin.com/job_detail/' + (job.id || job.jobId) + '.html') : '',
        welfareConfirmed: welfareConfirmed,
        daysPerWeekDesc: daysPerWeekDesc
      };
    });
}

// ── per-job 自定义招呼语：从 ui:jobCustom 灌入 state.jobCustom ──
// buildSendQueueV6 是同步函数，无法自己 await storage；故在每次建队前（startSendV6 / 恢复路径）先异步灌好。
// popup 发送前会强制落盘 ui:jobCustom（绕过 300ms 防抖），保证这里读到的是最新自定义招呼语。
async function loadJobCustomIntoState() {
  try {
    const r = await chrome.storage.local.get(STORAGE_KEYS.UI.JOB_CUSTOM);
    state.jobCustom = r[STORAGE_KEYS.UI.JOB_CUSTOM] || {};
  } catch (_) {
    state.jobCustom = state.jobCustom || {};
  }
}

// ── 空/占位招呼语保险丝 ──
// greeting 为空或等于生成失败占位串的岗位发出去就是空消息（且 repair 阶段无从核对），
// 一律不入队，记一条失败 sendResults（结构对齐 stage1 提取失败的 skipped 记录）。
var GREETING_PLACEHOLDERS = ['生成失败，请刷新', '请重新上传清晰的简历图片'];
function isGreetingMissing(g) {
  var t = (g || '').trim();
  return !t || GREETING_PLACEHOLDERS.indexOf(t) >= 0;
}
function dropMissingGreetingJobs() {
  var dropped = state.sendQueueV6.filter(function(item) { return isGreetingMissing(item.greeting); });
  if (!dropped.length) return;
  state.sendQueueV6 = state.sendQueueV6.filter(function(item) { return !isGreetingMissing(item.greeting); });
  for (var i = 0; i < dropped.length; i++) {
    var d = dropped[i];
    if (sentJobIds.has(d.jobId)) continue; // 已有结果的不重复记
    sentJobIds.add(d.jobId);
    state.sendProgress.sent++;
    state.sendResults.push({
      jobId: d.jobId,
      positionName: d.positionName,
      companyName: d.companyName,
      success: false, skipped: true,
      error: 'AI招呼语缺失，未投递（请刷新重新采集）',
      time: Date.now(),
    });
  }
  console.warn('[即投] 空招呼语保险丝：剔除', dropped.length, '个岗位不入队');
  pushState();
}

// ── 状态持久化：确保 SW 重启后 popup 能恢复 B 页 ──
let persistTimer = null;

// 诊断旁路：从当前内存态抽取脱敏快照摘要（与 diag-export.js buildSnapshot 同口径：
// 招呼语只留长度+前 20 字，绝不 dump apiKey/简历/手机号）。SW 卸载后导出 fallback 读它。
function buildSnapshotSummary() {
  try {
    var snap = {
      ts: Date.now(),
      phase: state.phase,
      sendPhase: state.sendPhase || '',
      jobs: (state.jobs || []).length,
      sendQueueV6: (state.sendQueueV6 || []).length,
      sendQueueV6Index: state.sendQueueV6Index || 0,
      sendProgress: state.sendProgress || {},
      greetingProgress: state.greetingProgress || {},
      selectedPositions: state.selectedPositions || [],
      customPositions: state.customPositions || [],
      hrActiveFilter: state.hrActiveFilter || '不限',
      workerTabs: (state._v6WorkerTabIds || []).length,
      missedJobs: (state._v6MissedJobs || []).length,
      sendResultsCount: (state.sendResults || []).length,
    };
    var g = state.greetings || {};
    snap.greetings = {};
    for (var k in g) {
      if (Object.prototype.hasOwnProperty.call(g, k)) {
        var gv = String(g[k] == null ? '' : g[k]);
        snap.greetings[k] = (gv.length > 20 ? gv.slice(0, 20) + '…' : gv) + ' (len=' + gv.length + ')';
      }
    }
    return snap;
  } catch (e) { return { ts: Date.now(), _snapshotError: String(e && e.message || e) }; }
}

function persistState() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const toSave = {
      [STORAGE_KEYS.SW.PHASE]: state.phase,
      [STORAGE_KEYS.SW.JOBS]: state.jobs,
      [STORAGE_KEYS.SW.GREETINGS]: state.greetings,
      [STORAGE_KEYS.SW.SEND_PROGRESS]: state.sendProgress,
      [STORAGE_KEYS.SW.SENT_JOB_IDS]: Array.from(sentJobIds),
      [STORAGE_KEYS.SW.SEND_RESULTS]: state.sendResults,
      [STORAGE_KEYS.SW.SEND_DURATION]: state.sendDuration,
      [STORAGE_KEYS.SW.SEARCH_URL]: state.searchUrlParams,
      [STORAGE_KEYS.SW.SEND_QUEUE_V6]: state.sendQueueV6,
      [STORAGE_KEYS.SW.SEND_QUEUE_INDEX]: state.sendQueueV6Index,
      [STORAGE_KEYS.SW.SEND_PHASE]: state.sendPhase,
      [STORAGE_KEYS.SW.SELECTED_POSITIONS]: state.selectedPositions || [],
      [STORAGE_KEYS.SW.CUSTOM_POSITIONS]: state.customPositions || [],
      [STORAGE_KEYS.SW.MISSED_JOBS]: state._v6MissedJobs || [],
      [STORAGE_KEYS.SW.LAST_SNAPSHOT]: buildSnapshotSummary(),
    };
    chrome.storage.local.set(toSave)
      .then(function () { _flushDiagnosticsAfterBusinessPersist(); })
      .catch(() => {});
  }, 500);
}

// ── 全局错误捕获 ──
self.addEventListener('error', (event) => {
  ErrorLogger.logError(event.message, event.filename + ':' + event.lineno, 'SW global error');
  try { DiagLogger.error('sw.global', event.message + ' at ' + event.filename + ':' + event.lineno); } catch (_) {}
  console.error('[即投] SW global error:', event.message, 'at', event.filename + ':' + event.lineno);
});
self.addEventListener('unhandledrejection', (event) => {
  ErrorLogger.logError(event.reason?.message || String(event.reason), event.reason?.stack, 'SW unhandled rejection');
  try { DiagLogger.error('sw.global', 'unhandledrejection: ' + (event.reason?.message || String(event.reason))); } catch (_) {}
  console.error('[即投] SW unhandled rejection:', event.reason?.message || String(event.reason));
});



// ── 全自动开发重载（零抢屏）──
// content.js RELOAD_EXTENSION 在 reload 前置 __pending_tab_reload flag。扩展重载后 SW top-level 重新求值，
// 在此读 flag：若有则原地 chrome.tabs.reload 所有 BOSS tab。页面 reload 触发 Chrome 按 manifest 注入【新版】CS，
// 既不开新 tab、也不切焦点 → 绕开「runtime.reload 后已有 tab 不重注入 CS、必须开新 tab 才注入」的死局。
chrome.storage.local.get('__pending_tab_reload', (r) => {
  if (!r || !r.__pending_tab_reload) return;
  chrome.storage.local.remove('__pending_tab_reload');
  chrome.tabs.query({ url: '*://*.zhipin.com/*' }, (tabs) => {
    (tabs || []).forEach((t) => {
      try { chrome.tabs.reload(t.id, { bypassCache: true }); } catch (e) {}
    });
  });
});

// 点击工具栏图标打开侧边栏（不自动关闭），而不是弹窗
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// SW 冷启动竞态防护：消息唤醒冷 SW 时，下面这个异步 restore 回调可能晚于
// 消息处理执行，用 storage 旧值覆盖刚建好的内存状态（实测致投递 0/0/0）。
// 所有会改写发送/采集状态的入口必须先 await bootRestored。
let _bootRestoreResolve;
const bootRestored = new Promise((resolve) => { _bootRestoreResolve = resolve; });

chrome.storage.local.get([
  STORAGE_KEYS.SW.PHASE,
  STORAGE_KEYS.SW.JOBS,
  STORAGE_KEYS.SW.GREETINGS,
  STORAGE_KEYS.SW.SEND_PROGRESS,
  STORAGE_KEYS.SW.SENT_JOB_IDS,
  STORAGE_KEYS.SW.SEND_RESULTS,
  STORAGE_KEYS.SW.SEND_DURATION,
  STORAGE_KEYS.SW.SEARCH_URL,
  STORAGE_KEYS.SW.SEND_QUEUE_V6,
  STORAGE_KEYS.SW.SEND_QUEUE_INDEX,
  STORAGE_KEYS.SW.SEND_PHASE,
  STORAGE_KEYS.SW.SELECTED_POSITIONS,
  STORAGE_KEYS.SW.CUSTOM_POSITIONS,
  STORAGE_KEYS.SW.MISSED_JOBS,
  STORAGE_KEYS.DIAG.MEMBER_ID,
  STORAGE_KEYS.DIAG.ACTIVE_RUN,
], (result) => {
  _diagnosticMemberId = String(result[STORAGE_KEYS.DIAG.MEMBER_ID] || '');
  if (result[STORAGE_KEYS.DIAG.ACTIVE_RUN] && typeof result[STORAGE_KEYS.DIAG.ACTIVE_RUN] === 'object') {
    _diagnosticRun = result[STORAGE_KEYS.DIAG.ACTIVE_RUN];
    if (_diagnosticMemberId) _diagnosticRun.member_id = _diagnosticMemberId;
  }
  flushDiagnosticEvents().catch(function () {});
  // searchUrlParams 无论 phase 是什么都要恢复，否则发送时 getJobsPageUrl() 返回裸 URL
  if (result[STORAGE_KEYS.SW.SEARCH_URL]) state.searchUrlParams = result[STORAGE_KEYS.SW.SEARCH_URL];

  if (result[STORAGE_KEYS.SW.PHASE] && result[STORAGE_KEYS.SW.PHASE] !== 'idle') {
    state.phase = result[STORAGE_KEYS.SW.PHASE];
    if (result[STORAGE_KEYS.SW.JOBS]) state.jobs = result[STORAGE_KEYS.SW.JOBS];
    if (result[STORAGE_KEYS.SW.GREETINGS]) state.greetings = result[STORAGE_KEYS.SW.GREETINGS];
    // 期望岗位词恢复：丢了会让 buildSendQueueV6 类目匹配落空 → greeting 取空串
    if (result[STORAGE_KEYS.SW.SELECTED_POSITIONS]) state.selectedPositions = result[STORAGE_KEYS.SW.SELECTED_POSITIONS];
    if (result[STORAGE_KEYS.SW.CUSTOM_POSITIONS]) state.customPositions = result[STORAGE_KEYS.SW.CUSTOM_POSITIONS];
    if (result[STORAGE_KEYS.SW.SEND_PROGRESS]) state.sendProgress = result[STORAGE_KEYS.SW.SEND_PROGRESS];
    if (result[STORAGE_KEYS.SW.SEND_RESULTS]) state.sendResults = result[STORAGE_KEYS.SW.SEND_RESULTS];
    if (result[STORAGE_KEYS.SW.SEND_DURATION]) state.sendDuration = result[STORAGE_KEYS.SW.SEND_DURATION];
    // 从数组恢复 sentJobIds Set
    if (result[STORAGE_KEYS.SW.SENT_JOB_IDS] && Array.isArray(result[STORAGE_KEYS.SW.SENT_JOB_IDS])) {
      result[STORAGE_KEYS.SW.SENT_JOB_IDS].forEach(id => sentJobIds.add(id));
    }

    // v6 字段恢复
    if (Array.isArray(result[STORAGE_KEYS.SW.MISSED_JOBS])) state._v6MissedJobs = result[STORAGE_KEYS.SW.MISSED_JOBS];
    if (result[STORAGE_KEYS.SW.SEND_QUEUE_V6]) state.sendQueueV6 = result[STORAGE_KEYS.SW.SEND_QUEUE_V6];
    if (result[STORAGE_KEYS.SW.SEND_QUEUE_INDEX]) state.sendQueueV6Index = result[STORAGE_KEYS.SW.SEND_QUEUE_INDEX];
    if (result[STORAGE_KEYS.SW.SEND_PHASE]) state.sendPhase = result[STORAGE_KEYS.SW.SEND_PHASE];

    // v7 详情派恢复：SW 被杀于 send-on-open 串行循环中途。绝不重跑循环（会对已发岗位双发），
    // 仅把已持久化的结果收口进 review（剩余未达岗记「未投递」中性灰），由用户手动重投。
    if (state.phase === 'sending' && state.sendPhase === 'detail') {
      resumeSendV7();
    } else if (state.phase === 'sending') {
      // v5/旧 v6 遗留 sending 态：v7 已是唯一活路径，旧状态无法续跑 → 清空重置为 idle
      state.phase = 'idle';
      state.sendQueue = [];
      state.sendIndex = 0;
    }
    // 恢复后推送给已打开的 popup
    pushState();
  }
  _bootRestoreResolve();
});

// 新 SW 成功完成启动恢复后回报健康，并启动按需更新检查。




// 诊断包：phase 状态机转换单点打点（pushState 是所有 phase 变化的汇聚点）
let _diagLastPhase = 'idle';
function pushState() {
  try {
    if (state.phase !== _diagLastPhase) {
      DiagLogger.info('sw.phase', 'phase: ' + _diagLastPhase + ' → ' + state.phase + (state.sendPhase ? ' (sendPhase=' + state.sendPhase + ')' : ''));
      _diagLastPhase = state.phase;
    }
  } catch (_) {}
  console.log('[P1D-SW] pushState', { phase: state.phase, jobsLen: state.jobs && state.jobs.length });
  chrome.runtime.sendMessage({ type: 'STATE_UPDATE', state }).catch(() => {});
  persistState();
  if (_activityTokens.size === 0 && state.phase !== 'collecting' && state.phase !== 'sending' && state.phase !== 'captcha_paused') {
    scheduleUpdaterRetry(UPDATE_QUIET_MS + 100);
  }
}

// ── 消息路由 ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // CS 调试桥：把 content script 关键步骤同步到 SW console
  if (msg && msg.type === 'CS_DBG') {
    var tabId = sender && sender.tab ? sender.tab.id : '?';
    console.log('[即投][CS_DBG][tab=' + tabId + '] ' + msg.stage, msg.info || {});
    return;
  }
  // 客户端全局错误桥：popup/sidepanel/content 捕获后转 SW 入库 extension:errorLog
  if (msg && msg.type === 'EXT_ERROR') {
    var locInfo = msg.file ? (msg.file + ':' + (msg.line || '?') + ':' + (msg.col || '?')) : '';
    ErrorLogger.logError(String(msg.msg || ''), msg.stack || locInfo, (msg.src || 'client') + ' global error');
    try { DiagLogger.error((msg.src || 'client') + '.global', String(msg.msg || '') + (locInfo ? ' @' + locInfo : '')); } catch (_) {}
    return;
  }
  // 测试桥：全自动开发重载。content script 无 chrome.runtime.reload 特权（CS 的 runtime 仅子集），
  // 故由 CS 发此消息、SW 代为执行。置 __pending_tab_reload flag 后 reload；扩展重启后 SW top-level
  // 读 flag 原地 chrome.tabs.reload 所有 BOSS tab 重注入新 CS（零抢屏）。产品流程永不发此消息。
  if (msg && msg.type === 'RELOAD_EXT_SELF') {
    chrome.storage.local.set({ __pending_tab_reload: true }, () => {
      chrome.runtime.reload();
    });
    return;
  }
  switch (msg.type) {
    case 'GET_STATE':
      sendResponse({ success: true, state });
      break;

    case 'START_COLLECT':
      if (rejectActivityStart(sendResponse)) return false;
      runActivity('collecting', function () { return startCollect(msg.params); }).then(() => sendResponse({ success: true })).catch((e) => {
        ErrorLogger.logError(e.message, e.stack, 'START_COLLECT failed');
        const reasonCode = classifyCollectFailure(e);
        if (reasonCode) trackCollectFinishedOnce(e && e._collectRunId, reasonCode);
        sendResponse({ success: false, error: e.message });
      });
      return true;

    case 'STOP_COLLECT':
      stopCollect().then(() => sendResponse({ success: true })).catch((e) => sendResponse({ success: false, error: e.message }));
      return true;

    case 'OPEN_JOB_DETAIL':
      // popup 点岗位卡 → 转发给搜索页 CS，按 jobId 定位左侧卡并点击展开 JD。
      // #③ 多城市多 tab：岗位采集时带 _sourceTabId（归属 BOSS 搜索 tab）。
      //   路由优先级：① 归属 tab 仍存活且是 zhipin/web/geek/jobs 页 → 切到它再定位；
      //   ② 归属 tab 已关/不符（单城市无归属、或 tab 被用户关掉）→ 降级到第一个搜索 tab。
      chrome.tabs.query({ url: '*://*.zhipin.com/web/geek/jobs*' }).then((tabs) => {
        if (!tabs.length) { sendResponse({ success: false, error: '未找到 BOSS 搜索页，请先打开岗位列表' }); return; }
        var target = null;
        if (msg.sourceTabId) {
          target = tabs.filter(function (t) { return t.id === msg.sourceTabId; })[0] || null;
        }
        if (!target) target = tabs[0]; // 降级：归属 tab 不在 → 用第一个搜索页
        chrome.tabs.sendMessage(target.id, { type: 'OPEN_JOB_DETAIL', jobId: msg.jobId, jobName: msg.jobName, company: msg.company })
          .then((resp) => {
            try { chrome.windows.update(target.windowId, { focused: true }); chrome.tabs.update(target.id, { active: true }); } catch (_) {}
            sendResponse(resp || { success: true });
          })
          .catch((e) => sendResponse({ success: false, error: e.message }));
      }).catch((e) => sendResponse({ success: false, error: e.message }));
      return true;

    case 'JOBS_COLLECTED':
      // 真相源是 DO_COLLECT 的直接 response。这条旧广播没有轮次 ID，
      // STOP 后可能迟到，因此只 ack，不再改当前 state。
      sendResponse({ success: true });
      break;

    case 'COLLECT_PROGRESS':
      if (!state._multiCityCollect) {
        chrome.runtime.sendMessage(msg).catch(() => {});
      }
      sendResponse({ success: true });
      break;

    case 'START_SEND':
      if (rejectActivityStart(sendResponse)) return false;
      // sender.tab 在 side panel 场景下为 undefined，fallback 到 lastFocused 窗口
      if (sender && sender.tab && sender.tab.windowId) {
        state.originalMainWindowId = sender.tab.windowId;
      } else {
        chrome.windows.getLastFocused().then(win => {
          if (win && win.id) state.originalMainWindowId = win.id;
        }).catch(() => {});
      }
      state.hrActiveFilter = msg.hrActiveFilter || '不限';
      // 正文精筛透传：msg 优先（popup 现值），否则保留 collect 阶段已存的 state 值（冷重启降级为不筛=fail-open）
      if (typeof msg.restDayFilter === 'string') state.restDayFilter = msg.restDayFilter;
      if (typeof msg.welfareFilter === 'string') state.welfareFilter = msg.welfareFilter;
      // v7 详情派 send-on-open 串行投递：唯一活投递入口（旧 v6 并行 worker 链路已退役删除）
      var _diagnosticRetryKind = (msg.retryKind === 'manual_retry' || msg.retryKind === 'captcha_resume') ? msg.retryKind : '';
      runActivity('sending', function () { return startSendV7(msg.jobIds, _diagnosticRetryKind); }).then(() => {
        sendResponse({ success: true });
      }).catch((e) => {
        ErrorLogger.logError(e.message, e.stack, 'START_SEND failed');
        emitDiagnostic({ stage: 'delivery', action: 'delivery_failed', status: 'failed', reason_code: e.errorCode || 'start_failed', raw_error: e.message });
        finishDiagnosticRun('delivery_failed');
        chrome.runtime.sendMessage({ type: 'ERROR', message: e.message }).catch(() => {});
        sendResponse({ success: false, error: e.message, errorCode: e.errorCode || null });
      });
      return true;

    case 'STOP_SEND':
      stopSend().then(() => sendResponse({ success: true })).catch((e) => sendResponse({ success: false, error: e.message }));
      return true;

    case MSG.TRACK_EVENT:
      // 立即 ack，不 await（容错铁律：埋点绝不阻塞 popup）。
      try { trackEvent(msg.event, msg.meta); } catch (_) {}
      sendResponse({ success: true });
      return false;

    case MSG.GET_DAILY_SEND_COUNT:
      // 投递数量闸门：popup 投递前读当天已成功投递岗位数（本地自然日，跨日自动归零）
      getDailySendCount().then((count) => sendResponse({ success: true, count: count, limit: CONFIG.DAILY_SEND_LIMIT }))
        .catch(() => sendResponse({ success: true, count: 0, limit: CONFIG.DAILY_SEND_LIMIT }));
      return true;

    case MSG.GET_SW_BOSS_UID:
      (msg.fresh ? getBossUidFresh() : getBossUidSafe()).then((uid) => sendResponse({ success: true, bossUid: uid || '' }))
        .catch(() => sendResponse({ success: true, bossUid: '' }));
      return true;


    case MSG.START_JD_PREFETCH: {
      if (rejectActivityStart(sendResponse)) return false;
      // #1 JD 定制招呼语：popup 进 B 页选好前 75 岗 → 后台串行取 JD + 流水线生成（旁路，投递端零改）
      var _jdJobs = Array.isArray(msg.jobs) ? msg.jobs.slice(0, 75) : [];
      var _jdForce = Array.isArray(msg.force) ? msg.force : [];
      // fire-and-forget：立即 ack，编排在后台跑（容错铁律：任何失败一律降级不阻塞）
      runActivity('jd-prefetch', function () { return startJdPrefetch(_jdJobs, _jdForce, msg.seed); })
        .catch(function (e) { ErrorLogger.logError(e.message || String(e), e?.stack, 'startJdPrefetch'); });
      // 猎头岗 B3 支线（并发，不 await，与预取互不阻塞）：独立页不渲活跃度，唯一途径=点采集 tab 真卡自发 detail.json。
      // 挑本批 isHeadhunter 且 filter 为分级档（不限=不筛、只投在线=采集期 bossOnline 已判，均无需点卡）。
      kickHeadhunterProbe(_jdJobs);
      sendResponse({ ok: true, total: _jdJobs.length });
      break;
    }

    case MSG.CANCEL_JD_PREFETCH:
      // 换选区/退出 B 页：bump runId，所有在途取 JD 循环 + API worker 检测到 runId 变即自停、清队列
      _jdPrefetchRunId++;
      _closeJdPrefetchTab().catch(function () {}); // 关预取后台 tab（取消后不留残 tab）
      sendResponse({ ok: true });
      break;

    case MSG.B3_HEADHUNTER_RESULT: {
      // 猎头岗活跃度探测结果：对 excluded 岗复用「正常岗预取排除」同一条出口（JD_PROGRESS excluded →
      // popup 置灰+取消勾选+不进投递队列），并写 _jdGreetingCache excluded 让并发 startJdPrefetch 尊重此判
      // （_jdGenerateOne 不用招呼语覆盖 = SPEC「取消该岗招呼语生成」）。非 excluded 岗不动（预取招呼语照留）。
      var _b3res = Array.isArray(msg.results) ? msg.results : [];
      for (var _bi = 0; _bi < _b3res.length; _bi++) {
        var _r = _b3res[_bi];
        if (!_r || !_r.jobId || !_r.excluded) continue;
        var _rsr = 'HR活跃不符';
        _jdGreetingCache.set(_r.jobId, { excluded: true, skipReason: _rsr });
        chrome.runtime.sendMessage({ type: MSG.JD_PROGRESS, jobId: _r.jobId, excluded: true, skipReason: _rsr, ok: false }).catch(function () {});
      }
      sendResponse({ ok: true });
      break;
    }

    case 'SEND_PROGRESS':
      state.sendProgress = msg.progress;
      chrome.runtime.sendMessage(msg).catch(() => {});
      sendResponse({ success: true });
      break;

    case 'SEND_ITEM_RESULT':
      // v5 发送流程中，结果已由 recordV5Success/recordV5Failure 处理，防止重复计数
      if (state.phase === 'sending') {
        if (msg.payload?.jobId && sentJobIds.has(msg.payload.jobId)) {
          sendResponse({ success: true });
          break;
        }
      }
      // 累积发送结果，用于 Review 页
      state.sendResults.push(msg.payload);
      // 更新 sentJobIds（中断恢复用）
      if (msg.payload.success || msg.payload.error === 'partial') {
        sentJobIds.add(msg.payload.jobId);
      }
      // 按累积结果更新进度
      state.sendProgress.sent = state.sendResults.length;
      // 增量持久化（500ms 防抖，中断恢复不会丢失进度）
      persistState();
      // 转发给 popup（Review 页实时更新）
      chrome.runtime.sendMessage(msg).catch(() => {});
      sendResponse({ success: true });
      break;

    case 'SEND_COMPLETE':
      // SW 驱动的逐条导航发送：忽略 content script 的单条 SEND_COMPLETE
      if (state.phase === 'sending') { sendResponse({ success: true }); break; }
      // CAPTCHA 中断发送，不切换到 review
      if (state.phase === 'captcha_paused') break;
      // 全部发送失败，回退到 ready（不展示 review）
      if (state.sendResults.length > 0 && state.sendResults.every(r => !r.success)) {
        state.phase = 'ready';
        state.sendProgress = { sent: 0, total: 0 };
        pushState();
        break;
      }
      state.phase = 'review';
      state.sendDuration = Date.now() - sendStartTime;
      state.sendProgress = { sent: msg.total, total: msg.total };
      pushState();
      // 转发给 popup：扩展 results[] + duration
      chrome.runtime.sendMessage({
        type: MSG.SEND_COMPLETE,
        results: state.sendResults,
        duration: state.sendDuration,
      }).catch(() => {});
      sendResponse({ success: true });
      break;

    case 'CHAT_DETECTED':
      state.autoReplyCount++;
      pushState();
      sendResponse({ success: true });
      break;

    case 'CAPTCHA_DETECTED':
      try { DiagLogger.warn('sw.captcha', 'CAPTCHA detected, send paused (tab=' + (sender && sender.tab ? sender.tab.id : '?') + ')'); } catch (_) {}
      state.phase = 'captcha_paused';
      state.captchaError = true;
      recordCaptchaEvent(); // 风控退避：记一次触发（12h 滚动窗口），下批投递据此降速/停投（fire-and-forget）
      pushState();
      emitDiagnostic({ stage: 'delivery', action: 'captcha_paused', status: 'paused', reason_code: 'captcha_detected' });
      finishDiagnosticRun('interrupted');
      // 通知所有 content script 停止发送
      chrome.tabs.query({ url: '*://*.zhipin.com/*' }).then((tabs) => {
        tabs.forEach((t) => chrome.tabs.sendMessage(t.id, { type: 'DO_STOP' }).catch(() => {}));
      });
      sendResponse({ success: true });
      break;

    case MSG.CS_READY:
      var role = msg.role;
      if (role === 'search') {
        state._v6SearchReady = true;
        state.searchTabId = sender.tab.id;
      } else if (role === 'worker') {
        state._v6WorkerTabsReady.add(sender.tab.id);
      } else if (state.phase === 'sending') {
        // 兼容旧 v5 逻辑
        if (sender.tab.id === state.chatTabId) {
          state._v5ChatReady = true;
        }
      }
      sendResponse({ success: true });
      break;

    case 'AUTO_REPLY_SENT':
      chrome.runtime.sendMessage(msg).catch(() => {});
      sendResponse({ success: true });
      break;

    case 'REGENERATE_GREETING':
      if (rejectActivityStart(sendResponse)) return false;
      runActivity('greeting-regenerate', function () { return regenerateGreeting(msg.category, msg.jdSamples); })
        .then((greeting) => sendResponse({ success: true, greeting }))
        .catch((e) => {
          ErrorLogger.logError(e.message, e.stack, 'REGENERATE_GREETING failed');
          sendResponse({ success: false, error: e.message });
        });
      return true;

    case 'REWRITE_GREETING':
      if (rejectActivityStart(sendResponse)) return false;
      runActivity('greeting-rewrite', function () { return doRewriteGreeting(msg.greeting, msg.instruction); })
        .then((newGreeting) => sendResponse({ success: true, greeting: newGreeting }))
        .catch((e) => {
          ErrorLogger.logError(e.message, e.stack, 'REWRITE_GREETING failed');
          sendResponse({ success: false, error: e.message });
        });
      return true;

    case 'UPDATE_GREETING':
      state.greetings[msg.category] = msg.greeting;
      pushState();
      sendResponse({ success: true });
      break;

    case 'GET_API_KEY':
      chrome.storage.local.get('apiKey', (r) => sendResponse({ success: true, apiKey: r.apiKey || '' }));
      return true;

    case 'SAVE_API_KEY':
      chrome.storage.local.set({ apiKey: msg.apiKey }, () => sendResponse({ success: true }));
      return true;

    case 'CLEAR_SENT_JOB_IDS':
      sentJobIds.clear();
      persistState();
      sendResponse({ success: true });
      break;

    case '__TEST_OPEN_POPUP__': {
      if (chrome.runtime.getManifest().update_url) {
        sendResponse({ success: false, error: 'test API disabled in production' });
        return false;
      }
      chrome.tabs.create({
        url: chrome.runtime.getURL('src/popup/popup.html'),
        active: false
      }, (tab) => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ success: true, tabId: tab.id });
        }
      });
      return true;
    }
    case '__TEST_OPEN_TAB__': {
      if (chrome.runtime.getManifest().update_url) {
        sendResponse({ success: false, error: 'test API disabled in production' });
        return false;
      }
      // 只允许开 zhipin.com 测试页（不抢屏：active:false）
      const _u = String(msg.url || '');
      if (!/^https?:\/\/([^/]+\.)?zhipin\.com\//.test(_u)) {
        sendResponse({ success: false, error: 'url not allowed' });
        return false;
      }
      chrome.tabs.create({ url: _u, active: false }, (tab) => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ success: true, tabId: tab.id });
        }
      });
      return true;
    }
    case '__TEST_CLOSE_POPUP__': {
      if (chrome.runtime.getManifest().update_url) {
        sendResponse({ success: false, error: 'test API disabled in production' });
        return false;
      }
      chrome.tabs.remove(msg.tabId, () => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ success: true });
        }
      });
      return true;
    }

    default:
      sendResponse({ success: false, error: 'Unknown message type' });
  }
});

// ── 辅助：构建 BOSS 直聘搜索 URL ──
function buildJobUrl(params) {
  const base = 'https://www.zhipin.com/web/geek/jobs';
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v) qs.set(k, v);
  }
  return `${base}?${qs.toString()}`;
}

// ── 获取带搜索参数的岗位页面 URL（无参数时 fallback 到裸 URL）──
function getJobsPageUrl() {
  if (state.searchUrlParams) {
    return buildJobUrl(state.searchUrlParams);
  }
  return 'https://www.zhipin.com/web/geek/jobs';
}

// ── 辅助：等待标签页加载完成（超时兜底） ──
function waitForTabLoad(tabId, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('页面加载超时'));
    }, timeoutMs);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ── PING/PONG 握手：确认 content script 已注入就绪 ──
async function waitForContentScript(tabId, timeoutMs = 3000, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('PING timeout')), timeoutMs);
        chrome.tabs.sendMessage(tabId, { type: 'PING' }).then((resp) => {
          clearTimeout(timer);
          resolve(resp);
        }).catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      if (response && response.type === 'PONG') {
        console.log('[即投] Content script ready after PING attempt', attempt + 1);
        return true;
      }
    } catch (err) {
      console.warn(`[即投] PING attempt ${attempt + 1}/${maxRetries} failed:`, err.message);
      ErrorLogger.logError(err.message, err.stack, `PING attempt ${attempt + 1}/${maxRetries}`);
      if (attempt < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }
  throw new Error('Content script not ready after ' + maxRetries + ' attempts');
}

// ── 通用辅助 ──
function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

// 间隔随机化：[min,max] 闭区间均匀随机整数 ms（破等距节奏指纹）
function randBetween(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

// ═══════════════════════════════════════════════════════════════════
// Worker tab keepalive — chrome.alarms 30s 周期给后台 worker tab 发 PING
// 目的：防 BFCache 失活、防 service worker 30s 空闲休眠、防 tab discard
// 不切前台（不抢用户屏幕）— 仅靠消息往返让 chromium 认为 tab/SW 都活跃
// ═══════════════════════════════════════════════════════════════════
const _workerAlarmPrefix = 'zitou:worker_keepalive:';
const _activeWorkerKeepalives = new Set(); // tabId 集合

// 采集终态按轮次去重。新一轮启动或 STOP_COLLECT 都会让旧轮次失效，
// 避免旧 content script / 多城并发的迟到结果抢占新一轮终态。
let _collectRunId = 0;
let _collectFinishedRunId = 0;

function trackCollectFinishedOnce(runId, reasonCode) {
  if (!runId || runId !== _collectRunId || _collectFinishedRunId === runId || !reasonCode) return false;
  _collectFinishedRunId = runId;
  trackEvent('collect_finished', { reason_code: reasonCode }).catch(function () {});
  return true;
}

function _workerAlarmName(tabId) { return _workerAlarmPrefix + tabId; }

function startWorkerKeepalive(tabId) {
  if (_activeWorkerKeepalives.has(tabId)) return;
  _activeWorkerKeepalives.add(tabId);
  // periodInMinutes 最低 0.5 = 30s（chrome 强制下限）
  var period = (typeof CONFIG !== 'undefined' && CONFIG.KEEPALIVE_PERIOD_MIN) || 0.5;
  chrome.alarms.create(_workerAlarmName(tabId), {
    delayInMinutes: period,
    periodInMinutes: period,
  });
  console.log('[即投] keepalive: started for tab', tabId, 'period=', period, 'min');
}

function stopWorkerKeepalive(tabId) {
  if (!_activeWorkerKeepalives.has(tabId)) return;
  _activeWorkerKeepalives.delete(tabId);
  chrome.alarms.clear(_workerAlarmName(tabId)).catch(function(){});
  console.log('[即投] keepalive: stopped for tab', tabId);
}

// onAlarm 单点 dispatcher — 收到 ping alarm 就给对应 tab 发 PING
// CS 侧已有 PONG handler（content.js:401-403），无需新增
chrome.alarms.onAlarm.addListener(function(alarm) {
  if (!alarm || !alarm.name) return;
  if (alarm.name.indexOf(_workerAlarmPrefix) !== 0) return;
  var tabId = parseInt(alarm.name.slice(_workerAlarmPrefix.length), 10);
  if (!tabId || !_activeWorkerKeepalives.has(tabId)) {
    chrome.alarms.clear(alarm.name).catch(function(){});
    return;
  }
  // 异步发 PING，不 await（alarm 回调不需要保活）
  chrome.tabs.sendMessage(tabId, { type: MSG.PING }).catch(function(err) {
    // 失败可能是 tab 已关、CS 未注入、BFCache — 都不致命，下次 alarm 继续试
    console.warn('[即投] keepalive PING failed tab=' + tabId + ' err=' + err.message);
  });
});

// 清理：cleanupV6 时一并清掉所有残留 keepalive alarm
function stopAllWorkerKeepalives() {
  var tabs = Array.from(_activeWorkerKeepalives);
  for (var i = 0; i < tabs.length; i++) stopWorkerKeepalive(tabs[i]);
}

// ── 采集控制 ──
async function startCollect(params) {
  await bootRestored;         // 冷启动竞态防护，同 startSendV6
  startDiagnosticRun(null, '');
  const collectRunId = ++_collectRunId;
  try { DiagLogger.userEvent('sw.collect', '任务启动：开始采集 cities=' + ((params && params.selectedCities && params.selectedCities.length) || 0) + ' positions=' + (allExpectedPositions({ selectedPositions: params && params.selectedPositions, customPositions: params && params.customPositions }).length)); } catch (_) {}
  console.log('[P1D-SW] startCollect enter');
  state.phase = 'collecting';
  state.jobs = [];
  state.greetings = {};
  // 新批次开始，清空已发送记录
  sentJobIds.clear();
  state.sendResults = [];
  state._v6MissedJobs = []; // 上一批漏发清单随新批作废（重新投递会重建联+重发）
  state.sendDuration = 0;
  state.sendProgress = { sent: 0, total: 0 };
  if(params&&params.selectedPositions) state.selectedPositions = params.selectedPositions;
  state.customPositions = (params && Array.isArray(params.customPositions)) ? params.customPositions : (state.customPositions||[]);
  if(params && typeof params.welfareFilter === 'string') state.welfareFilter = params.welfareFilter;
  if(params && typeof params.restDayFilter === 'string') state.restDayFilter = params.restDayFilter;
  // HR 活跃：镜像 welfare/restDay，采集期就落 state → 预取 READ_JD(sw ~2081) 读得到真 filter → judgeJdFilters HR 段生效
  // （修断线：此前只在 START_SEND 设，预取期恒为「不限」致 HR 前置过滤整个被禁；正常岗70%由此复活）
  if(params && typeof params.hrActiveFilter === 'string') state.hrActiveFilter = params.hrActiveFilter;
  if(params && params.urlParams) state.searchUrlParams = params.urlParams;
  else state.searchUrlParams = null;
  pushState();
  emitDiagnostic({ stage: 'collection', action: 'collection_started', status: 'started' });
  trackEvent('collect_started', {}).catch(function () {});
  // 即时预热招呼语：不等岗位采集，A 点击"开始收集"瞬即并发生成 N 条（N=期望岗位数）
  // 5-6s 采集期间复用为招呼语生成时间窗，B 页打开即有结果
  if (!greetingPromise && allExpectedPositions(state).length) {
    greetingPromise = generateAllGreetingsConcurrent();
  }
  try {
    const cities = params.selectedCities || [];

    // Single city (or 000000 national) → original single-tab collection
    if (cities.length <= 1) {
      const singleCity = cities.length === 1 ? cities[0] : (params.urlParams?.city || '');
      if (params.urlParams) params.urlParams.city = singleCity;
      return await singleCityCollect(params, collectRunId);
    }

    // Multi-city batch collection
    state._multiCityCollect = true;
    const MAX_PARALLEL = CONFIG.MAX_COLLECT_TABS || 2;
    let allJobs = [];
    let earlyGreetingStarted = false;
    let hadCollectionFailure = false;
    let knownCollectionFailure = '';

    for (let i = 0; i < cities.length; i += MAX_PARALLEL) {
      const batch = cities.slice(i, i + MAX_PARALLEL);
      const batchResults = await Promise.allSettled(
        batch.map(cityCode => collectOnTab(cityCode, params))
      );
      if (collectRunId !== _collectRunId) return;

      for (const result of batchResults) {
        if (result.status === 'fulfilled' && result.value) {
          if (Array.isArray(result.value)) allJobs.push(...result.value);
        } else if (result.status === 'rejected') {
          hadCollectionFailure = true;
          if (!knownCollectionFailure) knownCollectionFailure = classifyCollectFailure(result.reason);
        }
      }

      // 【并行优化】第一批岗位收集完后立即异步启动招呼语生成，不等待后续批次
      if (i === 0 && allJobs.length > 0 && !earlyGreetingStarted) {
        earlyGreetingStarted = true;
        // 用已有岗位构建 jdSamples，提前触发 AI 招呼语生成
        // 兜底：从 chrome.storage 读权威 selectedPositions（防止 popup 没传或传空）
        if ((!state.selectedPositions || !state.selectedPositions.length) || (!state.customPositions || !state.customPositions.length)) {
          try {
            const { [STORAGE_KEYS.UI.FILTER_STATE]: fs } = await chrome.storage.local.get(STORAGE_KEYS.UI.FILTER_STATE);
            if (fs) {
              if ((!state.selectedPositions || !state.selectedPositions.length) && Array.isArray(fs.selectedPositions) && fs.selectedPositions.length) state.selectedPositions = fs.selectedPositions;
              if ((!state.customPositions || !state.customPositions.length) && Array.isArray(fs.customPositions) && fs.customPositions.length) state.customPositions = fs.customPositions;
            }
          } catch (e) { /* 静默：storage 读失败保持原值 */ }
        }
        const partialClusters = clusterJobs(filterJobsByExpected(allJobs, state.selectedPositions, state.customPositions), state.selectedPositions, state.customPositions);
        state.jdSamples = sampleJDs(partialClusters, 5);
        greetingPromise = generateAllGreetingsConcurrent();
      }

      // City-level progress
      const completed = Math.min(i + MAX_PARALLEL, cities.length);
      chrome.runtime.sendMessage({
        type: 'COLLECT_CITY_PROGRESS',
        progress: { completed, total: cities.length, jobsCollected: allJobs.length }
      }).catch(() => {});
    }

    delete state._multiCityCollect;

    // 兜底：从 chrome.storage 读权威 selectedPositions（防止 popup 没传或传空）
    if ((!state.selectedPositions || !state.selectedPositions.length) || (!state.customPositions || !state.customPositions.length)) {
      try {
        const { [STORAGE_KEYS.UI.FILTER_STATE]: fs } = await chrome.storage.local.get(STORAGE_KEYS.UI.FILTER_STATE);
        if (fs) {
          if ((!state.selectedPositions || !state.selectedPositions.length) && Array.isArray(fs.selectedPositions) && fs.selectedPositions.length) state.selectedPositions = fs.selectedPositions;
          if ((!state.customPositions || !state.customPositions.length) && Array.isArray(fs.customPositions) && fs.customPositions.length) state.customPositions = fs.customPositions;
        }
      } catch (e) { /* 静默：storage 读失败保持原值 */ }
    }
    allJobs = filterJobsByExpected(allJobs, state.selectedPositions, state.customPositions);
    allJobs = filterJobsByWelfare(allJobs, state.welfareFilter);
    allJobs = filterJobsByRestDay(allJobs, state.restDayFilter);
    allJobs = filterJobsByOnline(allJobs, state.hrActiveFilter); // 「只投在线」采集期硬筛（分级档不动）
    state.jobs = allJobs;
    state.clusters = clusterJobs(allJobs, state.selectedPositions, state.customPositions);
    state.jdSamples = sampleJDs(state.clusters, 5);
    state.phase = 'ready';
    pushState();
    emitDiagnostic({ stage: 'collection', action: 'collection_completed', status: 'success', duration_ms: Date.now() - (_diagnosticRun ? _diagnosticRun.started_at : Date.now()) });

    if (allJobs.length === 0) {
      if (knownCollectionFailure) {
        trackCollectFinishedOnce(collectRunId, knownCollectionFailure);
      } else if (!hadCollectionFailure) {
        trackCollectFinishedOnce(collectRunId, 'no_matches');
      }
      chrome.runtime.sendMessage({ type: 'ERROR', message: '未找到匹配岗位，请调整筛选条件' }).catch(() => {});
      finishDiagnosticRun('no_matches');
      return;
    }
    trackCollectFinishedOnce(collectRunId, 'success');

    // 如果已提前启动招呼语生成，等待完成后补充新增分类
    if (earlyGreetingStarted) {
      try { await greetingPromise; } catch (_) {}
      // 后续批次可能引入了新分类，补充生成
      const apiKey = await getApiKey();
      if (apiKey && state.jdSamples) {
        let resumeImages = await loadResumeImages();
        for (const [cat, samples] of Object.entries(state.jdSamples)) {
          if (!state.greetings[cat]) {
            try {
              state.greetings[cat] = await generateGreeting(apiKey, resumeImages, samples, cat);
              pushState();
            } catch (e) {
              state.greetings[cat] = '生成失败，请刷新';
              ErrorLogger.logError(e.message || String(e), e?.stack, 'Late greeting gen: ' + cat);
              pushState();
            }
          }
        }
      }
      greetingPromise = null;
      pushState();
    } else {
      greetingPromise = generateAllGreetingsConcurrent();
    }

  } catch (e) {
    if (collectRunId === _collectRunId) {
      delete state._multiCityCollect;
      state.phase = 'idle';
      pushState();
    }
    try { e._collectRunId = collectRunId; } catch (_) {}
    emitDiagnostic({ stage: 'collection', action: 'collection_failed', status: 'failed', reason_code: classifyCollectFailure(e) || 'collection_error', raw_error: e && e.message });
    finishDiagnosticRun('collection_failed');
    throw e;
  }
}

// Original single-city tab collection logic
async function singleCityCollect(params, collectRunId) {
  const hasUrlParams = params?.urlParams && Object.keys(params.urlParams).length > 0;

  if (hasUrlParams) {
    const url = buildJobUrl(params.urlParams);

    let tabId;
    try {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTab && activeTab.url && activeTab.url.includes('zhipin.com') && activeTab.id) {
        tabId = activeTab.id;
        await chrome.tabs.update(tabId, { url });
      } else {
        const tab = await chrome.tabs.create({ url, active: false });
        tabId = tab.id;
      }
    } catch (_) {
      const tab = await chrome.tabs.create({ url, active: false });
      tabId = tab.id;
    }

    await waitForTabLoad(tabId);
    await waitForContentScript(tabId);
    await runSingleCityCollectOnTab(tabId, params, collectRunId);
  } else {
    const tabs = await chrome.tabs.query({ url: '*://*.zhipin.com/web/geek/jobs*' });
    if (!tabs.length) throw new Error('请先打开 BOSS 直聘岗位搜索页');
    await runSingleCityCollectOnTab(tabs[0].id, params, collectRunId);
  }
}

async function runSingleCityCollectOnTab(tabId, params, collectRunId) {
  const response = await chrome.tabs.sendMessage(tabId, { type: 'DO_COLLECT', params });
  applySingleCityCollectResult(response, tabId, collectRunId);
}

function applySingleCityCollectResult(response, tabId, collectRunId) {
  if (collectRunId !== _collectRunId) return;
  if (!response || response.success === false) {
    const err = new Error((response && response.error) || 'content script collection failed');
    err._collectRunId = collectRunId;
    throw err;
  }
  let jobs = Array.isArray(response.jobs) ? response.jobs : [];
  if (tabId) jobs.forEach((job) => { if (job && job._sourceTabId == null) job._sourceTabId = tabId; });
  jobs = filterJobsByExpected(jobs, state.selectedPositions, state.customPositions);
  jobs = filterJobsByWelfare(jobs, state.welfareFilter);
  jobs = filterJobsByRestDay(jobs, state.restDayFilter);
  jobs = filterJobsByOnline(jobs, state.hrActiveFilter);
  state.jobs = jobs;
  const positions = allExpectedPositions(state);
  state.clusters = positions.length
    ? clusterJobs(jobs, state.selectedPositions, state.customPositions)
    : (response.clusters || {});
  state.jdSamples = response.jdSamples;
  state.phase = 'ready';
  pushState();
  emitDiagnostic({ stage: 'collection', action: 'collection_completed', status: 'success', duration_ms: Date.now() - (_diagnosticRun ? _diagnosticRun.started_at : Date.now()) });

  if (!jobs.length) {
    trackCollectFinishedOnce(collectRunId, 'no_matches');
    chrome.runtime.sendMessage({ type: 'ERROR', message: '未找到匹配岗位，请调整筛选条件' }).catch(() => {});
    finishDiagnosticRun('no_matches');
    return;
  }
  trackCollectFinishedOnce(collectRunId, 'success');
  if (!greetingPromise) greetingPromise = generateAllGreetingsConcurrent();
}

// Multi-city: collect jobs from one city in a background tab and return results
async function collectOnTab(cityCode, params) {
  const urlParams = params.urlParams ? { ...params.urlParams, city: cityCode } : { city: cityCode };
  // 工作区域每城独立：用当前城市自己的 districtCode，没有则清掉（区 code 是城市专属，串城无效）
  const dbc = params.districtByCity && params.districtByCity[cityCode];
  if (dbc) urlParams.multiBusinessDistrict = dbc;
  else delete urlParams.multiBusinessDistrict;
  const url = buildJobUrl(urlParams);
  const tab = await chrome.tabs.create({ url, active: false });
  const tabId = tab.id;
  try {
    await waitForTabLoad(tabId);
    await waitForContentScript(tabId);
    const response = await chrome.tabs.sendMessage(tabId, { type: 'DO_COLLECT', params: { ...params, urlParams } });
    if (response && response.success && response.jobs) {
      // 多城市多 tab 路由（#③）：给每个 job 打来源 tab/城市归属，
      // popup 点卡片看 JD 时 SW 据此切到正确 BOSS tab 再定位（不再永远取 tabs[0]）。
      response.jobs.forEach((j) => { if (j) { j._sourceTabId = tabId; j._cityCode = cityCode; } });
      return response.jobs;
    }
    return [];
  } catch (e) {
    chrome.tabs.remove(tabId).catch(() => {});
    throw e;
  }
}

// 客户端硬过滤：BOSS 模糊匹配返回脏数据，按"全词命中"剔除非期望岗位
// 规则：选中的任一期望岗位的所有关键词都出现在 job.name 里 → 留
// 期望岗位为空 → 不过滤（兜底）；过滤后 0 条 → 打 warn 但仍返回 0 条不阻塞
// picker(严格) + 自定义(字符重叠) 期望岗位合集，用于 cluster/招呼语/发送（filter 仍区分两类）
function allExpectedPositions(state) {
  const sp = Array.isArray(state.selectedPositions) ? state.selectedPositions : [];
  const cp = Array.isArray(state.customPositions) ? state.customPositions : [];
  return sp.concat(cp);
}
function filterJobsByExpected(jobs, selectedPositions, customPositions) {
  const picker = Array.isArray(selectedPositions) ? selectedPositions : [];
  const custom = Array.isArray(customPositions) ? customPositions : [];
  if (!picker.length && !custom.length) return jobs;
  // 采集过滤与分组/发送同源：能归进某期望词组（matchJobToExpected !== '其他'）即保留。
  // 这样「保留 ⟺ 可归组」，被采进来的岗位不会在 B 页落「其他」。
  const filtered = jobs.filter(job => {
    if (!String((job && job.name) || '')) return false;
    return matchJobToExpected(job, picker, custom) !== '其他';
  });
  if (filtered.length === 0) {
    console.warn('[filterJobsByExpected] 过滤后 0 条', { before: jobs.length, selectedPositions, customPositions });
  }
  return filtered;
}

// 福利精筛（严格过滤 · 列表初筛）。镜像 content 侧 JobCollector.filterByWelfare 纯逻辑
// （SW 跨 world 调不到 content 模块，故复制一份）。welfareFilter='不限' → 不筛。
// 严格规则：① welfareList 已知且含关键词 → 保留（确认命中）；② welfareList 已知但不含 → 滤掉
// （BOSS 结构化说没有，可靠丢弃）；③ welfareList 缺失(null/非数组) → 放行到投递阶段，由 JD 正文
// 终判生死（不在列表丢，否则到不了正文检查；投递阶段正文不命中则跳过不投，见 content.js）。
// welfareUnknownCount=③类「待正文终判」放行数（供 popup 提示）。
function filterJobsByWelfare(jobs, welfareFilter) {
  state.welfareUnknownCount = 0;
  if (!welfareFilter || welfareFilter === '不限') return jobs;
  const kw = welfareFilter; // 当前只支持单关键词「五险一金」
  let unknown = 0;
  const kept = (Array.isArray(jobs) ? jobs : []).filter(job => {
    const wl = job && job.welfareList;
    if (!Array.isArray(wl)) { unknown++; return true; } // 数据未知 → 放行到投递阶段正文终判
    return wl.some(w => String(w).indexOf(kw) !== -1);  // 已知含→留，已知不含→丢（严格）
  });
  state.welfareUnknownCount = unknown;
  if (kept.length === 0) {
    console.warn('[filterJobsByWelfare] 过滤后 0 条', { before: (jobs || []).length, welfareFilter });
  }
  return kept;
}

// 双休标题判定（镜像 content 侧 JobCollector.classifyRestDay；SW 跨 world 调不到 content 模块）。
// BOSS 网页端工作制信息只活在 jobName 标题里（四重印证锁死），故按标题白/黑名单打标。
// 返回 'double'|'no'|'unknown'。黑名单优先（更保守，宁可不标也不误标）。
function classifyRestDay(jobName) {
  const t = String(jobName || '');
  if (!t) return 'unknown';
  const NO = ['大小周', '单休', '做六休一', '单双周', '单双休'];
  for (let i = 0; i < NO.length; i++) { if (t.indexOf(NO[i]) !== -1) return 'no'; }
  const YES = ['双休', '周末双休', '做五休二', '五天工作制', '五天双休'];
  for (let j = 0; j < YES.length; j++) { if (t.indexOf(YES[j]) !== -1) return 'double'; }
  return 'unknown';
}

// 双休精筛（严格过滤 · 列表初筛 + 命中置顶）。镜像 content 侧 JobCollector.filterByRestDay。
// restDayFilter='不限' → 不筛。'双休' 时：① 标题命中双休白名单→保留并置顶（确认命中）；
// ② 命中非双休黑名单（大小周/单休等）→ 明确滤掉；③ 标题未写工作制（unknown）→ 放行到投递阶段，
// 由 JD 正文终判（投递阶段正文/标题均未明确 double 则跳过不投，见 content.js）。
// restDayUnknownCount=③类「待正文终判」放行数（供 popup 提示）。
function filterJobsByRestDay(jobs, restDayFilter) {
  state.restDayUnknownCount = 0;
  const list = Array.isArray(jobs) ? jobs : [];
  if (restDayFilter !== '双休') return list;
  const hit = [];
  const pending = []; // 标题 unknown，放行到投递阶段正文终判
  for (const job of list) {
    const rd = (job && job.restDay) || classifyRestDay(job && job.name);
    if (rd === 'double') hit.push(job);
    else if (rd === 'no') { /* 明确非双休，滤掉 */ }
    else pending.push(job);
  }
  state.restDayUnknownCount = pending.length;
  const kept = hit.concat(pending);
  if (kept.length === 0) {
    console.warn('[filterJobsByRestDay] 过滤后 0 条', { before: list.length, restDayFilter });
  }
  return kept;
}

// HR「只投在线」采集期硬筛（新增，不碰上面 welfare/双休两个 filter）。
// 仅 '只投在线' 档触发：joblist 已带 bossOnline，对全岗（含猎头）采集期即硬判——bossOnline===true 留、
// ===false 丢、undefined→fail-open 放行（走预取期 DOM 判）。分级档（3日内/本周/本月）不在采集期动，走预取/B3。
function filterJobsByOnline(jobs, hrActiveFilter) {
  const list = Array.isArray(jobs) ? jobs : [];
  if (hrActiveFilter !== '只投在线') return list;
  const kept = list.filter(job => {
    const bo = job && job.bossOnline;
    if (typeof bo !== 'boolean') return true; // 未知 → 放行（fail-open）
    return bo === true;
  });
  if (kept.length === 0) {
    console.warn('[filterJobsByOnline] 过滤后 0 条', { before: list.length, hrActiveFilter });
  }
  return kept;
}

// 单个 job → 期望岗位名 的打分匹配。统一委托共享真相源 matchJobToExpected（constants.js），
// 与 popup prepareGroups 完全同源 → 编辑 key === 发送 key，归组一致。分来源：picker 严格 / custom 宽松。
function matchJobToPosition(job, picker, custom) {
  return matchJobToExpected(job, picker, custom);
}

// Cluster jobs by primary tag (matching content-side logic in JobCollector.clusterByTag)
function clusterJobs(jobs, picker, custom) {
  const clusters = {};
  const positions = (Array.isArray(picker) ? picker : []).concat(Array.isArray(custom) ? custom : []);
  if (positions.length) {
    // 按用户期望岗位聚类（镜像 popup prepareGroups 匹配逻辑），确保每个期望岗位独立生成招呼语
    for (const pos of positions) { clusters[pos] = []; }
    clusters['其他'] = [];
    for (const job of jobs) {
      const bestPos = matchJobToPosition(job, picker, custom);
      if (bestPos !== '其他') clusters[bestPos].push(job);
      else clusters['其他'].push(job);
    }
    if (clusters['其他'].length === 0) delete clusters['其他'];
    return clusters;
  }
  // Fallback: 按 BOSS tag 首项聚类
  for (const job of jobs) {
    const primaryTag = (job.tags && job.tags[0]) || '其他';
    if (!clusters[primaryTag]) clusters[primaryTag] = [];
    clusters[primaryTag].push(job);
  }
  return clusters;
}

function sampleJDs(clusters, perCluster = 5) {
  const samples = {};
  for (const [tag, tagJobs] of Object.entries(clusters)) {
    samples[tag] = tagJobs.slice(0, perCluster).map(j => ({
      title: j.name || j.title,
      tags: j.tags,
      desc: j.name || j.title,
    }));
  }
  return samples;
}

async function stopCollect() {
  try { DiagLogger.userEvent('sw.collect', '用户停止采集 (STOP_COLLECT)'); } catch (_) {}
  const wasCollecting = state.phase === 'collecting';
  const stoppedRunId = _collectRunId;
  state.phase = 'idle';
  delete state._multiCityCollect;
  pushState();
  if (wasCollecting) trackCollectFinishedOnce(stoppedRunId, 'user_stopped');
  if (wasCollecting) {
    emitDiagnostic({ stage: 'collection', action: 'user_stopped', status: 'interrupted', reason_code: 'user_stopped' });
    finishDiagnosticRun('stopped');
  }
  if (_collectRunId === stoppedRunId) _collectRunId += 1;
  const tabs = await chrome.tabs.query({ url: '*://*.zhipin.com/*' });
  tabs.forEach((t) => chrome.tabs.sendMessage(t.id, { type: 'DO_STOP' }).catch(() => {}));
}

// ── 发送完成（切换到 review 或 fallback）──
function finishSend() {
  try {
    var _dOk = 0, _dFail = 0, _dSkip = 0;
    for (var _di = 0; _di < state.sendResults.length; _di++) {
      var _dr = state.sendResults[_di];
      if (_dr && _dr.success) _dOk++; else if (_dr && _dr.skipped) _dSkip++; else _dFail++;
    }
    DiagLogger.info('sw.send', '阶段完成：finishSend ok=' + _dOk + ' fail=' + _dFail + ' skip=' + _dSkip + ' total=' + state.sendResults.length);
    // ── 埋点：delivery_finished（每批一次，_deliveryFinishedFired 去重；finishSend 有多入口）──
    // 口径：成功/失败一视同仁记录，不设门槛；fire-and-forget 不阻塞收口。
    if (!_deliveryFinishedFired) {
      _deliveryFinishedFired = true;
      try {
        trackDeliveryFinished({
          total: state.sendResults.length,
          success_count: _dOk,
          fail_count: _dFail,
          skip_count: _dSkip,
        });
      } catch (_) {}
    }
  } catch (_) {}
  state.phase = 'review';
  state.sendDuration = Date.now() - sendStartTime;
  state.sendProgress = { sent: state.sendProgress.sent, total: state.sendProgress.total };
  pushState();
  // 成功率 = 成功数 / (应投数 − HR跳过数)；HR跳过(skipped)从分母剔除，不计分子也不计分母。

  chrome.runtime.sendMessage({
    type: MSG.SEND_COMPLETE,
    results: state.sendResults,
    duration: state.sendDuration,
    missedCount: (state._v6MissedJobs || []).length, // A1：review 页据此显示「一键补发」提示行
  }).catch(() => {});
}

// ── 诊断滚动归档（ring buffer，保留最近 5 次投递任务）──
// 每次任务终态写一份「本轮完整诊断摘要」（时间戳/sendResults 摘要+全量/脱敏 snapshot）到 diag:recentRuns。
// 即使用户开新任务清内存，历史 5 份仍在；导出时按时间窗定位是哪次投递。
function archiveRecentRun(reason) {
  return new Promise(function (resolve) {
    try {
      var results = (state.sendResults || []);
      var ok = 0, fail = 0, skip = 0, failures = [];
      for (var i = 0; i < results.length; i++) {
        var r = results[i] || {};
        if (r.success) ok++;
        else { if (r.skipped) skip++; else fail++; }
        if (!r.success) {
          failures.push({
            position: String(r.positionName || '').slice(0, 30),
            company: String(r.companyName || '').slice(0, 30),
            error: String(r.error || '').slice(0, 120),
            time: r.time || 0,
          });
        }
      }
      var run = {
        member_id: _diagnosticMemberId || (_diagnosticRun && _diagnosticRun.member_id) || '',
        run_id: (_diagnosticRun && _diagnosticRun.run_id) || '',
        parent_run_id: (_diagnosticRun && _diagnosticRun.parent_run_id) || '',
        retry_kind: (_diagnosticRun && _diagnosticRun.retry_kind) || '',
        startTs: (_diagnosticRun && _diagnosticRun.started_at) || 0,
        endTs: Date.now(),
        reason: reason,
        snapshot: buildSnapshotSummary(),  // 已脱敏
        sendSummary: { total: results.length, ok: ok, fail: fail, skip: skip },
        failures: failures.slice(0, 50),
        // sendResults 全量（脱敏：只留岗位/公司/状态/错误/时间，不含招呼语/简历）
        sendResults: results.map(function (x) {
          x = x || {};
          return {
            jobId: x.jobId,
            positionName: String(x.positionName || '').slice(0, 40),
            companyName: String(x.companyName || '').slice(0, 40),
            success: !!x.success,
            skipped: !!x.skipped,
            error: String(x.error || '').slice(0, 120),
            time: x.time || 0,
          };
        }),
      };
      chrome.storage.local.get(STORAGE_KEYS.DIAG.RECENT_RUNS, function (got) {
        var arr = (got && Array.isArray(got[STORAGE_KEYS.DIAG.RECENT_RUNS])) ? got[STORAGE_KEYS.DIAG.RECENT_RUNS] : [];
        arr.push(run);
        while (arr.length > 5) arr.shift();  // ring buffer：仅保留最近 5 次
        var put = {}; put[STORAGE_KEYS.DIAG.RECENT_RUNS] = arr;
        chrome.storage.local.set(put, function () { resolve(); });
      });
    } catch (e) { resolve(); }
  });
}

// ── 统一终态出口 ──
// 所有任务结束路径（成功完成 / 失败 / 用户停止 / stage1 超时）都汇到这里：
// 为「在队列里但从未产出结果」的岗位补一条中性灰「未投递」结果，再走 review。
// 永不再走 phase='idle'+ERROR 的死胡同（那会让 popup 死卡「正在投递」）。
async function finalizeTask(reason, diagnosticReason) {
  try { DiagLogger.info('sw.send', 'finalizeTask reason=' + reason + ' queueLeft=' + ((state.sendQueueV6 || []).length) + ' repairLeft=' + ((state._v6RepairQueue || []).length) + ' results=' + state.sendResults.length); } catch (_) {}
  // 把仍残留在发送队列/补发队列、却没有任何 sendResults 记录的岗位，记为「未投递」（中性灰）
  var recorded = {};
  for (var ri = 0; ri < state.sendResults.length; ri++) {
    if (state.sendResults[ri] && state.sendResults[ri].jobId != null) recorded[state.sendResults[ri].jobId] = true;
  }
  var leftovers = []
    .concat(state.sendQueueV6 || [])
    .concat(state._v6RepairQueue || []);
  // A1 漏发清单：已建联（stage1 点过「立即沟通」，hrName 非空）但没有任何投递结果记录的岗位。
  // 此处只计算并留存清单（保留 greeting/hrName 等队列项字段，补发要用），不发送任何内容——
  // 「停止 = 立即硬中止」语义零改动；补发仅由 review 页「一键补发」或恢复路径触发。
  // 排除：已有结果记录（成功/失败/跳过，在 recorded/sentJobIds）的、空/占位招呼语的（#36 保险丝语义，
  // 正常路径这类岗早被 dropMissingGreetingJobs 剔队并记失败，此处兜底不让其入补发清单）。
  var _missed = [], _missedSeen = {};
  for (var mi = 0; mi < leftovers.length; mi++) {
    var mt = leftovers[mi];
    if (!mt || mt.jobId == null || !mt.hrName) continue;
    if (recorded[mt.jobId] || sentJobIds.has(mt.jobId) || _missedSeen[mt.jobId]) continue;
    if (isGreetingMissing(mt.greeting)) continue;
    _missedSeen[mt.jobId] = true;
    _missed.push(mt);
    recorded[mt.jobId] = true;  // 标记已处理：归入待补发清单，下方循环不再把它当「未投递」重复记
  }
  state._v6MissedJobs = _missed;
  if (_missed.length) {
    try { DiagLogger.info('sw.send', 'A1 漏发清单：' + _missed.length + ' 个已建联未发岗位（reason=' + reason + '）'); } catch (_) {}
  }
  for (var li = 0; li < leftovers.length; li++) {
    var it = leftovers[li];
    if (!it || it.jobId == null || recorded[it.jobId]) continue;
    recorded[it.jobId] = true;
    state.sendResults.push({
      jobId: it.jobId,
      positionName: it.positionName || '',
      companyName: it.companyName || '',
      success: false,
      skipped: true,                       // 计入 failCount，renderReview 以中性灰呈现
      error: reason === 'stopped' ? '未投递：已停止' : '未投递',
      time: Date.now(),
    });
  }
  // total 反映本批所有已记录结果（已投 + skip + 未投递），review 据此展示
  state.sendProgress.total = state.sendResults.length;
  state.sendPhase = '';
  await persistState();
  // 诊断滚动归档：把本轮完整诊断摘要存进 diag:recentRuns（最近 5 次），开新任务清内存也不丢
  try { await archiveRecentRun(reason); } catch (_) {}
  finishSend();
  finishDiagnosticRun(diagnosticReason || reason);
}

// ════════════════════════════════════════════════════════════════
// v5 发送协调 — 双页面串行循环
// ════════════════════════════════════════════════════════════════

async function startSendV5(jobIds) {
  sendStartTime = Date.now();

  // 构建发送队列（过滤已发送）
  const filtered = [];
  for (const id of jobIds) {
    if (sentJobIds.has(id)) continue;
    const job = state.jobs.find(j => j.id === id);
    if (!job) continue;
    filtered.push({
      jobId: id,
      positionName: job.name || '',
      companyName: job.company || '',
      jobLink: job.link || '',
      greeting: state.greetings[job?.tags?.[0] || '其他'] || '',
    });
  }
  if (filtered.length === 0) throw new Error('所有岗位均已发送');

  state.phase = 'sending';
  state.sendQueue = filtered;
  state.sendIndex = 0;
  state.sendProgress = { sent: 0, total: filtered.length };
  state.searchTabId = null;
  pushState();

  // 找到搜索页 tab
  const jobTabs = await chrome.tabs.query({ url: '*://*.zhipin.com/web/geek/jobs*' });
  if (jobTabs.length === 0) throw new Error('搜索页面已关闭');
  state.searchTabId = jobTabs[0].id;
  await waitForContentScript(state.searchTabId);

  // 打开/复用聊天页 tab
  let chatTabId = state.chatTabId;
  if (chatTabId) {
    try {
      const existing = await chrome.tabs.get(chatTabId);
      if (!existing || !existing.url?.includes('/web/geek/chat')) chatTabId = null;
    } catch (_) { chatTabId = null; }
  }
  if (!chatTabId) {
    const ct = await chrome.tabs.create({
      url: 'https://www.zhipin.com/web/geek/chat',
      active: true,
    });
    chatTabId = ct.id;
    state.chatTabId = ct.id;
    await waitForTabLoad(ct.id);
  }
  pushState();
  await waitForContentScript(chatTabId);
  // 切回搜索 tab（后台 tab 节流修复）
  await chrome.tabs.update(state.searchTabId, { active: true });

  // 串行循环
  for (let i = 0; i < filtered.length && state.phase === 'sending'; i++) {
    const item = filtered[i];
    state.sendIndex = i;
    let hrName = '', hrCompany = '';

    // 搜索页：点立即沟通
    try {
      const startResp = await chrome.tabs.sendMessage(state.searchTabId, {
        type: MSG.DO_START_CHAT,
        jobLink: item.jobLink,
        positionName: item.positionName,
        companyName: item.companyName,
      });
      if (!startResp || !startResp.success) {
        if (startResp?.error && startResp.error.includes('captcha')) {
          state.phase = 'captcha_paused';
          pushState();
          break;
        }
        await recordV5Failure(item, startResp?.error || '启动聊天失败');
        continue;
      }
      hrName = startResp.hrName || '';
      hrCompany = startResp.hrCompany || '';
      // 等 BOSS 服务端创建会话 + 推送到聊天 tab
      await new Promise(r => setTimeout(r, 1500));
    } catch (err) {
      if (err.message?.includes('captcha')) {
        state.phase = 'captcha_paused';
        pushState();
        break;
      }
      await recordV5Failure(item, err.message);
      continue;
    }

    // 聊天页：发送招呼语+简历
    try {
      const sendResp = await chrome.tabs.sendMessage(chatTabId, {
        type: MSG.DO_SEND_CHAT,
        hrName: hrName,
        hrCompany: hrCompany,
        greeting: item.greeting,
        jobId: item.jobId,
      });
      if (!sendResp || !sendResp.success) {
        if (sendResp?.captchaDetected || sendResp?.error?.includes('captcha')) {
          state.phase = 'captcha_paused';
          pushState();
          break;
        }
        await recordV5Failure(item, sendResp?.error || '发送失败');
        continue;
      }
      await recordV5Success(item);
    } catch (err) {
      if (err.message?.includes('captcha')) {
        state.phase = 'captcha_paused';
        pushState();
        break;
      }
      await recordV5Failure(item, err.message);
      continue;
    }

    // 随机 2-4s 延迟（最后一个不等）
    if (i < filtered.length - 1 && state.phase === 'sending') {
      const delay = 333;
      await new Promise(r => setTimeout(r, delay));
    }
  }

  // 清理聊天 tab
  try { await chrome.tabs.remove(state.chatTabId); } catch (_) {}
  state.chatTabId = null;
  state.searchTabId = null;
  state.sendQueue = [];
  state.sendIndex = 0;
  pushState();

  if (state.phase === 'sending') finishSend();
}

async function recordV5Success(item) {
  sentJobIds.add(item.jobId);
  state.sendProgress.sent++;
  state.sendResults.push({
    jobId: item.jobId, success: true,
    positionName: item.positionName, companyName: item.companyName,
  });
  pushState();
  chrome.runtime.sendMessage({
    type: MSG.SEND_ITEM_RESULT,
    payload: { jobId: item.jobId, success: true, positionName: item.positionName },
  }).catch(() => {});
}

async function recordV5Failure(item, error) {
  sentJobIds.add(item.jobId);
  state.sendProgress.sent++;
  state.sendResults.push({
    jobId: item.jobId, success: false, error,
    positionName: item.positionName, companyName: item.companyName,
  });
  pushState();
  chrome.runtime.sendMessage({
    type: MSG.SEND_ITEM_RESULT,
    payload: { jobId: item.jobId, success: false, error, positionName: item.positionName },
  }).catch(() => {});
}

// ════════════════════════════════════════════════════════════
// 投递数量闸门 —— 日累积计数器（本地自然日，零点归零）
// 口径：当天「成功发起沟通」的岗位数。成功落账处 +1，幂等（同 jobId 不重复计）。
// 完全独立于发送批次状态：自带 storage key，跨 SW 重启读储存里的 {date,count} 复活；
// date 与今天不符即视为 0（跨日归零，不主动清旧 key）。绝不与核心 send state 耦合。
// ────────────────────────────────────────────────────────────
function localDateKey() {
  // 本地自然日 YYYY-MM-DD（避免 toISOString 的 UTC 偏移导致零点判定错位）
  var d = new Date();
  var y = d.getFullYear();
  var m = String(d.getMonth() + 1).padStart(2, '0');
  var day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

// 本批已计数的 jobId（幂等去重）：startSendV6 每批开始清空
let _dailyCountedJobIds = new Set();

async function getDailySendCount() {
  try {
    var r = await chrome.storage.local.get(STORAGE_KEYS.SW.DAILY_SEND_COUNT);
    var rec = r[STORAGE_KEYS.SW.DAILY_SEND_COUNT];
    if (rec && rec.date === localDateKey() && typeof rec.count === 'number') return rec.count;
  } catch (_) {}
  return 0; // 无记录 / 跨日 / 异常 → 视为今日 0
}

async function incrementDailySendCount(jobId) {
  // 幂等：同一 jobId 本批只 +1（worker 成功 + repair 翻成功可能对同岗调两次）
  if (jobId != null) {
    if (_dailyCountedJobIds.has(jobId)) return;
    _dailyCountedJobIds.add(jobId);
  }
  try {
    var today = localDateKey();
    var r = await chrome.storage.local.get(STORAGE_KEYS.SW.DAILY_SEND_COUNT);
    var rec = r[STORAGE_KEYS.SW.DAILY_SEND_COUNT];
    var count = (rec && rec.date === today && typeof rec.count === 'number') ? rec.count : 0;
    count += 1;
    await chrome.storage.local.set({ [STORAGE_KEYS.SW.DAILY_SEND_COUNT]: { date: today, count: count } });
  } catch (_) {}
}

// ════════════════════════════════════════════════════════════
// HR 活跃度前置过滤 · B3 猎头支线 kick（与 JD 预取并发，不 await）
// ════════════════════════════════════════════════════════════
// 挑本批 isHeadhunter 岗（猎头/匿名，独立页不渲活跃度），把 encryptJobId 发采集 tab → content.js
// handleB3HeadhunterProbe 逐个点真卡自发 detail.json 拿分级活跃度 → 回 B3_HEADHUNTER_RESULT。
// 只 sendMessage 不 activate/切 tab（前台采集 tab 原地点卡，面板翻动=预期内唯一视觉代价）。
// 分级档才需（不限=不筛；只投在线=采集期 bossOnline 已判掉，无需点卡）。任何失败静默（fail-open：猎头不 gate）。
function kickHeadhunterProbe(jdJobs) {
  try {
    var hf = state.hrActiveFilter || '不限';
    try { DiagLogger.info('sw.b3', 'kick入口: hf=' + hf + ' jdJobs=' + (Array.isArray(jdJobs) ? jdJobs.length : -1)); } catch (_) {}
    if (hf === '不限' || hf === '只投在线') return;
    var ids = {};
    var jj = Array.isArray(jdJobs) ? jdJobs : [];
    for (var i = 0; i < jj.length; i++) { if (jj[i] && jj[i].jobId != null) ids[jj[i].jobId] = true; }
    // 按岗回「采集它的那个 tab」分组（_sourceTabId 单城/多城均已打标）：搜索页列表静态不重排
    // （2026-07-04 b3cov 实测 append-only + user 确证），卡只存在于采集 tab 的 DOM——发对 tab 是覆盖率命根。
    var byTab = {};      // sourceTabId → [jobId...]
    var orphan = [];     // 无 _sourceTabId 的岗（旧数据/异常）→ 走降级路由
    var sj = state.jobs || [];
    for (var k = 0; k < sj.length; k++) {
      var j = sj[k];
      var jid = j && (j.jobId || j.id);
      if (!jid || !ids[jid]) continue;      // 只探本批预取岗
      if (!j.isHeadhunter) continue;         // 只探猎头岗（~30%，通常 ~22 个）
      var tid = j._sourceTabId;
      if (tid != null) (byTab[tid] = byTab[tid] || []).push(jid);
      else orphan.push(jid);
    }
    var send = function (tabId, idList) {
      if (!tabId || !idList || !idList.length) return;
      try {
        runActivity('b3-probe', function () {
          return chrome.tabs.sendMessage(tabId, { type: MSG.B3_HEADHUNTER_PROBE, jobIds: idList, hrActiveFilter: hf });
        }).catch(function () {});
      } catch (e) {}
    };
    // 降级路由（orphan / 归属 tab 已死）：query 存活搜索 tab 优先挑 state.searchTabId，否则 tabs[0]
    var fallback = function (idList) {
      if (!idList.length) return;
      chrome.tabs.query({ url: '*://*.zhipin.com/web/geek/jobs*' }).then(function (tabs) {
        var list = tabs || [];
        var hit = null;
        for (var t = 0; t < list.length; t++) {
          if (list[t].id === state.searchTabId) { hit = list[t]; break; }
        }
        send(hit ? hit.id : (list.length ? list[0].id : state.searchTabId), idList);
      }).catch(function () { send(state.searchTabId, idList); });
    };
    try { DiagLogger.info('sw.b3', 'kick分组: ids=' + Object.keys(ids).length + ' byTab=' + JSON.stringify(Object.keys(byTab).map(function (t) { return t + ':' + byTab[t].length; })) + ' orphan=' + orphan.length); } catch (_) {}
    Object.keys(byTab).forEach(function (tidStr) {
      var tid = Number(tidStr);
      chrome.tabs.get(tid).then(function () { send(tid, byTab[tidStr]); })
        .catch(function () { fallback(byTab[tidStr]); }); // 归属 tab 已被关 → 降级（fail-open 兜底）
    });
    fallback(orphan);
  } catch (e) {}
}

// ════════════════════════════════════════════════════════════
// #1 JD 定制招呼语：JD 预取编排器（B 页静默预取 → 流水线生成定制招呼语）
// ════════════════════════════════════════════════════════════
// 机制：popup 进 B 页选好前 75 岗 → START_JD_PREFETCH → 本编排器①简历图只传一次复用②串行取每岗
// JD（每 JD_FETCH_INTERVAL_MS=3000ms 导航后台 tab 到本岗 job_detail 页 → READ_JD 读 JD，拿到立刻丢 API 队列不等返回）
// 取 JD 与调 API 解耦 → 流水线后 ≈ max(3s,4s)≈4s/岗（非串行 7s/岗）。
// 🔴 取 JD 走「导航式」（复刻 startSendV7：tabs.update 后台 tab 到 /job_detail/ 整页 → READ_JD 读 DOM），
//    对屏幕外/任意岗 ~100% 可靠（旧合成点卡靠搜索列表 DOM，虚拟滚动卸载屏幕外卡即失败，已弃）。
// 🔴 单写者铁律：SW 绝不写 ui:jobCustom storage——只内存缓存 + JD_PROGRESS 推送，popup 负责落盘 + 编辑守护。
// 🔴 容错铁律：取 JD 真失败（404/下架/网络/导航超时/读超时）→ 不卡整批 → 退回组级生成（不传 jdText），JD_PROGRESS 带 degraded:true。
// 🔴 旁路：绝不碰 startSendV7/buildSendQueueV6/投递循环；popup 把 greeting 存进 jobCustom 后 startSendV7 本就自动发。
let _jdPrefetchRunId = 0;             // 每次 START/CANCEL 自增；旧在途循环/worker 检测到 runId 变即自停（取消/重启）
const _jdGreetingCache = new Map();   // 同岗缓存：jobId → {greeting, degraded}。定制招呼语是 per-job（含该岗 JD），故按 jobId 缓存（非 category，否则同组不同岗会串用同一招呼语，破坏定制语义）。秒回放不重取不重扣天花板。

// ── JD 预取专用后台 tab（导航式取 JD）──
// 复刻 startSendV7 的后台 loop tab 模式（_preflightV7/_waitTabUrlReady）：tabs.update 到 /job_detail/ 整页 → READ_JD 读 DOM。
// 与投递 loop tab（_v7LoopTabId）隔离（预取发生在投递前，互不占用）；active:false 不抢焦点。
let _jdPrefetchTabId = null;

// 确保预取后台 tab 存在：复用存活的；否则后台新建并初始导航到 initialUrl。
async function _ensureJdPrefetchTab(initialUrl) {
  if (_jdPrefetchTabId != null) {
    try { await chrome.tabs.get(_jdPrefetchTabId); return _jdPrefetchTabId; } catch (_) { _jdPrefetchTabId = null; }
  }
  try { _diagMarkSelfTabOps(); } catch (_) {}
  var tab = await chrome.tabs.create({ url: initialUrl, active: false });
  _jdPrefetchTabId = tab.id;
  return tab.id;
}

async function _closeJdPrefetchTab() {
  if (_jdPrefetchTabId != null) {
    try { _diagMarkSelfTabOps(); } catch (_) {}
    try { await chrome.tabs.remove(_jdPrefetchTabId); } catch (_) {}
    _jdPrefetchTabId = null;
  }
}

// 预取后台 tab 导航就绪：poll tab.url 命中 /job_detail/ + status==='complete' + CS 握手。
// 复刻 _waitTabUrlReady 轮询模式，但生命周期挂 _jdPrefetchRunId（取消/重启即停），与投递 sendAborted 解耦
// （避免 stopSend 残留 sendAborted=true 时预取全 degrade）。
async function _waitJdDetailReady(tabId, runId, timeoutMs) {
  var deadline = Date.now() + (timeoutMs || 15000);
  while (Date.now() < deadline) {
    if (runId !== _jdPrefetchRunId) return false;
    var t = null;
    try { t = await chrome.tabs.get(tabId); } catch (e) { return false; } // tab 没了
    if (t && typeof t.url === 'string' && t.url.indexOf('/job_detail/') >= 0 && t.status === 'complete') {
      try { await waitForContentScript(tabId); return true; } catch (e) { /* CS 还在注入，继续 poll */ }
    }
    await sleep(300);
  }
  return false;
}

// JD 定制招呼语天花板计数（本地自然日，跨日归零；与投递日计数解耦，独立 key）



// 编排入口（fire-and-forget；ack 已由消息分发同步回）
async function startJdPrefetch(jobs, forceIds, seed) {
  await bootRestored; // 冷启动竞态防护：等 boot-restore 完成再跑（与 startSendV7 一致）
  var runId = ++_jdPrefetchRunId;   // bump：抢占旧在途，旧循环/worker 据此自停
  // force 集：单岗刷新用——这些 jobId 跳缓存重生成（删旧缓存，强制重取 JD + 重调 API）
  var forceSet = {};
  if (Array.isArray(forceIds)) for (var fi = 0; fi < forceIds.length; fi++) { forceSet[forceIds[fi]] = true; _jdGreetingCache.delete(forceIds[fi]); }
  // seed 回填：popup 已有招呼语补进内存缓存（SW 被 idle 杀后缓存清空，避免全量重生成）。
  // 只补空位不覆盖（已有条目含 excluded 标记以 SW 为准），force 岗跳过（本就要重生成）。
  if (Array.isArray(seed)) for (var si = 0; si < seed.length; si++) {
    var s = seed[si];
    if (!s || s.jobId == null || typeof s.greeting !== 'string' || !s.greeting) continue;
    if (forceSet[s.jobId] || _jdGreetingCache.has(s.jobId)) continue;
    _jdGreetingCache.set(s.jobId, { greeting: s.greeting, degraded: !!s.degraded });
  }
  var list = (Array.isArray(jobs) ? jobs : []).slice(0, 75).filter(function (j) { return j && j.jobId != null; });
  var total = (Array.isArray(jobs) ? jobs : []).slice(0, 75).length; // 分母含被剔的脏项，保证 done 能到 total
  if (!total) return;
  var _capExempt = true; // No commercial generation limits.
  if (runId !== _jdPrefetchRunId) return; // 门禁查询期间被取消
  try { DiagLogger.info('sw.jd', '[JD预取] 启动 runId=' + runId + ' total=' + total + ' capExempt=' + _capExempt); } catch (_) {}

  // ① 简历图只上传一次，75 岗全复用（内部签名去重，但显式提前传一次拿 fileIds）
  var fileIds = [];
  try { fileIds = await prepareResumeImages(await loadResumeImages(), 30000); } catch (_) { fileIds = []; }
  if (runId !== _jdPrefetchRunId) return; // 上传期间被取消
  // 降本：整批 OCR 一次拿简历文字，75 岗全复用喂文字不喂图（省 74×~2242 图 token）。失败则各岗回退喂图。
  var resumeText = '';
  try { resumeText = await resolveResumeTextOnce(fileIds); } catch (_) { resumeText = ''; }
  if (runId !== _jdPrefetchRunId) return; // OCR 期间被取消

  var progress = { done: 0 };
  // meta（可选）：{excluded, skipReason} —— 取 JD 阶段三标签终判不符时透传给 popup（不生成招呼语，popup 取消勾选）
  function emit(jobId, greeting, ok, degraded, meta) {
    if (runId !== _jdPrefetchRunId) return; // 取消后不再推
    progress.done++;
    var m = {
      type: MSG.JD_PROGRESS,
      jobId: jobId, greeting: greeting || '', ok: !!ok,
      done: progress.done, total: total, degraded: !!degraded,
    };
    if (meta && meta.excluded) { m.excluded = true; m.skipReason = meta.skipReason || ''; }
    if (meta && meta.noQuota) { m.noQuota = true; } // 免费额度用尽：popup 顶部弹购买横幅（卡片仍走失败态）
    chrome.runtime.sendMessage(m).catch(function () {});
  }

  // 脏项（无 jobId）直接记 degraded 推进 done
  var dirtyCount = total - list.length;
  for (var d = 0; d < dirtyCount; d++) emit(null, '', false, true);

  // 已缓存秒回放（不重取不重扣天花板） + 收集待取
  var toFetch = [];
  for (var i = 0; i < list.length; i++) {
    var job = list[i];
    var cached = _jdGreetingCache.get(job.jobId);
    if (cached) {
      if (cached.excluded) emit(job.jobId, '', false, false, { excluded: true, skipReason: cached.skipReason });
      else emit(job.jobId, cached.greeting, true, !!cached.degraded);
      continue;
    }
    toFetch.push(job);
  }

  // ③ API worker 池：并发消费队列；取 JD 与生成解耦的关键
  var apiQueue = [];   // {job, jdText, degraded}
  var fetchDone = false;
  async function apiWorker() {
    while (true) {
      if (runId !== _jdPrefetchRunId) return;
      if (!apiQueue.length) {
        if (fetchDone) return;
        await sleep(150);
        continue;
      }
      var task = apiQueue.shift();
      await _jdGenerateOne(task, fileIds, runId, emit, _capExempt, resumeText);
    }
  }
  var pool = [];
  var workers = (CONFIG && CONFIG.JD_API_CONCURRENCY) || 3;
  for (var w = 0; w < workers; w++) pool.push(apiWorker());

  // ② 取 JD 串行循环：每岗导航后台 tab 到 /job_detail/ → READ_JD 读整页 JD → 拿到立刻丢 API 队列不等返回。
  //    导航式（复刻 startSendV7）对屏幕外/任意岗可靠；degraded 只在真失败（404/下架/网络/读超时）触发。
  var interval = (CONFIG && CONFIG.JD_FETCH_INTERVAL_MS) || 3000;
  for (var f = 0; f < toFetch.length; f++) {
    if (runId !== _jdPrefetchRunId) break;
    var fjob = toFetch[f];
    var jdText = '';
    var degraded = false;
    var detailUrl = fjob.jobLink || ('https://www.zhipin.com/job_detail/' + fjob.jobId + '.html');
    // 取 JD 阶段三标签前置终判所需：从 state.jobs 查全字段（welfareList→welfareConfirmed / daysPerWeekDesc / 标题）
    // + 当前三 filter（state 存），一并透传 content 侧 judgeJdFilters 判定（复用投递期 helper，逻辑同源）。
    var _sj = (state.jobs || []).find(function (j) { return j && (j.jobId || j.id) === fjob.jobId; });
    var _wl = _sj && _sj.welfareList;
    var _WELFARE_KW = ['五险一金', '六险一金', '五险二金', '五险１金']; // 对齐 content.hasInsuranceFromText / buildSendQueueV6
    var _welfareConfirmed = Array.isArray(_wl) && _wl.some(function (w) {
      var ws = String(w);
      return _WELFARE_KW.some(function (kw) { return ws.indexOf(kw) !== -1; });
    });
    var _readJdMsg = {
      type: 'READ_JD', jobId: fjob.jobId,
      restDayFilter: state.restDayFilter || '不限',
      welfareFilter: state.welfareFilter || '不限',
      hrActiveFilter: state.hrActiveFilter || '不限',
      jobName: _sj ? (_sj.name || _sj.positionName || '') : '',
      welfareConfirmed: _welfareConfirmed,
      daysPerWeekDesc: (_sj && typeof _sj.daysPerWeekDesc === 'string') ? _sj.daysPerWeekDesc : '',
    };
    try {
      var tabId = await _ensureJdPrefetchTab(detailUrl);
      if (runId !== _jdPrefetchRunId) break;
      await chrome.tabs.update(tabId, { url: detailUrl }); // 整页导航到本岗详情页
      var ready = await _waitJdDetailReady(tabId, runId, 15000);
      if (runId !== _jdPrefetchRunId) break;
      if (!ready) {
        degraded = true; // 详情页未就绪（404/下架/网络/导航超时）→ 降级组级生成
      } else {
        var resp = await chrome.tabs.sendMessage(tabId, _readJdMsg).catch(function () { return null; });
        if (resp && resp.ok && resp.jdText) {
          // 三标签前置终判：不符 → 不生成招呼语（省 API）+ 标记 excluded 推 popup（popup 取消勾选=不进投递队列）
          if (resp.excluded) {
            _jdGreetingCache.set(fjob.jobId, { excluded: true, skipReason: resp.skipReason || '' });
            emit(fjob.jobId, '', false, false, { excluded: true, skipReason: resp.skipReason || '' });
            if (f < toFetch.length - 1) await sleep(interval); // 串行节流，同正常岗节奏（1.5s 触软封锁）
            continue; // 跳过 apiQueue：excluded 岗绝不生成招呼语
          }
          jdText = String(resp.jdText).slice(0, (CONFIG && CONFIG.JD_TEXT_MAX_LEN) || 1500);
        } else {
          degraded = true; // 读 JD 失败/超时/空 → 降级
        }
      }
    } catch (_) { degraded = true; }
    if (runId !== _jdPrefetchRunId) break;
    apiQueue.push({ job: fjob, jdText: degraded ? '' : jdText, degraded: degraded });
    if (f < toFetch.length - 1) await sleep(interval); // 串行节流，绝不更快（1.5s 触软封锁）
  }
  fetchDone = true;
  // 取 JD 阶段结束：关预取后台 tab（API 生成不再需要它）。仅当仍是本 run 才关，避免误关新 run 复用的 tab。
  if (runId === _jdPrefetchRunId) { try { await _closeJdPrefetchTab(); } catch (_) {} }
  await Promise.all(pool);
  try { DiagLogger.info('sw.jd', '[JD预取] 完成 runId=' + runId + ' done=' + progress.done + '/' + total); } catch (_) {}
}

async function _jdGenerateOne(task, fileIds, runId, emit, capExempt, resumeText) {
  var job = task.job;
  var jdText = task.jdText;
  var degraded = task.degraded;
  // 并发 B3 支线已判此猎头岗 HR 活跃不符 → 不生成（省 API），复用 excluded 出口（尊重 B3 判定）
  var _preB3 = _jdGreetingCache.get(job.jobId);
  if (_preB3 && _preB3.excluded) {
    if (runId === _jdPrefetchRunId) emit(job.jobId, '', false, false, { excluded: true, skipReason: _preB3.skipReason || '' });
    return;
  }

  var greeting = '';
  var ok = false;
  try {
    var _genOpts = {};
    if (!degraded && jdText) _genOpts.jdText = jdText;   // 有 JD → 定制
    if (resumeText) _genOpts.resumeText = resumeText;     // 有 OCR 文字 → 降本喂文字（失败时为空 → 回退喂图）
    greeting = await generateConfiguredGreeting(job.category, fileIds, 120000, Object.keys(_genOpts).length ? _genOpts : undefined);
    if (greeting) ok = true;
  } catch (e) {
    ok = false;
    degraded = true; // 后端/网络失败 → degraded（popup 保留组级招呼语，不阻塞）
    try { DiagLogger.warn('sw.jd', '[JD预取] 生成失败 jobId=' + job.jobId + ' ' + (e && e.message)); } catch (_) {}
  }
  if (runId !== _jdPrefetchRunId) return; // 取消后不推不缓存
  // 生成期间并发 B3 判了排除 → 尊重，不用招呼语覆盖（闭合竞态：B3-first 与 B3-last 都正确）
  var _postB3 = _jdGreetingCache.get(job.jobId);
  if (_postB3 && _postB3.excluded) {
    emit(job.jobId, '', false, false, { excluded: true, skipReason: _postB3.skipReason || '' });
    return;
  }
  if (ok && greeting) {
    _jdGreetingCache.set(job.jobId, { greeting: greeting, degraded: degraded });
    emit(job.jobId, greeting, true, degraded);
  } else {
    emit(job.jobId, '', false, true);
  }
}

// ── 风控自适应退避：captcha 触发记录 + 风险等级（12h 滚动窗口，非自然日，避免午夜重置漏洞）──
// 主因=频率/节奏型自动化检测；BOSS 先弹 captcha（累积阈值），多次后才硬封。
// 窗口内 captcha 次数：0=满速 / 1=降速（worker↓+间隔↑）/ ≥CAPTCHA_STOP_THRESHOLD=拒绝整批冷却。
function _captchaWindowMs() {
  return (typeof CONFIG !== 'undefined' && CONFIG.CAPTCHA_RISK_WINDOW_MS) || (12 * 60 * 60 * 1000);
}
async function recordCaptchaEvent() {
  try {
    var now = Date.now();
    var win = _captchaWindowMs();
    var r = await chrome.storage.local.get(STORAGE_KEYS.SW.CAPTCHA_LOG);
    var log = Array.isArray(r[STORAGE_KEYS.SW.CAPTCHA_LOG]) ? r[STORAGE_KEYS.SW.CAPTCHA_LOG] : [];
    log.push(now);
    // 只留窗口内时间戳，防数组无限增长
    log = log.filter(function (ts) { return typeof ts === 'number' && (now - ts) < win; });
    await chrome.storage.local.set({ [STORAGE_KEYS.SW.CAPTCHA_LOG]: log });
  } catch (_) {}
}
// 返回 12h 滚动窗口内 captcha 触发次数；异常→0（fail-open，不误伤正常用户）
async function getCaptchaRiskCount() {
  try {
    var now = Date.now();
    var win = _captchaWindowMs();
    var r = await chrome.storage.local.get(STORAGE_KEYS.SW.CAPTCHA_LOG);
    var log = Array.isArray(r[STORAGE_KEYS.SW.CAPTCHA_LOG]) ? r[STORAGE_KEYS.SW.CAPTCHA_LOG] : [];
    return log.filter(function (ts) { return typeof ts === 'number' && (now - ts) < win; }).length;
  } catch (_) { return 0; }
}

// 投递错位止血 #3：调用契约——只有「确认发给了正确 HR」才可调本函数。
// 前置不变量（调用方保证）：① WORKER_ACTIVATE 返回 success（含 fallback 命中已通过身份断言）；
// ② WORKER_SEND 返回 success（内容确认送达）。任一不满足走 recordV6Failure + 补发，绝不标成功。
async function recordV6Success(item) {
  sentJobIds.add(item.jobId);
  state.sendProgress.sent++;
  incrementDailySendCount(item.jobId); // 投递数量闸门：成功投递 +1（幂等、独立落盘）
  state.sendResults.push({
    jobId: item.jobId, positionName: item.positionName, companyName: item.companyName,
    success: true, hrName: item.hrName, time: Date.now()
  });
  pushState();
  chrome.runtime.sendMessage({
    type: MSG.SEND_ITEM_RESULT,
    payload: { jobId: item.jobId, positionName: item.positionName, companyName: item.companyName, success: true }
  }).catch(() => {});
}

async function recordV6Failure(item, error, stage) {
  sentJobIds.add(item.jobId);
  state.sendProgress.sent++;
  state.sendResults.push({
    jobId: item.jobId, positionName: item.positionName, companyName: item.companyName,
    success: false, error: error, stage: stage || null, hrName: item.hrName, time: Date.now()
  });
  pushState();
  chrome.runtime.sendMessage({
    type: MSG.SEND_ITEM_RESULT,
    payload: { jobId: item.jobId, positionName: item.positionName, companyName: item.companyName, success: false, error: error }
  }).catch(() => {});
}

async function resumeSendV5() {
  console.log('[即投] Resuming v5 send');
  state.chatTabId = null;

  const jobTabs = await chrome.tabs.query({ url: '*://*.zhipin.com/web/geek/jobs*' });
  if (jobTabs.length === 0) {
    state.phase = 'idle';
    state.sendProgress = { sent: 0, total: 0 };
    pushState();
    chrome.runtime.sendMessage({ type: 'ERROR', message: '搜索页面已关闭，无法恢复发送' }).catch(() => {});
    return;
  }
  state.searchTabId = jobTabs[0].id;

  const unsentJobs = state.jobs.filter(j => !sentJobIds.has(j.id));
  state.sendQueue = unsentJobs.map(j => ({
    jobId: j.id,
    positionName: j.name || '',
    companyName: j.company || '',
    jobLink: j.link || '',
    greeting: state.greetings[j?.tags?.[0] || '其他'] || '',
  }));
  state.sendIndex = 0;
  state.sendProgress = { sent: sentJobIds.size, total: state.jobs.length };
  state.phase = 'sending';
  pushState();

  const ct = await chrome.tabs.create({
    url: 'https://www.zhipin.com/web/geek/chat',
    active: true,
  });
  state.chatTabId = ct.id;
  pushState();
  await waitForTabLoad(ct.id);
  await waitForContentScript(ct.id);
  // 切回搜索 tab（后台 tab 节流修复）
  await chrome.tabs.update(state.searchTabId, { active: true });

  try {
    await waitForContentScript(state.searchTabId);
  } catch (e) {
    for (const item of state.sendQueue) {
      await recordV5Failure(item, '搜索页未就绪(恢复)');
    }
    finishSend();
    return;
  }

  // 继续主循环——复用 startSendV5 的循环逻辑
  const filtered = state.sendQueue;
  const chatTabId = state.chatTabId;
  for (let i = 0; i < filtered.length && state.phase === 'sending'; i++) {
    const item = filtered[i];
    state.sendIndex = i;
    let hrName = '', hrCompany = '';

    try {
      const startResp = await chrome.tabs.sendMessage(state.searchTabId, {
        type: MSG.DO_START_CHAT,
        jobLink: item.jobLink,
        positionName: item.positionName,
        companyName: item.companyName,
      });
      if (!startResp || !startResp.success) {
        if (startResp?.error?.includes('captcha')) { state.phase = 'captcha_paused'; pushState(); break; }
        await recordV5Failure(item, startResp?.error || '启动聊天失败');
        continue;
      }
      hrName = startResp.hrName || '';
      hrCompany = startResp.hrCompany || '';
      // 等 BOSS 服务端创建会话 + 推送到聊天 tab
      await new Promise(r => setTimeout(r, 1500));
    } catch (err) {
      if (err.message?.includes('captcha')) { state.phase = 'captcha_paused'; pushState(); break; }
      await recordV5Failure(item, err.message);
      continue;
    }

    try {
      const sendResp = await chrome.tabs.sendMessage(chatTabId, {
        type: MSG.DO_SEND_CHAT,
        hrName, hrCompany,
        greeting: item.greeting,
        jobId: item.jobId,
      });
      if (!sendResp || !sendResp.success) {
        if (sendResp?.captchaDetected || sendResp?.error?.includes('captcha')) {
          state.phase = 'captcha_paused'; pushState(); break;
        }
        await recordV5Failure(item, sendResp?.error || '发送失败');
        continue;
      }
      await recordV5Success(item);
    } catch (err) {
      if (err.message?.includes('captcha')) { state.phase = 'captcha_paused'; pushState(); break; }
      await recordV5Failure(item, err.message);
      continue;
    }

    if (i < filtered.length - 1 && state.phase === 'sending') {
      await new Promise(r => setTimeout(r, 333));
    }
  }

  try { await chrome.tabs.remove(state.chatTabId); } catch (_) {}
  state.chatTabId = null;
  state.searchTabId = null;
  state.sendQueue = [];
  state.sendIndex = 0;
  pushState();
  if (state.phase === 'sending') finishSend();
}

let _deliveryFinishedFired = false; // 埋点：delivery_finished 每批只发一次（finishSend 可能多入口）；startSendV7 顶部重置

// ════════════════════════════════════════════════════════════════
// v7 详情派 send-on-open 串行投递（替代 v6 并行 worker）
// ──────────────────────────────────────────────────────────────
// 逐岗串行：单后台 loop tab → 导航详情页 → 点「立即沟通」→ 整页跳 /web/geek/chat
//   → 在刚打开的会话里直接发自己 AI 招呼语（BOSS 自动招呼开关已关，不双发）。
// 命门已真机验通：开关关 → 点立即沟通不自动发默认语 → 落进会话 + 输入框就绪 → send-on-open。
// 串行换可靠性（无多 tab WS 争用、无 findConv 错位）；牺牲速度，靠 SEND_INTERVAL 节奏天然降封号风险。
// 旧 v6 两阶段并行 worker 链路已退役删除（startSendV6/runStage1/runStage2/runWorkerLoop/runRepairV6 等）。
// ════════════════════════════════════════════════════════════════

// loop tab 导航到目标 URL 子串并就绪：poll tab.url 命中 substr + status==='complete'，再 PING 握手。
// 整页导航（详情页→chat）期间 tab.url 渐变，onUpdated 可能错过，故主动 poll。
async function _waitTabUrlReady(tabId, urlSubstr, timeoutMs) {
  var deadline = Date.now() + (timeoutMs || 15000);
  while (Date.now() < deadline) {
    if (sendAborted) return false;
    var t = null;
    try { t = await chrome.tabs.get(tabId); } catch (e) { return false; } // tab 没了
    if (t && typeof t.url === 'string' && t.url.indexOf(urlSubstr) >= 0 && t.status === 'complete') {
      // URL + 加载完成都满足，再确认 CS（含新 DETAIL_CLICK_CHAT/CHAT_SEND_ON_OPEN handler 的 main onMessage）就绪
      try { await waitForContentScript(tabId); return true; } catch (e) { /* 继续 poll，CS 可能还在注入 */ }
    }
    await sleep(300);
  }
  return false;
}

function _sameJobDetailUrl(actualUrl, expectedUrl) {
  var pick = function (value) {
    var m = String(value || '').match(/\/job_detail\/([^/?#]+?)(?:\.html)?(?:[?#]|$)/);
    return m ? m[1] : '';
  };
  var actualId = pick(actualUrl);
  var expectedId = pick(expectedUrl);
  return !!actualId && actualId === expectedId;
}

// preflight：①关其他 zhipin chat tab（防多 tab WS 争用）②开最小化独立窗口起步到首岗详情页
//            ③关 BOSS 自动招呼开关（DISABLE_GREETING_SETTING，失败不阻断，降级走双发风险）
async function _preflightV7(firstDetailUrl) {
  try { _diagMarkSelfTabOps(); } catch (_) {}
  // ① 关掉所有已开的 zhipin 聊天页（用户手动开的 + 上一批残留），独占 WS
  try {
    var chatTabs = await chrome.tabs.query({ url: '*://*.zhipin.com/web/geek/chat*' });
    for (var ci = 0; ci < chatTabs.length; ci++) {
      try { await chrome.tabs.remove(chatTabs[ci].id); } catch (e) {}
    }
    if (chatTabs.length) { try { DiagLogger.info('sw.send', 'v7 preflight：关闭 ' + chatTabs.length + ' 个已开聊天页防 WS 争用'); } catch (_) {} }
  } catch (_) {}

  // ② 独立最小化窗口：tab 在窗口内 active，但窗口不抢主屏。
  // 真机控制变量已证实：同岗/同图/同 repairSingle，普通 inactive tab 图片 WS 帧超时；
  // 最小化窗口 active tab 则 status-delivery 成功。单 tab 串行与反封节奏均不变。
  var loopWindow = null;
  var tab = null;
  try {
    loopWindow = await chrome.windows.create({ url: firstDetailUrl, focused: false, state: 'minimized' });
    tab = loopWindow && loopWindow.tabs && loopWindow.tabs[0];
    if (!tab && loopWindow && loopWindow.id != null) {
      var createdTabs = await chrome.tabs.query({ windowId: loopWindow.id });
      tab = createdTabs && createdTabs[0];
    }
    if (!tab) throw new Error('最小化窗口未创建 tab');
  } catch (e) {
    // 极少数浏览器/策略不允许创建窗口：回退旧后台 tab，保证文字投递不被阻断。
    if (loopWindow && loopWindow.id != null) {
      try { await chrome.windows.remove(loopWindow.id); } catch (_) {}
    }
    loopWindow = null;
    tab = await chrome.tabs.create({ url: firstDetailUrl, active: false });
    try { DiagLogger.warn('sw.send', 'v7 preflight：最小化窗口创建失败，回退 inactive tab（图片可能受节流）：' + e.message); } catch (_) {}
  }
  state._v7LoopTabId = tab.id;
  state._v7LoopWindowId = loopWindow && loopWindow.id != null ? loopWindow.id : null;
  var firstDetailReady = false;
  try {
    // 不用只监听未来 onUpdated 的 waitForTabLoad：chrome.tabs.create 返回前页面可能已 complete，
    // 事件已错过会白等满 15s。复用状态轮询，同时验证 CS 已注入。
    var ready = await _waitTabUrlReady(tab.id, '/job_detail/', 15000);
    if (ready) {
      var readyTab = await chrome.tabs.get(tab.id);
      // BOSS 可能追加 query/hash；按 jobId 校验，既可复用同岗，也绝不复用错岗。
      firstDetailReady = !!(readyTab && readyTab.status === 'complete' && _sameJobDetailUrl(readyTab.url, firstDetailUrl));
    }
  } catch (e) { /* CS/URL 未就绪，循环首岗会立即重导航兜底 */ }

  // ③ 关 BOSS 自动招呼开关（status=0）。失败/未实现一律不阻断投递（容错铁律），降级=可能双发默认语+AI 语。
  try {
    var dr = await chrome.tabs.sendMessage(tab.id, { type: MSG.DISABLE_GREETING_SETTING });
    if (dr && dr.ok) { try { DiagLogger.info('sw.send', 'v7 preflight：BOSS 自动招呼开关已关（enabled=' + dr.enabled + '）'); } catch (_) {} }
    else { try { DiagLogger.warn('sw.send', 'v7 preflight：关招呼开关未确认（dr=' + JSON.stringify(dr) + '），继续投递（可能双发）'); } catch (_) {} }
  } catch (e) {
    try { DiagLogger.warn('sw.send', 'v7 preflight：关招呼开关消息失败（CS 半可能未实现 DISABLE_GREETING_SETTING）：' + e.message + '，继续投递'); } catch (_) {}
  }
  return { loopTabId: tab.id, loopWindowId: state._v7LoopWindowId, firstDetailUrl: firstDetailUrl, firstDetailReady: firstDetailReady };
}

function _getReadyPreNavUrl(preflight, detailUrl) {
  return preflight && preflight.firstDetailReady === true && preflight.firstDetailUrl === detailUrl
    ? detailUrl
    : null;
}

async function _closeV7LoopContext() {
  try { _diagMarkSelfTabOps(); } catch (_) {}
  var windowId = state._v7LoopWindowId;
  var tabId = state._v7LoopTabId;
  state._v7LoopWindowId = null;
  state._v7LoopTabId = null;
  if (windowId != null) {
    try { await chrome.windows.remove(windowId); } catch (e) {}
  }
  // 窗口已关时 remove tab 会报不存在；吞掉。窗口创建降级时靠此分支真正关 tab。
  if (tabId != null) {
    try { await chrome.tabs.remove(tabId); } catch (e) {}
  }
}

async function _cleanupV7() {
  if (state._v7LoopWindowId != null || state._v7LoopTabId != null) await _closeV7LoopContext();
  try { await activateOriginalMainWindow(); } catch (e) {}
}

// chat 导航总预算仍是 15s，但约 2.5s 时先看一次详情页按钮：
// 若已翻成「继续沟通」，说明会话已建但导航丢失，立即复用 F2 reclick 救济；
// 若尚未建联，则继续等剩余预算，到 15s 后仍按原 F2 语义再探测一次。
// deps 仅为聚焦时序测试提供可控时钟/依赖；生产路径不传。
async function _waitChatNavigationWithRecovery(tabId, item, totalTimeoutMs, deps) {
  deps = deps || {};
  var totalMs = Math.max(0, totalTimeoutMs || 15000);
  var earlyMs = Math.min(totalMs, 2500);
  var now = deps.now || Date.now;
  var waitReady = deps.waitReady || function (budgetMs) {
    return _waitTabUrlReady(tabId, '/web/geek/chat', budgetMs);
  };
  var probe = deps.probe || async function () {
    try { return await chrome.tabs.sendMessage(tabId, { type: MSG.DETAIL_CHECK_CHAT_BTN, jobId: item.jobId }); }
    catch (e) { return null; }
  };
  var reclick = deps.reclick || async function () {
    try { return await chrome.tabs.sendMessage(tabId, { type: MSG.DETAIL_CLICK_CHAT, jobId: item.jobId }); }
    catch (e) { return null; }
  };
  var isStopped = deps.isStopped || function () {
    return sendAborted || state.phase !== 'sending';
  };
  var logRecovery = deps.logRecovery || function (stage) {
    try {
      var label = stage === 'early' ? '早探测' : 'F2';
      DiagLogger.warn('sw.send', 'v7 ' + label + '：chatNav 未就绪但按钮已翻继续沟通（会话已建、导航丢），再点一次重试 jobId=' + item.jobId);
    } catch (_) {}
  };

  var startedAt = now();

  async function tryReclick(stage, btnResp) {
    if (!btnResp || !btnResp.alreadyChatted) return null;
    logRecovery(stage);
    var clickResp = await reclick();
    if (isStopped()) return { ready: false, recovered: false, aborted: true };
    if (!clickResp || !clickResp.ok) return null;
    // 保留原 F2 语义：reclick 后单独给导航完整 15s 兜底。
    var recoveredReady = await waitReady(15000);
    return { ready: !!recoveredReady, recovered: true, aborted: isStopped() };
  }

  // 正常快导航在这里直接返回，不探测、不 reclick。
  var ready = await waitReady(earlyMs);
  if (ready) return { ready: true, recovered: false, aborted: false };
  if (isStopped()) return { ready: false, recovered: false, aborted: true };

  var earlyBtn = await probe();
  if (isStopped()) return { ready: false, recovered: false, aborted: true };
  var earlyRecovery = await tryReclick('early', earlyBtn);
  if (earlyRecovery) return earlyRecovery;

  // 早探测未建联（或 reclick 瞬时失败）：只用总预算的剩余部分继续等。
  var remainingMs = Math.max(0, totalMs - Math.max(0, now() - startedAt));
  if (remainingMs > 0) ready = await waitReady(remainingMs);
  if (ready) return { ready: true, recovered: false, aborted: false };
  if (isStopped()) return { ready: false, recovered: false, aborted: true };

  // 总预算到期：保留原 F2 终点探测 + reclick 救济。
  var lateBtn = await probe();
  if (isStopped()) return { ready: false, recovered: false, aborted: true };
  var lateRecovery = await tryReclick('late', lateBtn);
  if (lateRecovery) return lateRecovery;
  return { ready: false, recovered: false, aborted: false };
}

async function startSendV7(jobIds, retryKind) {
  await bootRestored;         // 冷启动竞态防护：等 boot-restore 完成再建队列，防止被旧值覆盖
  prepareDiagnosticSendRun(retryKind || '');

  // ── 埋点：delivery_started（尝试级，置于所有闸门之前）──
  _deliveryFinishedFired = false; // 新一批：重置终态埋点去重
  try { trackEvent('delivery_started', { job_count: (jobIds && jobIds.length) || 0 }); } catch (_) {}
  emitDiagnostic({ stage: 'delivery', action: 'delivery_started', status: 'started', queue_total: (jobIds && jobIds.length) || 0 });

  // 串行无并行风暴，故不设降速档（_captchaSlowMode 仅 v6 worker 用）；仅复用「≥阈值拒绝整批」冷却。
  var _riskCount = await getCaptchaRiskCount();
  var _stopN = (typeof CONFIG !== 'undefined' && CONFIG.CAPTCHA_STOP_THRESHOLD) || 2;
  if (_riskCount >= _stopN) {
    try { DiagLogger.warn('sw.send', '风控冷却：12h 内 captcha ' + _riskCount + ' 次，拒绝整批投递'); } catch (_) {}
    trackEvent('delivery_blocked', { reason_code: 'captcha_cooldown' }).catch(function () {});
    var _cooldownErr = new Error('账户近期已触发平台风控 2 次，为避免封号已暂停投递，请休息半天后再试');
    _cooldownErr.errorCode = 'CAPTCHA_COOLDOWN';
    throw _cooldownErr;
  }



  try { DiagLogger.userEvent('sw.send', '任务启动(v7 详情派)：开始投递 jobs=' + ((jobIds && jobIds.length) || 0)); } catch (_) {}
  sendAborted = false;
  state._captchaSlowMode = false;
  state._bossLimitReached = false;
  sendStartTime = Date.now();

  // ── 日上限校验（SW 侧权威闸门）：本批只放行 150 - 今日已投 个，超限记「达上限」不入队 ──
  var _dailyAlready = await getDailySendCount();
  var _dailyLimit = (typeof CONFIG !== 'undefined' && CONFIG.DAILY_SEND_LIMIT) || 150;
  var _remaining = Math.max(0, _dailyLimit - _dailyAlready);
  var _allowedIds = (jobIds || []).slice(0, _remaining);
  var _overflowIds = (jobIds || []).slice(_remaining);
  if ((jobIds || []).length > 0 && _allowedIds.length === 0) {
    trackEvent('delivery_blocked', { reason_code: 'daily_limit' }).catch(function () {});
  }
  try { DiagLogger.info('sw.send', '[v7] 投前数量校验：今日已投=' + _dailyAlready + ' 上限=' + _dailyLimit + ' 本批=' + (jobIds || []).length + ' 放行=' + _allowedIds.length + ' 超限=' + _overflowIds.length); } catch (_) {}

  await loadJobCustomIntoState(); // per-job 自定义招呼语：建队前灌入 state.jobCustom
  // 🔴 sentJobIds 必须在 buildSendQueueV6 之前清空：建队用 !sentJobIds.has(id) 过滤，上一轮失败岗
  // （recordV6Failure 记入 + boot-restore 从 storage 重建）残留会把「一键重投」全滤掉→空队列→报「投递 0 个岗位」。
  sentJobIds.clear();
  _dailyCountedJobIds.clear();
  state.sendQueueV6 = buildSendQueueV6(state, _allowedIds); // 复用 v6 建队（含 per-job/组级招呼语解析）；hrName 留空（v7 无 stage1 提取）
  state.sendQueueV6Index = 0;
  state.sendProgress = { sent: 0, total: (jobIds || []).length }; // 分母含超限岗位（review 能看到被拦）
  state.sendResults = [];
  // 超限岗位：记入结果（达上限、未投递），不入队。须在 sentJobIds/sendResults 重置之后。
  for (var _ov = 0; _ov < _overflowIds.length; _ov++) {
    var _ovId = _overflowIds[_ov];
    var _ovJob = (state.jobs || []).find(function (j) { return (j.jobId || j.id) === _ovId; });
    sentJobIds.add(_ovId);
    state.sendProgress.sent++;
    state.sendResults.push({
      jobId: _ovId,
      positionName: _ovJob ? (_ovJob.name || _ovJob.positionName || '') : '',
      companyName: _ovJob ? (_ovJob.company || _ovJob.companyName || '') : '',
      success: false, skipped: true,
      error: '未投递：今日投递数量已达 BOSS 上限 ' + _dailyLimit + '（明日额度恢复后再投）',
      time: Date.now(),
    });
  }
  state._v6MissedJobs = [];     // v7 不产 missed（hrName 留空→finalizeTask 不计补发清单）
  state._v6RepairQueue = [];
  dropMissingGreetingJobs();    // 空/占位招呼语保险丝：不入队，记失败（须在重置之后）
  emitDiagnostic({ stage: 'delivery', action: 'send_queue_created', status: 'success', queue_total: state.sendQueueV6.length });
  state.phase = 'sending';
  state.sendPhase = 'detail';   // v7 标记：boot-restore 据此走 resumeSendV7（只收口不重跑，防双发）
  await persistState();

  // 冻结待投队列（迭代副本；state.sendQueueV6 保持完整，供终态 finalizeTask 跳过已记录、补记未达岗）
  var queue = (state.sendQueueV6 || []).slice();
  if (!queue.length) {
    // 全被超限/空招呼语剔除 → 直接收口进 review
    await finalizeTask('done');
    return;
  }

  // preflight：关其他 chat tab + 开 loop tab + 关 BOSS 自动招呼开关
  var firstUrl = queue[0].jobLink || ('https://www.zhipin.com/job_detail/' + queue[0].jobId + '.html');
  var _preflight = await _preflightV7(firstUrl);
  var loopTabId = _preflight.loopTabId;
  if (sendAborted) { return; } // preflight 期间被停 → stopSend 已清场/finalize

  var imgOpts = { timeoutMs: 5000, maxAttempts: 2, retryDelayMs: 600 }; // v7 无补发兜底 → 保守值（非 worker fail-fast）

  // B1：上一岗末尾预导航到「本岗详情页」时记下的 URL。本岗 ① 若与之相符则跳过重复 update，直接等就绪。
  var preNavUrl = _getReadyPreNavUrl(_preflight, firstUrl);

  // ── 逐岗串行投递 ──
  for (var qi = 0; qi < queue.length; qi++) {
    if (sendAborted || state.phase !== 'sending') break;
    if (state._bossLimitReached) { try { DiagLogger.warn('sw.send', 'v7：BOSS 今日沟通已达上限，halt 剩余岗位'); } catch (_) {} break; }
    var item = queue[qi];
    if (!item || item.jobId == null) continue;
    if (sentJobIds.has(item.jobId)) continue; // 防御：已记录（超限/dropMissing）的不重复处理

    var detailUrl = item.jobLink || ('https://www.zhipin.com/job_detail/' + item.jobId + '.html');
    try {
      // ① 导航 loop tab 到详情页 + 等就绪
      // B1：若上一岗末尾已预导航到本岗详情（preNavUrl 命中），跳过重复 update，直接等就绪——
      // 那次导航的整页 load 已与「必等的岗间 sleep」重叠，此处 _waitTabUrlReady 大概率秒过。
      var _alreadyPreNav = (preNavUrl && preNavUrl === detailUrl);
      preNavUrl = null; // 消费掉，防误配后续岗位
      if (!_alreadyPreNav) {
        await chrome.tabs.update(loopTabId, { url: detailUrl });
      }
      var detailReady = await _waitTabUrlReady(loopTabId, '/job_detail/', 15000);
      if (sendAborted || state.phase !== 'sending') break;
      if (!detailReady) {
        // 守卫④：详情页 URL 偶发回弹 → 重导航一次
        try { DiagLogger.warn('sw.send', 'v7：详情页未就绪 jobId=' + item.jobId + '，重导航一次'); } catch (_) {}
        await chrome.tabs.update(loopTabId, { url: detailUrl });
        detailReady = await _waitTabUrlReady(loopTabId, '/job_detail/', 15000);
      }
      if (sendAborted || state.phase !== 'sending') break;
      if (!detailReady) {
        await recordV6Failure(item, '详情页加载超时/未就绪', 'detailNav');
        emitDiagnosticAfterBusinessPersist({ stage: 'job_detail', action: 'job_detail_failed', status: 'failed', reason_code: 'detail_not_ready', job_id: item.jobId, job_name: item.positionName, company: item.companyName, queue_index: qi + 1, queue_total: queue.length });
        await persistState();
        await sleep(randBetween(200, 900));
        continue;
      }
      emitDiagnosticAfterBusinessPersist({ stage: 'job_detail', action: 'job_detail_opened', status: 'success', job_id: item.jobId, job_name: item.positionName, company: item.companyName, queue_index: qi + 1, queue_total: queue.length });

      // ② 点「立即沟通」
      var clickResp = null;
      try { clickResp = await chrome.tabs.sendMessage(loopTabId, { type: MSG.DETAIL_CLICK_CHAT, jobId: item.jobId }); } catch (e) { clickResp = { ok: false, reason: '通信失败:' + e.message }; }
      if (sendAborted || state.phase !== 'sending') break;
      if (!clickResp || !clickResp.ok) {
        var _r = (clickResp && clickResp.reason) || '点立即沟通失败';
        // F3-a：优先判显式布尔 alreadyChatted（reason 是英文 'already_chatted'，旧中文正则匹配不上落 else 误记失败）；
        // 保留正则兜底老版本 content。仅老版本 content 返回 ok:false 时才进本分支（新版返 ok:true 走点击+补发守卫）。
        if ((clickResp && clickResp.alreadyChatted) || /已沟通|已经沟通|继续沟通/.test(_r)) {
          // 守卫③：已沟通过 → 记中性灰跳过（非失败、不补发）
          sentJobIds.add(item.jobId);
          state.sendProgress.sent++;
          state.sendResults.push({ jobId: item.jobId, positionName: item.positionName, companyName: item.companyName, success: true, alreadyChatted: true, hrName: item.hrName, time: Date.now() });
          pushState();
        } else if (/上限|达上限/.test(_r)) {
          // 守卫②：沟通次数已达上限 → 整批 halt
          state._bossLimitReached = true;
          await recordV6Failure(item, _r, 'limit');
          await persistState();
          emitDiagnosticAfterBusinessPersist({ stage: 'conversation', action: 'conversation_failed', status: 'failed', reason_code: 'boss_daily_limit', raw_error: _r, job_id: item.jobId, job_name: item.positionName, company: item.companyName, queue_index: qi + 1, queue_total: queue.length });
          break;
        } else {
          await recordV6Failure(item, _r, 'detailClick');
          emitDiagnosticAfterBusinessPersist({ stage: 'conversation', action: 'conversation_failed', status: 'failed', reason_code: 'detail_click_failed', raw_error: _r, job_id: item.jobId, job_name: item.positionName, company: item.companyName, queue_index: qi + 1, queue_total: queue.length });
        }
        await persistState();
        await sleep(randBetween(200, 900));
        continue;
      }

      // ③ 等整页导航到 /web/geek/chat + CS 就绪。约 2.5s 早探测会话已建/导航丢失，
      // 未建联则继续剩余 15s 总预算；到期仍保留原 F2 探测 + reclick 救济。
      var _chatNav = await _waitChatNavigationWithRecovery(loopTabId, item, 15000);
      if (sendAborted || state.phase !== 'sending' || _chatNav.aborted) break;
      var chatReady = _chatNav.ready;
      var _navLostRecovered = _chatNav.recovered;
      if (!chatReady) {
        await recordV6Failure(item, '点立即沟通后未跳转到聊天页/超时', _navLostRecovered ? 'conv_created_nav_lost' : 'chatNav');
        emitDiagnosticAfterBusinessPersist({ stage: 'conversation', action: 'conversation_failed', status: 'failed', reason_code: _navLostRecovered ? 'created_navigation_lost' : 'chat_navigation_timeout', job_id: item.jobId, job_name: item.positionName, company: item.companyName, queue_index: qi + 1, queue_total: queue.length });
        await persistState();
        await sleep(randBetween(200, 900));
        continue;
      }
      emitDiagnosticAfterBusinessPersist({ stage: 'conversation', action: 'conversation_created', status: 'success', job_id: item.jobId, job_name: item.positionName, company: item.companyName, queue_index: qi + 1, queue_total: queue.length });

      // ④ 在刚打开的会话里发招呼语（CS 用 job 上预生成招呼语，不现生成 AI）
      // TODO(jdText 定制)：v1 用统一/组级招呼语，暂不在循环里按该岗 JD 现场定制（旧 maybeApplyJdGreeting 太慢）。
      var sendResp = null;
      var _resumeAssetRefs = [];
      for (var _rs = 0; _rs < _resumeAssetRefs.length; _rs++) {
        emitDiagnosticAfterBusinessPersist({ stage: 'delivery', action: 'resume_send_started', status: 'started', job_id: item.jobId, job_name: item.positionName, company: item.companyName, queue_index: qi + 1, queue_total: queue.length, resume_asset_ref: _resumeAssetRefs[_rs] });
      }
      emitDiagnosticAfterBusinessPersist({ stage: 'delivery', action: 'text_send_started', status: 'started', job_id: item.jobId, job_name: item.positionName, company: item.companyName, queue_index: qi + 1, queue_total: queue.length });
      try {
        sendResp = await chrome.tabs.sendMessage(loopTabId, {
          type: MSG.CHAT_SEND_ON_OPEN,
          jobId: item.jobId,
          greeting: item.greeting,
          imgOpts: imgOpts,
          // F3-b：「继续沟通」点入 / F2 恢复路径 → 启用补发守卫（chat 页查我方消息，有则跳过、无则补发）
          guardAlreadySent: !!(clickResp && clickResp.alreadyChatted) || _navLostRecovered,
        });
      } catch (e) { sendResp = { ok: false, reason: '通信失败:' + e.message }; }
      if (state.phase !== 'sending') break;
      if (sendResp && sendResp.reason && /上限|达上限/.test(sendResp.reason)) {
        state._bossLimitReached = true;
        await recordV6Failure(item, sendResp.reason, 'limit');
        await persistState();
        emitDiagnosticAfterBusinessPersist({ stage: 'delivery', action: 'text_send_failed', status: 'failed', reason_code: 'boss_daily_limit', raw_error: sendResp.reason, job_id: item.jobId, job_name: item.positionName, company: item.companyName, queue_index: qi + 1, queue_total: queue.length });
        break;
      }
      if (sendResp && sendResp.alreadyChatted) {
        // F3-b：会话已存在我方消息 → 中性灰跳过（记成功-跳过，不重复发、不记失败；同守卫③语义）
        sentJobIds.add(item.jobId);
        state.sendProgress.sent++;
        state.sendResults.push({ jobId: item.jobId, positionName: item.positionName, companyName: item.companyName, success: true, alreadyChatted: true, hrName: item.hrName, time: Date.now() });
        pushState();
        emitDiagnosticAfterBusinessPersist({ stage: 'delivery', action: 'text_send_confirmed', status: 'skipped', reason_code: 'already_sent_guard', job_id: item.jobId, job_name: item.positionName, company: item.companyName, queue_index: qi + 1, queue_total: queue.length });
      } else if (sendResp && (sendResp.ok || sendResp.success)) {
        await recordV6Success(item);
        for (var _rc = 0; _rc < _resumeAssetRefs.length; _rc++) {
          emitDiagnosticAfterBusinessPersist({ stage: 'delivery', action: 'resume_send_confirmed', status: 'success', job_id: item.jobId, job_name: item.positionName, company: item.companyName, queue_index: qi + 1, queue_total: queue.length, resume_asset_ref: _resumeAssetRefs[_rc] });
        }
        emitDiagnosticAfterBusinessPersist({ stage: 'delivery', action: 'text_send_confirmed', status: 'success', job_id: item.jobId, job_name: item.positionName, company: item.companyName, queue_index: qi + 1, queue_total: queue.length });
      } else {
        await recordV6Failure(item, (sendResp && sendResp.reason) || '发送失败', (sendResp && sendResp.status) || 'sendOnOpen');
        var _sendReason = (sendResp && (sendResp.reason || sendResp.error || sendResp.status)) || 'send_failed';
        if (sendResp && sendResp.skipped === 'image') {
          if (_resumeAssetRefs.length) {
            for (var _rf = 0; _rf < _resumeAssetRefs.length; _rf++) {
              emitDiagnosticAfterBusinessPersist({ stage: 'delivery', action: 'resume_send_failed', status: 'failed', reason_code: 'image_send_failed', raw_error: _sendReason, job_id: item.jobId, job_name: item.positionName, company: item.companyName, queue_index: qi + 1, queue_total: queue.length, resume_asset_ref: _resumeAssetRefs[_rf] });
            }
          } else {
            emitDiagnosticAfterBusinessPersist({ stage: 'delivery', action: 'resume_send_failed', status: 'failed', reason_code: 'image_send_failed', raw_error: _sendReason, job_id: item.jobId, job_name: item.positionName, company: item.companyName, queue_index: qi + 1, queue_total: queue.length });
          }
          emitDiagnosticAfterBusinessPersist({ stage: 'delivery', action: 'text_send_confirmed', status: 'success', job_id: item.jobId, job_name: item.positionName, company: item.companyName, queue_index: qi + 1, queue_total: queue.length });
        } else {
          emitDiagnosticAfterBusinessPersist({ stage: 'delivery', action: 'text_send_failed', status: 'failed', reason_code: (sendResp && sendResp.status) || 'send_failed', raw_error: _sendReason, job_id: item.jobId, job_name: item.positionName, company: item.companyName, queue_index: qi + 1, queue_total: queue.length });
        }
      }
    } catch (e) {
      await recordV6Failure(item, '详情派通信异常: ' + e.message, 'detail_comm');
      emitDiagnosticAfterBusinessPersist({ stage: 'delivery', action: 'text_send_failed', status: 'failed', reason_code: 'detail_comm', raw_error: e && e.message, job_id: item.jobId, job_name: item.positionName, company: item.companyName, queue_index: qi + 1, queue_total: queue.length });
    }

    await persistState(); // 增量持久化：每岗落账即写盘，SW 被杀也不丢已发进度
    if (sendAborted || state.phase !== 'sending') break;
    // B1：本岗 send 已完成 → 立刻预导航「下一岗详情页」，令其整页 load(~2.3s) 与下方必等的岗间 sleep 重叠，
    // 下一 iter 的 ① 便可直接等就绪、免掉串行的网络等待（省 ~15%）。
    // 🔴 仍单 tab / 单 WS / 零并发：导航发生在本岗 send 完成之后（非并发），且详情页是列表页不连 chatws、不抢帧。
    // 队尾无下一岗则不导航；被停/达上限则不导航（cleanup 会收 tab）。
    if (!sendAborted && !state._bossLimitReached && qi + 1 < queue.length) {
      var _next = queue[qi + 1];
      if (_next && _next.jobId != null && !sentJobIds.has(_next.jobId)) {
        var _nextUrl = _next.jobLink || ('https://www.zhipin.com/job_detail/' + _next.jobId + '.html');
        try {
          await chrome.tabs.update(loopTabId, { url: _nextUrl });
          preNavUrl = _nextUrl;
        } catch (_e) { preNavUrl = null; }
      }
    }
    // 节奏：投递间隔（封号风险主控）+ 岗间随机化破等距指纹
    await sleep(randBetween(CONFIG.SEND_INTERVAL_MIN_MS || 2000, CONFIG.SEND_INTERVAL_MAX_MS || 4000));
    await sleep(randBetween(200, 900));
  }

  if (sendAborted) { return; } // stopSend 已 finalizeTask + 清 loop tab，不重复收尾
  if (state.phase === 'captcha_paused') {
    // CAPTCHA 是可恢复的忙状态：关闭本轮 loop tab，保留 paused，绝不继续下一岗或收口成 review。
    await _cleanupV7();
    return;
  }

  await _cleanupV7();
  // 统一终态：finalizeTask 为「队列里但 halt 未达」的岗位补「未投递」中性灰，再走 review。
  // 正常跑完则无 leftover（每岗已记结果），finalizeTask 直接走 finishSend。
  await finalizeTask('done');
}

// v7 详情派恢复：SW 被杀于串行循环中途。绝不重跑（防对已发岗双发），仅收口已持久化结果进 review。
async function resumeSendV7() {
  await bootRestored;
  try { DiagLogger.info('sw.send', 'resumeSendV7：SW 重启于详情派投递中途，仅收口进 review（不重跑，防双发）results=' + state.sendResults.length); } catch (_) {}
  try { _diagMarkSelfTabOps(); } catch (_) {}
  // 清掉可能残留的 loop 窗口/tab（绝不重放任务，防双发）。
  if (state._v7LoopWindowId != null || state._v7LoopTabId != null) await _closeV7LoopContext();
  sendAborted = false;
  await finalizeTask('done', 'interrupted'); // 把未达岗记「未投递」中性灰，进 review，底部变「重新投递」
}

async function activateOriginalMainWindow() {
  if (!state.originalMainWindowId) return;
  try {
    await chrome.windows.update(state.originalMainWindowId, { focused: true, drawAttention: true });
  } catch (e) {
    // 主窗口可能已被用户关闭，忽略
  }
}

async function stopSend() {
  try { DiagLogger.userEvent('sw.send', '用户点击「停止发送」(STOP_SEND) phase=' + state.phase + ' sendPhase=' + state.sendPhase + ' sent=' + (state.sendProgress && state.sendProgress.sent) + '/' + (state.sendProgress && state.sendProgress.total)); } catch (_) {}
  const wasSending = state.phase === 'sending' || state.phase === 'captcha_paused';
  if (wasSending) trackEvent('delivery_blocked', { reason_code: 'user_stopped' }).catch(function () {});
  try { _diagMarkSelfTabOps(); } catch (_) {} // 下面要主动关 worker tab，别记成用户误操作
  // 硬中止：立即断一切，再统一进终态（review + 重新投递）。
  sendAborted = true; // ① 置全局停止标记：v7 串行循环各边界即刻 bail
  if (wasSending) emitDiagnostic({ stage: 'delivery', action: 'user_stopped', status: 'interrupted', reason_code: 'user_stopped' });

  // ② 立即给搜索 tab + 所有 worker tab 发 DO_STOP，置 content 侧 stopped（停 click/发送/弹窗）
  const tabs = await chrome.tabs.query({ url: '*://*.zhipin.com/*' });
  tabs.forEach((t) => chrome.tabs.sendMessage(t.id, { type: 'DO_STOP' }).catch(() => {}));

  stopAllWorkerKeepalives(); // 强停时清心跳

  // ③ 立即关所有 worker tab/窗（优先关独立后台窗口，连带关 tab；tab remove 兜底）
  if (state._v6WorkerWindowIds) {
    state._v6WorkerWindowIds.forEach(function(wid) {
      try { chrome.windows.remove(wid).catch(function(){}); } catch (e) {}
    });
  }
  state._v6WorkerWindowIds = [];
  if (state._v6WorkerTabIds) {
    state._v6WorkerTabIds.forEach(function(tid) {
      try { chrome.tabs.remove(tid).catch(function(){}); } catch (e) {}
    });
  }
  state._v6WorkerTabIds = [];
  if (state._v6WorkerTabsReady) state._v6WorkerTabsReady.clear();
  state._v6SearchReady = false;

  // v7 详情派：关掉串行循环用的最小化窗口/tab。
  if (state._v7LoopWindowId != null || state._v7LoopTabId != null) await _closeV7LoopContext();

  // 清 v5 残留字段（v5 链路用）
  state.sendQueue = [];
  state.sendIndex = 0;
  state.searchTabId = null;
  state.chatTabId = null;

  // ⑤ 置统一终态：把未投出去的岗位记「未投递」中性灰，停在 review，底部按钮变「重新投递」。
  //    finalizeTask 内部会清 sendPhase、读 sendQueueV6/_v6RepairQueue 补记后再清空也无妨——
  //    故在 finalizeTask 之后再清队列。
  await finalizeTask('stopped');
  state.sendQueueV6 = [];
  state.sendQueueV6Index = 0;
  state._v6RepairQueue = [];
  await persistState();
  await activateOriginalMainWindow();
}

async function getApiKey() { const c = await JitouAI.config(); return c.apiKey || (c.local ? 'local-model' : ''); }

// ── 招呼语并发生成 ──
let greetingPromise = null;

function generateAllGreetingsConcurrent() {
  return runActivity('greeting-batch', _generateAllGreetingsConcurrent);
}

async function _generateAllGreetingsConcurrent() {


  // 即时预热：以用户期望岗位为锚生成 N 条招呼语，不依赖 jdSamples / 岗位采集结果
  // 兜底：从 chrome.storage 读权威 selectedPositions
  let pickerPositions = Array.isArray(state.selectedPositions) ? state.selectedPositions.slice() : [];
  let customPos = Array.isArray(state.customPositions) ? state.customPositions.slice() : [];
  if (!pickerPositions.length && !customPos.length) {
    try {
      const { [STORAGE_KEYS.UI.FILTER_STATE]: fs } = await chrome.storage.local.get(STORAGE_KEYS.UI.FILTER_STATE);
      if (fs) {
        if (Array.isArray(fs.selectedPositions) && fs.selectedPositions.length) {
          pickerPositions = fs.selectedPositions.slice();
          state.selectedPositions = pickerPositions;
        }
        if (Array.isArray(fs.customPositions) && fs.customPositions.length) {
          customPos = fs.customPositions.slice();
          state.customPositions = customPos;
        }
      }
    } catch (e) { /* 静默 */ }
  }
  const selectedPositions = pickerPositions.concat(customPos);
  if (!selectedPositions.length) return;
  const _diagnosticGreetingStartedAt = Date.now();
  emitDiagnostic({ stage: 'greeting', action: 'greeting_started', status: 'started', queue_total: selectedPositions.length });
  _cachedResumeImages = null;
  const apiKey = await getApiKey();
  if (!apiKey) {
    emitDiagnostic({ stage: 'greeting', action: 'greeting_failed', status: 'failed', reason_code: 'api_key_missing', duration_ms: Date.now() - _diagnosticGreetingStartedAt });
    chrome.runtime.sendMessage({ type: 'ERROR', message: '请先在设置页配置 AI API Key' }).catch(() => {});
    return;
  }

  // 加载简历图片（压缩缓存）
  let resumeImages = await loadResumeImages();

  // 已生成成功的 category 跳过，避免重复 API 调用（多触发入口同时打进来时）
  const categories = selectedPositions
    .filter(p => !(state.greetings[p] && !String(state.greetings[p]).includes('生成失败')))
    .map(p => [p, null]);
  const CONCURRENCY = CONFIG.GREETING_CONCURRENCY || 3;
  const TIMEOUT_MS = CONFIG.GREETING_TIMEOUT_MS || 120000;
  let doneCount = 0;
  const total = categories.length;

  state.greetingProgress = { done: 0, total };
  pushState();

  for (let i = 0; i < categories.length; i += CONCURRENCY) {
    const batch = categories.slice(i, i + CONCURRENCY);
    await Promise.allSettled(
      batch.map(([category, samples]) =>
        (async () => {
          for (let attempt = 1; attempt <= 2; attempt++) {
            const tRaceStart = Date.now();
            console.log(`[即投][RACE] ${category} attempt=${attempt} start budget=${TIMEOUT_MS}ms`);
            try {
              const greeting = await Promise.race([
                generateGreeting(apiKey, resumeImages, samples, category),
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS))
              ]);
              const tRaceEnd = Date.now();
              console.log(`[即投][RACE] ${category} attempt=${attempt} WIN ${tRaceEnd - tRaceStart}ms`);
              state.greetings[category] = greeting;
              return;
            } catch (err) {
              const tRaceEnd = Date.now();
              const raceElapsed = tRaceEnd - tRaceStart;
              const reason = err.message === 'timeout' ? `RACE_TIMEOUT@${raceElapsed}ms` : `ERR ${err.message}`;
              console.warn(`[即投][RACE] ${category} attempt=${attempt} LOSE ${raceElapsed}ms reason=${reason}`);
              ErrorLogger.logError(`RACE_LOSE ${category} attempt=${attempt} elapsed=${raceElapsed}ms ${reason}`, err.stack, 'greeting race');
              if (attempt < 2) {
                console.warn(`Greeting generation timeout, retrying (${attempt}/2):`, category, err.message);
                continue;
              }
              console.error('Greeting generation failed (after 2 attempts):', category, err);
              ErrorLogger.logError(err.message || String(err), err?.stack, `Greeting generation failed: ${category}`);
              state.greetings[category] = '生成失败，请刷新';
              emitDiagnostic({ stage: 'greeting', action: 'greeting_failed', status: 'failed', reason_code: err && err.message === 'timeout' ? 'timeout' : 'generation_error', raw_error: err && err.message, job_name: category, attempt: attempt });
            }
          }
        })()
      )
    );

    doneCount += batch.length;
    state.greetingProgress.done = Math.min(doneCount, total);
    pushState();
  }

  state.greetingProgress = { done: total, total };
  // 检查是否全部生成失败
  let allFailed = true;
  for (const cat in state.greetings) {
    if (state.greetings[cat] && !state.greetings[cat].includes('生成失败')) {
      allFailed = false; break;
    }
  }
  if (allFailed && total > 0) {
    chrome.runtime.sendMessage({ type: 'ERROR', message: '招呼语生成失败，请检查 API Key 配置' }).catch(() => {});
  }
  emitDiagnostic({
    stage: 'greeting', action: allFailed && total > 0 ? 'greeting_failed' : 'greeting_completed',
    status: allFailed && total > 0 ? 'failed' : 'success',
    reason_code: allFailed && total > 0 ? 'all_failed' : '',
    duration_ms: Date.now() - _diagnosticGreetingStartedAt, queue_total: total,
  });
  greetingPromise = null;
  pushState();
}

async function regenerateGreeting(category, jdSamples) {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('请先在设置中配置 API Key');
  const resumeImages = await loadResumeImages();
  const samples = jdSamples?.length ? jdSamples : (state.jdSamples?.[category] || []);
  const greeting = await generateGreeting(apiKey, resumeImages, samples, category);
  state.greetings[category] = greeting;
  pushState();
  return greeting;
}

async function doRewriteGreeting(originalGreeting, instruction) {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('请先在设置中配置 API Key');
  return rewriteGreeting(apiKey, originalGreeting, instruction);
}

// ════════════════════════════════════════════════════════════════
// 诊断包：用户行为事件监听（USER_EVENT，误操作判别关键）— 纯新增模块
// 见 handoff-diagnostic-bundle-01。只读 state，不改任何业务逻辑/状态。
// ════════════════════════════════════════════════════════════════

// 「扩展自己关 tab」窗口期标记：teardown/stopSend/resume 清理期间的 onRemoved
// 不算用户误操作。8s 后自动失效（关窗动作是异步的，给足余量）。
var _diagSelfTabOpsUntil = 0;
function _diagMarkSelfTabOps() { _diagSelfTabOpsUntil = Date.now() + 8000; }

// 判断 tabId 是否任务相关（worker / 搜索 / v5 聊天 tab）
function _diagTabRole(tabId) {
  if (state._v6WorkerTabIds && state._v6WorkerTabIds.indexOf(tabId) >= 0) return 'worker';
  if (tabId === state.searchTabId) return 'search';
  if (tabId === state.chatTabId) return 'chat';
  return '';
}

// ① worker/搜索 tab 被关闭
chrome.tabs.onRemoved.addListener(function (tabId, removeInfo) {
  try {
    var role = _diagTabRole(tabId);
    if (!role) return;
    var busy = state.phase === 'sending' || state.phase === 'collecting';
    if (Date.now() < _diagSelfTabOpsUntil) {
      DiagLogger.info('sw.tabs', role + ' tab 关闭（扩展自身清理）tab=' + tabId);
    } else {
      DiagLogger.userEvent('sw.tabs', role + ' tab 被关闭（用户/外部）tab=' + tabId + ' phase=' + state.phase + (busy ? ' ⚠️ 任务进行中被关闭' : ''));
    }
  } catch (_) {}
});

// ② worker/搜索 tab 被导航走（URL 变化）。zhipin 站内 SPA/页内跳转记 INFO，离开 zhipin 记 USER_EVENT。
chrome.tabs.onUpdated.addListener(function (tabId, changeInfo) {
  try {
    if (!changeInfo || !changeInfo.url) return;
    var role = _diagTabRole(tabId);
    if (!role) return;
    if (state.phase !== 'sending' && state.phase !== 'collecting') return;
    // 只保留 origin+path，去掉 query/hash（防泄漏搜索词等）
    var urlBrief = changeInfo.url;
    try { var u = new URL(changeInfo.url); urlBrief = u.origin + u.pathname; } catch (e2) {}
    if (changeInfo.url.indexOf('zhipin.com') < 0) {
      DiagLogger.userEvent('sw.tabs', role + ' tab 被导航离开 BOSS（疑似用户操作）tab=' + tabId + ' → ' + urlBrief + ' phase=' + state.phase);
    } else {
      DiagLogger.info('sw.tabs', role + ' tab URL 变化 tab=' + tabId + ' → ' + urlBrief);
    }
  } catch (_) {}
});

// Installation requires no account registration or network request.

// Invalidate image cache immediately when the user changes their resume.
chrome.storage.onChanged.addListener(function(changes, area) {
 if (area === 'local' && changes.resumeImages) _cachedResumeImages = null;
});
