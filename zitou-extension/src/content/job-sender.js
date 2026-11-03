// ── CAPTCHA 检测 ──
const CAPTCHA_SELECTORS = [
  '.captcha-box',
  '.verify-box',
  '.geetest_box',
  '#captcha',
  '.yoda-modal',
  '.nc_wrapper',
  '[class*="captcha"]',
  '[class*="verify"]',
  '.boss-popup-captcha',
];

function detectCaptcha() {
  for (const sel of CAPTCHA_SELECTORS) {
    const el = document.querySelector(sel);
    if (el && el.offsetParent !== null) {
      return { detected: true, selector: sel };
    }
  }
  return { detected: false };
}

// ═══════════════════════════════════════════════════════════════════
// 图片上传 XHR 追踪 — hook XHR.prototype 监听 /wapi/zpupload/quicklyUpload
// 走 CS 世界（content script isolated world）即可，不需注入 page world：
// BOSS 上传走 XMLHttpRequest，CS 与 page 共享同一 XHR 构造器原型链
// （主世界与隔离世界共享 DOM，但不共享 XHR.prototype——所以这里我们 hook
//  的是 isolated world 的 XHR，专门用于 CS 内的 sendImage(); BOSS 自己的
//  上传是 page world 的 XHR，我们捕获不到——所以采用「MutationObserver
//  + change 事件后等 .image-message 出现」组合：见 3.2.c 兜底方案）
// 实际方案：用 Performance Observer + fetch/XHR 双 hook，注入 page world
// 通过 web_accessible_resources，已在 manifest:61 配 — 但为最小改动，
// 这里直接用 MutationObserver 看消息列表里新增 .item-myself 图片气泡。
const ImageUploadTracker = {
  // 等待新的自己图片气泡出现（替代死等 1500ms）
  // baselineCount: 调用前的 .item-myself 数量
  // timeoutMs: 上限超时
  async waitForNewSelfImage(baselineCount, timeoutMs) {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      var pollCount = 0;   // 轮询次数——后台 tab 节流时会很低（区分真没发 vs 确认假阴性的关键）
      var sawBlob = false; // 是否见过 blob: 占位 img（说明 change 已触发上传管线）
      const check = () => {
        pollCount++;
        const items = document.querySelectorAll(SELECTORS.chatDetail.messageSent);
        // tester 实测：BOSS 是 optimistic UI——change 事件后立刻插含 blob: URL 的占位 img，
        // 异步上传完成才把 src 替换为 imgaz.bosszhipin.com 的 CDN URL。
        // 等真 CDN URL 才算上传真完成（排除 blob: 占位）。
        for (let i = baselineCount; i < items.length; i++) {
          const el = items[i];
          var img = el.querySelector('img');
          if (img && img.src && img.src.indexOf('blob:') === 0) sawBlob = true;
          if (img && img.src && img.src.indexOf('https://imgaz.bosszhipin.com/') === 0) {
            resolve({ success: true, latencyMs: timeoutMs - (deadline - Date.now()), pollCount: pollCount, sawBlob: sawBlob, itemsBefore: baselineCount, itemsAfter: items.length });
            return;
          }
        }
        if (Date.now() >= deadline) {
          resolve({ success: false, error: 'image_upload_timeout', latencyMs: timeoutMs, pollCount: pollCount, sawBlob: sawBlob, itemsBefore: baselineCount, itemsAfter: items.length });
          return;
        }
        setTimeout(check, 200); // ⏱️ 轮询 200ms（后台 tab 节流下会被拉长，但 deadline 兜底）
      };
      check();
    });
  },
};

// ═══════════════════════════════════════════════════════════════════
// 投递确认 — 等「我刚发的那条」自己消息的真实投递状态确定
// BOSS 是乐观 UI：失败的消息气泡照样插 DOM，靠 .item-myself 出现判成功是错的。
// 真信号是 .message-status 的 class：
//   .status-delivery = 服务器已确认（真成功）
//   .status-loading  = 发送中
//   .status-error    = 失败
// baselineCount = 发送动作执行前的 .item-myself 数量。必须先等 items.length
// 超过 baseline（新消息真出现）才开始判，否则会读到上一条旧消息误报 delivery
// （致漏图片：图片气泡还没插入 DOM 时读到上条文字的 status-delivery）。
// ⚠️ 内容校验（关键修复）：旧版只看 items[baselineCount] 的 .message-status，
//    不校验那条气泡的内容是不是这次发的招呼语。并发/会话切换竞态下会读到
//    别的气泡（上一条/平台默认招呼/兄弟会话）误报 delivery → 招呼语其实没送出，
//    流程却判完 → 关窗掐断在飞帧 → 漏招呼语。现改为在「新增气泡」里按内容指纹
//    定位真正属于本条招呼语的气泡，再读它的投递状态。
// 返回 { status: 'delivery' | 'error' | 'timeout', meta }。meta 只含计数/状态/耗时，
// 不记录正文或指纹原文；status 判定与原逻辑保持一致。
async function waitForDeliveryStatus(timeoutMs, baselineCount, expectText, attemptNo) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const norm = function(s) { return (s || '').replace(/\s+/g, ''); };
  // 取招呼语前 16 个非空字符作为内容指纹（足以区别平台默认招呼语）
  const fp = norm(expectText).slice(0, 16);
  var pollCount = 0;
  var sawNewBubble = false;
  var matchedFingerprintBubble = false;
  var lastMatchedStatus = 'none';
  var maxNewBubbleCount = 0;
  var maxMatchedBubbleCount = 0;

  function result(status) {
    return {
      status: status,
      meta: {
        attempt: attemptNo || 1,
        sawNewBubble: sawNewBubble,
        matchedFingerprintBubble: matchedFingerprintBubble,
        lastMatchedStatus: lastMatchedStatus,
        newBubbleCount: maxNewBubbleCount,
        matchedBubbleCount: maxMatchedBubbleCount,
        pollCount: pollCount,
        elapsedMs: Date.now() - startedAt,
      },
    };
  }

  while (Date.now() < deadline) {
    pollCount++;
    const items = document.querySelectorAll(SELECTORS.chatDetail.messageSent);
    var newBubbleCount = Math.max(0, items.length - baselineCount);
    if (newBubbleCount > 0) sawNewBubble = true;
    if (newBubbleCount > maxNewBubbleCount) maxNewBubbleCount = newBubbleCount;
    var matchedBubbleCount = 0;
    // 在「新增气泡」(index >= baselineCount) 里找内容含本条招呼语指纹的那条
    for (let i = baselineCount; i < items.length; i++) {
      const target = items[i];
      if (!target) continue;
      // 内容校验：有指纹时必须命中，没命中跳过（继续等真正属于本条的气泡）
      if (fp && norm(target.textContent).indexOf(fp) < 0) continue;
      matchedBubbleCount++;
      matchedFingerprintBubble = true;
      if (matchedBubbleCount > maxMatchedBubbleCount) maxMatchedBubbleCount = matchedBubbleCount;
      const st = target.querySelector('.message-status');
      if (st) {
        if (st.className.indexOf('status-delivery') >= 0) {
          lastMatchedStatus = 'delivery';
          return result('delivery');
        }
        if (st.className.indexOf('status-error') >= 0) {
          lastMatchedStatus = 'error';
          return result('error');
        }
        if (st.className.indexOf('status-loading') >= 0) lastMatchedStatus = 'loading';
        else lastMatchedStatus = 'none';
      } else {
        lastMatchedStatus = 'none';
      }
    }
    await sleep(300);
  }
  return result('timeout');
}

// ═══════════════════════════════════════════════════════════════════
// 图片专用确认：必须等到「新增气泡含 <img> 且 src 是 BOSS CDN url」才算真送出。
// status-delivery 只代表 IM 消息帧送达，不代表图片上传完成——BOSS optimistic UI
// 先插 blob: 占位图，上传成功才换成 imgaz.bosszhipin.com 的 CDN url。上传失败时
// 消息帧照样 status-delivery，但 img 永远停在 blob: → HR 看到消息但没有图。
// 返回 { status:'delivery'|'error'|'timeout', seen:'none'|'bubble_no_img'|'blob'|'cdn'|'error' }
async function waitForImageDelivered(timeoutMs, baselineCount) {
  const deadline = Date.now() + timeoutMs;
  let seen = 'none';
  while (Date.now() < deadline) {
    const items = document.querySelectorAll(SELECTORS.chatDetail.messageSent);
    // ⚠️ 内容校验：在「新增气泡」(index >= baselineCount) 里找含 CDN 图的那条。
    //    图片气泡可能不恰在 baselineCount 位置（前面可能先插了别的气泡），死认
    //    固定下标会误读 → 漏图。改为扫描，必须真出现 CDN <img> 才算送达。
    for (let i = baselineCount; i < items.length; i++) {
      const target = items[i];
      if (!target) continue;
      const st = target.querySelector('.message-status');
      if (st && st.className.indexOf('status-error') >= 0) {
        return { status: 'error', seen: 'error' };
      }
      const img = target.querySelector('img');
      if (img && img.src) {
        if (img.src.indexOf('blob:') === 0) seen = 'blob';
        if (img.src.indexOf('https://imgaz.bosszhipin.com/') === 0) {
          seen = 'cdn';
          // ⚠️ 真送达 = 上传完成(CDN url) 且 WS 帧服务器确认(status-delivery) 两者都满足。
          //    只看 CDN 会在 WS 风暴下误报：上传(HTTP)成功但图片消息帧没发出 → HR 看不到图。
          //    CDN 有了但 status-delivery 还没 → 继续等（WS 可能正在重连），由 sendImage 重试兜底。
          if (st && st.className.indexOf('status-delivery') >= 0) {
            return { status: 'delivery', seen: 'cdn' };
          }
        }
      } else if (seen === 'none') {
        seen = 'bubble_no_img';
      }
    }
    await sleep(300);
  }
  return { status: 'timeout', seen: seen };
}

// 纯观测：检查 baseline 后是否已出现图片发送气泡，不产生任何 DOM/网络动作。
// sendImage 重试前用它区分「首图晚到」和「确实没有气泡」。
function inspectNewImageBubble(baselineCount) {
  const items = document.querySelectorAll(SELECTORS.chatDetail.messageSent);
  let seen = 'none';
  for (let i = baselineCount; i < items.length; i++) {
    const target = items[i];
    if (!target) continue;
    const st = target.querySelector('.message-status');
    if (st && st.className.indexOf('status-error') >= 0) {
      return { found: true, status: 'error', seen: 'error' };
    }
    const img = target.querySelector('img');
    if (img && img.src) {
      if (img.src.indexOf('blob:') === 0) seen = 'blob';
      if (img.src.indexOf('https://imgaz.bosszhipin.com/') === 0) {
        seen = 'cdn';
        if (st && st.className.indexOf('status-delivery') >= 0) {
          return { found: true, status: 'delivery', seen: 'cdn' };
        }
      }
    } else if (seen === 'none') {
      seen = 'bubble_no_img';
    }
  }
  return { found: seen !== 'none', status: 'pending', seen: seen };
}

// 同步检查：baselineCount 之后是否已有「真送达」的图片气泡（CDN url + status-delivery）。
// 用于图片重试前防双发：上次发的图若已确认送达，直接判成功不再重发。
function findDeliveredImageBubble(baselineCount) {
  const items = document.querySelectorAll(SELECTORS.chatDetail.messageSent);
  for (let i = baselineCount; i < items.length; i++) {
    const t = items[i];
    if (!t) continue;
    const img = t.querySelector('img');
    const st = t.querySelector('.message-status');
    if (img && img.src && img.src.indexOf('https://imgaz.bosszhipin.com/') === 0
        && st && st.className.indexOf('status-delivery') >= 0) {
      return true;
    }
  }
  return false;
}

// 同步检查：baselineCount 之后是否已有「真送达」的招呼语气泡（内容含本条招呼语 + status-delivery）。
// 用于文字重试前防双发：上次发的招呼语若已确认送达，直接判成功不再重发。
function findDeliveredTextBubble(baselineCount, expectText) {
  const norm = function(s) { return (s || '').replace(/\s+/g, ''); };
  const fp = norm(expectText).slice(0, 16);
  if (!fp) return false;
  const items = document.querySelectorAll(SELECTORS.chatDetail.messageSent);
  for (let i = baselineCount; i < items.length; i++) {
    const t = items[i];
    if (!t) continue;
    if (norm(t.textContent).indexOf(fp) < 0) continue;
    const st = t.querySelector('.message-status');
    if (st && st.className.indexOf('status-delivery') >= 0) return true;
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════
// 失败重试包装器 — 仅在 status==='error'（真失败）时重试
// fn: 执行一次完整发送动作的 async 函数（文字：重新填字+点 btn；图片：重新 dispatch change）
// label: 'sendText' | 'sendImage'（写诊断用）
// isFailure: (result) => bool，判断结果是否属于「需重试的失败」
//   ⚠️ 只认 status==='error'。timeout 绝不重试——timeout 是不确定态，
//   原消息可能其实已送达，重试会「图片发两次」（实测用户抱怨过）。
// 最多 3 次尝试（首次 + 2 次重试），重试间 sleep 800ms。
// 注意：不点 BOSS 的 error 图标——实测点图片 error 图标会弹出简历上传弹窗污染流程。
async function sendWithRetry(fn, label, isFailure) {
  var lastResult = null;
  for (var attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) {
      // 重试前写诊断（含第几次尝试、上次结果）
      try {
        if (typeof ErrorLogger !== 'undefined' && ErrorLogger.logError) {
          ErrorLogger.logError('[' + label + ':retry] ' + JSON.stringify({
            attempt: attempt, prevResult: lastResult,
          }), '', label + '.diag');
        }
      } catch (e) { /* 诊断失败不影响发送 */ }
      await sleep(800);
    }
    try {
      lastResult = await fn();
    } catch (e) {
      // 抛错视为真失败（status:'error'）——会被重试（如 fileInput 未找到，重试或可恢复）
      lastResult = { success: false, error: label + '异常: ' + (e && e.message), status: 'error' };
    }
    if (!isFailure(lastResult)) return lastResult;
  }
  return lastResult;
}

// ═══════════════════════════════════════════════════════════════════
// 聊天页发送模块 — v4 单次发送（在完整加载的聊天页 /web/geek/chat 运行）
// 不再使用 hash 导航或侧边栏点击，由 SW 驱动搜索页→聊天页导航
// ═══════════════════════════════════════════════════════════════════
// ── 全局轮询等待元素出现（多选择器 fallback，最长 timeoutMs 毫秒）──
async function waitForElement(selectors, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const sel of (Array.isArray(selectors) ? selectors : [selectors])) {
      const el = document.querySelector(sel);
      if (!el) continue;
      if (el.offsetParent !== null) return el;
      // 固定定位元素的 offsetParent 始终为 null，但仍是可见的
      if (getComputedStyle(el).position === 'fixed') return el;
    }
    await sleep(200);
  }
  return null;
}

const JobSender = {
  stopped: false,
  minInterval: 2000,
  maxInterval: 4000,
  batchSize: 50,

  // ── 随机间隔 2-4s（与 CONFIG 对齐）──
  randomInterval() {
    return this.minInterval + Math.random() * (this.maxInterval - this.minInterval);
  },

  // ── 等待 ──
  async wait(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this._stopTimer = () => { clearTimeout(timer); resolve(); };
    });
  },

  // ── 轮询等待元素 ──
  waitForElement(selectors, timeoutMs = 5000) {
    return waitForElement(selectors, timeoutMs);
  },

  // ── 在聊天输入框发送文字招呼语（单次尝试，不含重试）──
  async _sendTextOnce(greeting, baselineOverride, timeoutMsOverride, attemptNo) {
    // 空招呼语兜底：AI 招呼语生成超时会产生空 greeting，绝不能把空内容发出去。
    // 返回 status:'error' 让上层如实记失败（注意：error 仍会被重试，但空 greeting
    // 重试也还是空——sendText 的 isFailure 不认空内容场景，见下方说明）。
    if (!greeting || !greeting.trim()) {
      return { success: false, error: 'greeting_empty', status: 'error' };
    }

    const input = await this.waitForElement(SELECTORS.chatDetail.chatInput, 10000);
    if (!input) return { success: false, error: '未找到聊天输入框', status: 'error' };

    const sendBtn = await this.waitForElement(SELECTORS.chatDetail.btnSend, 2000);
    if (!sendBtn) return { success: false, error: '未找到发送按钮', status: 'error' };

    // 重新获取输入框引用，用 waitForElement 而非 querySelector
    // querySelector 返回 DOM 第一个匹配（可能是隐藏的），waitForElement 只返回可见元素
    const freshInput = await this.waitForElement(SELECTORS.chatDetail.chatInput, 2000);
    if (!freshInput) return { success: false, error: '未找到聊天输入框', status: 'error' };

    // ── 诊断采集（只读，不影响发送逻辑）──
    var _diag = {};
    try {
      _diag.hasFocus_before = document.hasFocus();
      _diag.input_tag = freshInput.tagName;
      _diag.input_id = freshInput.id;
      _diag.input_class = freshInput.className;
      _diag.input_isContentEditable = freshInput.isContentEditable;
      _diag.input_offsetHeight = freshInput.offsetHeight;
    } catch (e) { _diag.preErr = String(e && e.message); }

    freshInput.focus();

    try {
      _diag.hasFocus_after = document.hasFocus();
      var _ae = document.activeElement;
      _diag.activeEl_tag = _ae ? _ae.tagName : null;
      _diag.activeEl_id = _ae ? _ae.id : null;
      _diag.activeEl_class = _ae ? _ae.className : null;
      var _sel = window.getSelection();
      _diag.sel_rangeCount = _sel ? _sel.rangeCount : -1;
      _diag.sel_inFreshInput = (_sel && _sel.rangeCount > 0) ? freshInput.contains(_sel.anchorNode) : false;
    } catch (e) { _diag.focusErr = String(e && e.message); }

    // 后台 tab 下 execCommand('insertText') 是 no-op（实测）。
    // 改走 textContent 直填 + 派发 InputEvent('input') 让 Vue v-model 更新。
    freshInput.textContent = greeting;
    freshInput.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: greeting,
    }));

    try {
      _diag.fillMode = 'textContent+InputEvent';
      _diag.textContent_afterFill = (freshInput.textContent || '').slice(0, 60);
      _diag.textContent_afterFill_len = (freshInput.textContent || '').length;
      _diag.greeting_len = (greeting || '').length;
    } catch (e) { _diag.fillErr = String(e && e.message); }

    try {
      if (typeof ErrorLogger !== 'undefined' && ErrorLogger.logError) {
        ErrorLogger.logError('[sendText:diag] ' + JSON.stringify(_diag), '', 'sendText.diag');
      }
    } catch (e) { /* 诊断失败不影响发送 */ }

    if (!freshInput.textContent || freshInput.textContent.trim() === '') {
      return { success: false, error: '文字未能填入输入框', status: 'error' };
    }

    // ⏱️ 等 ≥600ms 给 Vue 跑完 watch → btn-send classList 切换到 enabled
    // （后台 tab setTimeout 节流，给 700ms 余量；原 300ms 改为 700ms）
    await sleep((typeof CONFIG !== 'undefined' && CONFIG.FILL_SETTLE_MS) || 700);

    // 用 classList 判 enable 替代 disabled 属性（BOSS 用 .btn-send.disabled 而非 [disabled]）
    var enabled = !sendBtn.classList.contains('disabled') && !sendBtn.disabled;
    if (!enabled) {
      // 再给一次 200ms 余量重检（仍非 enabled 视为填字未触发 v-model）
      await sleep(200); // ⏱️ 新增：enable 兜底重检
      enabled = !sendBtn.classList.contains('disabled') && !sendBtn.disabled;
      if (!enabled) {
        return { success: false, error: 'btn-send 未激活（v-model 未更新？）', status: 'error' };
      }
    }

    // ── baseline：click 之前记录自己消息数，确认「我刚发的这条」而非旧消息 ──
    // baselineOverride：重试时由 sendText 传入「首次发送前」的基准，使内容校验能跨
    // 多次重试扫描，配合 findDeliveredTextBubble 防双发。
    const baselineCount = (typeof baselineOverride === 'number')
      ? baselineOverride
      : document.querySelectorAll(SELECTORS.chatDetail.messageSent).length;

    sendBtn.click();

    // ── 投递确认（替代旧的乐观 UI 假信号轮询）──
    // 旧版靠「输入框清空 / btn disabled / 气泡出现」判成功——全是乐观 UI 假信号，
    // 失败的消息气泡照样插入 DOM。改为轮询「我刚发的那条」的 .message-status。
    // 调用方（sendText）可覆盖此超时；不传则走 8s（legacy 兼容）。
    const _waitMs = (typeof timeoutMsOverride === 'number') ? timeoutMsOverride : 8000;
    const deliveryResult = await waitForDeliveryStatus(_waitMs, baselineCount, greeting, attemptNo);
    const status = deliveryResult.status;
    try {
      if (typeof ErrorLogger !== 'undefined' && ErrorLogger.logError) {
        ErrorLogger.logError('[sendText:diag] ' + JSON.stringify({
          deliveryStatus: status,
          baselineCount: baselineCount,
          deliveryMeta: deliveryResult.meta,
        }), '', 'sendText.diag');
      }
    } catch (e) { /* 诊断失败不影响发送 */ }
    if (status === 'delivery') return { success: true, status: 'delivery' };
    if (status === 'error') return { success: false, error: 'text_delivery_failed', status: 'error' };
    // timeout：不确定态，不重发（避免双发），如实返回失败
    return { success: false, error: 'text_delivery_timeout', status: 'timeout', warning: 'send_unconfirmed' };
  },

  // ── 发送文字招呼语（含失败重试，可调超时/重试次数）──
  // WS 风暴下招呼语消息帧也可能发不出（status 卡 loading/timeout → HR 看不到）。
  // 与图片一致：重试直到 waitForDeliveryStatus 确认本条招呼语 status-delivery 真送达。
  // 防双发：origBaseline 只在首次前取一次；重试前先按内容查是否已送达，有则直接成功不重发。
  // opts: { timeoutMs, maxAttempts, retryDelayMs } — 不传走默认值 = 历史行为（兼容 legacy 串行）。
  //   worker 阶段：{timeoutMs:3000, maxAttempts:1} — 不死等抢 WS，快速转补发（补发兜底）
  //   补发阶段：{timeoutMs:5000, maxAttempts:2, retryDelayMs:600} — 单连接干净环境
  async sendText(greeting, opts) {
    // 空招呼语：立即失败返回（重试空内容无意义）。
    if (!greeting || !greeting.trim()) {
      return { success: false, error: 'greeting_empty', status: 'error' };
    }
    opts = opts || {};
    const maxAttempts = opts.maxAttempts || 3;
    const retryDelayMs = (typeof opts.retryDelayMs === 'number') ? opts.retryDelayMs : 1200;
    const timeoutMs = opts.timeoutMs; // 透传给 _sendTextOnce；undefined 时走 8s 默认
    const origBaseline = document.querySelectorAll(SELECTORS.chatDetail.messageSent).length;
    let last = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        // 重试前两次查送达：上次的招呼语可能 WS 帧延迟才确认 → 已送达就不重发（防双发）
        if (findDeliveredTextBubble(origBaseline, greeting)) return { success: true, status: 'delivery' };
        await sleep(retryDelayMs); // 给 WS 重连留时间
        if (findDeliveredTextBubble(origBaseline, greeting)) return { success: true, status: 'delivery' };
      }
      try {
        last = await this._sendTextOnce(greeting, origBaseline, timeoutMs, attempt);
      } catch (e) {
        last = { success: false, error: 'sendText异常: ' + (e && e.message), status: 'error' };
      }
      if (last && last.success) return last;
    }
    return last || { success: false, status: 'timeout' };
  },

  // ── 在当前对话发图片（简历）—— 单次尝试，不含重试 ──
  // 注意：BOSS 的 file input change 事件会触发自动上传 + 自动发送，
  // 不需要再点 btn-send。改为 dispatch change 后等真实投递状态确定
  // （waitForDeliveryStatus 看 .message-status），替代旧的 CDN URL 气泡检测。
  async _sendImageOnce(blob, filename = 'resume.jpg', jobId, baselineOverride, timeoutMsOverride) {
    const file = new File([blob], filename, { type: 'image/jpeg' });
    const dt = new DataTransfer();
    dt.items.add(file);

    // 纯 DOM 重试（不能用 waitForElement，隐藏 input 的 offsetParent 永远是 null）
    var fileInput = null;
    for (var retry = 0; retry < 10 && !fileInput; retry++) {
      fileInput = document.querySelector(SELECTORS.chatDetail.imageUpload);
      if (!fileInput) await sleep(500); // ⏱️ 保留：找 fileInput 重试
    }
    if (!fileInput) {
      try {
        if (typeof ErrorLogger !== 'undefined' && ErrorLogger.logError) {
          ErrorLogger.logError('[sendImage:diag] ' + JSON.stringify({ jobId: jobId || '', filename: filename, fileInputFound: false }), '', 'sendImage.diag');
        }
      } catch (e) {}
      throw new Error('未找到图片上传入口');
    }

    // ── baseline：dispatch change 之前记录自己消息数，确认「我刚发的这条」 ──
    // 关键修复：图片气泡可能晚于 dispatch 才插入 DOM，若不传 baseline 会读到
    // 上一条文字消息（已 status-delivery）误报成功 → 图片漏发。
    // baselineOverride：重试时由 sendImage 传入「首次发送前」的基准，使确认能跨多次
    // 重试扫描所有图片气泡，配合 findDeliveredImageBubble 防双发。
    const baselineCount = (typeof baselineOverride === 'number')
      ? baselineOverride
      : document.querySelectorAll(SELECTORS.chatDetail.messageSent).length;

    // 用原生 setter 绕过框架拦截
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files').set;
    nativeSetter.call(fileInput, dt.files);
    // 派发两种事件，兼容 React/Vue（BOSS 监听 change 后自动上传+发送）
    fileInput.dispatchEvent(new Event('input', { bubbles: true }));
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));

    // ⏱️ 图片专用确认：status-delivery（IM 消息帧送达）不代表图片上传完成。
    // 必须验 <img> src 是 BOSS CDN url——否则上传失败时 img 停在 blob: 占位，
    // HR 看到消息但没有图（实测 9/10 报 delivery 但 3 个对话缺图的根因）。
    // 上限 IMG_UPLOAD_TIMEOUT_MS（默认 15s）。
    // 调用方（sendImage）可覆盖此超时；不传则走 CONFIG.IMG_UPLOAD_TIMEOUT_MS（15s，legacy 兼容）
    const timeoutMs = (typeof timeoutMsOverride === 'number')
      ? timeoutMsOverride
      : ((typeof CONFIG !== 'undefined' && CONFIG.IMG_UPLOAD_TIMEOUT_MS) || 15000);
    const r = await waitForImageDelivered(timeoutMs, baselineCount);
    const status = r.status;
    // 始终写诊断（成功也写）——含真实投递状态 + seen（卡在 blob/bubble_no_img/none）
    try {
      if (typeof ErrorLogger !== 'undefined' && ErrorLogger.logError) {
        ErrorLogger.logError('[sendImage:diag] ' + JSON.stringify({
          jobId: jobId || '', filename: filename, fileInputFound: true,
          deliveryStatus: status, seen: r.seen, baselineCount: baselineCount, success: status === 'delivery',
        }), '', 'sendImage.diag');
      }
    } catch (e) { /* 诊断失败不影响发送 */ }
    if (status !== 'delivery') {
      console.warn('[即投] sendImage: 图片未确认，status=' + status + ' seen=' + r.seen);
    }
    return { success: status === 'delivery', status: status, seen: r.seen };
  },

  // ── 发送图片（含失败重试，可调超时/重试次数）──
  // WS 风暴下图片消息帧可能发不出（上传 HTTP 成功但 WS 帧未送达 → HR 看不到图）。
  // 改为重试直到 waitForImageDelivered 确认「CDN 上传完成 且 status-delivery WS 帧送达」。
  // 防双发：origBaseline 只在首次发送前取一次；每次重试前先查是否已有送达的图，有则直接成功不重发。
  // timeout 但已见 cdn/blob/bubble_no_img 表示首图气泡在途；后续 attempt 仅继续确认，禁止再 dispatch。
  // opts: { timeoutMs, maxAttempts, retryDelayMs } — 不传走默认值 = 历史行为（兼容 legacy 串行）。
  //   worker 阶段：{timeoutMs:4000, maxAttempts:1} — 不死等抢 WS，快速转补发
  //   补发阶段：{timeoutMs:5000, maxAttempts:2, retryDelayMs:600} — 单连接干净环境，发不出多半真没救
  async sendImage(blob, filename = 'resume.jpg', jobId, opts) {
    opts = opts || {};
    const maxAttempts = opts.maxAttempts || 3;
    const retryDelayMs = (typeof opts.retryDelayMs === 'number') ? opts.retryDelayMs : 1200;
    const timeoutMs = opts.timeoutMs; // 透传给 _sendImageOnce；undefined 时走 CONFIG.IMG_UPLOAD_TIMEOUT_MS
    const confirmTimeoutMs = (typeof timeoutMs === 'number')
      ? timeoutMs
      : ((typeof CONFIG !== 'undefined' && CONFIG.IMG_UPLOAD_TIMEOUT_MS) || 15000);
    const origBaseline = document.querySelectorAll(SELECTORS.chatDetail.messageSent).length;
    let last = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      var observed = null;
      if (attempt > 1) {
        // 重试前先查送达，再给 WS 重连时间；延迟后观测任何新气泡，不只看 delivery。
        if (findDeliveredImageBubble(origBaseline)) return { success: true, status: 'delivery', seen: 'cdn' };
        await sleep(retryDelayMs); // 给 WS 重连留时间
        observed = inspectNewImageBubble(origBaseline);
        if (observed.status === 'delivery') return { success: true, status: 'delivery', seen: observed.seen };
      }
      // 已见任何首图气泡（首轮或 retryDelay 期间晚到）：下一 attempt 只做确认并耗用该槽位。
      var hasInFlightBubble = last && last.status === 'timeout' && (
        last.seen === 'cdn' || last.seen === 'blob' || last.seen === 'bubble_no_img' ||
        (last.seen === 'none' && observed && observed.found && observed.status !== 'error')
      );
      if (hasInFlightBubble) {
        try {
          var confirmResult = await waitForImageDelivered(confirmTimeoutMs, origBaseline);
          if (confirmResult && confirmResult.status === 'delivery') {
            return { success: true, status: 'delivery', seen: confirmResult.seen };
          }
          return {
            success: false,
            status: (confirmResult && confirmResult.status) || 'timeout',
            seen: (confirmResult && confirmResult.seen) || 'cdn',
          };
        } catch (e) {
          return { success: false, error: 'sendImage确认异常: ' + (e && e.message), status: 'error', seen: 'cdn' };
        }
      }
      // 只有明确 error，或完整窗口仍 seen=none 且 retryDelay 后仍无气泡，才重新 dispatch。
      // 每次 dispatch 用当前气泡数作 baseline，避免上一 attempt 的 error 气泡污染新确认。
      var attemptBaseline = document.querySelectorAll(SELECTORS.chatDetail.messageSent).length;
      try {
        last = await this._sendImageOnce(blob, filename, jobId, attemptBaseline, timeoutMs);
      } catch (e) {
        last = { success: false, error: 'sendImage异常: ' + (e && e.message), status: 'error' };
      }
      if (last && last.status === 'delivery') return { success: true, status: 'delivery', seen: last.seen };
    }
    return last || { success: false, status: 'timeout' };
  },

  // ── 发送单个岗位（招呼语 + 简历图片）──
  // textOpts: 透传给 sendText（worker 阶段传激进值快速 fail-fast 转补发，跟 imgOpts 并列）
  // imgOpts: 透传给 _sendResumeImages → sendImage（worker 阶段传激进值快速 fail-fast 转补发）
  async sendSingle(greeting, jobId, imgOpts, textOpts) {
    // 硬中止：停止后绝不再发文本/图片
    if (this.stopped) return { success: false, stopped: true, error: 'stopped' };

    // ── 发送顺序：默认机制=先发简历图，再发 AI 招呼语 ──
    // 部分 HR 只看到【图片】字样不打开对话，先发简历图能让首条可见消息就是图。
    // 语义：文字=核心招呼语（失败 = 硬失败短路），
    // 图片=附属物（失败 = skipped:'image' 软失败，SW 据此区分 stage）。
    var imageFailed = false;
    var imageError = null;

    // 1. 先发简历图：图失败不短路（先记录，待文字发完后如实返回）
    var imgRet = await this._sendResumeImages(jobId, imgOpts);
    imageFailed = imgRet.imageFailed;
    imageError = imgRet.imageError;
    if (this.stopped) return { success: false, stopped: true, error: 'stopped' };
    await sleep(500);

    // 2. 发送文字招呼语（核心，失败硬短路）
    var textResult;
    try { textResult = await this.sendText(greeting, textOpts); }
    catch (e) { textResult = { success: false, error: 'sendText异常: ' + e.message }; }
    if (!textResult.success) return textResult;
    if (this.stopped) return { success: false, stopped: true, error: 'stopped' };

    // 3. 检测验证码
    if (typeof detectCaptcha === 'function') {
      const captcha = detectCaptcha();
      if (captcha.detected) {
        chrome.runtime.sendMessage({ type: MSG.CAPTCHA_DETECTED }).catch(() => {});
        return { success: false, error: 'captcha', captchaDetected: true };
      }
    }

    // 4. 如实返回：图片最终仍失败则带 skipped:'image'（SW 靠此字段区分 stage）
    if (imageFailed) {
      return { success: false, error: imageError || 'image_send_failed', skipped: 'image' };
    }

    return { success: true };
  },

  // ── 发送简历图片（sendSingle 与 repairSingle 共用）──
  // 返回 { imageFailed, imageError, attempted }
  //   attempted=false 表示根本没有可发的图（storage 里无图）——此时不算失败，调用方据此判断。
  // imgOpts: 透传给 sendImage（控制单图超时/重试次数/重试间隔，区分 worker vs 补发）
  async _sendResumeImages(jobId, imgOpts) {
    // 优先读取 per-job 自定义图片，没有则 fallback 到 group 级别图片
    let imagesData = null;
    try {
      const { 'ui:jobCustom': jobCustom } = await chrome.storage.local.get('ui:jobCustom');
      if (jobCustom && jobCustom[jobId] && jobCustom[jobId].images && jobCustom[jobId].images.length > 0) {
        imagesData = jobCustom[jobId].images;
      } else if (jobCustom && jobCustom[jobId] && jobCustom[jobId].noImages) {
        // 组图被用户明确清空 → 不发图也不走全局兜底（无图可发不算失败）
        try { if (typeof DiagLogger !== 'undefined') DiagLogger.info('cs.send', 'noImages命中跳过发图 jobId=' + jobId); } catch (_) {}
        return { imageFailed: false, imageError: null, attempted: false };
      }
    } catch (e) { /* 静默，fallback 到 group 级别 */ }

    var imageFailed = false;
    var imageError = null;
    var attempted = false;

    if (imagesData && imagesData.length > 0) {
      // Per-job 自定义图片（data URL 格式）
      for (const img of imagesData) {
        if (this.stopped) break;
        const dataUrl = img.fullSrc || img.src;
        if (!dataUrl) continue;
        attempted = true;
        try {
          const blob = dataUrlToBlob(dataUrl);
          const imgResult = await this.sendImage(blob, img.name || 'resume.jpg', jobId, imgOpts);
          if (!imgResult || imgResult.success === false) {
            imageFailed = true;
            imageError = (imgResult && imgResult.status) ? ('image_' + imgResult.status) : 'image_send_failed';
          }
        } catch (e) {
          console.warn('[即投] 发送 per-job 图片失败:', e.message);
          imageFailed = true;
          imageError = 'image_send_failed';
        }
        await sleep(800); // ⏱️ 保留：多图之间节流（避免 BOSS 反作弊触发，不可省）
      }
    } else {
      // Fallback: group 级别 resumeImages（二进制格式）
      const { resumeImages: stored } = await chrome.storage.local.get('resumeImages');
      if (stored && stored.length > 0) {
        for (const s of stored) {
          if (this.stopped) break;
          attempted = true;
          const blob = new Blob([new Uint8Array(s.data)], { type: s.type || 'image/jpeg' });
          const imgResult = await this.sendImage(blob, s.name || 'resume.jpg', jobId, imgOpts);
          if (!imgResult || imgResult.success === false) {
            imageFailed = true;
            imageError = (imgResult && imgResult.status) ? ('image_' + imgResult.status) : 'image_send_failed';
          }
          await sleep(800); // ⏱️ 保留：多图之间节流（避免 BOSS 反作弊触发，不可省）
        }
      }
    }

    return { imageFailed: imageFailed, imageError: imageError, attempted: attempted };
  },

  // ═══════════════════════════════════════════════════════════════════
  // 补发阶段：核对「服务器历史」里招呼语/图片在不在（只读，不依赖 status-delivery）。
  // 重进对话加载的是服务器真相——丢帧的消息根本不会出现在历史里。
  // ⚠️ 仅用于「刚重进对话、尚未自己补发」时的核对；自己补发后本地会插乐观气泡，
  //    不能再用这两个函数判定，须以 sendText/sendImage 的 status-delivery 结果为准。
  hasTextInHistory(expectText) {
    var norm = function (s) { return (s || '').replace(/\s+/g, ''); };
    var fp = norm(expectText).slice(0, 16);
    if (!fp) return false; // 空招呼语：按缺失处理（与 repairSingle 空 greeting 语义一致，不掩蔽失败）
    var items = document.querySelectorAll(SELECTORS.chatDetail.messageSent);
    for (var i = 0; i < items.length; i++) {
      if (norm(items[i].textContent).indexOf(fp) >= 0) return true;
    }
    return false;
  },

  hasImageInHistory() {
    var items = document.querySelectorAll(SELECTORS.chatDetail.messageSent);
    for (var i = 0; i < items.length; i++) {
      var img = items[i].querySelector('img');
      if (img && img.src && img.src.indexOf('https://imgaz.bosszhipin.com/') === 0) return true;
    }
    return false;
  },

  // ── 补发单个岗位：缺招呼语补招呼语、缺图片补图片 ──
  // 调用前 CS 已重进该对话、历史已加载。返回 { complete, hadText, hadImage, repairedText, repairedImage }
  async repairSingle(greeting, jobId, imgOpts, textOpts) {
    // 1. 核对服务器历史（补发前的真相）
    // 空 greeting：没内容可发也不可能在历史里 → hadText=false 如实记缺失，
    // 不再默认 true（旧逻辑会把「招呼语压根没生成」掩蔽成补发成功）。
    var hadText = greeting ? this.hasTextInHistory(greeting) : false;
    var hadImage = this.hasImageInHistory();

    var textOk = hadText;
    var imageOk = hadImage;
    var repairedText = false;
    var repairedImage = false;

    // 2. 缺招呼语 → 补（单连接安静期，sendText 的 status-delivery 可信）
    if (!hadText && greeting) {
      var tr = null;
      try { tr = await this.sendText(greeting, textOpts); } catch (e) { /* 失败保持 textOk=false */ }
      textOk = !!(tr && tr.success);
      repairedText = textOk;
      await sleep(500);
    }

    // 3. 缺图片 → 补
    if (!hadImage) {
      var ir = await this._sendResumeImages(jobId, imgOpts);
      if (!ir.attempted) {
        // 没有可发的图——补不了也不算缺陷（本就无图可发）
        imageOk = true;
      } else {
        imageOk = !ir.imageFailed;
        repairedImage = imageOk;
      }
    }

    return {
      complete: textOk && imageOk,
      hadText: hadText, hadImage: hadImage,
      repairedText: repairedText, repairedImage: repairedImage,
    };
  },

  stop() {
    this.stopped = true;
    if (this._stopTimer) this._stopTimer();
  },
};

// ── Data URL → Blob 转换（用于 per-job 自定义图片）──
function dataUrlToBlob(dataUrl) {
  const parts = dataUrl.split(',');
  const mimeMatch = parts[0].match(/:(.*?);/);
  if (!mimeMatch) throw new Error('Invalid data URL');
  const mime = mimeMatch[1];
  const byteStr = atob(parts[1]);
  const arr = new Uint8Array(byteStr.length);
  for (let i = 0; i < byteStr.length; i++) arr[i] = byteStr.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
