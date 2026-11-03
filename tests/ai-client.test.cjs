const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function harness(values = {}, replies = ['生成结果']) {
  const calls = [];
  const context = { URL, AbortController, setTimeout, clearTimeout, Blob, Uint8Array, btoa, GREETING_SYSTEM_PROMPT: 'original-prompt', chrome: { storage: { local: { get: async key => ({ [key]: values[key] }) } } }, fetch: async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (reply instanceof Error) throw reply;
    return { ok: true, json: async () => ({ choices: [{ message: { content: reply } }] }) };
  } };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../zitou-extension/src/shared/ai-client.js'), 'utf8'), context);
  return { ai: context.JitouAI, values, calls, context };
}
const cfg = { baseUrl: 'https://provider.example/v1', apiKey: 'test-only-key', model: 'text-model' };
test('missing setup makes zero requests and never injects a default credential', async () => {
 const h = harness(); await assert.rejects(h.ai.chat([]), /API 地址/); assert.equal(h.calls.length, 0);
});
test('text resume uses only configured endpoint, model and original prompt', async () => {
 const h=harness({aiConfig:cfg,resumeText:'实际简历文字'});const result=await h.ai.greeting('运营',[],{jdText:'岗位要求'});
 assert.equal(result,'生成结果');assert.equal(h.calls.length,1);const c=h.calls[0];
 assert.equal(c.url,'https://provider.example/v1/chat/completions');assert.equal(c.options.redirect,'error');assert.equal(c.options.headers.Authorization,'Bearer test-only-key');assert.equal(c.body.model,'text-model');assert.equal(c.body.messages[0].content,'original-prompt');assert.match(c.body.messages[1].content,/实际简历文字/);assert.match(c.body.messages[1].content,/岗位要求/);
});
test('local server works with no auth header and full completion URLs are accepted',async()=>{
 const h=harness({aiConfig:{baseUrl:'http://localhost:1234/v1/chat/completions',model:'local'}});await h.ai.chat([]);assert.equal(h.calls[0].url,'http://localhost:1234/v1/chat/completions');assert.equal(h.calls[0].options.headers.Authorization,undefined);
});
test('remote insecure endpoints and URL credentials are rejected',async()=>{
 for(const baseUrl of ['http://provider.example/v1','https://user:pass@provider.example/v1']){const h=harness({aiConfig:{...cfg,baseUrl}});await assert.rejects(h.ai.chat([]),/HTTPS/);assert.equal(h.calls.length,0);}
});
test('vision OCR deduplicates concurrent calls and invalidates on image content change',async()=>{
 const h=harness({aiConfig:{...cfg,visionModel:'vision-model'}},['简历OCR文字']);const images=['data:image/png;base64,AAAA'];
 const [a,b]=await Promise.all([h.ai.resumeText(images),h.ai.resumeText(images)]);assert.equal(a,b);assert.equal(h.calls.length,1);assert.equal(h.calls[0].body.model,'vision-model');
 await h.ai.resumeText(['data:image/png;base64,BBBB']);assert.equal(h.calls.length,2);
});
test('images go directly to selected vision-capable main model, no storage upload',async()=>{
 const h=harness({aiConfig:cfg});await h.ai.greeting('运营',['data:image/png;base64,AAAA']);assert.equal(h.calls.length,1);assert.equal(h.calls[0].body.messages[1].content[0].type,'image_url');
});
test('no resume is a clear error rather than invented candidate information',async()=>{
 const h=harness({aiConfig:cfg});await assert.rejects(h.ai.greeting('运营',[]),/简历/);assert.equal(h.calls.length,0);
});
test('provider transport errors do not expose secrets in error messages',async()=>{
 const h=harness({aiConfig:cfg},[new Error('echo test-only-key')]);await assert.rejects(h.ai.chat([]),e=>!e.message.includes('test-only-key'));
});
test('remote provider requires user API key and never sends unauthenticated request',async()=>{
 const h=harness({aiConfig:{...cfg,apiKey:''}});await assert.rejects(h.ai.chat([]),/API Key/);assert.equal(h.calls.length,0);
});
