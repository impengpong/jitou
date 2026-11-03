// ═══════════════════════════════════════════════════════════════════
// 沟通页对话列表采集器 — MAIN world + document_start，在 chat 页 hook
// 捕获 BOSS 拉取左侧会话列表的 HTTP 响应：
//   GET /wapi/zprelation/friend/getGeekFriendList.json
//   GET /wapi/zprelation/friend/geekFilterByLabel?labelId=..（按标签筛选）
// 响应 zpData.result[] 每条明文带 encryptBossId（= 我们点「立即沟通」拿到的 encBossId）、
// encryptJobId、brandName(公司)、title(HR职位)、name(真名)、lastMsg、lastTS 等。
//
// 用途：content.js 的对话定位绕开「名字匹配」（采集全名↔聊天掩码名对不上致漏发），
// 改用 encryptBossId 在此列表里定位会话项，再拿 brandName+title 当指纹去对碰左侧 li DOM。
//
// 累积合并：滚动加载/切筛选会触发多次请求，用 encryptBossId 去重、后到覆盖更新，
// 不只存最后一次。写 DOM 属性 data-jitou-chatlist = JSON.stringify({ts, list:[...]})
// 供 ISOLATED world 的 content.js 读。
//
// 纯只读：原样读 BOSS 自己下发的响应字段，不解密、不伪造、不改 BOSS 行为/请求
// （技术同 welfare-collector / ws-probe / encbossid-collector，法务认定 safe）。
// ═══════════════════════════════════════════════════════════════════
(function () {
  if (window.__ztChatListCollector) return;
  window.__ztChatListCollector = true;

  // encryptBossId → 会话项（累积、去重、后到覆盖）
  var byBoss = Object.create(null);
  var MAX = 400; // 安全上限，防极端长列表无限膨胀

  function flush() {
    try {
      var list = [];
      for (var k in byBoss) {
        if (Object.prototype.hasOwnProperty.call(byBoss, k)) list.push(byBoss[k]);
      }
      // 控制规模：超限则按 lastTS 降序保留最近的 MAX 条
      if (list.length > MAX) {
        list.sort(function (a, b) { return (b.lastTS || 0) - (a.lastTS || 0); });
        list = list.slice(0, MAX);
      }
      document.documentElement.setAttribute(
        'data-jitou-chatlist',
        JSON.stringify({ ts: Date.now(), list: list })
      );
    } catch (e) {}
  }
  // 初始置位，让消费方能读到空基线（区分「没抓到」与「抓到空列表」）
  flush();

  function ingest(jsonText) {
    try {
      var obj = JSON.parse(jsonText);
      var arr = obj && obj.zpData && obj.zpData.result;
      if (!Array.isArray(arr) || !arr.length) return;
      var changed = false;
      for (var i = 0; i < arr.length; i++) {
        var it = arr[i] || {};
        var enc = it.encryptBossId;
        if (!enc) continue;
        var lmi = it.lastMessageInfo || {};
        byBoss[enc] = {
          encryptBossId: enc,
          encryptJobId: it.encryptJobId || '',
          brandName: it.brandName || '',
          title: it.title || '',
          name: it.name || '',
          lastMsg: it.lastMsg || '',
          lastTS: it.lastTS || it.lastTime || 0,
          securityId: it.securityId || '',
          // 数字 ID（数据层独有；当前左侧 li DOM 不暴露，存作诊断对照 + 未来治本备用）
          uid: it.uid || 0,
          jobId: it.jobId || 0,
          fromId: lmi.fromId || 0,
        };
        changed = true;
      }
      if (changed) flush();
    } catch (e) {}
  }

  function isListUrl(url) {
    if (typeof url !== 'string') return false;
    return url.indexOf('getGeekFriendList.json') !== -1 ||
           url.indexOf('geekFilterByLabel') !== -1;
  }

  // ── hook fetch ──
  var oFetch = window.fetch;
  if (oFetch) {
    window.fetch = function () {
      var url = '';
      try { url = String(arguments[0] && (arguments[0].url || arguments[0])); } catch (e) {}
      var p = oFetch.apply(this, arguments);
      if (isListUrl(url)) {
        p.then(function (resp) {
          try { resp.clone().text().then(function (t) { ingest(t); }); } catch (e) {}
        }).catch(function () {});
      }
      return p;
    };
  }

  // ── hook XHR ──
  var OXHR = window.XMLHttpRequest;
  if (OXHR) {
    var oOpen = OXHR.prototype.open;
    var oSend = OXHR.prototype.send;
    OXHR.prototype.open = function (method, url) {
      try { this.__ztListUrl = String(url); } catch (e) {}
      return oOpen.apply(this, arguments);
    };
    OXHR.prototype.send = function () {
      var self = this;
      try {
        if (self.__ztListUrl && isListUrl(self.__ztListUrl)) {
          self.addEventListener('load', function () {
            try { ingest(self.responseText); } catch (e) {}
          });
        }
      } catch (e) {}
      return oSend.apply(this, arguments);
    };
  }
})();
