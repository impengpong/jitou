// ════════════════════════════════════════════════════════════
// 即投 — 错误日志持久化（按 context 分桶环形缓冲）
// 通过 chrome.storage.local 持久化，SW 重启不丢失
// 可在 Service Worker 和 Content Script 中共享使用
// ════════════════════════════════════════════════════════════
// 旧版单一环形缓冲（MAX_ENTRIES=50）下，高负载多岗位测试时 sendText:diag 刷屏
// 会把 findConv:diag 等关键诊断挤掉（李焕之真因被冲走）。改为按 context 分桶，
// 每类各留最近 PER_CONTEXT_MAX 条，互不挤占；总量再设 TOTAL_HARD_CAP 兜底。
// 存储结构仍是单一 array（最新在前），接口签名/读取桥/syncToDOM 不变。

var ErrorLogger = {
  MAX_ENTRIES: 50,            // 兼容保留（旧引用）；实际裁剪走 PER_CONTEXT_MAX
  PER_CONTEXT_MAX: 25,        // 每个 context 桶保留最近条数（findConv/sendText/sendImage 互不挤占）
  TOTAL_HARD_CAP: 300,        // 全部桶之和的硬上限兜底，防 storage 无限增长
  STORAGE_KEY: 'extension:errorLog',

  /**
   * 记录一条错误到 chrome.storage.local
   * @param {string} message - 错误消息
   * @param {string} [stack] - 堆栈或位置信息
   * @param {string} [context] - 发生错误的上下文描述
   */
  async logError(message, stack, context) {
    try {
      const result = await chrome.storage.local.get(this.STORAGE_KEY);
      let entries = result[this.STORAGE_KEY] || [];
      entries.unshift({
        timestamp: Date.now(),
        message: String(message || ''),
        stack: String(stack || ''),
        context: String(context || ''),
      });
      // 按 context 分桶裁剪：每类各留最近 PER_CONTEXT_MAX 条，互不挤占。
      // entries 已是「最新在前」，逐条扫描时每个 context 各自计数，超额的丢弃。
      var perCtxCount = {};
      var kept = [];
      for (var i = 0; i < entries.length; i++) {
        var ctx = entries[i].context || '';
        var c = (perCtxCount[ctx] || 0) + 1;
        perCtxCount[ctx] = c;
        if (c <= this.PER_CONTEXT_MAX) kept.push(entries[i]);
      }
      // 全局硬上限兜底（防 context 种类过多导致总量失控）
      if (kept.length > this.TOTAL_HARD_CAP) {
        kept = kept.slice(0, this.TOTAL_HARD_CAP);
      }
      entries = kept;
      await chrome.storage.local.set({ [this.STORAGE_KEY]: entries });
      // content script 环境下同步写入 DOM，供 osascript 注入读取
      this.syncToDOM();
    } catch (e) {
      // 写 storage 失败时静默 fallback 到 console.error
      console.error('[ErrorLogger] Failed to persist error log:', e);
    }
  },

  /**
   * 获取全部错误日志（最新在前）
   * @returns {Promise<Array>}
   */
  async getErrors() {
    try {
      const result = await chrome.storage.local.get(this.STORAGE_KEY);
      return result[this.STORAGE_KEY] || [];
    } catch (e) {
      return [];
    }
  },

  /**
   * 清空错误日志
   */
  async clearErrors() {
    try {
      await chrome.storage.local.remove(this.STORAGE_KEY);
      this.syncToDOM();
    } catch (e) {
      console.error('[ErrorLogger] Failed to clear error log:', e);
    }
  },

  /**
   * 把当前错误日志同步到页面 DOM（data-error-log 属性）
   * 主对话通过 osascript 注入 JS 读 DOM 即可获取错误日志
   */
  syncToDOM() {
    if (typeof document !== 'undefined' && document.documentElement) {
      this.getErrors().then(function(errors) {
        document.documentElement.setAttribute('data-error-log', JSON.stringify(errors));
      }).catch(function(){});
    }
  },
};
