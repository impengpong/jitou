// ════════════════════════════════════════════════════════════
// 即投 — 统一常量（单一真相源）
// ════════════════════════════════════════════════════════════

// ── 消息类型常量（popup ↔ background ↔ content） ──
const MSG = {
  // Popup → SW
  GET_STATE: 'GET_STATE',
  SAVE_MUTABLE_STATE: 'SAVE_MUTABLE_STATE',
  START_COLLECT: 'START_COLLECT',
  STOP_COLLECT: 'STOP_COLLECT',
  START_SEND: 'START_SEND',
  STOP_SEND: 'STOP_SEND',
  REGENERATE_GREETING: 'REGENERATE_GREETING',
  UPDATE_GREETING: 'UPDATE_GREETING',
  REWRITE_GREETING: 'REWRITE_GREETING',
  GET_API_KEY: 'GET_API_KEY',
  SAVE_API_KEY: 'SAVE_API_KEY',
  OPEN_JOB_DETAIL: 'OPEN_JOB_DETAIL', // popup 点岗位卡「查看JD」→ SW 转搜索页 CS：按 encryptJobId 定位左侧卡并点击展开详情（不投递）
  TRACK_EVENT: 'TRACK_EVENT',         // popup -> SW: 商业化埋点统一出口（{event, meta}）；SW 附 device_id/ext_version 后 fire-and-forget 上报后端 /track（CS 不用，无需镜像 selectors.js）

  // SW → Popup
  STATE_UPDATE: 'STATE_UPDATE',
  ERROR: 'ERROR',

  // Content → SW
  JOBS_COLLECTED: 'JOBS_COLLECTED',
  COLLECT_PROGRESS: 'COLLECT_PROGRESS',
  COLLECT_CITY_PROGRESS: 'COLLECT_CITY_PROGRESS',
  SEND_PROGRESS: 'SEND_PROGRESS',
  SEND_ITEM_RESULT: 'SEND_ITEM_RESULT',
  SEND_COMPLETE: 'SEND_COMPLETE',
  CHAT_DETECTED: 'CHAT_DETECTED',
  AUTO_REPLY_SENT: 'AUTO_REPLY_SENT',
  JD_FETCHED: 'JD_FETCHED',
  PONG: 'PONG',

  // SW → Content
  DO_COLLECT: 'DO_COLLECT',
  DO_SEND: 'DO_SEND',
  DO_STOP: 'DO_STOP',
  PING: 'PING',

  // v5 发送架构
  DO_START_CHAT: 'DO_START_CHAT',       // v5: SW -> CS(搜索页): 启动聊天流程
  DO_SEND_CHAT: 'DO_SEND_CHAT',         // v5: SW -> CS(聊天页): 发送消息
  CS_READY: 'CS_READY',                 // CS -> SW: CS 注入完成，就绪信号

  // v6 发送架构
  QUEUE_EMPTY: 'QUEUE_EMPTY',
  DO_BATCH_EXTRACT: 'DO_BATCH_EXTRACT',
  EXTRACT_PROGRESS: 'EXTRACT_PROGRESS',
  EXTRACT_COMPLETE: 'EXTRACT_COMPLETE',
  WORKER_SEND: 'WORKER_SEND',
  WORKER_RESULT: 'WORKER_RESULT',

  // v7 详情派 send-on-open 串行投递架构（替代 v6 并行；逐岗：详情页→点立即沟通→整页跳 chat→发自己 AI 招呼语）
  DETAIL_CLICK_CHAT: 'DETAIL_CLICK_CHAT',   // SW -> CS(详情页 /job_detail): 点「立即沟通」，payload {jobId}，回 {ok:true}（即将整页导航到 chat）或 {ok:false, reason}（🔴 必须镜像 selectors.js）
  CHAT_SEND_ON_OPEN: 'CHAT_SEND_ON_OPEN',   // SW -> CS(聊天页 /web/geek/chat): 在刚打开的会话里发招呼语，payload {jobId, greeting, imgOpts}，回 sendSingle 结果 {ok, status, reason}（🔴 必须镜像 selectors.js）
  DISABLE_GREETING_SETTING: 'DISABLE_GREETING_SETTING', // SW -> CS(zhipin 任一页): updateGreetingV2 status=0 关 BOSS 自动招呼语（详情派要关，避免点立即沟通双发默认语），回 {ok, enabled}（🔴 必须镜像 selectors.js；CS 半未实现则降级跳过，见 startSendV7 preflight）
  DETAIL_CHECK_CHAT_BTN: 'DETAIL_CHECK_CHAT_BTN', // SW -> CS(详情页 /job_detail): F2 超时救济——只读 a.btn-startchat 文案不点击，回 {ok, found, btnText, alreadyChatted}（翻「继续沟通」=会话已建、导航丢）（🔴 必须镜像 selectors.js）

  // #39 阶段1跳转恢复：同 HR 新岗位点立即沟通后 BOSS 整页跳 /web/geek/chat，确认弹窗弹在消息页
  CONFIRM_CHANGE_JOB_DIALOG: 'CONFIRM_CHANGE_JOB_DIALOG', // SW -> 消息页 CS: 点「沟通新职位」确认钮，响应 {clicked, reason}（🔴 必须镜像 selectors.js）

  // CAPTCHA
  CAPTCHA_DETECTED: 'CAPTCHA_DETECTED',

  // 招呼语开关 pre-flight（陷阱 #31：BOSS「自动打招呼」开关关闭 → 点立即沟通整页跳转 → stage1 卡死）
  CHECK_GREETING_SETTING: 'CHECK_GREETING_SETTING',   // SW -> CS(搜索页): 读 getGreetingList，返回 {success, enabled, templateId}（🔴 必须镜像 selectors.js）
  ENABLE_GREETING_SETTING: 'ENABLE_GREETING_SETTING', // SW -> CS(搜索页): updateGreetingV2 写开+复读自检，返回 {ok, enabled}（🔴 必须镜像 selectors.js）
  GREETING_AUTO_ENABLED: 'GREETING_AUTO_ENABLED',     // SW -> Popup: 已自动开启打招呼开关的非阻断提示（CS 不用，无需镜像 selectors.js）
  GET_DAILY_SEND_COUNT: 'GET_DAILY_SEND_COUNT',       // Popup -> SW: 读当天（本地自然日）已成功投递岗位数，投递前 gate 用（CS 不用，无需镜像 selectors.js）

  // #1 JD 定制招呼语：B 页静默预取 JD → 流水线生成定制招呼语
  COLLECT_JD: 'COLLECT_JD',                 // SW -> CS(搜索页 /web/geek/jobs): 合成点卡读 DOM 取该岗 JD 全文，请求 {jobId, jobLink}，回 {ok:true,jobId,jdText} 或 {ok:false,jobId,reason}（🔴 必须镜像 selectors.js）
  START_JD_PREFETCH: 'START_JD_PREFETCH',   // Popup -> SW: 进 B 页选好前 75 岗后启动 JD 预取，请求 {jobs:[{jobId,jobLink,category},...≤75]}，回 ack {ok:true,total:N}
  JD_PROGRESS: 'JD_PROGRESS',               // SW -> Popup(广播): 单岗定制招呼语就绪，{jobId, greeting, ok, done, total, degraded}（popup 负责落盘 ui:jobCustom + 编辑守护）
  CANCEL_JD_PREFETCH: 'CANCEL_JD_PREFETCH', // Popup -> SW: 取消所有在途 JD 预取（换选区/退出 B 页），回 {ok:true}

  // HR 活跃度前置过滤 · B3 猎头支线：独立页不渲活跃度，唯一途径=点采集 tab 真卡自发 detail.json 抓 activeTimeDesc
  B3_HEADHUNTER_PROBE: 'B3_HEADHUNTER_PROBE',   // SW -> CS(搜索页 /web/geek/jobs): 逐个点猎头岗真卡触发 detail.json 拿分级活跃度，请求 {jobIds:[encryptJobId...], hrActiveFilter}，回 {ok:true,count}（🔴 必须镜像 selectors.js）
  B3_HEADHUNTER_RESULT: 'B3_HEADHUNTER_RESULT', // CS -> SW: 猎头岗活跃度探测结果 {results:[{jobId,excluded,desc}...]}，SW 对 excluded 岗复用 JD_PROGRESS excluded 出口置灰取消勾选（🔴 必须镜像 selectors.js：content.js 发送时引用 selectors 副本的 MSG，缺键则 type=undefined 发不出）

  // P2 免费额度绑 BOSS 账号（堵重装换 device_id 白嫖）
  GET_BOSS_UID: 'GET_BOSS_UID',   // SW -> CS(zhipin 任一页): 同源 fetch getUserInfo.json 取 zpData.encryptUserId，回 {ok:true,bossUid} 或 {ok:false,reason}（🔴 必须镜像 selectors.js）
  // 付费订单绑 BOSS 账号：popup -> SW 取 boss_uid（popup 无法直接调 getBossUidSafe/发 CS）。回 {bossUid:string}（取不到为 ''）。
  // 仅 popup<->SW，content script 不发此消息，故无需镜像 selectors.js。
  GET_SW_BOSS_UID: 'GET_SW_BOSS_UID',
};

// ── Storage key 白名单（sw:/ui: 前缀隔离） ──
const STORAGE_KEYS = {
  // Service Worker 持久化（sw: 前缀）
  SW: {
    STATE: 'sw:state',
    API_KEY: 'sw:apiKey',
    TEXT_RESUME: 'sw:textResume',
    PHASE: 'sw:phase',
    JOBS: 'sw:jobs',
    GREETINGS: 'sw:greetings',
    SEND_PROGRESS: 'sw:sendProgress',
    SENT_JOB_IDS: 'sw:sentJobIds',
    SEND_RESULTS: 'sw:sendResults',
    SEND_DURATION: 'sw:sendDuration',
    SEARCH_URL: 'sw:searchUrl',
    PENDING_GREETING: 'sw:pendingGreeting',
    PENDING_JOB_ID: 'sw:pendingJobId',
    SEND_QUEUE_V6: 'sw:sendQueueV6',
    SEND_QUEUE_INDEX: 'sw:sendQueueIndex',
    SEND_PHASE: 'sw:sendPhase',
    SELECTED_POSITIONS: 'sw:selectedPositions',
    CUSTOM_POSITIONS: 'sw:customPositions',
    MISSED_JOBS: 'sw:missedJobs',
    DAILY_SEND_COUNT: 'sw:dailySendCount',  // 投递数量闸门：{date:'YYYY-MM-DD', count:N}，本地自然日成功投递岗位数，跨日归零
    CAPTCHA_LOG: 'sw:captchaLog',           // 风控退避：12h 滚动窗口内 captcha 触发时间戳数组 [ts,...]，自适应降速/停投用
    LAST_SNAPSHOT: 'sw:lastSnapshot',       // 诊断旁路：每次 persistState 落盘的内存态快照摘要（脱敏），SW 卸载后导出仍有基本完整快照
    BOSS_UID: 'sw:bossUid',                 // P2 免费额度绑 BOSS 账号：{uid:'encryptUserId', ts:毫秒}，CS 取不到时的兜底缓存（TTL 见 SW getBossUidSafe）
    JD_GEN_COUNT: 'sw:jdGenCount',           // #1 JD 定制招呼语天花板：{date:'YYYY-MM-DD', count:N}，本地自然日已生成定制招呼语数，跨日归零（防滥用）
  },
  // 诊断滚动持久化（diag: 前缀）—— 与 SW 内存态解耦，新任务清内存也不丢
  DIAG: {
    RECENT_RUNS: 'diag:recentRuns',         // ring buffer：最近 5 次投递任务结束时的完整诊断摘要（含时间戳/sendResults/snapshot）
    MEMBER_ID: 'diag:memberId',             // 服务端下发的固定会员ID（仅展示/诊断关联）
    ACTIVE_RUN: 'diag:activeRun',           // 当前诊断 run；SW 重启只恢复记录，绝不据此重放任务
    LAST_ABNORMAL_RUN: 'diag:lastAbnormalRun', // 最近失败/中断 run，客服关联不被新子 run 覆盖
    EVENT_OUTBOX: 'diag:eventOutbox',       // 有界诊断事件补传队列（只补事件，不是业务真相源）
  },
  // UI / Popup 持久化（ui: 前缀）
  UI: {
    LAST_CITY: 'ui:lastCity',
    FILTER_STATE: 'ui:filterState',
    GROUP_EXPANDED: 'ui:groupExpanded',
    JOB_CUSTOM: 'ui:jobCustom',
    // 自定义招呼语三层（与 jobCustom 的 AI 机制隔离，各自独立持久化 + popup 重开显式恢复）
    GLOBAL_GREET: 'ui:globalGreet',   // string：全局-自定义招呼语文本
    GROUP_GREET: 'ui:groupGreet',     // {[position]:{mode:'ai'|'custom',text}}：组 key 走 matchJobToExpected 的 g.position
    JOB_GREET: 'ui:jobGreet',         // {[jobId]:{mode:'ai'|'custom',text}}：岗位级模式覆盖 + 单岗位-自定义招呼语文本
  },
};

// ── 出厂兜底招呼语（P1 终稿，写死；三层自定义招呼语全空时发它）──
// 关联 UI：全局层 placeholder 尾部内联同一句（render-b.js renderGlobalGreetBlock），改这里须同步 placeholder。
const FACTORY_DEFAULT_GREETING = '您好，我对这个岗位很感兴趣，我的经历与岗位要求比较匹配，已附上简历，期待与您进一步沟通。';

// ── 全局配置参数 ──
const CONFIG = {
  // 每组分组的最大岗位数
  MAX_JOBS_PER_GROUP: 6,
  // AI 招呼语生成超时（ms）。组级 race 预算：后端带简历图 OCR 本就 5-8s、qwen3.7 更慢，8s 太紧频超时；给 25s 兜底。
  GREETING_TIMEOUT_MS: 25000,
  // AI 招呼语并发数
  GREETING_CONCURRENCY: 3,
  // 采集/发送批处理大小
  BATCH_SIZE: 50,
  // 发送间隔下限（ms）
  SEND_INTERVAL_MIN_MS: 2000,
  // 发送间隔上限（ms）
  SEND_INTERVAL_MAX_MS: 4000,
  // 批次间休息时间（ms）
  BATCH_REST_MS: 90000,
  // 最大采集标签页数
  MAX_COLLECT_TABS: 2,
  // 简历图片最大数量
  RESUME_MAX_COUNT: 10,
  // 简历缩略图宽度（px）
  RESUME_THUMB_WIDTH: 200,
  // v6 并行发送架构
  MAX_SEND_WORKERS: 3, // 并行发送 worker 数（每个 worker 跑在独立后台窗口，避免 hidden tab WS 风暴）
  EXTRACT_CARD_DELAY_MS: 1500,
  CONVERSATION_POLL_MS: 500,
  CONVERSATION_TIMEOUT_MS: 6000,
  POST_EXTRACT_DELAY_MS: 3000,
  // 后台 tab 节流下的填字/确认等待（>=600ms 给 BOSS Vue 重渲染 btn-send 状态）
  FILL_SETTLE_MS: 700,
  // 图片上传 XHR 超时（loadend 不到时兜底）
  IMG_UPLOAD_TIMEOUT_MS: 15000,
  // SW → worker tab keepalive 心跳间隔（chrome.alarms 最低 30s）
  KEEPALIVE_PERIOD_MIN: 0.5,
  // 投递数量闸门
  DAILY_SEND_LIMIT: 150,   // 日累积上限（本地自然日）：当天成功投递岗位数超过即硬拦
  SOFT_BATCH_LIMIT: 75,    // 单批硬上限（events-b.js gate 截断超出部分）；命名留存兼容，语义已由软提示改为硬拦
  // ── 风控自适应退避（captcha 触发后 12h 滚动窗口降级投递）──
  // 主因=频率/节奏型自动化检测；惩罚先弹 captcha（累积阈值），多次后才硬封。
  // 策略：12h 滚动窗口内 captcha 次数 0=满速 / 1=降速（worker↓+间隔↑）/ ≥STOP=拒绝整批冷却。
  CAPTCHA_RISK_WINDOW_MS: 12 * 60 * 60 * 1000, // 12h 滚动窗口（非自然日，避免午夜重置漏洞）
  CAPTCHA_SLOW_WORKERS: 2,             // 降速档并行 worker 数（满速=MAX_SEND_WORKERS）
  CAPTCHA_SLOW_INTERVAL_MIN_MS: 2000,  // 降速档岗位间隔下限（满速档=200）
  CAPTCHA_SLOW_INTERVAL_MAX_MS: 5000,  // 降速档岗位间隔上限（满速档=900）
  CAPTCHA_STOP_THRESHOLD: 2,           // 12h 内 captcha 次数 ≥ 此值 → 拒绝整批（冷却到窗口滑出）
  // ── #4 JD 实时定制招呼语（per-job 边投边生成）──
  // true=stage2 worker 发送前用该岗 JD 实时生成定制招呼语（覆盖按类目统一预生成的招呼语）；
  // false=保持现状（按类目统一招呼语）。默认 false 灰度：UI 入口由 #6 mockup 统一出。
  // 失败/超时/JD 为空一律回退统一招呼语兜底，绝不阻断投递（容错铁律）。
  JD_GREETING_ENABLED: false,
  // JD 实时生成的后端调用超时（ms）。超时即回退统一招呼语，故可比批量生成短。
  JD_GREETING_TIMEOUT_MS: 12000,
  // stage1 采集的 JD 正文最大保留字数（客户端截断；后端再二次 slice 防护）。
  JD_TEXT_MAX_LEN: 1500,
  // ── #1 JD 定制招呼语预取编排（B 页静默预取 → 流水线生成）──
  JD_FETCH_INTERVAL_MS: 3000,  // 取 JD 串行间隔，绝不更快（实测 1.5s 触 BOSS 软封锁 code:37）
  JD_API_CONCURRENCY: 3,       // 后端生成并发（取 JD 与调 API 解耦，流水线后 ≈ max(3s,4s)/岗）
  JD_GEN_DAILY_CAP: 200,       // 每设备每天定制招呼语生成天花板（本地自然日，防滥用；超了降级保留组级招呼语）
};

// ── 岗位归类：单一真相源（分来源打分） ──
// 一个 job 该归到哪个期望词组的唯一判定。SW（采集过滤 / 发送分组 / cluster）
// 与 popup（B 页 prepareGroups）都调它，保证「编辑 key === 发送 key」、归组结果一致。
// 病根修复：历史上三套不同打分（采集 50% / 发送 60% / 分组无重叠分支）导致编辑组≠发送组、落「其他」。
//
// 两类来源都走严格匹配（不用字符重叠，避免「游戏运营」靠 运/营 重叠误纳「电商运营」、
// 「AI产品经理」靠重叠把纯产品经理岗都带进来）：
//   picker 词：name===pos +10 / 分词(/[\s·/&]+/)后每 token 都 includes 岗位名 +5
//   custom 词：name===pos +10 / name 完整含 pos(>=2) +5 / else 英文段精确命中 +3
//   两类都：tag===pos +8 / tag 完整含 pos +3（严格，无反向）
// 返回最佳期望词（bestScore>=3）；0 匹配的极端 fallback 才返回 '其他'。
function matchJobToExpected(job, picker, custom) {
  var pickerArr = Array.isArray(picker) ? picker : [];
  var customArr = Array.isArray(custom) ? custom : [];
  if (!pickerArr.length && !customArr.length) return '其他';
  // BOSS 返回 name/tags 大小写不可控，比较前两侧 toLowerCase，但返回值用 original pos 保 key 一致
  var jobNameLc = ((job && job.name) || '').toLowerCase();
  var tags = (job && job.tags) || [];
  var bestPos = '其他', bestScore = 0;

  // tag 打分（严格，picker 与 custom 共用）：仅 tag===pos(+8) 或 tag 完整含 pos(+3)。
  // 不给 pos 含 tag 片段的反向分 —— 否则「AI产品经理」会因 tag『产品』被纯产品经理岗误纳。
  function scoreTagsStrict(posLc) {
    var s = 0;
    for (var t = 0; t < tags.length; t++) {
      var tLc = (tags[t] || '').toLowerCase();
      if (tLc === posLc) s += 8;
      else if (tLc.indexOf(posLc) >= 0) s += 3;
    }
    return s;
  }

  // picker：严格，不用字符重叠。复用 filterJobsByExpected 原 picker 逻辑（分词全命中）
  for (var i = 0; i < pickerArr.length; i++) {
    var pos = pickerArr[i];
    var posLc = (pos || '').toLowerCase();
    var score = 0;
    if (jobNameLc === posLc) score += 10;
    else {
      var tokens = posLc.split(/[\s·/&]+/).filter(Boolean);
      if (tokens.length && tokens.every(function (k) { return jobNameLc.indexOf(k) >= 0; })) score += 5;
    }
    score += scoreTagsStrict(posLc);
    if (score > bestScore) { bestScore = score; bestPos = pos; }
  }

  // custom：严格（与 picker 同款 scoreTagsStrict）。仅 name 完整含词条 / 英文段精确命中，无字符重叠
  for (var ci = 0; ci < customArr.length; ci++) {
    var cpos = customArr[ci];
    var cposLc = (cpos || '').toLowerCase();
    var cscore = 0;
    if (jobNameLc === cposLc) cscore += 10;
    else if (cposLc.length >= 2 && jobNameLc.indexOf(cposLc) >= 0) cscore += 5;
    else {
      // 英文段精确命中（如 flutter / flutter工程师）：英文是区分词，要求至少一个长度>=2 的
      // 英文段是岗位名子串 +3。否则「后端工程师」会靠通用中文后缀「工程师」蹭进「flutter工程师」组，
      // 纯英文「flutter」也会靠单字母 l/u/t/e/r 重叠误纳无关英文岗位。
      // 纯中文不再做字符重叠兜底：自创词条退回与 picker 同款严格 —— 只认 name 完整含词条（上方
      // 连续子串 +5）或下方 scoreTagsStrict。避免「游戏运营」靠 运/营 字符重叠误纳「电商运营」。
      var latinSegs = (cposLc.match(/[a-z0-9]+/g) || []).filter(function (s) { return s.length >= 2; });
      if (latinSegs.length && latinSegs.some(function (s) { return jobNameLc.indexOf(s) >= 0; })) cscore += 3;
    }
    cscore += scoreTagsStrict(cposLc);
    if (cscore > bestScore) { bestScore = cscore; bestPos = cpos; }
  }

  return (bestPos !== '其他' && bestScore >= 3) ? bestPos : '其他';
}
