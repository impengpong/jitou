// BOSS 直聘 DOM 选择器集中管理 — 2026-05-13 实测验证
const SELECTORS = {
  // ── 岗位搜索页 /web/geek/jobs ──
  jobs: {
    jobCard: 'li.job-card-box',
    jobName: '.job-name',
    jobSalary: '.job-salary',
    tagList: '.tag-list li',
    company: '.job-card-footer .boss-info',
    expectSelect: 'div.c-expect-select',
    synthesis: 'a.synthesis',
    expectItem: 'a.expect-item',
    expectItemText: 'a.expect-item span.text-content',
    filterCondition: 'div.filter-condition div.c-filter-condition',
    // Vue 下拉强制打开
    industryDropdown: '.condition-industry-select .filter-select-dropdown',
    // 立即沟通按钮（搜索页右侧详情面板），href=javascript:;
    immediateChatBtn: 'a.op-btn-chat',
    // JD 全文：搜索页合成点卡后右侧详情面板的正文（COLLECT_JD 首选）
    jdDescPanel: '.job-detail-container .desc',
    // JD 全文 fallback：旧全页 /job_detail 的正文
    jdDescBox: '.job-detail-box .desc',
  },

  // ── 聊天列表页 /web/geek/chat ──
  chatList: {
    userList: '.user-list-content li',
    unreadLabel: '.label-name',
    friendContent: '.friend-content',
    // 定位用：li 的可见文字（数字 ID 不在 DOM，name-text 文本 === getGeekFriendList 的 name 字段）
    nameText: '.name-text',
    nameBox: '.name-box',
    lastMsgText: '.last-msg-text',
    // 「已向BOSS发送消息」弹窗：cancelBtn=留在此页（点它），sureBtn=继续沟通（会跳转，绝不点）
    greetBossContainer: '.greet-boss-container',
    greetBossCancelBtn: 'a.cancel-btn',
  },

  // ── 聊天详情页 ──
  chatDetail: {
    chatInput: 'div#chat-input.chat-input',
    btnSend: 'button.btn-send',
    hrMessage: '.message-item.item-friend',
    systemMessage: '.message-item.item-system',
    // 自己发出的消息气泡（发送成功确认判据之一）
    messageSent: '.item-myself',
    imageUpload: '.btn-sendimg input[type=file]',
    resumeBtn: '.toolbar-btn',
    // 发简历弹窗
    resumeDialog: '.dialog-container',
    resumeItem: '.list-item',
    resumeConfirm: '.btn-confirm',
  },

  // ── JD 详情页 /job_detail/{id}.html ──
  jobDetail: {
    jobDetail: '.job-detail',
    jobSecText: '.job-sec-text',
    // 详情页「立即沟通」按钮，href=javascript:;（≠ 搜索页右侧面板 a.op-btn-chat，别混）。
    // 真机验：完整鼠标序列点它 → 整页导航 /web/geek/chat + 自动开该岗 HR 会话 + 输入框就绪。
    // 已沟通时文本变「继续沟通」，需跳过（详情派 DETAIL_CLICK_CHAT 判此）。
    detailStartChatBtn: 'a.btn-startchat',
  },

  // ── #6 业务拦截弹窗：BOSS「今日沟通已达上限」限额弹窗（达上限权威信号）──
  // 点「立即沟通」后若 BOSS 弹此弹窗，说明账号今日新开聊数已达平台上限（约 150），
  // 该岗建联其实没成功。本地计数不准（用户可能在手机/别处也点过立即沟通），
  // 故以此弹窗为 ground truth 判定「达上限」。
  // ⚠️ 真机精确文案/class 待二次确认；当前用「必含词 + 语境词」双命中宽松匹配可见弹窗文本，
  //    误判风险低（普通打招呼/同HR弹窗不含「上限/已达/明天再来」）。确认后可收紧到精确 class。
  limitDialog: {
    container: '[class*="dialog"]',
    // 命中下列任一「必含词」且同时命中任一「语境词」→ 判定为达上限弹窗
    keywordsRequired: ['上限', '已达', '明天再来', '已用完', '超过限制'],
    keywordsContext: ['沟通', '聊天', '招呼', 'boss', '今日', '数量', '人数', '次数'],
  },
};

// ── 消息类型常量（popup ↔ background ↔ content） ──
// 必须与 src/shared/constants.js 的 MSG 完全一致：content script 不加载 constants.js，此处为镜像
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
  DO_START_CHAT: 'DO_START_CHAT',
  DO_SEND_CHAT: 'DO_SEND_CHAT',
  CS_READY: 'CS_READY',

  // v6 发送架构
  QUEUE_EMPTY: 'QUEUE_EMPTY',
  DO_BATCH_EXTRACT: 'DO_BATCH_EXTRACT',
  EXTRACT_PROGRESS: 'EXTRACT_PROGRESS',
  EXTRACT_COMPLETE: 'EXTRACT_COMPLETE',
  WORKER_SEND: 'WORKER_SEND',
  WORKER_RESULT: 'WORKER_RESULT',

  // #39 阶段1跳转恢复：SW -> 消息页 CS 点「沟通新职位」确认钮（必须与 constants.js 同步）
  CONFIRM_CHANGE_JOB_DIALOG: 'CONFIRM_CHANGE_JOB_DIALOG',

  // CAPTCHA
  CAPTCHA_DETECTED: 'CAPTCHA_DETECTED',

  // 招呼语开关 pre-flight（必须与 constants.js 同步）
  CHECK_GREETING_SETTING: 'CHECK_GREETING_SETTING',   // SW -> CS(搜索页): 读 getGreetingList
  ENABLE_GREETING_SETTING: 'ENABLE_GREETING_SETTING', // SW -> CS(搜索页): 写开关+复读自检

  // 查看JD详情：SW -> CS(搜索页) 按 encryptJobId 定位左侧卡并点击展开 JD（必须与 constants.js 同步）
  OPEN_JOB_DETAIL: 'OPEN_JOB_DETAIL',

  // 详情派 send-on-open（必须与 constants.js 同步）
  DETAIL_CLICK_CHAT: 'DETAIL_CLICK_CHAT',   // SW -> CS(详情页): 点 a.btn-startchat 整页导航到 chat
  CHAT_SEND_ON_OPEN: 'CHAT_SEND_ON_OPEN',   // SW -> CS(chat页): 关弹窗+等输入框+sendSingle 发招呼语
  DISABLE_GREETING_SETTING: 'DISABLE_GREETING_SETTING', // SW -> CS(详情页): 关 BOSS 自动打招呼开关(status=0)
  DETAIL_CHECK_CHAT_BTN: 'DETAIL_CHECK_CHAT_BTN', // SW -> CS(详情页): F2 超时救济，只读按钮文案不点击（必须与 constants.js 同步）

  // HR 活跃度前置过滤 · B3 猎头支线（必须与 constants.js 同步：content.js 用本副本的 MSG，缺键则 case/发送类型变 undefined）
  B3_HEADHUNTER_PROBE: 'B3_HEADHUNTER_PROBE',   // SW -> CS(搜索页): 逐个点猎头岗真卡触发 detail.json 拿分级活跃度
  B3_HEADHUNTER_RESULT: 'B3_HEADHUNTER_RESULT', // CS -> SW: 猎头岗活跃度探测结果，content.js 发送时引用本副本的 MSG

  // P2 免费额度绑 BOSS 账号（必须与 constants.js 同步）
  GET_BOSS_UID: 'GET_BOSS_UID',   // SW -> CS(zhipin 任一页): 同源 fetch getUserInfo.json 取 encryptUserId
};

// ── URL 参数映射 ──
const URL_PARAMS = {
  city: '101280600', // 深圳
  experience: { '1-3年': '104', '3-5年': '105', '5-10年': '106' },
  degree: { 本科: '203', 硕士: '204', 博士: '205' },
  jobType: { 全职: '1' },
  position: null, // 三级岗位 code，从 API 获取
};

// ── 岗位分类 API ──
const POSITION_API =
  '/wapi/zpgeek/common/data/expectposition.json?cityCode={code}&version=1';
