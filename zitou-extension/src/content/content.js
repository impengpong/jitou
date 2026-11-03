// Content Script 入口 — 根据 URL 路由 + 消息监听

// 🔴 发布打包前改为 false：关闭 window.postMessage 测试桥，防同页恶意脚本触发自动投递
const TEST_BRIDGE_ENABLED = false;

// ── 同步诊断：直接写 documentElement.dataset.diagSync ringer（零 await，零 race） ──
// 决策：ErrorLogger.logError 是 async read-modify-write，多个 _dbg 连续调用时后写覆盖前写
// 实测 2026-05-24：click flow 11 个 _dbg 实际只留 5 个，apiCheck/bossInfo/hrExtracted 等中间项被冲掉
// 同步 attribute 写在 isolated world 内单线程同步执行，绝不丢数据；osascript 读 data-diag-sync 即可
function _persistDiag(prefix, info) {
  try {
    var el = document.documentElement;
    if (!el) return;
    var raw = el.getAttribute('data-diag-sync') || '[]';
    var arr;
    try { arr = JSON.parse(raw); } catch (e) { arr = []; }
    if (!Array.isArray(arr)) arr = [];
    arr.push({ t: Date.now(), m: '[' + prefix + '] ' + JSON.stringify(info || {}) });
    if (arr.length > 500) arr = arr.slice(-500);
    el.setAttribute('data-diag-sync', JSON.stringify(arr));
  } catch (e) {}
}

// Self-test 入口：main world (osascript inject) 通过 CustomEvent 跨 world 触发 CS 自己调
// _persistDiag N 次，用于验证「修改后 content.js 已被加载 + 同步诊断写无丢失」。
// 用法：document.dispatchEvent(new CustomEvent('ZITOU_DIAG_TEST', {detail:{n:100}}))
try {
  document.addEventListener('ZITOU_DIAG_TEST', function(e) {
    var n = (e && e.detail && e.detail.n) || 100;
    for (var i = 0; i < n; i++) _persistDiag('test:' + i, { i: i, ts: Date.now() });
  });
} catch (_) {}

// ── #39 导航中止哨兵 ──
// 真机坐实：点「立即沟通」触发 BOSS 整页跳转后，pagehide 已触发但文档拆毁延迟数秒，
// handleBatchExtract 若继续跑会在拆毁中 DOM 上 findCard 全败 → 假失败记账 + 提前发
// EXTRACT_COMPLETE → SW stage1 假结算。哨兵置位后批处理循环立即中止，交 SW 恢复环重发。
// （575 行附近 DiagLogger 的 pagehide 监听在守卫块内不可共用，此处独立注册。）
var _navAborting = false;
try { window.addEventListener('pagehide', function() { _navAborting = true; }); } catch (_) {}

// ── JobClicker 内联到 content.js（manifest 中文件顺序有时不可靠）──
async function waitForElHidden(selectors, timeoutMs) {
  timeoutMs = timeoutMs || 5000;
  var start = Date.now();
  while (Date.now() - start < timeoutMs) {
    var visible = false;
    for (var si = 0; si < (Array.isArray(selectors) ? selectors : [selectors]).length; si++) {
      var el = document.querySelector((Array.isArray(selectors) ? selectors : [selectors])[si]);
      if (el && el.offsetParent !== null) { visible = true; break; }
    }
    if (!visible) return true;
    await new Promise(function(r) { setTimeout(r, 200); });
  }
  return false;
}

function sleep(ms) {
  return new Promise(function(r) { setTimeout(r, ms); });
}
// 闭区间随机整数（B3 点卡间隔抖动用，镜像 SEND_INTERVAL 反爬反封，绝不固定节拍器）
function randBetween(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

// ── HR 活跃解析 + 阈值判定（Item2，send 期逐岗判定）──
function parseHrActivity(onlineText, activeText){
  if(onlineText && /在线/.test(onlineText)) return {online:true, activeDays:0, desc:'在线'};
  var t=(activeText||'').trim();
  if(!t) return {online:false, activeDays:null, desc:''};
  if(/刚刚|今日|今天/.test(t)) return {online:false, activeDays:1, desc:t};
  var dm=t.match(/(\d+)\s*日内/); if(dm) return {online:false, activeDays:parseInt(dm[1]), desc:t};
  if(/本周/.test(t)) return {online:false, activeDays:7, desc:t};
  var wm=t.match(/(\d+)\s*周内/); if(wm) return {online:false, activeDays:parseInt(wm[1])*7, desc:t};
  if(/本月/.test(t)) return {online:false, activeDays:30, desc:t};
  var mm=t.match(/(\d+)\s*月内/); if(mm) return {online:false, activeDays:parseInt(mm[1])*30, desc:t};
  if(/半年内|近半年/.test(t)) return {online:false, activeDays:180, desc:t};
  if(/半年前|年前|更早/.test(t)) return {online:false, activeDays:999, desc:t};
  return {online:false, activeDays:null, desc:t};
}
// fail-open：未知/读不到→放行（避免读取毛刺误杀）；online 永远通过
function passActivityFilter(filter, act){
  if(!filter || filter==='不限') return true;
  if(filter==='只投在线') return act.online===true;
  var maxMap={'3日内活跃':3,'本周内活跃':7,'本月内活跃':30};
  var max=maxMap[filter]; if(max==null) return true;
  if(act.online) return true;
  if(act.activeDays==null) return true;
  return act.activeDays<=max;
}

// ── #4 JD 正文采集（stage1 点「立即沟通」后复用已展开的 .job-detail-box .desc，零额外请求）──
// 供 stage2 worker 发送前调 /greeting 实时生成定制招呼语。采不到（详情面板未渲染/无 JD）返回 ''。
// 截断到 CONFIG.JD_TEXT_MAX_LEN（默认 1500 字），防超长 JD 拖慢生成 / 撑大消息体。
// 用完即弃：只随建联结果短暂带回 SW 内存态，绝不写 storage/库/日志（见技术方案 §4）。
function _captureJdText(){
  try {
    var el = document.querySelector('.job-detail-box .desc');
    var t = el ? (el.innerText || el.textContent || '') : '';
    t = String(t).replace(/\s+/g, ' ').trim();
    var max = (typeof CONFIG !== 'undefined' && CONFIG.JD_TEXT_MAX_LEN) || 1500;
    return t.length > max ? t.slice(0, max) : t;
  } catch (_) { return ''; }
}

// ── 正文级双休判定（投递 send 阶段复用已展开的 .job-detail-box .desc 正文，零额外请求）──
// 镜像 JobCollector.classifyRestDay 的白/黑名单，扩到正文场景（正文比标题信息更全）。
// 返回 'double'|'no'|'unknown'。黑名单优先（更保守，宁可不标也不误标）。
function classifyRestDayFromText(text){
  var t = String(text || '');
  if(!t) return 'unknown';
  // 黑名单：明确非稳定双休（即便含"休"字）。正文常见表述
  var NO = ['大小周','单休','做六休一','六休一','单双休','单双周','大小休','单休制','月休4天','月休四天'];
  for(var i=0;i<NO.length;i++){ if(t.indexOf(NO[i])!==-1) return 'no'; }
  // 白名单：明确稳定双休
  var YES = ['双休','周末双休','周末两天休','做五休二','五天工作制','五天双休','五天制','5天工作制','法定双休'];
  for(var j=0;j<YES.length;j++){ if(t.indexOf(YES[j])!==-1) return 'double'; }
  return 'unknown';
}

// ── 五险一金文本识别（严格三路终判共用：扫标题 jobName 与 JD 正文 .desc）──
// 返回 true=文本明确提到五险一金类福利；false=未提到。
// 匹配集严格对齐规格 ['五险一金','六险一金','五险二金']（+全角变体 '五险１金'）。只认「险和金都全」
// 的明确表述——「五险/社保/住房公积金」单写不等于五险一金，要可靠不要泛化误匹（user 拍板去泛化）。
function hasInsuranceFromText(text){
  var t = String(text || '');
  if(!t) return false;
  var KW = ['五险一金','六险一金','五险二金','五险１金'];
  for(var i=0;i<KW.length;i++){ if(t.indexOf(KW[i])!==-1) return true; }
  return false;
}

// ── 工作制字段解析：从 daysPerWeekDesc 提取每周工作天数（双休严格①路）──
// 字段形如 "5天/周" / "5天" / "做五休二" / 纯数字 等；解析出数值 ≤5 视为双休（白捡高置信）。
// 网页端绝大多数为空 → 返回 null（①路不命中，退化走②标题/正文）。空值安全，绝不报错。
function parseDaysPerWeek(desc){
  var s = String(desc || '').trim();
  if(!s) return null;
  // 中文数字 → 阿拉伯（仅覆盖 1-7，工作天数范围）
  var cnMap = { '一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7 };
  // 优先取阿拉伯数字
  var m = s.match(/([1-7])\s*天/);
  if(m) return parseInt(m[1], 10);
  // 「做X休Y」→ 工作天数 = X（如 做五休二 → 5）
  var m2 = s.match(/做([一二两三四五六七1-7])休/);
  if(m2){ var d = cnMap[m2[1]]; return d != null ? d : (parseInt(m2[1],10) || null); }
  // 纯中文「X天」
  var m3 = s.match(/([一二两三四五六七])\s*天/);
  if(m3) return cnMap[m3[1]] || null;
  // 纯数字
  var m4 = s.match(/^([1-7])$/);
  if(m4) return parseInt(m4[1], 10);
  return null;
}

// ── 三标签前置终判（取 JD 阶段调用；从投递期 clickImmediateChat 286-333 前移，逻辑严格镜像）──
// 输入：msg 携带 restDayFilter/welfareFilter/hrActiveFilter + jobName/welfareConfirmed/daysPerWeekDesc；jdText=已读到的 JD 正文。
// 输出：{excluded, skipReason, hrInfoFound}。任一 filter 不符即 excluded；首个不符定 skipReason（顺序 HR→双休→五险，与投递期一致）。
// 只在拿到 JD 正文时判（handleReadJd 读不到 JD 已提前 return degraded，绝不据缺失误排除）。
// HR 活跃：2026-07-01 实机验证 job_detail 独立页 .job-boss-info 卡片必渲二者之一——
//   在线 HR = .boss-online-tag「在线」；离线 HR = .boss-active-time「刚刚活跃/半年前活跃」等 graded 文案。
//   故 hrInfoFound 对在线&离线 HR 均为 true，过滤对每个 HR 都真正生效。
//   （极端缺失双 null 仍走 passActivityFilter fail-open，不误排除。）
function judgeJdFilters(msg, jdText) {
  var restDayFilter = msg && msg.restDayFilter;
  var welfareFilter = msg && msg.welfareFilter;
  var hrActiveFilter = msg && msg.hrActiveFilter;
  var jobName = (msg && msg.jobName) || '';
  var welfareConfirmed = !!(msg && msg.welfareConfirmed);
  var daysPerWeekDesc = (msg && msg.daysPerWeekDesc) || '';

  // ① HR 活跃终判：整页详情读 HR 在线/活跃文本（搜索页详情面板结构 .boss-online-tag/.boss-active-time）
  var _onlineEl = document.querySelector('.boss-online-tag');
  var _activeEl = document.querySelector('.boss-active-time');
  var hrInfoFound = !!(_onlineEl || _activeEl);
  if (hrActiveFilter && hrActiveFilter !== '不限' && hrInfoFound) {
    var _act = parseHrActivity(
      (_onlineEl && _onlineEl.textContent) || '',
      (_activeEl && _activeEl.textContent) || ''
    );
    if (!passActivityFilter(hrActiveFilter, _act)) {
      return { excluded: true, skipReason: 'HR活跃不符', hrInfoFound: hrInfoFound };
    }
  }

  // ② 双休严格终判（① daysPerWeekDesc≤5 ∪ ② 标题/正文 double；①②都不中 → 排除）
  if (restDayFilter === '双休') {
    var _bodyRest = classifyRestDayFromText(jdText);
    var _titleRest = classifyRestDayFromText(jobName);
    var _dpw = parseDaysPerWeek(daysPerWeekDesc);
    var _byField = (_dpw !== null && _dpw <= 5);
    var _byText = (_titleRest === 'double') || (_bodyRest === 'double');
    if (!(_byField || _byText)) {
      return { excluded: true, skipReason: '未明确双休', hrInfoFound: hrInfoFound };
    }
  }

  // ③ 五险一金严格终判（welfareConfirmed 放行 ∪ 标题含 ∪ 正文含；全不中 → 排除）
  if (welfareFilter && welfareFilter !== '不限' && !welfareConfirmed) {
    var _byTitle = hasInsuranceFromText(jobName);
    var _byBody = _byTitle ? true : hasInsuranceFromText(jdText);
    if (!_byTitle && !_byBody) {
      return { excluded: true, skipReason: '未明确五险一金', hrInfoFound: hrInfoFound };
    }
  }

  return { excluded: false, skipReason: null, hrInfoFound: hrInfoFound };
}

// ── encBossId 读取（跨 world：encbossid-collector.js 在 MAIN world 写 DOM 属性）──
// data-jitou-encboss = {seq, list:[{seq,encBossId,securityId,jobId,ts}]}
function _readEncBossState() {
  try {
    var raw = document.documentElement.getAttribute('data-jitou-encboss');
    if (!raw) return { seq: 0, list: [] };
    var o = JSON.parse(raw);
    return { seq: o.seq || 0, list: Array.isArray(o.list) ? o.list : [] };
  } catch (e) { return { seq: 0, list: [] }; }
}
function _readEncBossSeq() { return _readEncBossState().seq; }
// 返回 seq > preSeq 的最新一条（点击后新增的 encBossId）；无则 null
function _readEncBossSince(preSeq) {
  var st = _readEncBossState();
  var best = null;
  for (var i = 0; i < st.list.length; i++) {
    var e = st.list[i];
    if (e && e.seq > preSeq && e.encBossId && (!best || e.seq > best.seq)) best = e;
  }
  return best;
}

// ── #6 BOSS「今日沟通已达上限」业务弹窗检测（达上限权威信号）──
// 点「立即沟通」后若 BOSS 弹「今日沟通数已达上限/明天再来」，该岗建联其实没成功。
// 本地计数不准（用户可能在手机/别处也点过立即沟通），故以此弹窗为 ground truth 判定达上限。
// DOM 契约见 selectors.js limitDialog（单一真相源）。返回 { detected, text, cls }。
function detectBossLimitDialog() {
  try {
    var ld = (typeof SELECTORS !== 'undefined' && SELECTORS.limitDialog) || {};
    var req = ld.keywordsRequired || [];
    var ctx = ld.keywordsContext || [];
    if (!req.length) return { detected: false };
    var nodes = document.querySelectorAll(ld.container || '[class*="dialog"]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!el || el.offsetHeight <= 0) continue;
      var raw = el.textContent || '';
      var t = raw.replace(/\s+/g, '').toLowerCase();
      if (!t) continue;
      var hitReq = req.some(function (k) { return t.indexOf(String(k).toLowerCase()) >= 0; });
      if (!hitReq) continue;
      var hitCtx = ctx.some(function (k) { return t.indexOf(String(k).toLowerCase()) >= 0; });
      if (hitCtx) return { detected: true, text: raw.trim().substring(0, 80), cls: el.className };
    }
  } catch (e) {}
  return { detected: false };
}

var JobClicker = {
  findCardByLink: function(jobLink) {
    var cards = document.querySelectorAll(SELECTORS.jobs.jobCard);
    var jobId = (jobLink || '').split('/').pop();
    if (jobId) jobId = jobId.replace('.html', '');
    if (!jobId) return null;
    for (var c = 0; c < cards.length; c++) {
      var links = cards[c].querySelectorAll('a');
      for (var l = 0; l < links.length; l++) {
        if ((links[l].getAttribute('href') || '').includes(jobId)) return cards[c];
      }
    }
    return null;
  },
  findCardByText: function(positionName, companyName) {
    var cards = document.querySelectorAll(SELECTORS.jobs.jobCard);
    for (var c = 0; c < cards.length; c++) {
      var nameEl = cards[c].querySelector(SELECTORS.jobs.jobName);
      var companyEl = cards[c].querySelector(SELECTORS.jobs.company);
      if (!nameEl || !companyEl) continue;
      if (nameEl.textContent.trim() === positionName && companyEl.textContent.trim().includes(companyName)) return cards[c];
    }
    return null;
  },

  // v5: 只点"立即沟通"，提取HR信息，关闭弹窗，不导航页面
  // progressCtx（可选，#39 阶段1跳转恢复）：{ index, jobId, jobName }，仅 handleBatchExtract 传入，
  // 用于点「立即沟通」前上报 beforeClick 进度（点击可能触发整页跳转摧毁本 CS，SW 据此恢复断头批次）。
  clickImmediateChat: async function(jobLink, positionName, companyName, hrActiveFilter, progressCtx, restDayFilter, welfareFilter, welfareConfirmed, daysPerWeekDesc) {
    // 同步诊断 _persistDiag 是真相源（dataset 写无 race）；ErrorLogger 保留双写仅作 SW 侧回看。
    // 2026-05-24 修复：ErrorLogger.logError 多写 race 导致中间项丢失 → _persistDiag 同步直写 dataset 永不丢。
    var _dbg = function(s, i) {
      _persistDiag(s, i);
      try { chrome.runtime.sendMessage({ type: 'CS_DBG', stage: s, info: i || {} }).catch(function(){}); } catch (_) {}
      try {
        if (typeof ErrorLogger !== 'undefined' && ErrorLogger.logError) {
          ErrorLogger.logError('[' + s + '] ' + JSON.stringify(i || {}), '', 'click.diag');
        }
      } catch (_) {}
    };
    _dbg('click:start', { jobLink: jobLink, positionName: positionName });
    // 硬中止：每个 await 边界前后检查 stopped，停了立即 bail（不点卡片/不点立即沟通/不开弹窗）
    var _isStopped = function() { return typeof JobCollector !== 'undefined' && JobCollector.stopped; };
    if (_isStopped()) { _dbg('click:bail', { at: 'start' }); return { success: false, stopped: true }; }
    var card = null;
    if (jobLink) card = this.findCardByLink(jobLink);
    if (!card && positionName && companyName) card = this.findCardByText(positionName, companyName);
    _dbg('click:findCard', { found: !!card, byLink: !!(jobLink && this.findCardByLink(jobLink)) });
    if (!card) return { success: false, error: '未找到岗位卡片: ' + (positionName || jobLink) };
    card.scrollIntoView({ block: 'center', behavior: 'instant' });
    await new Promise(function(r) { setTimeout(r, 200); });
    if (_isStopped()) { _dbg('click:bail', { at: 'beforeCardClick' }); return { success: false, stopped: true }; }
    _dbg('click:beforeCardClick', { urlBefore: location.href });
    card.click();
    await new Promise(function(r) { setTimeout(r, 800); });
    if (_isStopped()) { _dbg('click:bail', { at: 'afterCardClick' }); return { success: false, stopped: true }; }
    _dbg('click:afterCardClick', { urlAfter: location.href });
    if (typeof detectCaptcha === 'function' && detectCaptcha().detected) {
      _dbg('click:captcha', {});
      return { success: false, error: 'captcha detected after clicking card' };
    }

    // 提取HR信息（详情面板 .job-boss-info）
    var bossInfo = document.querySelector('.job-boss-info');
    _dbg('click:bossInfo', { found: !!bossInfo });
    var hrName = '';
    var hrCompany = '';
    if (bossInfo) {
      var nameH2 = bossInfo.querySelector('h2.name, .name');
      if (nameH2) {
        for (var ci = 0; ci < nameH2.childNodes.length; ci++) {
          var node = nameH2.childNodes[ci];
          if (node.nodeType === 3) { hrName += node.nodeValue; }
          else if (node.nodeType === 1 && node.tagName !== 'I') break;
        }
        hrName = hrName.trim();
      }
      var attrEl = bossInfo.querySelector('.boss-info-attr');
      if (attrEl) {
        var attrText = attrEl.textContent.trim();
        hrCompany = (attrText.split(' · ')[0] || '').trim();
      }
    }
    _dbg('click:hrExtracted', { hrName: hrName, hrCompany: hrCompany });
    if (!hrName) return { success: false, error: '无法提取HR信息' };

    // HR 活跃筛选：复用已打开的 .job-boss-info 面板，零额外请求；不达标则跳过、不发起联系
    var _act = parseHrActivity(
      (bossInfo.querySelector('.boss-online-tag') || {}).textContent || '',
      (bossInfo.querySelector('.boss-active-time') || {}).textContent || ''
    );
    if (!passActivityFilter(hrActiveFilter, _act)) {
      _dbg('click:activitySkip', { filter: hrActiveFilter, desc: _act.desc });
      return { success: false, skipped: true, skipReason: 'HR活跃不符', activeDesc: _act.desc };
    }

    // 严格终判：复用已展开的 .job-detail-box .desc（JD 正文）+ 标题 + 工作制字段，零额外请求。
    // 严格语义：只投「明确写明」的岗，未写明一律不投。
    //   双休（①∪②，黑名单直滤）：① daysPerWeekDesc 解析每周天数≤5 → 双休（白捡高置信）；
    //     ② 标题 jobName 或正文 .desc 命中双休白名单 → 双休；①②都不中 → 跳过。
    //   五险一金（三路确认，任一命中即投）：welfareList已确认含(welfareConfirmed) ∪ 标题含 ∪ 正文含；
    //     全不中 → 跳过。
    if (restDayFilter === '双休' || (welfareFilter && welfareFilter !== '不限')) {
      var _descEl = document.querySelector('.job-detail-box .desc');
      var _descText = _descEl ? (_descEl.innerText || _descEl.textContent || '') : '';

      // ── 双休严格终判（① daysPerWeekDesc≤5 ∪ ② 标题/正文 double） ──
      if (restDayFilter === '双休') {
        var _bodyRest = classifyRestDayFromText(_descText);
        var _titleRest = classifyRestDayFromText(positionName);
        // ① 工作制字段：每周天数≤5 → 直接判双休（最高置信，网页端绝大多数为空，空则 null 不命中走②）
        var _dpw = parseDaysPerWeek(daysPerWeekDesc);
        var _byField = (_dpw !== null && _dpw <= 5);
        // ② 标题或正文任一明确 double
        var _byText = (_titleRest === 'double') || (_bodyRest === 'double');
        var _isDouble = _byField || _byText;
        // 严格：①②都不中（含工作制空/>5 且 标题、正文均未明确 double）→ 跳过不投
        if (!_isDouble) {
          _dbg('click:restDaySkip', { dpw: _dpw, titleRest: _titleRest, bodyRest: _bodyRest });
          var _rdDesc = (_bodyRest === 'no' || _titleRest === 'no') ? '正文/标题标注非双休' : '未明确双休';
          return { success: false, skipped: true, skipReason: '未投递：未明确双休', restDayDesc: _rdDesc };
        }
      }

      // ── 五险一金严格终判（三路：welfareList含 ∪ 标题含 ∪ 正文含） ──
      // welfareConfirmed=true（列表 welfareList 已确认含）→ 直接放行，不必扫文本。
      if (welfareFilter && welfareFilter !== '不限' && !welfareConfirmed) {
        var _byTitle = hasInsuranceFromText(positionName); // 路②：扫标题 jobName
        var _byBody = _byTitle ? true : hasInsuranceFromText(_descText); // 路③：标题没中再扫正文
        if (!_byTitle && !_byBody) {
          _dbg('click:welfareSkip', { kw: welfareFilter, titleHit: false, bodyHit: false });
          return { success: false, skipped: true, skipReason: '未投递：未明确五险一金', welfareDesc: '标题与正文均未提及五险一金' };
        }
      }
    }

    // 点击"立即沟通"
    if (_isStopped()) { _dbg('click:bail', { at: 'beforeWaitChatBtn' }); return { success: false, stopped: true }; }
    _dbg('click:waitChatBtn', {});
    var chatBtn = await waitForElement(SELECTORS.jobs.immediateChatBtn, 5000);
    _dbg('click:chatBtnFound', { found: !!chatBtn });
    if (!chatBtn) return { success: false, error: '未找到立即沟通按钮' };
    // 关键：等到按钮后若已停止，绝不点击「立即沟通」、不发起联系
    if (_isStopped()) { _dbg('click:bail', { at: 'beforeChatClick' }); return { success: false, stopped: true }; }

    // #39 预判：按钮文本含「继续沟通」= 该 HR 此前已沟通过，点了会整页跳转消息页摧毁 CS → 不点，标记 alreadyChatted
    var chatBtnTxt = (chatBtn.textContent || '').trim();
    if (chatBtnTxt.indexOf('继续沟通') >= 0) {
      _dbg('click:alreadyChatted', { hrName: hrName, hrCompany: hrCompany, btnText: chatBtnTxt });
      try { if (typeof DiagLogger !== 'undefined') DiagLogger.info('cs.flow', '检测到继续沟通按钮，跳过点击 标记alreadyChatted hr=' + hrName + ' btnText=' + chatBtnTxt); } catch (_) {}
      return { success: true, hrName: hrName, hrCompany: hrCompany, alreadyChatted: true };
    }

    // #39 阶段1跳转恢复：即将点「立即沟通」——同 HR 新岗位场景 BOSS 会整页跳转 /web/geek/chat
    // 摧毁本 CS，故点前 fire-and-forget 上报 beforeClick（带已提取的 HR 信息），绝不阻塞流程。
    if (progressCtx) {
      try {
        chrome.runtime.sendMessage({
          type: MSG.EXTRACT_PROGRESS,
          index: progressCtx.index,
          jobId: progressCtx.jobId,
          jobName: progressCtx.jobName,
          hrName: hrName,
          hrCompany: hrCompany,
          stage: 'beforeClick',
        }).catch(function(){});
      } catch (_) {}
    }

    // 诊断：click 前后 diff performance resource entries，看 BOSS conv create wapi 是否真被调用
    // 2026-05-25 实测根因：单独 chatBtn.click() 只触发 dapCommon 上报，不触发 friend/add.json
    // → BOSS Vue add friend handler 监 mousedown+mouseup+click 完整序列；单 click 事件不足
    // → 改为完整鼠标序列（osascript inject 3 连点实测 3/3 add.json 全发出）
    var _apiBefore = (performance.getEntriesByType('resource') || []).length;
    // encBossId 捕获基线：点击前读 collector 的 seq（friend/add.json 每捕获一条 +1），
    // 点击后取「seq > preSeq 的最新一条」= 本次建联的 encBossId（不靠 URL jobId 匹配）。
    var _encPreSeq = _readEncBossSeq();
    var _mOpts = { bubbles: true, cancelable: true, view: window, button: 0 };
    chatBtn.dispatchEvent(new MouseEvent('mousedown', _mOpts));
    chatBtn.dispatchEvent(new MouseEvent('mouseup', _mOpts));
    chatBtn.dispatchEvent(new MouseEvent('click', _mOpts));
    await new Promise(function(r) { setTimeout(r, 800); });
    var _encCaptured = _readEncBossSince(_encPreSeq);
    try {
      var _all = performance.getEntriesByType('resource') || [];
      var _newOnes = _all.slice(_apiBefore);
      var _wapiNew = _newOnes.filter(function(e) { return /wapi/.test(e.name || ''); }).map(function(e) {
        return {
          url: (e.name || '').replace('https://www.zhipin.com', '').substring(0, 150),
          dur: Math.round(e.duration || 0),
          size: e.transferSize || 0,
        };
      }).slice(0, 10);
      _persistDiag('click:apiCheck', {
        hrName: hrName,
        hrCompany: hrCompany,
        wapiNewCount: _wapiNew.length,
        wapiNew: _wapiNew,
      });
      if (typeof ErrorLogger !== 'undefined' && ErrorLogger.logError) {
        ErrorLogger.logError('[click:apiCheck] ' + JSON.stringify({
          hrName: hrName,
          hrCompany: hrCompany,
          wapiNewCount: _wapiNew.length,
          wapiNew: _wapiNew,
        }), '', 'click.diag');
      }
    } catch (_) {}

    // #6 达上限权威信号：点「立即沟通」后若 BOSS 弹「今日沟通已达上限」→ 该岗建联失败。
    // 必须在 closeBlockingDialogs 抹掉弹窗之前检测。返回 bossLimitReached=true 让上层（handleBatchExtract）
    // 停止本批后续建联并把本岗+剩余岗标「达上限」，但绝不中断已建联岗位的 stage2（招呼语+简历图照发）。
    var _limitDlg = detectBossLimitDialog();
    if (_limitDlg.detected) {
      _dbg('click:bossLimit', { hrName: hrName, hrCompany: hrCompany, text: _limitDlg.text, cls: _limitDlg.cls });
      try { if (typeof DiagLogger !== 'undefined') DiagLogger.warn('cs.flow', '检测到 BOSS 今日沟通已达上限弹窗，停止本批建联。文案=' + _limitDlg.text); } catch (_) {}
      try { await this._closeGreetDialog(); } catch (_) {} // 关掉弹窗不挡后续 UI
      return { success: false, bossLimitReached: true, error: '因今日投递数量已达 BOSS 上限 150', hrName: hrName, hrCompany: hrCompany };
    }

    // 关闭打招呼弹窗（可能是普通弹窗，也可能是同HR多岗位弹窗）
    if (_isStopped()) { _dbg('click:bail', { at: 'beforeCloseDialog' }); return { success: false, stopped: true }; }
    _dbg('click:beforeCloseDialog', {});
    await this._closeGreetDialog();
    _dbg('click:afterCloseDialog', {});
    // encBossId 兜底：弹窗交互后 friend/add 可能才返回，再补读一次（取并集最新）
    if (!_encCaptured || !_encCaptured.encBossId) {
      var _encLate = _readEncBossSince(_encPreSeq);
      if (_encLate && _encLate.encBossId) _encCaptured = _encLate;
    }
    _dbg('click:encBoss', { hit: !!(_encCaptured && _encCaptured.encBossId), seq: _encCaptured && _encCaptured.seq });

    return {
      success: true, hrName: hrName, hrCompany: hrCompany,
      encBossId: (_encCaptured && _encCaptured.encBossId) || '',
      securityId: (_encCaptured && _encCaptured.securityId) || '',
      // #4 JD 实时招呼语：随建联结果带回该岗 JD 正文（零额外请求，复用已展开的详情面板）。
      // 用完即弃：仅供 stage2 worker 发送前调 /greeting 实时生成，绝不落 storage/库/日志。
      jdText: _captureJdText(),
    };
  },

  _closeGreetDialog: async function() {
    // 委托给共用函数（stage1 提取 与 stage2 发送/补发 单一来源）
    await closeBlockingDialogs(3);
  },
};

// ── 关闭挡路弹窗（打招呼/同HR多岗位/沟通次数上限/投递成功率较低/温馨提示 等）──
// 两层策略：先 `.icon-close.click()`，剩余仍可见的弹窗 fallback `.remove()`。
// 决策依据（2026-05-25 实测：osascript inject 4 连点对照矩阵）：
//   - `.remove()` 单用：1/4 add（第 1 个 add 后弹「招呼输入框」被 remove → Vue 状态保留
//     「该 HR 正在打招呼」→ 后续岗位 card.click 切换后 chatBtn 直接 disabled，add API 不发）
//   - `.icon-close.click()` 单用：3/3 add（走 Vue close handler 正常释放 BOSS 内部业务状态）
//   - chat-block-dialog 无 .icon-close → 该弹窗为业务异常（限速/超额），无 add 流程不会污染状态
//     用 fallback .remove() 兜底安全（不触发 sure-btn 跳转副作用）
// 旧版「.remove() 零副作用」结论是单弹窗实测，没覆盖「连续多岗位 add」场景下的 Vue 状态污染。
// 陷阱 #39（2026-06-12）：「继续沟通新职位」二次确认弹窗（同 HR 此前已沟通过其他岗位）
// 只关/删会让该岗位进不了可发送状态 → 卡住。产品决策（user 拍板）：点「继续沟通」确认继续投。
// Step 0 判定（2026-06-12 真机抓 DOM 定死）：弹窗本体 .change-job-tip-dialog，确认钮
// span.boss-dialog__button（非 .button-outline）且文本 trim 后精确等于「沟通新职位」才点。
// 点过确认的弹窗打 data-zitou-sure-clicked 标记，按已处理对待，不再进 Step 1/2（绝不 remove 污染 Vue state）。
// #39 诊断埋点：未识别弹窗 DOM 快照去重表（每个 className 每次页面加载只快照一次）
var _snapDone = {};
async function closeBlockingDialogs(maxRounds) {
  maxRounds = maxRounds || 3;
  // 已点过确认的弹窗（含其内部嵌套节点）按已处理对待
  var _isConfirmed = function(el) {
    try { return !!(el.closest && el.closest('[data-zitou-sure-clicked]')); } catch (e) { return false; }
  };
  // #39 诊断埋点：btn-sure 弹窗出现但没点确认时记原因（textMismatch 时 btnText 是关键证据）。
  // 每个弹窗节点只记一次（防多轮重复刷屏）。纯留痕，不改任何流程。
  var _diagSureSkip = function(dlg, reason, btnTxt) {
    try {
      if (dlg.getAttribute('data-zitou-sure-skip-logged')) return;
      dlg.setAttribute('data-zitou-sure-skip-logged', '1');
      var snippet = (dlg.textContent || '').trim().substring(0, 80);
      var msg = '[#39] btn-sure 弹窗未点确认 reason=' + reason + ' btnText=「' + btnTxt + '」 dlgCls=' + dlg.className + ' dlgText=' + snippet;
      try { if (typeof DiagLogger !== 'undefined') DiagLogger.warn('cs.flow', msg); } catch (_) {}
      _persistDiag('dialog:sureSkip', { reason: reason, btnText: btnTxt, text: snippet, cls: dlg.className });
      console.warn('[即投] closeBlockingDialogs: ' + msg);
    } catch (e) {}
  };
  // B2：无弹窗快速短路 —— preflight 已关 BOSS 自动招呼(sw)，多数岗根本不弹窗。
  // 进函数立即扫一次「已知弹窗选择器」（[class*="dialog"] + .greet-boss-container 隐私/已发送框），
  // 全无命中 → ~150ms 轻确认（等可能入场动画中的弹窗现形）后仍无 → 直接 return，省掉 round1 固定 ~1s。
  // 🔴 一旦命中任一可见且未确认的弹窗，绝不短路 → 走下方完整流程，防漏关必关弹窗。
  var _hasBlockingDialog = function() {
    try {
      var ns = document.querySelectorAll('[class*="dialog"], .greet-boss-container, .icon-close');
      for (var x = 0; x < ns.length; x++) {
        if (ns[x].offsetHeight > 0 && !_isConfirmed(ns[x])) return true;
      }
    } catch (e) { return true; } // 扫描异常时保守走完整流程
    return false;
  };
  if (!_hasBlockingDialog()) {
    await new Promise(function(r) { setTimeout(r, 150); });
    if (!_hasBlockingDialog()) {
      try { if (typeof DiagLogger !== 'undefined') DiagLogger.debug('cs.flow', 'closeBlockingDialogs：无弹窗快速短路（省 round1 固定等待）'); } catch (_) {}
      return true;
    }
  }
  for (var round = 0; round < maxRounds; round++) {
    await new Promise(function(r) { setTimeout(r, 400); });

    // Step 0: 「继续沟通新职位」确认弹窗 → 点 span.boss-dialog__button 本身（最内层，陷阱 #14：click 只向上冒泡）
    // 2026-06-12 真机抓 DOM 定死：弹窗本体 .change-job-tip-dialog；确认钮 span.boss-dialog__button
    // （非 outline），文本 trim 后 =「沟通新职位」；取消钮带 .button-outline。span.btn-sure 不存在。
    var step0Dialogs = document.querySelectorAll('[class*="dialog"]');
    var confirmed = 0;
    for (var s0 = 0; s0 < step0Dialogs.length; s0++) {
      var dlg = step0Dialogs[s0];
      if (dlg.offsetHeight <= 0 || _isConfirmed(dlg)) continue;
      var target = dlg.classList.contains('change-job-tip-dialog') ? dlg : dlg.querySelector('.change-job-tip-dialog');
      if (!target) {
        // 结构漂移监测：弹窗文案像「沟通新职位」确认框却找不到 .change-job-tip-dialog → 留痕（难复现，没痕迹测试白跑）
        var dlgTxt0 = (dlg.textContent || '').trim();
        if (dlgTxt0.indexOf('沟通新职位') >= 0 || dlgTxt0.indexOf('新一轮沟通') >= 0) {
          _diagSureSkip(dlg, 'noConfirmDialog', '');
        }
        continue;
      }
      var sureBtn = target.querySelector('span.boss-dialog__button:not(.button-outline)');
      if (!sureBtn) { _diagSureSkip(dlg, 'noConfirmDialog', ''); continue; }
      var sureBtnTxt = (sureBtn.textContent || '').trim();
      if (sureBtn.offsetHeight <= 0) { _diagSureSkip(dlg, 'btnHidden', sureBtnTxt); continue; }
      if ((sureBtn.className || '').indexOf('disabled') >= 0) { _diagSureSkip(dlg, 'btnDisabled', sureBtnTxt); continue; }
      // 按钮文本精确匹配（真机实测定死：「沟通新职位」），别的弹窗绝不误点
      if (sureBtnTxt !== '沟通新职位') { _diagSureSkip(dlg, 'textMismatch', sureBtnTxt); continue; }
      var dlgText = (dlg.textContent || '').trim();
      var dlgSnippet = dlgText.substring(0, 50);
      try {
        // 标记打在根容器 .dialog-wrap（本体/icon-close 都是其后代）→ Step 1 绝不点其 icon-close、Step 2 绝不 remove
        var markRoot = target.closest('.dialog-wrap') || dlg;
        markRoot.setAttribute('data-zitou-sure-clicked', '1'); // 先标记防多轮重复点
        sureBtn.click();
        confirmed++;
        _persistDiag('dialog:continueChatConfirm', { text: dlgSnippet, cls: dlg.className });
        try { if (typeof DiagLogger !== 'undefined') DiagLogger.info('cs.flow', '命中「继续沟通新职位」确认弹窗，已点 btn-sure 继续投递。文案=' + dlgSnippet); } catch (_) {}
        try {
          if (typeof ErrorLogger !== 'undefined' && ErrorLogger.logError) {
            ErrorLogger.logError('[dialog:continueChatConfirm] ' + dlgSnippet, '', 'closeBlockingDialogs');
          }
        } catch (_) {}
        console.log('[即投] closeBlockingDialogs: 命中继续沟通确认弹窗，已点 btn-sure。text=' + dlgSnippet);
      } catch (e) {}
    }
    if (confirmed > 0) {
      await new Promise(function(r) { setTimeout(r, 400); }); // 等 Vue handlerConfirm 处理
      // #39 诊断埋点：点完确认后弹窗是否真关掉（仍可见 = handlerConfirm 没生效，必须留痕）
      try {
        var afterNodes = document.querySelectorAll('[data-zitou-sure-clicked]');
        var stillVis = 0;
        for (var a0 = 0; a0 < afterNodes.length; a0++) {
          if (afterNodes[a0].offsetHeight > 0) {
            stillVis++;
            var aTxt = (afterNodes[a0].textContent || '').trim().substring(0, 80);
            try { if (typeof DiagLogger !== 'undefined') DiagLogger.warn('cs.flow', '[#39] 点了 btn-sure 但 400ms 后弹窗仍可见 dlgText=' + aTxt); } catch (_) {}
            _persistDiag('dialog:sureClickedStillOpen', { text: aTxt });
          }
        }
        if (stillVis === 0) {
          try { if (typeof DiagLogger !== 'undefined') DiagLogger.info('cs.flow', '[#39] btn-sure 点击后确认弹窗已关闭（共 ' + confirmed + ' 个）'); } catch (_) {}
        }
      } catch (e) {}
    }

    // Step 0.5: 「已向BOSS发送消息」弹窗（.greet-boss-container）专用兜底 ──
    // DOM：a.cancel-btn=「留在此页」（关弹窗不跳转），a.sure-btn=「继续沟通」（会整页跳转，破坏 worker 流程）。
    // 通用 Step 1 的 .icon-close 不一定关得掉它，且绝不能点 sure-btn。故优先点 cancel-btn 留在此页。
    var greetBoxes = document.querySelectorAll('.greet-boss-container');
    var greetClosed = 0;
    for (var gb = 0; gb < greetBoxes.length; gb++) {
      var gbox = greetBoxes[gb];
      if (gbox.offsetHeight <= 0 || _isConfirmed(gbox)) continue;
      var cancelBtn = gbox.querySelector('a.cancel-btn');
      if (cancelBtn && cancelBtn.offsetHeight > 0) {
        try {
          cancelBtn.click();
          greetClosed++;
          _persistDiag('dialog:greetBossCancel', { text: (gbox.textContent || '').trim().substring(0, 50) });
          try { if (typeof DiagLogger !== 'undefined') DiagLogger.info('cs.flow', '命中「已向BOSS发送消息」弹窗，点 cancel-btn 留在此页（绝不点 sure-btn 跳转）'); } catch (_) {}
          console.log('[即投] closeBlockingDialogs: 命中 greet-boss-container，点 cancel-btn 留在此页');
        } catch (e) {}
      }
    }
    if (greetClosed > 0) {
      await new Promise(function(r) { setTimeout(r, 300); });
    }

    // Step 1: 优先 .icon-close.click() 走 Vue close handler（释放 BOSS 业务状态）
    var closers = document.querySelectorAll('.icon-close');
    var clicked = 0;
    for (var ci = 0; ci < closers.length; ci++) {
      if (closers[ci].offsetHeight > 0 && !_isConfirmed(closers[ci])) {
        try { closers[ci].click(); clicked++; } catch (e) {}
      }
    }
    await new Promise(function(r) { setTimeout(r, 300); });

    // Step 2: 仍可见的弹窗（如 chat-block-dialog 无 .icon-close）→ fallback .remove()
    var dialogs = document.querySelectorAll('[class*="dialog"]');
    var removed = 0;
    for (var i = 0; i < dialogs.length; i++) {
      if (dialogs[i].offsetHeight > 0 && !_isConfirmed(dialogs[i])) {
        // #39 诊断埋点：remove 前快照未识别弹窗 DOM（每 className 只快照一次），纯留痕不影响 remove
        try {
          var snapCls = dialogs[i].className;
          if (!_snapDone[snapCls]) {
            _snapDone[snapCls] = true;
            var snapHtml = dialogs[i].outerHTML || '';
            var snapRawLen = snapHtml.length;
            if (snapHtml.length > 2400) snapHtml = snapHtml.substring(0, 2400);
            try {
              if (typeof DiagLogger !== 'undefined') {
                var snapTotal = Math.ceil(snapHtml.length / 260);
                DiagLogger.warn('cs.flow', '[#39] 未识别弹窗即将被remove，DOM快照如下 cls=' + snapCls);
                for (var sk = 0; sk < snapTotal; sk++) {
                  DiagLogger.warn('cs.flow', '[#39][snap ' + (sk + 1) + '/' + snapTotal + '] ' + snapHtml.substring(sk * 260, (sk + 1) * 260));
                }
              }
            } catch (_) {}
            _persistDiag('dialog:removeSnapshot', { cls: snapCls, len: snapRawLen });
          }
        } catch (e) {}
        try { dialogs[i].remove(); removed++; } catch (e) {}
      }
    }
    if (confirmed > 0 || clicked > 0 || removed > 0) {
      console.log('[即投] closeBlockingDialogs: round=' + (round + 1) + ' sureConfirmed=' + confirmed + ' iconClicked=' + clicked + ' fallbackRemoved=' + removed);
      try { if (typeof DiagLogger !== 'undefined') DiagLogger.debug('cs.flow', 'closeBlockingDialogs round=' + (round + 1) + ' sureConfirmed=' + confirmed + ' iconClicked=' + clicked + ' fallbackRemoved=' + removed); } catch (_) {}
    }
    await new Promise(function(r) { setTimeout(r, 300); });
    var stillOpen = false;
    var nodes = document.querySelectorAll('[class*="dialog"]');
    for (var j = 0; j < nodes.length; j++) {
      if (nodes[j].offsetHeight > 0 && !_isConfirmed(nodes[j])) { stillOpen = true; break; }
    }
    if (!stillOpen) return true;
  }
  var leftover = document.querySelectorAll('[class*="dialog"]');
  for (var k = 0; k < leftover.length; k++) {
    if (leftover[k].offsetHeight > 0 && !_isConfirmed(leftover[k])) {
      console.warn('[即投] closeBlockingDialogs: 多轮后弹窗仍在，cls=' +
        leftover[k].className + ' text=' + (leftover[k].textContent || '').trim().substring(0, 100));
      try { if (typeof DiagLogger !== 'undefined') DiagLogger.warn('cs.flow', '[#39] 多轮后弹窗仍在 cls=' + leftover[k].className + ' text=' + (leftover[k].textContent || '').trim().substring(0, 80)); } catch (_) {}
      _persistDiag('dialog:leftoverOpen', { cls: leftover[k].className, text: (leftover[k].textContent || '').trim().substring(0, 80) });
      return false;
    }
  }
  return true;
}

// ── #39 阶段1跳转恢复：消息页确认「沟通新职位」弹窗（SW 主动指派，独立于 closeBlockingDialogs）──
// 背景：同 HR 新岗位点「立即沟通」后 BOSS 整页跳转 /web/geek/chat，确认弹窗弹在消息页，
// 岗位页 CS 已死。本函数运行在消息页 CS，收 CONFIRM_CHANGE_JOB_DIALOG 后执行。
// DOM 铁证（2026-06-12 真机抓取）：根 div.dialog-wrap.active，本体 class 含 change-job-tip-dialog，
// 确认钮 span.boss-dialog__button（文本两侧有空白+Vue 注释节点），取消钮多 button-outline 类。
// 弹窗内有 .icon-close 但绝不点它（点了 = 取消建联）。
async function confirmChangeJobDialog() {
  try { if (typeof DiagLogger !== 'undefined') DiagLogger.info('cs.flow', '[#39] confirmChangeJobDialog 开始轮询弹窗 url=' + location.href); } catch (_) {}
  _persistDiag('confirmChangeJob:start', { url: location.href });

  // 轮询最多 8s（500ms 间隔）等可见 .change-job-tip-dialog
  var dlg = null;
  var deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    var cands = document.querySelectorAll('.change-job-tip-dialog');
    for (var ci = 0; ci < cands.length; ci++) {
      if (cands[ci].offsetHeight > 0) { dlg = cands[ci]; break; }
    }
    if (dlg) break;
    await new Promise(function(r) { setTimeout(r, 500); });
  }
  if (!dlg) {
    try { if (typeof DiagLogger !== 'undefined') DiagLogger.warn('cs.flow', '[#39] 8s 内未等到可见 .change-job-tip-dialog'); } catch (_) {}
    _persistDiag('confirmChangeJob:dialogNotFound', { url: location.href });
    return { clicked: false, reason: 'dialogNotFound' };
  }

  // 确认钮严校验：非 outline、可见、className 不含 disabled、文本 trim 后精确等于「沟通新职位」
  var btns = dlg.querySelectorAll('span.boss-dialog__button:not(.button-outline)');
  var btn = null;
  var seenTxt = '';
  for (var bi = 0; bi < btns.length; bi++) {
    var t = (btns[bi].textContent || '').trim();
    seenTxt = seenTxt ? seenTxt + '|' + t : t;
    if (btns[bi].offsetHeight > 0 && (btns[bi].className || '').indexOf('disabled') < 0 && t === '沟通新职位') {
      btn = btns[bi];
      break;
    }
  }
  if (!btn) {
    try { if (typeof DiagLogger !== 'undefined') DiagLogger.warn('cs.flow', '[#39] 确认钮不符（不可见/disabled/文本不等「沟通新职位」） seen=「' + seenTxt + '」'); } catch (_) {}
    _persistDiag('confirmChangeJob:btnMismatch', { seen: seenTxt, dlgCls: dlg.className });
    return { clicked: false, reason: 'btnMismatch:' + seenTxt };
  }

  // 先在根容器打标记（closeBlockingDialogs 据此跳过，绝不二次处理/remove 污染 Vue state）再点击
  var markRoot = dlg.closest('.dialog-wrap') || dlg;
  markRoot.setAttribute('data-zitou-sure-clicked', '1');
  btn.click();
  await new Promise(function(r) { setTimeout(r, 400); });
  var stillOpen = document.contains(dlg) && dlg.offsetHeight > 0;
  if (stillOpen) {
    try { if (typeof DiagLogger !== 'undefined') DiagLogger.warn('cs.flow', '[#39] 已点「沟通新职位」但 400ms 后弹窗仍可见'); } catch (_) {}
  } else {
    try { if (typeof DiagLogger !== 'undefined') DiagLogger.info('cs.flow', '[#39] 已点「沟通新职位」确认钮，弹窗已消失'); } catch (_) {}
  }
  _persistDiag('confirmChangeJob:clicked', { stillOpen: stillOpen });
  return { clicked: true, reason: 'ok' };
}

// ── 投递错位止血：公司名归一化（剥离常见后缀/地域后双向 includes）──
// job.hrCompany 与对话列表/详情公司名同实体（都抓自 HR/猎头卡），归一化后正常岗应能匹配。
// 仅用于 fallback 命中（公司未经主循环双键验证）的发送前身份断言，不参与 exact 主路径。
function _normCompanyName(s) {
  s = (s || '').trim();
  if (!s) return '';
  // 剥离常见公司后缀
  s = s.replace(/(股份)?有限责任公司|(股份)?有限公司|有限公司|集团|科技|网络|信息|技术|服务|咨询|文化|传媒|互联网|电子商务|发展|实业|控股|分公司|公司/g, '');
  // 剥离常见地域前缀/词
  s = s.replace(/北京|上海|广州|深圳|杭州|成都|重庆|武汉|南京|西安|苏州|天津|长沙|郑州|东莞|佛山|宁波|青岛|沈阳|大连|厦门|福州|合肥|济南|无锡|昆明|哈尔滨|长春|南昌|贵阳|南宁|石家庄|太原|中国|（[^）]*）|\([^)]*\)/g, '');
  // 剥离空白与常见标点
  s = s.replace(/[\s·•・，,.。、\-—()（）]/g, '');
  return s;
}

// 归一化后双向 includes 判定公司名是否同实体
function _companyMatch(a, b) {
  var na = _normCompanyName(a);
  var nb = _normCompanyName(b);
  if (!na || !nb) return false;
  return na === nb || na.indexOf(nb) !== -1 || nb.indexOf(na) !== -1;
}

// ── 聊天页辅助：根据HR名字+公司名查找对话 ──
// 返回的元素上挂 dataset 旁路标记 _jtMatchMode = 'exact' | 'fallback'，
// 调用方据此决定发送前是否需做身份断言（fallback 高危，公司未验）。
function _tagMatchMode(el, mode) {
  // 在 DOM 节点上挂一个非持久化属性，供同步调用链读取命中方式
  try { if (el) el._jtMatchMode = mode; } catch (_) {}
  return el;
}

function findChatConversation(hrName, hrCompany) {
  var items = document.querySelectorAll('.user-list-content li, .friend-content-warp');
  hrName = (hrName || '').trim();
  hrCompany = (hrCompany || '').trim();
  console.log('[即投] findChatConversation: 在', items.length, '个对话中搜索 hrName="' + hrName + '" hrCompany="' + hrCompany + '"');

  for (var i = 0; i < items.length; i++) {
    var nameEl = items[i].querySelector('.name-text');
    if (!nameEl) continue;
    var nameText = nameEl.textContent.trim();
    if (!nameText.includes(hrName) && hrName !== nameText) continue;
    // 检查公司名匹配
    var nameBox = items[i].querySelector('.name-box');
    if (nameBox) {
      var spans = nameBox.querySelectorAll('span');
      for (var s = 0; s < spans.length; s++) {
        if (spans[s].classList.contains('name-text')) continue;
        var companyText = spans[s].textContent.trim();
        if (companyText.includes(hrCompany) || hrCompany === companyText) {
          console.log('[即投] findChatConversation: 找到匹配对话 idx=' + i + ' name="' + nameText + '"');
          // 必须返回 .friend-content（内层div），不能返回 .friend-content-warp（外层div）
          // BOSS Vue 2 的 click handler 绑在 .friend-content 上
          // JS .click() 事件从目标元素开始，只向上冒泡，不向下传递到子元素
          // 如果点 .friend-content-warp，事件不会到达 .friend-content，handler 不触发
          if (items[i].tagName === 'LI') {
            return _tagMatchMode(items[i].querySelector('.friend-content, [class*="friend-content"]') || items[i].querySelector('.friend-content-warp') || items[i], 'exact');
          }
          if (items[i].classList.contains('friend-content-warp')) {
            return _tagMatchMode(items[i].querySelector('.friend-content') || items[i], 'exact');
          }
          return _tagMatchMode(items[i], 'exact');
        }
      }
      // 公司名不匹配，跳过这个 item
      continue;
    }
  }
  // ── 兜底（投递错位止血 #1）：只按名字匹配（公司名可能对不上）──
  // 旧逻辑命中第一个同名即返回 → 同名异公司错投。
  // 改：先遍历统计 name-only 命中数；>1 个歧义 → 返回 null（绝不盲选）；恰好 1 个唯一命中才返回。
  var nameOnlyHits = [];
  for (var j = 0; j < items.length; j++) {
    var nEl = items[j].querySelector('.name-text');
    if (nEl) {
      var nText = nEl.textContent.trim();
      if (nText.includes(hrName) || hrName === nText) {
        nameOnlyHits.push(items[j]);
      }
    }
  }
  if (nameOnlyHits.length > 1) {
    console.warn('[即投] findChatConversation: 兜底命中 ' + nameOnlyHits.length + ' 个同名HR（歧义）→ 不返回，转定位失败/补发');
    try {
      if (typeof ErrorLogger !== 'undefined' && ErrorLogger.logError) {
        ErrorLogger.logError('[findConv:ambiguous] ' + JSON.stringify({
          searchHrName: hrName, searchHrCompany: hrCompany, nameOnlyHitCount: nameOnlyHits.length,
        }), '', 'findConv.ambiguous');
      }
    } catch (_) {}
    return null;
  }
  if (nameOnlyHits.length === 1) {
    var hit = nameOnlyHits[0];
    console.log('[即投] findChatConversation: 兜底唯一匹配 name="' + (hit.querySelector('.name-text') ? hit.querySelector('.name-text').textContent.trim() : '') + '" → 标记 fallback（公司未验，发前断言）');
    if (hit.tagName === 'LI') {
      return _tagMatchMode(hit.querySelector('.friend-content, [class*="friend-content"]') || hit.querySelector('.friend-content-warp') || hit, 'fallback');
    }
    if (hit.classList.contains('friend-content-warp')) {
      return _tagMatchMode(hit.querySelector('.friend-content') || hit, 'fallback');
    }
    return _tagMatchMode(hit, 'fallback');
  }
  try {
    if (typeof ErrorLogger !== 'undefined' && ErrorLogger.logError) {
      var _listNames = [];
      for (var d = 0; d < items.length && _listNames.length < 20; d++) {
        var _ne = items[d].querySelector('.name-text');
        if (_ne) _listNames.push(_ne.textContent.trim());
      }
      ErrorLogger.logError('[findConv:diag] ' + JSON.stringify({
        searchHrName: hrName,
        searchHrCompany: hrCompany,
        listCount: items.length,
        listNames: _listNames,
        url: location.href,
      }), '', 'findConv.diag');
    }
  } catch (e) {}
  console.warn('[即投] findChatConversation: 未找到匹配对话');
  return null;
}

// ── 投递错位止血 #2：发送前身份断言（仅 fallback 命中调用）──
// 读「当前激活对话」的 HR名+公司，跟目标 job 比；HR名匹配 且 公司归一化后匹配 才放行。
// ⚠️ 真机实证：聊天详情顶栏根本不显示公司名，原顶栏候选选择器全失效（已删）。
// 可靠数据源 = 当前激活列表项 `.friend-content.selected`（真机 outerHTML 实证，
// 同时带 HR名 .name-text + 公司名，连猎头对话也带）。读不到一律 cannotVerify 转补发，不再猜顶栏。
function assertOpenConversationIdentity(targetHrName, targetHrCompany) {
  var hrName = (targetHrName || '').trim();

  // 边界兜底：必须恰好 1 个激活对话，否则无法确定当前打开的是哪个 → cannotVerify 转补发
  var sels = document.querySelectorAll('.friend-content.selected');
  if (sels.length !== 1) {
    console.warn('[即投] assertOpenConversationIdentity: .friend-content.selected 数量=' + sels.length + '（非唯一）→ cannotVerify，转补发');
    return { ok: false, cannotVerify: true, openName: '', openCompany: '' };
  }
  var sel = sels[0];

  // HR 名
  var nameEl = sel.querySelector('.name-text');
  var openName = (nameEl && nameEl.textContent) ? nameEl.textContent.trim() : '';

  // 公司名 = .name-box 内 .name-text 之后第一个「有文本的 span」。
  // span 顺序 = [HR名, 公司名, 头衔]，中间可能夹 i.vline / 占位 → 用 nextElementSibling 逐个向后跳，
  // 只认 SPAN 且首个有文本者 = 公司名；命中即停（绝不继续走到第三个 span=头衔），故不会取到头衔。
  var openCompany = '';
  var nameTextEl = sel.querySelector('.name-box .name-text');
  if (nameTextEl) {
    var cur = nameTextEl.nextElementSibling;
    while (cur) {
      if (cur.tagName === 'SPAN') {
        var t = (cur.textContent || '').trim();
        if (t) { openCompany = t; break; } // 首个有文本 span = 公司名，命中即停
      }
      cur = cur.nextElementSibling;
    }
  }

  // 取不到名或公司 → 无法核验，按核心原则（错投 >> 漏发）当失败转补发
  if (!openName || !openCompany) {
    console.warn('[即投] assertOpenConversationIdentity: .selected 取不到 name/company（name="' + openName + '" company="' + openCompany + '"）→ cannotVerify，转补发');
    return { ok: false, cannotVerify: true, openName: openName, openCompany: openCompany };
  }
  var nameOk = openName.indexOf(hrName) !== -1 || hrName.indexOf(openName) !== -1 || openName === hrName;
  var companyOk = _companyMatch(openCompany, targetHrCompany);
  if (nameOk && companyOk) {
    return { ok: true, openName: openName, openCompany: openCompany };
  }
  console.warn('[即投] assertOpenConversationIdentity: 身份断言失败 target="' + hrName + '/' + (targetHrCompany || '') + '" open="' + openName + '/' + openCompany + '" nameOk=' + nameOk + ' companyOk=' + companyOk + ' → 转补发');
  try {
    if (typeof ErrorLogger !== 'undefined' && ErrorLogger.logError) {
      ErrorLogger.logError('[identityAssert:fail] ' + JSON.stringify({
        targetHrName: hrName, targetHrCompany: targetHrCompany,
        openName: openName, openCompany: openCompany, nameOk: nameOk, companyOk: companyOk,
      }), '', 'identityAssert.fail');
    }
  } catch (_) {}
  return { ok: false, cannotVerify: false, openName: openName, openCompany: openCompany };
}


(async () => {
  const href = window.location.href;

  // ── 全局错误捕获 ──
  self.addEventListener('error', (event) => {
    if (typeof ErrorLogger !== 'undefined') {
      ErrorLogger.logError(event.message, event.filename + ':' + event.lineno, 'Content script global error');
    }
    try { if (typeof DiagLogger !== 'undefined') DiagLogger.error('cs.global', event.message + ' at ' + event.filename + ':' + event.lineno); } catch (_) {}
  });
  self.addEventListener('unhandledrejection', (event) => {
    if (typeof ErrorLogger !== 'undefined') {
      ErrorLogger.logError(event.reason?.message || String(event.reason), event.reason?.stack, 'Content script unhandled rejection');
    }
    try { if (typeof DiagLogger !== 'undefined') DiagLogger.error('cs.global', 'unhandledrejection: ' + (event.reason?.message || String(event.reason))); } catch (_) {}
  });

  // ── 诊断包：页面级用户行为信号（纯新增，不碰业务逻辑）──
  // visibilitychange/pagehide 帮助区分「程序 bug」vs「用户切走/关页/导航走」。
  // 只在任务相关页（jobs 搜索页 / chat 页）记录；ring buffer 自然限量。
  try {
    if (typeof DiagLogger !== 'undefined' && (href.includes('/web/geek/jobs') || href.includes('/web/geek/chat'))) {
      var _diagPath = '';
      try { _diagPath = location.pathname; } catch (e2) {}
      document.addEventListener('visibilitychange', function () {
        try { DiagLogger.userEvent('cs.page', 'visibility=' + document.visibilityState + ' path=' + _diagPath); } catch (_) {}
      });
      window.addEventListener('pagehide', function () {
        try {
          DiagLogger.userEvent('cs.page', 'pagehide（页面被关闭/导航走）path=' + _diagPath);
          DiagLogger.flush(); // 尽力落盘，页面销毁可能丢最后几条，可接受
        } catch (_) {}
      });
    }
  } catch (_) {}

  // ── 初始化：把已存储的错误日志同步到 DOM ──
  if (typeof ErrorLogger !== 'undefined') {
    ErrorLogger.getErrors().then(function(errors) {
      if (document.documentElement) {
        if (errors.length > 0) {
          document.documentElement.setAttribute('data-error-log', JSON.stringify(errors));
        }
      }
    }).catch(function(){});
  }

  // ── window.postMessage 监听 ──
  if (TEST_BRIDGE_ENABLED) {
  window.addEventListener('message', function(event) {
    if (!event.data || !event.data.type) return;

    function setSplitAttr(baseName, data) {
      var json = JSON.stringify(data);
      if (json.length <= 10240) {
        document.documentElement.setAttribute('data-' + baseName, json);
        return;
      }
      var idx = 0;
      while (idx * 10240 < json.length) {
        document.documentElement.setAttribute(
          'data-' + baseName + '-' + idx,
          json.slice(idx * 10240, (idx + 1) * 10240)
        );
        idx++;
      }
    }

    switch (event.data.type) {
      case 'GET_ERROR_LOG':
        if (typeof ErrorLogger !== 'undefined' && typeof ErrorLogger.syncToDOM === 'function') {
          ErrorLogger.syncToDOM();
        }
        break;

      case 'GET_EXTENSION_STATE':
        chrome.storage.local.get(['sw:phase', 'sw:jobs', 'sw:greetings', 'sw:sendProgress', 'sw:sentJobIds', 'sw:sendResults', 'ui:filterState'], function(items) {
          setSplitAttr('ext-state', items);
        });
        break;

      case 'TRIGGER_GREETING_GEN':
        chrome.runtime.sendMessage({ type: 'REGENERATE_GREETING' }, function(resp) {
          setTimeout(function() {
            chrome.storage.local.get(['sw:greetings'], function(data) {
              var result = { response: resp, greetings: data['sw:greetings'] };
              if (typeof ErrorLogger !== 'undefined') {
                ErrorLogger.getErrors().then(function(errors) {
                  result.errorLog = errors;
                  setSplitAttr('greeting-result', result);
                }).catch(function() {
                  setSplitAttr('greeting-result', result);
                });
              } else {
                setSplitAttr('greeting-result', result);
              }
            });
          }, 5000);
        });
        break;

      case 'RELOAD_EXTENSION':
        // 全自动开发重载（零抢屏）：content script 无 chrome.runtime.reload 特权，故转发给 SW 执行。
        // SW 置 __pending_tab_reload flag 后 reload；扩展重启后 SW top-level 读 flag 原地
        // chrome.tabs.reload 所有 BOSS tab → Chrome 自动注入新版 CS（不开新 tab、不切焦点）。
        try {
          chrome.runtime.sendMessage({ type: 'RELOAD_EXT_SELF' });
          document.documentElement.setAttribute('data-ext-cmd-result', 'reload_requested');
        }
        catch(e) { document.documentElement.setAttribute('data-ext-cmd-result', 'reload_failed: ' + e.message); }
        break;

      case 'CLEAR_ERRORS':
        if (typeof ErrorLogger !== 'undefined' && typeof ErrorLogger.clearErrors === 'function') {
          ErrorLogger.clearErrors().then(function() {
            document.documentElement.setAttribute('data-ext-cmd-result', 'errors_cleared');
          }).catch(function() {
            document.documentElement.setAttribute('data-ext-cmd-result', 'error_clear_failed');
          });
        } else {
          document.documentElement.setAttribute('data-ext-cmd-result', 'error_logger_unavailable');
        }
        break;

      case 'GET_SEND_STATUS':
        chrome.storage.local.get(['sw:sendProgress', 'sw:sentJobIds', 'sw:sendResults', 'sw:phase'], function(data) {
          setSplitAttr('send-status', data);
        });
        break;

      case 'TRIGGER_COLLECT': {
        var params = event.data.params;
        if (!params) {
          params = {};
          try {
            var urlParams = new URLSearchParams(window.location.search);
            urlParams.forEach(function(value, key) { params[key] = value; });
          } catch (e) {
            if (typeof ErrorLogger !== 'undefined') {
              ErrorLogger.logError(e.message, e.stack, 'TRIGGER_COLLECT parseURL');
            }
          }
        }
        chrome.runtime.sendMessage({ type: 'START_COLLECT', params: params }, function(resp) {
          if (chrome.runtime.lastError) {
            document.documentElement.setAttribute('data-ext-cmd-result', JSON.stringify({ success: false, error: chrome.runtime.lastError.message }));
            if (typeof ErrorLogger !== 'undefined') {
              ErrorLogger.logError(chrome.runtime.lastError.message, null, 'TRIGGER_COLLECT sendMessage');
            }
            return;
          }
          document.documentElement.setAttribute('data-ext-cmd-result', JSON.stringify(resp || {}));
        });
        break;
      }

      case 'SET_GREETING':
        chrome.storage.local.set({'sw:greetings': event.data.greetings}, function() {
          document.documentElement.setAttribute('data-greeting-set', 'done');
        });
        break;

      // 测试桥：把一张简历图写进 resumeImages storage（产品发送路径 _sendResumeImages 读的同一个 key）。
      // 复刻 A 页上传 events-a.js 写入的 storage 条目形状 {name,type,data,id,thumb,fullSrc} + 原子 get-then-set
      // （等价 helpers.js atomicUpdateResumeImages），保证发送路径能读到、popup 重载后缩略图也能渲染。
      // 仅测试用：osascript 够不到 chrome.storage / file picker 需可信用户手势，无此桥无法自动喂图。产品流程永不发此消息。
      case 'EXT_TEST_SET_RESUME': {
        try {
          var _du = event.data.dataUrl || '';
          var _comma = _du.indexOf(',');
          var _meta = _comma >= 0 ? _du.slice(0, _comma) : '';
          var _b64 = _comma >= 0 ? _du.slice(_comma + 1) : _du;
          var _typeM = _meta.match(/data:([^;]+)/);
          var _type = (_typeM && _typeM[1]) || 'image/jpeg';
          var _bin = atob(_b64);
          var _data = new Array(_bin.length);
          for (var _i = 0; _i < _bin.length; _i++) _data[_i] = _bin.charCodeAt(_i);
          var _name = event.data.name || 'resume.jpg';
          var _id = Date.now() + '_' + Math.random().toString(36).slice(2, 6);
          var _entry = { name: _name, type: _type, data: _data, id: _id, thumb: _du, fullSrc: _du };
          chrome.storage.local.get('resumeImages', function(r) {
            var arr = r.resumeImages || [];
            arr.push(_entry);
            chrome.storage.local.set({ resumeImages: arr }, function() {
              document.documentElement.setAttribute('data-ext-set-resume', JSON.stringify({ success: true, count: arr.length, bytes: _data.length }));
            });
          });
        } catch (e) {
          document.documentElement.setAttribute('data-ext-set-resume', JSON.stringify({ success: false, error: e && e.message }));
        }
        break;
      }

      case 'CLEAR_SENT_JOB_IDS':
        chrome.runtime.sendMessage({type:'CLEAR_SENT_JOB_IDS'});
        chrome.storage.local.remove('sw:sentJobIds');
        chrome.storage.local.remove('sw:sendResults');
        document.documentElement.setAttribute('data-ext-cmd-result','sent_job_ids_cleared');
        break;

      case 'TRIGGER_SEND_V4': {
        var jobIds = event.data.jobIds;
        var _testHrFilter = event.data.hrActiveFilter || '不限';
        var doSend = function(ids) {
          chrome.runtime.sendMessage({ type: 'START_SEND', jobIds: ids, hrActiveFilter: _testHrFilter }, function(resp) {
            if (chrome.runtime.lastError) {
              document.documentElement.setAttribute('data-ext-cmd-result', JSON.stringify({ success: false, error: chrome.runtime.lastError.message }));
              if (typeof ErrorLogger !== 'undefined') {
                ErrorLogger.logError(chrome.runtime.lastError.message, null, 'TRIGGER_SEND_V4 sendMessage');
              }
              return;
            }
            document.documentElement.setAttribute('data-ext-cmd-result', JSON.stringify(resp || {}));
          });
        };
        if (!jobIds || !Array.isArray(jobIds) || jobIds.length === 0) {
          chrome.storage.local.get(['sw:jobs'], function(items) {
            var jobs = items['sw:jobs'] || [];
            if (jobs.length > 0) {
              doSend([jobs[0].id]);
            } else {
              document.documentElement.setAttribute('data-ext-cmd-result', JSON.stringify({ success: false, error: 'No jobs found in storage' }));
            }
          });
        } else {
          doSend(jobIds);
        }
        break;
      }

      case 'EXT_TEST_OPEN_POPUP':
        chrome.runtime.sendMessage({ type: '__TEST_OPEN_POPUP__' }, function(resp) {
          if (chrome.runtime.lastError) {
            document.documentElement.setAttribute('data-test-popup-tab-id', JSON.stringify({ success: false, error: chrome.runtime.lastError.message }));
            return;
          }
          document.documentElement.setAttribute('data-test-popup-tab-id', JSON.stringify(resp || { success: false, error: 'no response' }));
        });
        break;

      case 'EXT_TEST_CLOSE_POPUP':
        chrome.runtime.sendMessage({ type: '__TEST_CLOSE_POPUP__', tabId: event.data.tabId }, function(resp) {
          if (chrome.runtime.lastError) {
            document.documentElement.setAttribute('data-test-popup-close', JSON.stringify({ success: false, error: chrome.runtime.lastError.message }));
            return;
          }
          document.documentElement.setAttribute('data-test-popup-close', JSON.stringify(resp || { success: false, error: 'no response' }));
        });
        break;

      case 'EXT_TEST_OPEN_TAB':
        // 测试桥：SW 用 chrome.tabs.create({active:false}) 开后台 BOSS tab（不抢屏）。
        chrome.runtime.sendMessage({ type: '__TEST_OPEN_TAB__', url: event.data.url }, function(resp) {
          if (chrome.runtime.lastError) {
            document.documentElement.setAttribute('data-test-open-tab', JSON.stringify({ success: false, error: chrome.runtime.lastError.message }));
            return;
          }
          document.documentElement.setAttribute('data-test-open-tab', JSON.stringify(resp || { success: false, error: 'no response' }));
        });
        break;
    }
  });
  }

  // ── JD 定制招呼语：合成点卡读 JD 全文 ──
  // 对搜索页卡内 a.job-name 派完整合成事件序列（pointer + mouse + click）→ 页面自发合法 detail.json
  // → JD 渲进右侧详情面板 .job-detail-container .desc（首选）或旧全页 .job-detail-box .desc（fallback）。
  // 轮询直到非空，最长 ~3.5s。单次点卡读取，不 sleep（节奏 3s/张串行归 SW 编排）。
  // READ_JD：SW 已把后台 tab 整页导航到本岗 /job_detail/{id}.html，这里直接读整页 JD 正文回传。
  // 导航式取 JD 对屏幕外/任意岗 ~100% 可靠（不依赖搜索列表虚拟滚动是否卸载该卡，故弃旧合成点卡）。
  async function handleReadJd(msg) {
    var jobId = msg && msg.jobId;
    // job_detail 整页 JD 正文：首选 .job-sec-text（职位描述区），兜底 .job-detail-box/.job-detail-container 的 .desc。
    var sels = [SELECTORS.jobDetail.jobSecText, SELECTORS.jobs.jdDescBox, SELECTORS.jobs.jdDescPanel];
    var jdText = '';
    for (var i = 0; i < 18 && !jdText; i++) { // 轮询 ~3.5s（每 200ms 一轮），等 SPA 渲染完 JD
      for (var s = 0; s < sels.length; s++) {
        var el = document.querySelector(sels[s]);
        var txt = el ? (el.innerText || el.textContent || '').trim() : '';
        if (txt) { jdText = txt; break; }
      }
      if (!jdText) await sleep(200);
    }
    if (!jdText) return { ok: false, jobId: jobId, reason: 'jd-timeout' }; // 读不到 JD → SW 降级组级生成，绝不据缺失排除
    // 三标签前置终判：不符 → 回 excluded + skipReason（SW 据此不生成招呼语、popup 取消勾选=不进投递队列）
    var judged = judgeJdFilters(msg, jdText);
    return { ok: true, jobId: jobId, jdText: jdText, excluded: judged.excluded, skipReason: judged.skipReason, hrInfoFound: judged.hrInfoFound };
  }

  // ── B3 猎头岗活跃度探测（真卡版，Phase 3）──
  // welfare-collector（MAIN world）hook detail.json 后把 activeTimeDesc/bossOnline 写 data-jitou-hractive-map，本函数读回。
  function _readHrActiveMap() {
    try {
      var raw = document.documentElement.getAttribute('data-jitou-hractive-map');
      return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
  }

  // SW 传来猎头 jobIds（独立页不渲活跃度，唯一途径=点采集 tab 里已在 DOM 的真卡 → 页面自发 detail.json →
  // welfare-collector 抓 activeTimeDesc 写 DOM 属性 → 读回判定）。只探猎头岗（~22 个），节奏 randBetween(2500,4000) 抖动防封。
  // fail-open：卡找不到/detail 没回 → 不排除（excluded:false, miss:true），仅兜硬错误路，绝不扩大成默认兜底。
  async function handleB3HeadhunterProbe(msg) {
    var jobIds = (msg && Array.isArray(msg.jobIds)) ? msg.jobIds : [];
    var hrActiveFilter = (msg && msg.hrActiveFilter) || '不限';
    var results = [];
    for (var i = 0; i < jobIds.length; i++) {
      var jobId = jobIds[i];
      try {
        var a = document.querySelector('a[href*="job_detail/' + jobId + '.html"]');
        // 卡容器优先用 selectors.js（li.job-card-box），兜底 closest('li') 防 BOSS 改 class
        var card = a ? (a.closest(SELECTORS.jobs.jobCard) || a.closest('li')) : null;
        if (!card) { results.push({ jobId: jobId, excluded: false, desc: '', miss: true }); continue; } // fail-open：卡没找到
        card.scrollIntoView({ block: 'center' });
        await sleep(300);
        // 派完整 pointer 序列到 li 根（b3probe-log 实证：li 根完整序列点击触发 detail.json，无反爬）
        var types = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
        for (var t = 0; t < types.length; t++) {
          var Ctor = (types[t].indexOf('pointer') === 0) ? PointerEvent : MouseEvent;
          try { card.dispatchEvent(new Ctor(types[t], { bubbles: true, cancelable: true, view: window })); } catch (e2) {}
        }
        await sleep(randBetween(2500, 4000)); // 反爬+反封间隔抖动，镜像 SEND_INTERVAL
        var ham = _readHrActiveMap();
        var entry = ham[jobId];
        if (!entry) { results.push({ jobId: jobId, excluded: false, desc: '', miss: true }); continue; } // fail-open：detail 没回/未映射
        var act = parseHrActivity(entry.bossOnline ? '在线' : '', entry.activeTimeDesc || '');
        var pass = passActivityFilter(hrActiveFilter, act);
        results.push({ jobId: jobId, excluded: !pass, desc: entry.activeTimeDesc || (entry.bossOnline ? '在线' : '') });
      } catch (e) {
        results.push({ jobId: jobId, excluded: false, desc: '', miss: true }); // fail-open：任何异常放行
      }
    }
    try { chrome.runtime.sendMessage({ type: MSG.B3_HEADHUNTER_RESULT, results: results }).catch(function () {}); } catch (e) {}
    return { ok: true, count: results.length };
  }

  // ── 消息监听 ──
  try { chrome.runtime.sendMessage({ type: 'CS_DBG', stage: 'cs:listenerRegister', info: { url: location.href, msgKeys: Object.keys(MSG || {}).length, doBatchExtract: MSG && MSG.DO_BATCH_EXTRACT } }).catch(function(){}); } catch (_) {}
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // 全消息桥到 SW：诊断 case 是否命中
    if (msg && msg.type !== 'CS_DBG') {
      try { chrome.runtime.sendMessage({ type: 'CS_DBG', stage: 'cs:onMessage', info: { rcvType: msg.type, isDoBatchExtract: msg.type === MSG.DO_BATCH_EXTRACT, isPing: msg.type === MSG.PING } }).catch(function(){}); } catch (_) {}
    }
    if (msg.type === MSG.PING) {
      sendResponse({ type: MSG.PONG });
      return true;
    }

    switch (msg.type) {
      case MSG.DO_COLLECT:
        handleCollect(msg.params).then(
          (result) => sendResponse({ success: true, ...result }),
          (e) => sendResponse({ success: false, error: e.message })
        );
        return true;

      case MSG.DO_SEND:
        handleSend(msg.jobIds).then(
          (result) => sendResponse({ success: true, ...result }),
          (e) => sendResponse({ success: false, error: e.message })
        );
        return true;

      case MSG.DO_START_CHAT:
        // v5: 搜索页点"立即沟通"，返回 HR 信息
        handleStartChat(msg).then((result) => {
          sendResponse(result);
        }, (e) => {
          sendResponse({ success: false, error: e.message });
        });
        return true;

      case MSG.DO_SEND_CHAT:
        // v5: 聊天页匹配对话 + 发送消息
        handleSendChat(msg).then(
          (result) => sendResponse(result),
          (e) => sendResponse({ success: false, error: e.message })
        );
        return true;

      case MSG.DO_STOP:
        try { if (typeof DiagLogger !== 'undefined') DiagLogger.info('cs.flow', 'DO_STOP 到达，停止本页采集/发送'); } catch (_) {}
        if (typeof JobCollector !== 'undefined') JobCollector.stopped = true;
        if (typeof JobSender !== 'undefined') JobSender.stop();
        if (typeof ChatListMonitor !== 'undefined') ChatListMonitor.stop();
        sendResponse({ success: true });
        break;

      case MSG.OPEN_JOB_DETAIL:
        // popup 点岗位卡「查看JD」：按 encryptJobId 在左侧列表唯一定位对应卡并点击展开 JD（不投递）。
        // 唯一 ID 优先（findCardByLink 内部按 jobId 子串匹配 href），拿不到再用 name+company 文本降级。
        try {
          var _jl = msg.jobId ? ('/' + msg.jobId + '.html') : '';
          var _card = null;
          if (_jl) _card = JobClicker.findCardByLink(_jl);
          if (!_card && msg.jobName && msg.company) _card = JobClicker.findCardByText(msg.jobName, msg.company);
          if (!_card) { sendResponse({ success: false, error: '未在左侧列表找到该岗位（可能已翻页/被过滤）' }); break; }
          _card.scrollIntoView({ block: 'center', behavior: 'smooth' });
          // 点整张卡（li.job-card-box）才会驱动右侧详情面板渲染 JD——与 clickImmediateChat 的有效点击一致。
          // 之前点 .job-name（span，非链接）无任何导航/展开效果，故「查看JD详情」不生效。
          _card.click();
          sendResponse({ success: true });
        } catch (e) {
          sendResponse({ success: false, error: e.message });
        }
        break;

      case MSG.DO_BATCH_EXTRACT:
        console.log('[即投] DO_BATCH_EXTRACT 到达 CS, queueLen:', msg.queue?.length, 'url:', location.href);
        _persistDiag('DO_BATCH_EXTRACT:rcv', { queueLen: msg.queue?.length, url: location.href });
        handleBatchExtract(msg).then(
          (result) => sendResponse(result),
          (e) => sendResponse({ success: false, error: e.message })
        );
        return true;

      case MSG.WORKER_SEND:
        handleWorkerSend(msg).then(
          (result) => sendResponse(result),
          (e) => sendResponse({ success: false, error: e.message })
        );
        return true;

      case MSG.CONFIRM_CHANGE_JOB_DIALOG:
        // #39 阶段1跳转恢复：SW 指派消息页 CS 点「沟通新职位」确认弹窗
        confirmChangeJobDialog().then(
          (result) => sendResponse(result),
          (e) => sendResponse({ clicked: false, reason: 'error:' + e.message })
        );
        return true;

      case MSG.QUEUE_EMPTY:
        // 不再自动关闭 tab — 留给用户手动关闭，确保消息有充足时间发送完毕
        return;

      case MSG.GET_BOSS_UID:
        // P2: 取当前登录 BOSS 账号 encryptUserId（免费额度绑账号，堵重装白嫖）
        handleGetBossUid().then(
          (result) => sendResponse(result),
          (e) => sendResponse({ ok: false, reason: 'error:' + e.message })
        );
        return true;

      case MSG.CHECK_GREETING_SETTING:
        // pre-flight: 读 BOSS「自动打招呼」开关状态（CS 同源 fetch 带 cookie）
        handleCheckGreetingSetting().then(
          (result) => sendResponse(result),
          (e) => sendResponse({ success: false, error: e.message })
        );
        return true;

      case MSG.ENABLE_GREETING_SETTING:
        // pre-flight: API 写开（status=1）+ getGreetingList 复读自检
        handleEnableGreetingSetting(msg.templateId).then(
          (result) => sendResponse(result),
          (e) => sendResponse({ ok: false, error: e.message })
        );
        return true;

      case MSG.DISABLE_GREETING_SETTING:
        // 详情派 pre-flight：关 BOSS 自动打招呼（status=0），避免点立即沟通时 BOSS 自动发模板招呼
        handleDisableGreetingSetting(msg.templateId).then(
          (result) => sendResponse(result),
          (e) => sendResponse({ ok: false, error: e.message })
        );
        return true;

      case MSG.DETAIL_CLICK_CHAT:
        // 详情派：详情页点「立即沟通」(a.btn-startchat) → 整页导航到 chat
        handleDetailClickChat(msg).then(
          (result) => sendResponse(result),
          (e) => sendResponse({ ok: false, reason: 'error:' + e.message })
        );
        return true;

      case MSG.DETAIL_CHECK_CHAT_BTN:
        // F2 超时救济：只读详情页「立即沟通」按钮文案（不点击），判会话是否已建
        handleDetailCheckChatBtn(msg).then(
          (result) => sendResponse(result),
          (e) => sendResponse({ ok: false, error: e.message })
        );
        return true;

      case MSG.CHAT_SEND_ON_OPEN:
        // 详情派：导航到 chat 后会自动开该岗 HR 会话 → 关弹窗 + 等输入框 + sendSingle 发招呼语
        handleChatSendOnOpen(msg).then(
          (result) => sendResponse(result),
          (e) => sendResponse({ ok: false, error: e.message })
        );
        return true;

      case 'READ_JD':
        // JD 定制招呼语：SW 已把后台 tab 导航到本岗 /job_detail/ 页，本 case 直接读整页 JD 正文回传。
        // 节奏（3s/张串行）+ 导航全归 SW 编排。用字符串字面量比较，不依赖 MSG 常量落地（同 COLLECT_JD 旧式）。
        handleReadJd(msg).then(
          (result) => sendResponse(result),
          (e) => sendResponse({ ok: false, jobId: msg && msg.jobId, reason: 'error:' + (e && e.message) })
        );
        return true;

      case MSG.B3_HEADHUNTER_PROBE:
        // 猎头岗活跃度探测：逐个点采集 tab 真卡 → detail.json 抓分级活跃度 → 判定回传 B3_HEADHUNTER_RESULT。
        handleB3HeadhunterProbe(msg).then(
          (result) => sendResponse(result),
          (e) => sendResponse({ ok: false, error: e.message })
        );
        return true;

      case 'GET_ERROR_LOG':
        if (typeof ErrorLogger !== 'undefined') {
          ErrorLogger.getErrors()
            .then(errors => sendResponse({ success: true, errors }))
            .catch(() => sendResponse({ success: false, error: 'Failed to read error log' }));
        } else {
          sendResponse({ success: false, error: 'ErrorLogger not available' });
        }
        return true;
    }
  });

  // ── 路由 ──
  if (href.includes('/web/geek/jobs')) {
    console.log('[即投] 岗位搜索页已就绪 (v5 双页并行)');
  } else if (href.includes('/web/geek/chat')) {
    if (typeof ChatListMonitor !== 'undefined') ChatListMonitor.start();
    console.log('[即投] 聊天页已就绪 (v5 双页并行)');
  } else if (href.includes('/job_detail/')) {
    console.log('[即投] 岗位详情页已就绪');
  }

  // ── 通知 SW：CS 注入完成（携带角色信息）──
  var role = '';
  if (href.includes('/web/geek/jobs')) {
    role = 'search';
  } else if (href.includes('/web/geek/chat')) {
    role = 'worker';
  }
  try { if (typeof DiagLogger !== 'undefined' && role) DiagLogger.info('cs.flow', 'CS 就绪 role=' + role + ' path=' + location.pathname); } catch (_) {}
  chrome.runtime.sendMessage({ type: MSG.CS_READY, url: href, role: role }).catch(() => {});
})();

// ── 处理收集 ──
async function handleCollect(params) {
  const result = await runCollection(params, (progress) => {
    chrome.runtime.sendMessage({ type: MSG.COLLECT_PROGRESS, ...progress });
  });
  chrome.runtime.sendMessage({
    type: MSG.JOBS_COLLECTED,
    jobs: result.jobs,
    clusters: result.clusters,
    jdSamples: result.jdSamples,
  });
  return result;
}

// ── 处理发送（按 jobIds 逐个调用 sendSingle）──
async function handleSend(jobIds) {
  const stateResp = await chrome.runtime.sendMessage({ type: MSG.GET_STATE });
  const { greetings, jobs } = stateResp.state;
  let sent = 0, failed = 0;
  for (const id of jobIds) {
    const job = jobs.find((j) => j.id === id);
    const category = job?.tags?.[0] || '其他';
    const greeting = greetings[category] || '';
    try {
      const result = await JobSender.sendSingle(greeting, id);
      if (result.success) sent++; else failed++;
      chrome.runtime.sendMessage({
        type: MSG.SEND_ITEM_RESULT,
        payload: { jobId: id, ...result },
      }).catch(() => {});
      chrome.runtime.sendMessage({
        type: MSG.SEND_PROGRESS,
        payload: { sent, failed, total: jobIds.length, current: id },
      }).catch(() => {});
      if (result.captchaDetected) break;
    } catch (e) {
      failed++;
      if (typeof ErrorLogger !== 'undefined') { ErrorLogger.logError(e.message, e.stack, 'handleSend'); }
      chrome.runtime.sendMessage({
        type: MSG.SEND_ITEM_RESULT,
        payload: { jobId: id, success: false, error: e.message },
      }).catch(() => {});
      chrome.runtime.sendMessage({
        type: MSG.SEND_PROGRESS,
        payload: { sent, failed, total: jobIds.length, current: id },
      }).catch(() => {});
    }
  }
  const result = { sent, total: jobIds.length, failed };
  chrome.runtime.sendMessage({ type: MSG.SEND_COMPLETE, ...result }).catch(() => {});
  return result;
}

// ── v5: 搜索页点"立即沟通"，提取HR信息 ──
async function handleStartChat(msg) {
  try {
    const result = await JobClicker.clickImmediateChat(msg.jobLink, msg.positionName, msg.companyName);
    return result;
  } catch (e) {
    if (typeof ErrorLogger !== 'undefined') { ErrorLogger.logError(e.message, e.stack, 'handleStartChat'); }
    return { success: false, error: e.message };
  }
}

// ── v5: 聊天页匹配对话 + 发送消息 ──
async function handleSendChat(msg) {
  try {
    // v6: hrName 为空时直接返回，禁止盲目发送
    if (!msg.hrName) {
      return { success: false, error: 'HR名称为空，无法匹配对话' };
    }

    // 先等对话列表容器渲染（异步 AJAX 挂载），否则 findChatConversation 查到 0 节点。
    var listContainer = await waitForElement('.user-list-content', 10000);
    if (!listContainer) {
      return { success: false, error: '对话列表容器未加载' };
    }

    var conversation = findChatConversation(msg.hrName, msg.hrCompany);
    if (!conversation) {
      // 轮询等待：每 500ms 查一次，最多 5s
      for (var retry = 0; retry < 10 && !conversation; retry++) {
        await new Promise(function(r) { setTimeout(r, 500); });
        conversation = findChatConversation(msg.hrName, msg.hrCompany);
      }
    }
    if (!conversation) {
      return { success: false, error: '未找到对话: ' + msg.hrName + ' / ' + (msg.hrCompany || '') };
    }
    // 投递错位止血 #2：记录命中方式（fallback 高危，公司未验）
    var matchMode = conversation._jtMatchMode || 'exact';
    conversation.click();
    await new Promise(function(r) { setTimeout(r, 2000); });

    // fallback 命中 → 点开对话后、发送前做身份断言；不匹配/无法核验则不发，转失败（杜绝同名错投）
    if (matchMode === 'fallback') {
      var idn = assertOpenConversationIdentity(msg.hrName, msg.hrCompany);
      if (!idn.ok) {
        return { success: false, error: idn.cannotVerify ? '兜底命中无法核验对话身份，不发送' : '兜底命中身份断言失败（疑同名错投）：当前对话=' + (idn.openName || '?') + '/' + (idn.openCompany || '?'), identityAssertFailed: true };
      }
    }

    const result = await JobSender.sendSingle(msg.greeting, msg.jobId);
    chrome.runtime.sendMessage({
      type: MSG.SEND_ITEM_RESULT,
      payload: { jobId: msg.jobId, ...result },
    }).catch(() => {});
    return result;
  } catch (e) {
    if (typeof ErrorLogger !== 'undefined') { ErrorLogger.logError(e.message, e.stack, 'handleSendChat'); }
    return { success: false, error: e.message };
  }
}

// ── 详情派：详情页点「立即沟通」(a.btn-startchat) → BOSS 整页导航到 /web/geek/chat ──
// 与搜索页 clickImmediateChat 同款完整鼠标序列（BOSS Vue add friend handler 监 mousedown+mouseup+click，
// 单 click 不触发 friend/add.json）。点成功即将整页导航，CS 随即被摧毁，故只回 {ok:true} 不等导航。
// 已沟通（按钮文本「继续沟通」）→ 点了也只是跳转、不新建会话，判 skip 让 SW 跳过。
async function handleDetailClickChat(msg) {
  try {
    var chatBtn = await waitForElement(SELECTORS.jobDetail.detailStartChatBtn, 5000);
    if (!chatBtn) {
      _persistDiag('detail:clickChat:noBtn', { jobId: msg && msg.jobId });
      return { ok: false, reason: '未找到立即沟通按钮（a.btn-startchat）' };
    }
    var btnTxt = (chatBtn.textContent || '').trim();
    // F3-b：文本含「继续沟通」= 该 HR 此前已沟通过。仍照点——点击导航是唯一保证开对 HR 会话的路
    // （🔴 错投防护命根：绝不裸开 /web/geek/chat 靠列表猜会话）。标 alreadyChatted:true 让 SW 转给
    // CHAT_SEND_ON_OPEN 启用「补发守卫」（chat 页查我方消息，有则跳过、无则补发）。
    var _alreadyChatted = btnTxt.indexOf('继续沟通') >= 0;
    _persistDiag('detail:clickChat:beforeClick', { jobId: msg && msg.jobId, btnText: btnTxt, alreadyChatted: _alreadyChatted, url: location.href });
    var _mOpts = { bubbles: true, cancelable: true, view: window, button: 0 };
    chatBtn.dispatchEvent(new MouseEvent('mousedown', _mOpts));
    chatBtn.dispatchEvent(new MouseEvent('mouseup', _mOpts));
    chatBtn.dispatchEvent(new MouseEvent('click', _mOpts));
    return { ok: true, alreadyChatted: _alreadyChatted };
  } catch (e) {
    if (typeof ErrorLogger !== 'undefined') { ErrorLogger.logError(e.message, e.stack, 'handleDetailClickChat'); }
    return { ok: false, reason: 'error:' + e.message };
  }
}

// ── F2 超时救济：只读详情页「立即沟通」按钮文案（不点击），判会话是否已建（翻「继续沟通」）──
async function handleDetailCheckChatBtn(msg) {
  try {
    var chatBtn = await waitForElement(SELECTORS.jobDetail.detailStartChatBtn, 3000);
    if (!chatBtn) {
      return { ok: true, found: false, btnText: '', alreadyChatted: false };
    }
    var btnTxt = (chatBtn.textContent || '').trim();
    var alreadyChatted = btnTxt.indexOf('继续沟通') >= 0;
    _persistDiag('detail:checkChatBtn', { jobId: msg && msg.jobId, btnText: btnTxt, alreadyChatted: alreadyChatted });
    return { ok: true, found: true, btnText: btnTxt, alreadyChatted: alreadyChatted };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── 详情派：导航到 chat 后 BOSS 自动开该岗 HR 会话 → 关弹窗 + 等输入框 + 复用 sendSingle 发招呼语 ──
// 不生成招呼语（greeting 由 payload 给）。不重写发送原语，直接调 job-sender.js 的 sendSingle。
async function handleChatSendOnOpen(msg) {
  try {
    if (!msg || !msg.greeting) {
      return { ok: false, error: '招呼语为空，拒绝发送' };
    }
    // 关挡路弹窗（号码隐私保护「取消/确定」/「已向BOSS发送消息」等）— 复用共用关弹窗逻辑，不重写
    try { await closeBlockingDialogs(3); } catch (_) {}
    // 等输入框就绪：chatInput contenteditable=true（detail→chat 自动开会话后即就绪）
    var input = await waitForElement(SELECTORS.chatDetail.chatInput, 10000);
    if (!input || input.getAttribute('contenteditable') !== 'true') {
      _persistDiag('detail:sendOnOpen:noInput', { jobId: msg.jobId, hasInput: !!input });
      return { ok: false, status: 'failed', reason: '输入框未就绪（contenteditable!=true）' };
    }
    // F3-b 补发守卫：仅「继续沟通」/F2 恢复路径启用（guardAlreadySent）——查会话内有无我方已发消息，
    // 有则跳过（不重复打扰 HR，记成功-跳过），无则补发。正常新会话路径 guardAlreadySent=false，零改动零延迟。
    if (msg.guardAlreadySent) {
      var _sentCount = document.querySelectorAll(SELECTORS.chatDetail.messageSent).length;
      if (_sentCount > 0) {
        _persistDiag('detail:sendOnOpen:skipAlreadySent', { jobId: msg.jobId, sentCount: _sentCount });
        return { ok: true, status: 'skipped', alreadyChatted: true, note: '已沟通过，跳过' };
      }
      _persistDiag('detail:sendOnOpen:补发', { jobId: msg.jobId });
    }
    _persistDiag('detail:sendOnOpen:beforeSend', { jobId: msg.jobId });
    var result = await JobSender.sendSingle(msg.greeting, msg.jobId, msg.imgOpts);
    // v7 记账纯走 return 值（SW loop 据此调 recordV6Success/Failure）。
    // 🔴 不再发遗留 v5 SEND_ITEM_RESULT：v7 phase≠'sending' 致 SW 去重 guard 跳过 → 会 push 幻影条造成双重记账（e2e 实测选3记6）。
    return result;
  } catch (e) {
    if (typeof ErrorLogger !== 'undefined') { ErrorLogger.logError(e.message, e.stack, 'handleChatSendOnOpen'); }
    return { ok: false, error: e.message };
  }
}

// ── v6: 搜索页批量提取 HR 信息 ──
function _csDbg(stage, info) {
  try { chrome.runtime.sendMessage({ type: 'CS_DBG', stage: stage, info: info || {} }).catch(function(){}); } catch (_) {}
}

async function handleBatchExtract(msg) {
  var queue = msg.queue || [];
  if (typeof JobCollector !== 'undefined') JobCollector.stopped = false;
  if (typeof JobSender !== 'undefined') JobSender.stopped = false; // 新一批发送开始：重置硬中止标志，杜绝上一轮 stop 残留致本批 bail 不发文/图
  _csDbg('batchExtract:start', { queueLen: queue.length, url: location.href });
  console.log('[即投] handleBatchExtract: 开始，队列长度=', queue.length);
  var results = [];
  var skipped = [];
  var failed = [];
  var captchaDetected = false;
  var bossLimitHit = false; // #6：BOSS 今日沟通已达上限（点立即沟通弹限额弹窗）
  // #39 导航中止：哨兵置位或已不在岗位页（path 前缀判据，与 role=search 的 /web/geek/jobs 同源）
  // → 文档正在拆毁，继续跑全是假失败。≥0 即中止索引。
  var navAbortedAt = -1;
  var _navGone = function() {
    return _navAborting || location.pathname.indexOf('/web/geek/jobs') !== 0;
  };

  for (var i = 0; i < queue.length; i++) {
    // #39 检查点 1：每岗开始前——导航离开则中止，剩余岗不记 failed 不发 itemDone
    if (_navGone()) { navAbortedAt = i; break; }
    if (typeof JobCollector !== 'undefined' && JobCollector.stopped) {
      _csDbg('batchExtract:stopped', { i: i });
      break;
    }
    var item = queue[i];
    _csDbg('batchExtract:itemStart', { i: i, jobId: item.jobId, jobLink: item.jobLink, positionName: item.positionName });
    var tStart = Date.now();
    // #39 阶段1跳转恢复：逐岗结局快照（itemDone 上报用）
    var itemOutcome = { success: false, alreadyChatted: false, hrName: '', hrCompany: '', encBossId: '', securityId: '', jdText: '' };
    try {
      // 单 item 15s 硬 timeout 防永挂
      var clickResult = await Promise.race([
        JobClicker.clickImmediateChat(item.jobLink, item.positionName, item.companyName, msg.hrActiveFilter,
          { index: i, jobId: item.jobId, jobName: item.positionName }, // #39: beforeClick 进度上下文
          msg.restDayFilter, msg.welfareFilter, item.welfareConfirmed, item.daysPerWeekDesc), // 严格终判透传（双休①工作制字段/②标题正文；五险一金三路）
        new Promise(function(_, rej) { setTimeout(function() { rej(new Error('clickImmediateChat 15s timeout')); }, 15000); })
      ]);
      // #39 检查点 2：click 返回后——导航离开则本岗不记账不发 itemDone（SW 凭 beforeClick 知其在途）
      if (_navGone()) { navAbortedAt = i; break; }
      _csDbg('batchExtract:itemDone', { i: i, ms: Date.now() - tStart, success: clickResult.success, error: clickResult.error, hrName: clickResult.hrName });
      itemOutcome.success = !!clickResult.success;
      itemOutcome.alreadyChatted = !!clickResult.alreadyChatted;
      itemOutcome.hrName = clickResult.hrName || '';
      itemOutcome.hrCompany = clickResult.hrCompany || '';
      itemOutcome.encBossId = clickResult.encBossId || '';
      itemOutcome.securityId = clickResult.securityId || '';
      itemOutcome.jdText = clickResult.jdText || ''; // #4：随建联结果带回该岗 JD 正文（用完即弃）
      if (clickResult.success && clickResult.hrName) {
        results.push({
          jobId: item.jobId,
          hrName: clickResult.hrName,
          hrCompany: clickResult.hrCompany,
          greeting: item.greeting,
          positionName: item.positionName,
          companyName: item.companyName,
          alreadyChatted: !!clickResult.alreadyChatted,
          encBossId: clickResult.encBossId || '',
          securityId: clickResult.securityId || '',
          jdText: clickResult.jdText || '', // #4：JD 正文 → stage2 worker 发送前实时生成定制招呼语
        });
      } else if (clickResult.skipped) {
        skipped.push({ jobId: item.jobId, activeDesc: clickResult.activeDesc, skipReason: clickResult.skipReason, restDayDesc: clickResult.restDayDesc, welfareDesc: clickResult.welfareDesc });
      } else if (clickResult.bossLimitReached) {
        // #6 BOSS 今日沟通已达上限：本岗及之后所有岗都建联不了，标记本岗+剩余岗为达上限失败，停止 stage1。
        // 已建联成功的岗位（已在 results 里）照常进 stage2 发招呼语+简历图，绝不被本失败中断。
        var _limitMsg = clickResult.error || '因今日投递数量已达 BOSS 上限 150';
        failed.push({ jobId: item.jobId, error: _limitMsg, bossLimitReached: true });
        for (var _lr = i + 1; _lr < queue.length; _lr++) {
          failed.push({ jobId: queue[_lr].jobId, error: _limitMsg, bossLimitReached: true });
        }
        bossLimitHit = true;
        _csDbg('batchExtract:bossLimit', { i: i, remaining: queue.length - i - 1 });
        break;
      } else {
        // 提取失败（非 skip）：带原因回传，不再静默丢弃
        failed.push({ jobId: item.jobId, error: clickResult.error || '未能在搜索页找到该岗位卡片' });
      }
      // 检测验证码
      if (typeof detectCaptcha === 'function') {
        var captcha = detectCaptcha();
        if (captcha.detected) {
          _csDbg('batchExtract:captcha', { i: i });
          captchaDetected = true;
          chrome.runtime.sendMessage({ type: MSG.CAPTCHA_DETECTED }).catch(function(){});
          break;
        }
      }
    } catch (e) {
      // #39 检查点 2'：异常返回路径同检——拆毁中 DOM 抛错即假失败，不记 failed 不发 itemDone
      if (_navGone()) { navAbortedAt = i; break; }
      _csDbg('batchExtract:itemError', { i: i, ms: Date.now() - tStart, msg: e.message });
      if (typeof ErrorLogger !== 'undefined') {
        ErrorLogger.logError(e.message, e.stack, 'handleBatchExtract item=' + i);
      }
      failed.push({ jobId: item.jobId, error: e.message });
    }

    // #39 阶段1跳转恢复：逐岗 itemDone 上报（fire-and-forget，SW 未应答也绝不阻塞循环）
    try {
      chrome.runtime.sendMessage({
        type: MSG.EXTRACT_PROGRESS,
        index: i,
        jobId: item.jobId,
        jobName: item.positionName,
        hrName: itemOutcome.hrName,
        hrCompany: itemOutcome.hrCompany,
        encBossId: itemOutcome.encBossId,
        securityId: itemOutcome.securityId,
        jdText: itemOutcome.jdText, // #4：JD 正文随逐岗 itemDone 带回（与 EXTRACT_COMPLETE 同字段，merge 幂等）
        stage: 'itemDone',
        success: itemOutcome.success,
        alreadyChatted: itemOutcome.alreadyChatted,
      }).catch(function(){});
    } catch (_) {}

    chrome.runtime.sendMessage({
      type: MSG.EXTRACT_PROGRESS,
      done: i + 1,
      total: queue.length,
      extracted: results.length,
    }).catch(function(){});
  }

  // #39 导航中止收尾：绝不发 EXTRACT_COMPLETE（发了 = SW stage1 假结算 + 假失败入 _stage1DoneJobIds），
  // 直接 return 交 SW 恢复环重发剩余队列。已完成岗位的 itemDone 已逐岗发出，SW 侧记账不丢。
  if (navAbortedAt >= 0) {
    var navRemaining = queue.length - navAbortedAt;
    try { if (typeof DiagLogger !== 'undefined') DiagLogger.warn('cs.flow', '[#39] 检测到页面导航离开，批处理中止于 index=' + navAbortedAt + '，剩余 ' + navRemaining + ' 岗交恢复环重发'); } catch (_) {}
    _persistDiag('batchExtract:navAbort', { index: navAbortedAt, remaining: navRemaining, path: location.pathname, sentinel: _navAborting });
    _csDbg('batchExtract:navAbort', { index: navAbortedAt, remaining: navRemaining });
    return { success: false, navAborted: true, abortedAt: navAbortedAt };
  }

  _csDbg('batchExtract:complete', { resultsLen: results.length, captcha: captchaDetected, url: location.href });
  chrome.runtime.sendMessage({
    type: MSG.EXTRACT_COMPLETE,
    success: true,
    results: results,
    skipped: skipped,
    failed: failed,
    captchaDetected: captchaDetected,
    bossLimitReached: bossLimitHit, // #6：达上限信号 → SW 停止剩余 tab 建联
  }).catch(function(){});
  return { success: true, results: results, skipped: skipped, failed: failed, captchaDetected: captchaDetected, bossLimitReached: bossLimitHit };
}


// ── v6: 聊天页 worker 发送（在 CDP 点击后调用）──
async function handleWorkerSend(msg) {
  var job = msg.job || {};
  var jobId = job.jobId;
  console.log('[即投] handleWorkerSend: 开始发送，greeting长度=' + (job.greeting || '').length);
  try {
    // worker 阶段 fail-fast：文字 3s 图片 4s 各单次不重试，未确认即转补发队列。
    // 旧版 sendText 死等 8s + 重试 3 次 = ~28s/岗位 → 招呼语发 3 次（errorLog 实证 baseline=4）；
    // sendImage 同款 3 次重试。worker 阶段抢同账号 WS，重试纯浪费——补发兜底（单连接干净环境）。
    var sendResult = await JobSender.sendSingle(
      job.greeting, jobId,
      { timeoutMs: 4000, maxAttempts: 1 },  // imgOpts
      { timeoutMs: 3000, maxAttempts: 1 }   // textOpts
    );
    console.log('[即投] handleWorkerSend: sendSingle 结果', sendResult);
    return { success: true, jobId: jobId, positionName: job.positionName, companyName: job.companyName, ...sendResult };
  } catch (e) {
    return { success: false, jobId: jobId, error: e.message };
  }
}

// ════════════════════════════════════════════════════════════════
// 招呼语开关 pre-flight（陷阱 #31）：投递前确认 BOSS「自动打招呼」开关已开
// 开关关闭时点「立即沟通」会整页跳 /web/geek/chat → stage1 卡死，必须先开。
// fetch 由搜索页 CS 执行：同源带 cookie、且能 document.cookie 读 bst（非 HttpOnly）。
// ════════════════════════════════════════════════════════════════

// 读开关：GET getGreetingList → zpData.greeting.{enabled, templateId}
async function _fetchGreetingSetting() {
  var resp = await fetch('https://www.zhipin.com/wapi/zpchat/greeting/getGreetingList', {
    credentials: 'include',
  });
  var data = await resp.json();
  var g = data && data.zpData && data.zpData.greeting;
  if (!g || typeof g.enabled !== 'boolean') {
    throw new Error('getGreetingList 响应缺 greeting.enabled (code=' + (data && data.code) + ')');
  }
  return { enabled: g.enabled, templateId: g.templateId };
}

async function handleCheckGreetingSetting() {
  try {
    var g = await _fetchGreetingSetting();
    return { success: true, enabled: g.enabled, templateId: g.templateId };
  } catch (e) {
    // 读失败（网络/接口变更）→ SW 侧视为 enabled 未知，放行投递（宁可少拦截不可误拦截）
    return { success: false, error: e.message };
  }
}

function _readCookie(name) {
  var m = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : '';
}

// ════════════════════════════════════════════════════════════════
// P2 免费额度绑 BOSS 账号：取当前登录账号的 encryptUserId
// 账号身份 cookie（wt2/zp_at）是 HttpOnly，JS 读不到；但同源 fetch credentials:'include'
// 会自动带上 → getUserInfo.json 返回账号级 encryptUserId（换号即变、换设备不变）。
// ISOLATED world 即可（无需 MAIN），与 _fetchGreetingSetting 同款模式。
// 🔴 取不到一律返回 ok:false，SW 侧降级回 device_id 计额度、绝不拦截投递。
// ════════════════════════════════════════════════════════════════
async function _fetchBossUidOnce() {
  var resp = await fetch('https://www.zhipin.com/wapi/zpuser/wap/getUserInfo.json', {
    credentials: 'include',
  });
  var data = await resp.json();
  var z = data && data.zpData;
  if (!z || !z.encryptUserId) {
    throw new Error('getUserInfo 响应缺 encryptUserId (code=' + (data && data.code) + ')');
  }
  return String(z.encryptUserId);
}

async function handleGetBossUid() {
  // 实测偶发一次空 body（瞬时反爬抖动），重试 1 次即得。
  for (var i = 0; i < 2; i++) {
    try {
      var uid = await _fetchBossUidOnce();
      return { ok: true, bossUid: uid };
    } catch (e) {
      if (i === 1) return { ok: false, reason: 'error:' + (e && e.message) };
      await sleep(500);
    }
  }
  return { ok: false, reason: 'unreachable' };
}

// 写开关（只写 status=1，绝不写 status=0）+ 复读自检。
// zp_token = cookie bst 原值；traceId BOSS 不校验内容，随机串即可。实测 ~0.5s 生效。
async function handleEnableGreetingSetting(templateId) {
  try {
    var bst = _readCookie('bst');
    if (!bst) return { ok: false, error: '未读到 bst cookie（zp_token 缺失）' };
    var body = 'status=1&templateId=' + encodeURIComponent(templateId == null ? '' : templateId);
    await fetch('https://www.zhipin.com/wapi/zpchat/greeting/updateGreetingV2', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
        'zp_token': bst,
        'traceId': 'F-' + Math.random().toString(36).slice(2, 12).toUpperCase(),
      },
      body: body,
    });
    // 写后必须复读 enabled 自检（updateGreetingV2 响应不可全信，以 getGreetingList 为准）
    await sleep(600);
    var g = await _fetchGreetingSetting();
    if (g.enabled) return { ok: true, enabled: true };
    // 一次复读未生效 → 再等 1s 复读一次兜底（实测 0.5s 生效，1.6s 仍 false 即判失败走降级）
    await sleep(1000);
    g = await _fetchGreetingSetting();
    return { ok: !!g.enabled, enabled: g.enabled };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// 关开关（status=0）+ 复读自检。详情派 pre-flight：点立即沟通前关 BOSS 自动打招呼，
// 避免 BOSS 抢先自动发模板招呼（详情派要发自己的 AI 招呼语）。handleEnableGreetingSetting 的镜像。
async function handleDisableGreetingSetting(templateId) {
  try {
    var bst = _readCookie('bst');
    if (!bst) return { ok: false, error: '未读到 bst cookie（zp_token 缺失）' };
    var body = 'status=0&templateId=' + encodeURIComponent(templateId == null ? '' : templateId);
    await fetch('https://www.zhipin.com/wapi/zpchat/greeting/updateGreetingV2', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
        'zp_token': bst,
        'traceId': 'F-' + Math.random().toString(36).slice(2, 12).toUpperCase(),
      },
      body: body,
    });
    // 写后复读 enabled 自检（以 getGreetingList 为准）
    await sleep(600);
    var g = await _fetchGreetingSetting();
    if (!g.enabled) return { ok: true, enabled: false };
    await sleep(1000);
    g = await _fetchGreetingSetting();
    return { ok: !g.enabled, enabled: g.enabled };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
