// ════════════════════════════════════════════════════════════
// 即投 — 全局状态 Store
// API: get / set / getSnapshot / restore
// ════════════════════════════════════════════════════════════

(function () {
  var _state = {
    mode: 'settings',
    city: { name: '', code: '' },
    selectedCities: [],
    resumeImages: [],
    selectedPositions: [],
    customPositions: [],
    hrActiveFilter: '不限',
    welfareFilter: '不限',
    restDayFilter: '不限',
    posSearchQuery: '',
    selectedIndustries: [],
    indSearchQuery: '',
    showAllIndustries: false,
    expandedIndustries: [], // 展开（手风琴打开）的一级行业 category 名，持久化避免点选二级 chip 重渲后复位
    workAreasByCity: {}, // {cityCode:[区名]}，每城独立工作区域；缺省视作 ['不限']
    jobTypes: ['不限'],
    salaryRanges: ['不限'],
    experience: ['不限'],
    education: ['不限'],
    companySizes: ['不限'],
    fundingStages: ['不限'],
    cityOpen: false,
    progressDone: false,
    collecting: false,
    jobs: [],
    sending: false,
    groups: [],
    greetings: {},
    jobCustom: {},
    groupExpanded: {},
    // 自定义招呼语三层（与 jobCustom AI 机制隔离）
    globalGreet: '',   // 全局-自定义招呼语文本
    groupGreet: {},    // {[position]:{mode:'ai'|'custom',text}}
    jobGreet: {},      // {[jobId]:{mode:'ai'|'custom',text}}
  };

  // Backward-compatible alias (existing code uses S.xxx directly)
  window.S = _state;

  window.Store = {
    /** 读单个或全部（无参返回全部） */
    get: function (key) {
      return key === undefined ? _state : _state[key];
    },

    /** 写（开发模式有 schema 校验） */
    set: function (key, value) {
      _state[key] = value;
      // 自动持久化 ui: 前缀的状态
      persistUIState();
    },

    /** 深克隆，用于 SW 同步 */
    getSnapshot: function () {
      return JSON.parse(JSON.stringify(_state));
    },

    /** 恢复（popup 重开用），完全替换内部状态 */
    restore: function (snapshot) {
      // 清空所有现有 key
      var keys = Object.keys(_state);
      for (var i = 0; i < keys.length; i++) {
        delete _state[keys[i]];
      }
      // 从快照复制
      var copy = JSON.parse(JSON.stringify(snapshot));
      var ckeys = Object.keys(copy);
      for (var i = 0; i < ckeys.length; i++) {
        _state[ckeys[i]] = copy[ckeys[i]];
      }
    },
  };
})();

// UI 状态自动持久化（Store.set 触发，300ms 防抖）
var _persistTimer = null;
function persistUIState() {
  if (typeof chrome === 'undefined' || !chrome.storage) return;
  if (typeof STORAGE_KEYS === 'undefined') return;
  clearTimeout(_persistTimer);
  _persistTimer = setTimeout(function () {
    try {
      var state = window.S || {};
      var save = {};
      if (state.groupExpanded) {
        save[STORAGE_KEYS.UI.GROUP_EXPANDED] = state.groupExpanded;
      }
      if (state.jobCustom) {
        save[STORAGE_KEYS.UI.JOB_CUSTOM] = state.jobCustom;
      }
      // 自定义招呼语三层（独立持久化，popup 重开显式恢复）
      if (typeof state.globalGreet === 'string') {
        save[STORAGE_KEYS.UI.GLOBAL_GREET] = state.globalGreet;
      }
      if (state.groupGreet) {
        save[STORAGE_KEYS.UI.GROUP_GREET] = state.groupGreet;
      }
      if (state.jobGreet) {
        save[STORAGE_KEYS.UI.JOB_GREET] = state.jobGreet;
      }
      chrome.storage.local.set(save);
    } catch (e) {}
  }, 300);
}
