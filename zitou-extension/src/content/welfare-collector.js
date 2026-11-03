// ═══════════════════════════════════════════════════════════════════
// 福利采集器 — MAIN world + document_start，在 BOSS 发起 joblist.json 前 hook
// 捕获列表接口 zpData.jobList 每个岗位的 welfareList，按 encryptJobId 建索引，
// 写 data-jitou-welfare-map（DOM 属性，跨 world 可读）供 ISOLATED world 的
// job-collector 关联进 job 对象。纯只读，不改 BOSS 行为。
//
// 关联键说明：DOM 卡片 link = /job_detail/<encryptJobId>.html，job-collector
// 解析出的 job.id = encryptJobId；joblist.json 的 jobList[i].encryptJobId 同值，
// 二者即关联键。
// ═══════════════════════════════════════════════════════════════════
(function () {
  if (window.__ztWelfareCollector) return;
  window.__ztWelfareCollector = true;

  // encryptJobId → welfareList（累积，跨翻页保留）
  var welfareMap = {};
  // encryptJobId → daysPerWeekDesc（工作制字段，双休严格①路高置信来源）。
  // ⚠️ 该字段网页端绝大多数为空（历史「四重印证」结论：网页端工作制只活在标题文本里），
  // 故仅作「白捡」：有非空值才存、消费方据其解析每周天数≤5 判双休；空则退化为标题/正文判定（②路）。
  var daysPerWeekMap = {};

  // ── HR 前置过滤新增（Phase 2/3，不碰上面 welfare/双休两 map）──
  // encryptJobId → {bossOnline, proxyJob, proxyType, anonymous, securityId}（joblist 已含，采集期硬判「只投在线」+ 挑猎头岗）
  var hrMetaMap = {};
  // securityId → encryptJobId（反查：detail.json 抓取时把请求 url 的 securityId 映射回 encryptJobId）
  var secIdMap = {};
  // encryptJobId → {activeTimeDesc, bossOnline, ts}（B3 点猎头真卡后页面自发 detail.json 抓分级活跃度）
  var hrActiveMap = {};

  // ── 方案②：捕获页面自己发的真实岗位列表请求（模板），供采集期复放分页 ──
  // 背景（0717 真机实证）：BOSS 已把端点从 search/joblist.json 拆成两个：
  //   ① 带 query 搜索：POST /wapi/zpgeek/search/joblist.json?_=ts（查询参数在 **POST body**）
  //   ② 无 query 推荐：GET  /wapi/zpgeek/pc/recommend/job/list.json?page=1&pageSize=15&...（参数在 URL）
  // 采集期 job-collector（ISOLATED）读此模板，按 page 复放（POST 换 body.page / GET 换 url page）
  // 拿分页数据，绕过 hidden tab 懒加载节流（初始 page1 请求不受可见性节流、翻页才受）。
  // 捕获真实请求（含 BOSS 签名/参数），绝不自己拼猜。
  function isJobListReq(url) {
    if (!url) return false;
    return url.indexOf('search/joblist.json') !== -1 || url.indexOf('recommend/job/list') !== -1;
  }
  var listReqCaptured = false;
  // 锁定一条可复放的列表请求模板。bodyStr 已解析成字符串（GET 为 ''）。
  function captureListReq(url, method, bodyStr) {
    try {
      if (listReqCaptured || !isJobListReq(url)) return;
      var m = (method || 'GET').toUpperCase();
      // POST search 必须拿到非空 body 才可复放；拿不到就不锁，等下一条能拿到的
      if (url.indexOf('search/joblist.json') !== -1 && !(bodyStr && bodyStr.length)) return;
      var abs = url;
      try { abs = new URL(url, location.href).href; } catch (e0) {}
      var kind = (url.indexOf('search/joblist.json') !== -1) ? 'search' : 'recommend';
      listReqCaptured = true;
      document.documentElement.setAttribute('data-jitou-joblist-req', JSON.stringify({
        url: abs, method: m, body: bodyStr || '', kind: kind,
      }));
      document.documentElement.setAttribute('data-jitou-joblist-url', abs); // 兼容旧属性
    } catch (e) {}
  }
  // 从 fetch 实参统一提取 {url, method, bodyText}（构造 Request + clone().text() 对所有
  // body 类型健壮：string / URLSearchParams / FormData / Request.body 皆可）。异步，body 到手才锁。
  function captureFromFetchArgs(args) {
    try {
      var input = args[0], init = args[1];
      var url = (input && typeof input === 'object' && typeof input.url === 'string') ? input.url : String(input);
      if (!isJobListReq(url)) return;
      var req;
      try {
        req = (input instanceof Request && init == null) ? input.clone() : new Request(input, init);
      } catch (eR) {
        // 构造失败（跨域/流已用）→ 至少按 URL 锁（GET recommend 够用；POST 无 body 会被 captureListReq 拒）
        captureListReq(url, (init && init.method) || (input && input.method) || 'GET', '');
        return;
      }
      var method = req.method || 'GET';
      var rurl = req.url || url;
      req.clone().text().then(function (bodyText) {
        captureListReq(rurl, method, bodyText || '');
      }).catch(function () {
        captureListReq(rurl, method, '');
      });
    } catch (e) {}
  }

  function flush() {
    try {
      document.documentElement.setAttribute('data-jitou-welfare-map', JSON.stringify(welfareMap));
      document.documentElement.setAttribute('data-jitou-daysperweek-map', JSON.stringify(daysPerWeekMap));
      // 新增属性（仅 append，不改上面两个现有属性）
      document.documentElement.setAttribute('data-jitou-hrmeta-map', JSON.stringify(hrMetaMap));
      document.documentElement.setAttribute('data-jitou-secid-map', JSON.stringify(secIdMap));
      document.documentElement.setAttribute('data-jitou-hractive-map', JSON.stringify(hrActiveMap));
    } catch (e) {}
  }

  function ingest(jsonText) {
    try {
      var obj = JSON.parse(jsonText);
      var list = obj && obj.zpData && obj.zpData.jobList;
      if (!Array.isArray(list)) return;
      var changed = false;
      for (var i = 0; i < list.length; i++) {
        var j = list[i] || {};
        var key = j.encryptJobId;
        if (!key) continue;
        // welfareList 是字符串数组；只在拿到非空数组时写入（fail-open 由消费方保证）
        if (Array.isArray(j.welfareList)) {
          welfareMap[key] = j.welfareList;
          changed = true;
        }
        // daysPerWeekDesc：仅在非空字符串时写入（绝大多数为空，空不写避免污染）
        if (typeof j.daysPerWeekDesc === 'string' && j.daysPerWeekDesc.trim()) {
          daysPerWeekMap[key] = j.daysPerWeekDesc.trim();
          changed = true;
        }
        // ── HR 前置过滤元数据（Phase 2，新增；bossOnline/猎头/匿名/securityId，只在有值时写）──
        var meta = {};
        if (typeof j.bossOnline === 'boolean') meta.bossOnline = j.bossOnline;
        if (typeof j.proxyJob === 'number') meta.proxyJob = j.proxyJob;
        if (typeof j.proxyType === 'number') meta.proxyType = j.proxyType;
        if (typeof j.anonymous === 'number') meta.anonymous = j.anonymous;
        if (typeof j.securityId === 'string' && j.securityId) {
          meta.securityId = j.securityId;
          secIdMap[j.securityId] = key; // 反查供 detail.json 抓取映射回 encryptJobId
          changed = true;
        }
        for (var mk in meta) { if (Object.prototype.hasOwnProperty.call(meta, mk)) { hrMetaMap[key] = meta; changed = true; break; } }
      }
      if (changed) flush();
    } catch (e) {}
  }

  // ── B3 猎头支线：detail.json 抓分级活跃度（Phase 3，与 joblist ingest 同文件）──
  // 点猎头真卡 → 页面自发 detail.json → 本函数解析 zpData.bossInfo.activeTimeDesc/bossOnline，
  // 从请求 url 提 securityId → 经 secIdMap 映回 encryptJobId → 存 hrActiveMap，供 content.js B3 编排读回判定。
  // 容错：任何失败 try/catch 吞掉，绝不抛（MAIN world 抛错会污染页面）。
  function ingestDetail(jsonText, reqUrl) {
    try {
      var obj = JSON.parse(jsonText);
      var bi = obj && obj.zpData && obj.zpData.bossInfo;
      if (!bi) return;
      var sid = '';
      try { var m = String(reqUrl || '').match(/securityId=([^&]+)/); sid = m ? m[1] : ''; } catch (e0) {}
      if (!sid) return;
      var key = secIdMap[sid];
      if (!key) { try { key = secIdMap[decodeURIComponent(sid)]; } catch (e1) {} }
      if (!key) return; // 映射不回 encryptJobId → 丢弃（fail-open：B3 读不到即放行不排除）
      hrActiveMap[key] = {
        activeTimeDesc: (typeof bi.activeTimeDesc === 'string') ? bi.activeTimeDesc : '',
        bossOnline: (typeof bi.bossOnline === 'boolean') ? bi.bossOnline : null,
        ts: Date.now()
      };
      flush();
    } catch (e) {}
  }

  // ── hook fetch（🔴 Object.defineProperty 健壮包装）──
  // BOSS bundle 在 document_start 之后会用自己的实现覆盖 window.fetch（0717 实测=minified
  // 自定义 fetch）→ 简单的 `window.fetch = wrap(window.fetch)` 会被 BOSS 覆盖后失效（旧 hook
  // 就此静默失效，welfareMap 一直为空）。改用 get/set 拦截 window.fetch：BOSS 每次赋值我们都
  // 包住它的新实现；调用方经 getter 拿到的永远是包装版。复放也走 BOSS 自己的 fetch（带齐其
  // 签名/拦截器 header，最忠实）。任何异常兜底退回直接赋值，绝不让页面 fetch 失效。
  function fetchArgUrl(args) {
    try {
      var input = args[0];
      return (input && typeof input === 'object' && typeof input.url === 'string') ? input.url : String(input);
    } catch (e) { return ''; }
  }
  function wrapFetch(orig) {
    if (!orig || orig.__ztWrapped) return orig;
    var w = function () {
      var url = fetchArgUrl(arguments);
      var p = orig.apply(this, arguments);
      try {
        if (isJobListReq(url)) {
          captureFromFetchArgs(arguments);
          if (p && p.then) p.then(function (resp) { try { resp.clone().text().then(ingest); } catch (e) {} }).catch(function () {});
        } else if (url.indexOf('job/detail.json') !== -1) {
          if (p && p.then) p.then(function (resp) { try { resp.clone().text().then(function (t) { ingestDetail(t, url); }); } catch (e) {} }).catch(function () {});
        }
      } catch (e) {}
      return p;
    };
    try { w.__ztWrapped = true; w.__ztOrig = orig; } catch (e) {}
    return w;
  }
  try {
    var _wrapped = wrapFetch(window.fetch);
    Object.defineProperty(window, 'fetch', {
      configurable: true,
      enumerable: true,
      get: function () { return _wrapped; },
      set: function (nf) { _wrapped = wrapFetch(nf); },
    });
  } catch (e) {
    // defineProperty 不可用/被冻结 → 退回直接赋值（可能被 BOSS 覆盖，但绝不破坏页面）
    try { if (window.fetch) window.fetch = wrapFetch(window.fetch); } catch (e2) {}
  }

  // ── hook XHR（prototype 方法，BOSS 无法覆盖，稳）──
  var OXHR = window.XMLHttpRequest;
  if (OXHR) {
    var oOpen = OXHR.prototype.open;
    var oSend = OXHR.prototype.send;
    OXHR.prototype.open = function (method, url) {
      try { this.__ztUrl = String(url); this.__ztMethod = String(method || 'GET'); } catch (e) {}
      return oOpen.apply(this, arguments);
    };
    OXHR.prototype.send = function (body) {
      var self = this;
      try {
        if (self.__ztUrl && isJobListReq(self.__ztUrl)) {
          var _bs = '';
          try {
            if (typeof body === 'string') _bs = body;
            else if (body && typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) _bs = body.toString();
          } catch (eb) {}
          captureListReq(self.__ztUrl, self.__ztMethod, _bs);
          self.addEventListener('load', function () {
            try { ingest(self.responseText); } catch (e) {}
          });
        } else if (self.__ztUrl && self.__ztUrl.indexOf('job/detail.json') !== -1) {
          // B3 猎头支线：点真卡自发的详情接口，抓分级活跃度
          self.addEventListener('load', function () {
            try { ingestDetail(self.responseText, self.__ztUrl); } catch (e) {}
          });
        }
      } catch (e) {}
      return oSend.apply(this, arguments);
    };
  }

  // ── 方案②：MAIN world 分页复放驱动 ──
  // ISOLATED 的 job-collector 经 window.postMessage 请求第 N 页；本驱动读已捕获的请求模板，
  // 用 **BOSS 自己的 window.fetch**（defineProperty getter 返回的包装版=BOSS 实现 + 我们的捕获，
  // 带齐 BOSS 拦截器 header）复放，结果 postMessage 回 ISOLATED。走 BOSS fetch = 最忠实真流量，
  // 暴露面≈真滚动，比 ISOLATED 裸 fetch 更不易触 BOSS code=37 软封锁。
  // 纯只读列表接口，页面本来就会调、同节奏，不改 BOSS 行为。
  function buildPagedReq(req, page) {
    var isPost = String(req.method || 'GET').toUpperCase() === 'POST';
    if (isPost) {
      var body = String(req.body || '');
      if (/(^|&)page=\d+/.test(body)) body = body.replace(/(^|&)page=\d+/, '$1page=' + page);
      else body += (body ? '&' : '') + 'page=' + page;
      return { url: req.url, init: { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json, text/plain, */*' }, body: body } };
    }
    var url = req.url;
    try { var u = new URL(req.url, location.href); u.searchParams.set('page', String(page)); url = u.href; } catch (e0) {}
    return { url: url, init: { method: 'GET', credentials: 'same-origin', headers: { 'Accept': 'application/json, text/plain, */*' } } };
  }
  window.addEventListener('message', function (ev) {
    try {
      if (ev.source !== window) return;
      var d = ev.data;
      if (!d || d.__ztReq !== 'fetchListPage') return;
      var nonce = d.nonce, page = d.page;
      var raw = document.documentElement.getAttribute('data-jitou-joblist-req');
      if (!raw) { window.postMessage({ __ztRes: 'fetchListPage', nonce: nonce, ok: false, reason: 'noTemplate' }, '*'); return; }
      var req = JSON.parse(raw);
      var pr = buildPagedReq(req, page);
      // 用 BOSS 自己的 fetch（经 window.fetch getter 拿到包装版）
      window.fetch(pr.url, pr.init).then(function (r) { return r.json(); }).then(function (o) {
        var okCode = !(o && typeof o.code === 'number' && o.code !== 0);
        var list = (o && o.zpData && Array.isArray(o.zpData.jobList)) ? o.zpData.jobList : null;
        var ok = !!(okCode && list);
        window.postMessage({
          __ztRes: 'fetchListPage', nonce: nonce,
          ok: ok, code: (o && typeof o.code === 'number') ? o.code : 0,
          list: ok ? list : [], hasMore: !!(o && o.zpData && o.zpData.hasMore !== false),
        }, '*');
      }).catch(function () {
        window.postMessage({ __ztRes: 'fetchListPage', nonce: nonce, ok: false, reason: 'fetchErr' }, '*');
      });
    } catch (e) {
      try { window.postMessage({ __ztRes: 'fetchListPage', nonce: (ev && ev.data && ev.data.nonce), ok: false, reason: 'driverErr' }, '*'); } catch (e2) {}
    }
  });
})();
