// ═══════════════════════════════════════════════════════════════════
// encBossId 采集器 — MAIN world + document_start，在搜索页点「立即沟通」前 hook
// 捕获 BOSS 建联接口 friend/add.json 响应里的 zpData.encBossId + zpData.securityId
// （唯一稳定跨页 HR 身份 ID，2026-06-23 SendChainProbe 真机坐实：friend/add 的
//  encBossId === chat 页 getBossData 的 encBossId，同 HR 跨页完全一致）。
//
// 关联键策略：friend/add 请求 URL 的 jobId 参数名不定（jobId/jid/encryptJobId 皆可能），
// 故不靠 URL 参数匹配，而靠「时序」——每次响应递增 seq 写入 DOM 属性 ring，
// ISOLATED world 的 job-clicker 在点击「立即沟通」前后各读一次 seq，取「点击后新增」
// 的那条 encBossId（stage1 每岗串行点击、各 worker 独立页，故点击后新增 seq 唯一）。
// URL 解析出的 jobId 仅作旁证写入（不作主键）。
//
// 纯只读：原样读 BOSS 自己下发的响应字段，不解密、不伪造、不改 BOSS 行为
// （技术同 welfare-collector / ws-probe，法务认定 safe，见需求池「⑤ 方案定论·2」）。
// ═══════════════════════════════════════════════════════════════════
(function () {
  if (window.__ztEncBossCollector) return;
  window.__ztEncBossCollector = true;

  var seq = 0;            // 单调递增：每捕获一条 friend/add 响应 +1
  var ring = [];          // 最近 MAX 条 {seq, encBossId, securityId, jobId, ts}
  var MAX = 16;

  function flush() {
    try {
      document.documentElement.setAttribute(
        'data-jitou-encboss',
        JSON.stringify({ seq: seq, list: ring })
      );
    } catch (e) {}
  }
  // 初始置位，让消费方点击前能读到 seq=0 基线
  flush();

  function pickJobId(url) {
    try {
      var m = /[?&](?:jobId|jid|encryptJobId|jobIdCry)=([^&]+)/.exec(url || '');
      return m ? decodeURIComponent(m[1]) : '';
    } catch (e) { return ''; }
  }

  function ingest(url, jsonText) {
    try {
      var obj = JSON.parse(jsonText);
      var z = obj && obj.zpData;
      if (!z || !z.encBossId) return;
      seq++;
      ring.push({
        seq: seq,
        encBossId: z.encBossId,
        securityId: z.securityId || '',
        jobId: pickJobId(url),
        ts: Date.now(),
      });
      if (ring.length > MAX) ring.shift();
      flush();
    } catch (e) {}
  }

  function isAddUrl(url) {
    return typeof url === 'string' && url.indexOf('friend/add.json') !== -1;
  }

  // ── hook fetch ──
  var oFetch = window.fetch;
  if (oFetch) {
    window.fetch = function () {
      var url = '';
      try { url = String(arguments[0] && (arguments[0].url || arguments[0])); } catch (e) {}
      var p = oFetch.apply(this, arguments);
      if (isAddUrl(url)) {
        p.then(function (resp) {
          try { resp.clone().text().then(function (t) { ingest(url, t); }); } catch (e) {}
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
      try { this.__ztAddUrl = String(url); } catch (e) {}
      return oOpen.apply(this, arguments);
    };
    OXHR.prototype.send = function () {
      var self = this;
      try {
        if (self.__ztAddUrl && isAddUrl(self.__ztAddUrl)) {
          self.addEventListener('load', function () {
            try { ingest(self.__ztAddUrl, self.responseText); } catch (e) {}
          });
        }
      } catch (e) {}
      return oSend.apply(this, arguments);
    };
  }
})();
