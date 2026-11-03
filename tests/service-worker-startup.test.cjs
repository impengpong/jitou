const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),{webcrypto}=require('node:crypto');
const root=path.join(__dirname,'../zitou-extension');
function worker(){
 const data={},requests=[],tabOps=[],listeners={};
 const event=name=>({addListener:fn=>(listeners[name]||=[]).push(fn),removeListener:()=>{}});
 const get=(keys,cb)=>{let result={};for(const k of typeof keys==='string'?[keys]:Array.isArray(keys)?keys:Object.keys(data))if(k in data)result[k]=data[k];if(cb)queueMicrotask(()=>cb(result));return Promise.resolve(result);};
 const context={console:{log(){},warn(){},error(){}},URL,Blob,Uint8Array,btoa,AbortController,crypto:webcrypto,setTimeout,clearTimeout,setInterval,clearInterval,chrome:{storage:{local:{get,set:async x=>Object.assign(data,x),remove:async k=>delete data[k]},onChanged:event('storage')},runtime:{onMessage:event('message'),onInstalled:event('installed'),getManifest:()=>({version:'2.0.0'}),sendMessage:async()=>({}),getURL:x=>'chrome-extension://test/'+x},sidePanel:{setPanelBehavior:async()=>{}},tabs:{onRemoved:event('removed'),onUpdated:event('updated'),query:async()=>[],create:async x=>{tabOps.push(x);return {id:1};},sendMessage:async()=>({}),remove:async()=>{}},alarms:{onAlarm:event('alarm'),create:async()=>{},clear:async()=>{}},windows:{get:async()=>({})}}};
 context.self=context;context.addEventListener=()=>{};context.fetch=async(...args)=>{requests.push(args);throw new Error('unexpected external request');};vm.createContext(context);context.importScripts=(...files)=>files.forEach(file=>vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),context,{filename:file}));
 vm.runInContext(fs.readFileSync(path.join(root,'src/background/service-worker.js'),'utf8'),context,{filename:'service-worker.js'});return {context,data,requests,tabOps,listeners};
}
test('full service worker boots without bundled key, external network or automatic website tab',async()=>{
 const h=worker();await new Promise(r=>setTimeout(r,30));assert.equal(h.requests.length,0);assert.equal(h.tabOps.length,0);assert.equal(h.data.apiKey,undefined);assert.equal(h.data.aiConfig,undefined);assert.ok(h.listeners.message.length);
 await vm.runInContext('trackEvent("delivery_started",{}); flushDiagnosticEvents()',h.context);assert.equal(h.requests.length,0);
});
test('delivery has no commercial entitlement gate but keeps platform risk and daily limit checks',async()=>{
 const h=worker();await new Promise(r=>setTimeout(r,20));
 const source=vm.runInContext('startSendV7.toString()',h.context);
 assert.doesNotMatch(source,/entitlement|NO_QUOTA|no_quota|checkSendEntitlement|开通会员/);
 assert.match(source,/getCaptchaRiskCount/);assert.match(source,/getDailySendCount/);
 assert.equal(vm.runInContext('typeof claimVideoCode',h.context),'undefined');assert.equal(vm.runInContext('typeof sendUpdaterCommand',h.context),'undefined');
});
