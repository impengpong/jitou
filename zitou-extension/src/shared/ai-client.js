// User-owned OpenAI-compatible API. No bundled credentials or hosted proxy.
var JitouAI = (() => {
  async function config() {
    const stored = await chrome.storage.local.get('aiConfig');
    const c = stored.aiConfig || {};
    let url;
    try { url = new URL(String(c.baseUrl || '').trim()); }
    catch (_) { throw new Error('请在设置中填写 AI API 地址'); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) {
      throw new Error('API 地址须为 HTTPS（本机服务可用 HTTP），不能包含凭据或查询参数');
    }
    if (!c.model || !String(c.model).trim()) throw new Error('请在设置中填写模型名称');
    if (!local && !String(c.apiKey || '').trim()) throw new Error('请在设置中填写自己的 API Key');
    return { baseUrl: url.href.replace(/\/$/, ''), apiKey: String(c.apiKey || '').trim(), model: String(c.model).trim(), visionModel: String(c.visionModel || '').trim(), local };
  }
  async function chat(messages, opts = {}) {
    const c = await config();
    const endpoint = c.baseUrl.endsWith('/chat/completions') ? c.baseUrl : c.baseUrl + '/chat/completions';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs || 120000);
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (c.apiKey) headers.Authorization = 'Bearer ' + c.apiKey;
      const response = await fetch(endpoint, {
        method: 'POST', headers, signal: controller.signal, redirect: 'error',
        body: JSON.stringify({ model: opts.model || c.model, messages, temperature: 0.3, max_tokens: opts.maxTokens || 2048 })
      });
      if (!response.ok) throw new Error('AI API 请求失败（HTTP ' + response.status + '），请检查地址、Key、余额和模型能力');
      const body = await response.json();
      const content = body && body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content;
      if (typeof content !== 'string' || !content.trim()) throw new Error('AI 返回了空结果，请检查模型配置');
      return content.trim();
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('AI 请求超时，请检查网络或模型服务');
      // Never include provider response bodies, request headers or credentials in diagnostics.
      if (e && /^AI /.test(e.message)) throw e;
      throw new Error('AI 请求失败，请检查网络、API 地址及扩展的网站访问权限');
    } finally { clearTimeout(timeout); }
  }
  async function imagesToDataUrls(images) {
    const urls = [];
    for (const image of (images || []).slice(0, 2)) {
      if (!image || !image.blob) continue;
      const bytes = new Uint8Array(await image.blob.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      urls.push('data:' + (image.type || 'image/png') + ';base64,' + btoa(binary));
    }
    return urls;
  }
  let ocrCache = null;
  let ocrInflight = null;
  async function resumeText(images) {
    const saved = await chrome.storage.local.get('resumeText');
    if (typeof saved.resumeText === 'string' && saved.resumeText.trim()) return saved.resumeText.trim();
    if (!images || !images.length) return '';
    const c = await config();
    if (!c.visionModel) return '';
    const key = JSON.stringify([c.baseUrl, c.visionModel, images]);
    if (ocrCache && ocrCache.key === key) return ocrCache.text;
    if (ocrInflight && ocrInflight.key === key) return ocrInflight.promise;
    const promise = chat([{ role: 'user', content: [
      { type: 'text', text: '请逐字提取这些简历图片的全部文字，保留段落顺序，不补充、不猜测、不评价。仅输出文字。' },
      ...images.map(url => ({ type: 'image_url', image_url: { url } }))
    ] }], { model: c.visionModel, maxTokens: 4096 }).then(text => {
      ocrCache = { key, text }; return text;
    });
    ocrInflight = { key, promise };
    try { return await promise; }
    finally { if (ocrInflight && ocrInflight.promise === promise) ocrInflight = null; }
  }
  async function greeting(category, images, opts = {}) {
    const text = opts.resumeText || await resumeText(images);
    if (!text && (!images || !images.length)) throw new Error('请先填写简历文字或上传简历图片');
    const content = [];
    if (text) content.push({ type: 'text', text: '我的简历全文：\n' + text });
    else content.push(...images.map(url => ({ type: 'image_url', image_url: { url } })));
    content.push({ type: 'text', text: '目标岗位名：' + category + (opts.jdText ? '\n岗位 JD：\n' + opts.jdText : '\n未提供完整 JD，请仅依据简历和岗位类别写招呼语。') });
    return chat([{ role: 'system', content: GREETING_SYSTEM_PROMPT }, { role: 'user', content: text ? content.map(x => x.text).join('\n\n') : content }], { timeoutMs: opts.timeoutMs || 120000 });
  }
  async function rewrite(original, instruction) {
    return chat([{ role: 'system', content: GREETING_SYSTEM_PROMPT }, { role: 'user', content: '请按以下要求修改招呼语，不添加原文没有的经历或数字。\n原文：\n' + original + '\n修改要求：\n' + instruction }]);
  }
  return { config, chat, imagesToDataUrls, resumeText, greeting, rewrite };
})();
