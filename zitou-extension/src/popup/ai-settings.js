// AI credentials stay in this browser profile. Only the chosen provider receives requests.
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const message = text => { $('aiMessage').textContent = text; };
  function parseBase(value) {
    const url = new URL(value.trim());
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('请使用 HTTPS 地址；本机服务可使用 HTTP。');
    if (url.username || url.password || url.search || url.hash) throw new Error('API 地址不能包含密钥、查询参数或片段。');
    return {baseUrl: url.href.replace(/\/+$/, ''), origin: url.protocol + '//' + url.hostname + '/*'};
  }
  function init() {
    chrome.storage.local.get(['aiConfig', 'resumeText'], result => {
      const config = result.aiConfig || {};
      $('aiBaseUrl').value = config.baseUrl || '';
      $('aiApiKey').value = config.apiKey || '';
      $('aiModel').value = config.model || '';
      $('aiVisionModel').value = config.visionModel || '';
      $('resumeText').value = result.resumeText || '';
    });
    $('aiSave').addEventListener('click', async () => {
      try {
        const parsed = parseBase($('aiBaseUrl').value);
        const config = {baseUrl: parsed.baseUrl, apiKey: $('aiApiKey').value.trim(), model: $('aiModel').value.trim(), visionModel: $('aiVisionModel').value.trim()};
        if (!config.model) throw new Error('请填写文本模型 ID。');
        if (!config.apiKey && !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(config.baseUrl + '/')) throw new Error('请填写 API Key。');
        // Request only the selected provider, from this explicit user click.
        const allowed = await chrome.permissions.request({origins: [parsed.origin]});
        if (!allowed) throw new Error('未获准访问该 API 地址，设置未保存。');
        await chrome.storage.local.set({aiConfig: config});
        message('已保存。生成招呼语时会使用此模型服务。');
      } catch (error) { message(error.message || '保存失败，请重试。'); }
    });
    $('aiClear').addEventListener('click', async () => {
      try {
        const result = await chrome.storage.local.get('aiConfig');
        const config = Object.assign({}, result.aiConfig || {}, {apiKey: ''});
        await chrome.storage.local.set({aiConfig: config});
        $('aiApiKey').value = '';
        message('已清除本机保存的密钥。');
      } catch (_) { message('清除失败，请重试。'); }
    });
    let timer;
    $('resumeText').addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => chrome.storage.local.set({resumeText: $('resumeText').value}), 200);
    });
    $('resumeText').addEventListener('change', () => {
      clearTimeout(timer);
      chrome.storage.local.set({resumeText: $('resumeText').value});
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
