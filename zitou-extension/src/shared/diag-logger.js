// ════════════════════════════════════════════════════════════
// 即投 — 统一诊断 logger（诊断包功能核心模块）
// SW / Content Script / Popup 三端共用。结构化条目落 chrome.storage.local。
// ════════════════════════════════════════════════════════════
// 设计要点（详见 handoff-diagnostic-bundle-01）：
// - 条目结构 { ts, level, ctx, module, msg }，level ∈ DEBUG/INFO/WARN/ERROR/USER_EVENT
// - 按 context 分 key 存储（diag:log:sw / diag:log:cs / diag:log:popup），
//   避免三端对同一 key 并发 read-modify-write 互相覆盖；导出时合并排序。
// - 写入批量节流：内存攒批，2s 或满 25 条 flush 一次，避免高频 storage 写。
// - storage 为真相源，内存只是写缓冲（SW ~30s 闲置被卸载，内存态必丢）。
//   SW 卸载/页面关闭时丢最后 <2s 的几条可接受。
// - 脱敏在写入时执行：消息截断 300 字符、API key（sk-xxx）/手机号打码。
// - 所有公开方法绝不 throw —— logger 永远不能反过来破坏业务流程。
// ⚠️ 本模块为纯新增；不改动任何现有模块逻辑。

(function (root) {
  // ── context 自动识别 ──
  // SW: 无 window；popup/sidepanel/options: chrome-extension: 协议页面；其余（zhipin 页注入）= cs
  var CTX = (typeof window === 'undefined') ? 'sw'
    : (typeof location !== 'undefined' && location.protocol === 'chrome-extension:') ? 'popup'
    : 'cs';

  var KEY_PREFIX = 'diag:log:';
  var KEY = KEY_PREFIX + CTX;
  var ALL_KEYS = [KEY_PREFIX + 'sw', KEY_PREFIX + 'cs', KEY_PREFIX + 'popup'];

  var MAX_PER_CTX = 400;        // 每个 context 的 ring buffer 上限（三端合计 ~1200 条）
  var FLUSH_INTERVAL_MS = 2000; // 节流：最迟 2s 落盘一次
  var FLUSH_THRESHOLD = 25;     // 攒满 25 条立即落盘
  var MAX_MSG_LEN = 300;        // 单条消息长度上限（防大对象 dump 撑爆 storage）

  var _pending = [];            // 内存写缓冲
  var _timer = null;
  var _flushChain = Promise.resolve(); // 同 context 内 flush 串行化，防自身 read-modify-write 竞态

  // ── 写入级脱敏：API key / 手机号打码 + 截断 ──
  function _sanitize(s) {
    try {
      s = String(s == null ? '' : s);
      if (s.length > MAX_MSG_LEN) s = s.slice(0, MAX_MSG_LEN) + '…[截断]';
      // DashScope 等 API key（sk- 开头长串）
      s = s.replace(/sk-[A-Za-z0-9]{16,}/g, 'sk-[已脱敏]');
      // 中国大陆手机号
      s = s.replace(/(^|[^\d])1[3-9]\d{9}(?!\d)/g, '$11**********');
      return s;
    } catch (e) { return '[sanitize failed]'; }
  }

  function _push(level, module, msg) {
    try {
      _pending.push({
        ts: Date.now(),
        level: level,
        ctx: CTX,
        module: String(module || ''),
        msg: _sanitize(msg),
      });
      if (_pending.length >= FLUSH_THRESHOLD) { _flush(); return; }
      if (!_timer) _timer = setTimeout(_flush, FLUSH_INTERVAL_MS);
    } catch (e) { /* logger 绝不抛错影响业务 */ }
  }

  function _flush() {
    try {
      if (_timer) { clearTimeout(_timer); _timer = null; }
      if (!_pending.length) return _flushChain;
      var batch = _pending;
      _pending = [];
      _flushChain = _flushChain.then(function () {
        return new Promise(function (resolve) {
          try {
            chrome.storage.local.get(KEY, function (r) {
              try {
                if (chrome.runtime.lastError) { resolve(); return; }
                var arr = (r && r[KEY]) || [];
                if (!Array.isArray(arr)) arr = [];
                arr = arr.concat(batch);
                if (arr.length > MAX_PER_CTX) arr = arr.slice(arr.length - MAX_PER_CTX);
                var obj = {};
                obj[KEY] = arr;
                chrome.storage.local.set(obj, function () {
                  void chrome.runtime.lastError; // 吞掉 set 失败（quota 等），诊断尽力而为
                  resolve();
                });
              } catch (e) { resolve(); }
            });
          } catch (e) { resolve(); }
        });
      });
      return _flushChain;
    } catch (e) { return Promise.resolve(); }
  }

  var DiagLogger = {
    CTX: CTX,
    KEYS: ALL_KEYS.slice(),

    debug: function (module, msg) { _push('DEBUG', module, msg); },
    info: function (module, msg) { _push('INFO', module, msg); },
    warn: function (module, msg) { _push('WARN', module, msg); },
    error: function (module, msg) { _push('ERROR', module, msg); },
    // 用户行为事件（误操作判别关键）：关 tab / 导航走 / 点停止 / popup 打开 / 扩展重载等
    userEvent: function (module, msg) { _push('USER_EVENT', module, msg); },

    // 立即落盘（返回 promise，尽力而为）
    flush: function () { return _flush(); },

    // 读取三端全部日志（合并 + 按时间排序 + 含本 context 未落盘的 pending）。
    // callback(entries)；读失败回空数组。导出 UI（popup）用。
    getAll: function (callback) {
      try {
        chrome.storage.local.get(ALL_KEYS, function (r) {
          var all = [];
          try {
            if (!chrome.runtime.lastError && r) {
              for (var i = 0; i < ALL_KEYS.length; i++) {
                var part = r[ALL_KEYS[i]];
                if (Array.isArray(part)) all = all.concat(part);
              }
            }
            all = all.concat(_pending);
            all.sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
          } catch (e) { all = []; }
          try { callback(all); } catch (e2) {}
        });
      } catch (e) {
        try { callback([]); } catch (e2) {}
      }
    },

    // 清空三端日志（预留，导出 UI 可选用）
    clearAll: function (callback) {
      try {
        _pending = [];
        chrome.storage.local.remove(ALL_KEYS, function () {
          void chrome.runtime.lastError;
          try { if (callback) callback(); } catch (e2) {}
        });
      } catch (e) { try { if (callback) callback(); } catch (e2) {} }
    },
  };

  root.DiagLogger = DiagLogger;
})(typeof self !== 'undefined' ? self : this);
