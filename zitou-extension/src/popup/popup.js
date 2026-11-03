// ════════════════════════════════════════════════════════════
// 即投 — Popup 入口（路由 + 消息监听）
// ════════════════════════════════════════════════════════════
// Depends on: constants.js, tag-data.js, helpers.js, state.js
// Depends on: render-a.js, render-b.js, render-review.js
// Depends on: events-a.js, events-b.js

// ── 数组 → Data URL 转换（兼容 options 页上传的 data 格式） ──
window.arrayBufferToDataUrl=function(arr,mimeType){
  try{
    if(!arr||!arr.length)return null;
    var bytes=new Uint8Array(arr);
    // Chunked conversion avoids O(n^2) string concatenation
    var chunkSize=8192,chunks=[];
    for(var i=0;i<bytes.length;i+=chunkSize){
      chunks.push(String.fromCharCode.apply(null,bytes.subarray(i,i+chunkSize)));
    }
    return 'data:'+mimeType+';base64,'+btoa(chunks.join(''));
  }catch(e){return null}
};

// ── DOM References ──
var E={};
var _debounceJobsTimer=null;
let p1dPollHandle = null;
// 用户主动点回退（toSettings）后置 true：抑制 handleStateUpdate 的 phase recovery，守住 A 页。
// 🔴 解除时机只由「用户下一次主动进入 B / 开新批」负责（toResults / events-b.js 开投），
// 绝不由「任务 phase 收敛到终态」自动解除——采集/投递在后台收敛到 ready/idle/review/captcha_paused
// 都是必然终态，若拿它当解除信号，那条终态 state 解除挡板后会立刻命中下方 phase recovery 把用户拽回 B
// （采集中回退第一案：窄词 ~1s/宽词 ~5s 后被 'ready' state 弹回 B，窄词 0 结果还会落到空态 B 页）。
let userBackedOut = false;
function initDomRefs(){
  E.headerLeft=$('#headerLeft');E.hdrTitle=$('#hdrTitle');E.btnBack=$('#btnBack');
  E.settingsPanel=$('#settingsPanel');E.resultsPanel=$('#resultsPanel');
  E.cityInput=$('#cityInput');E.cityChipContainer=$('#cityChipContainer');E.citySelectedArea=$('#citySelectedArea');
  E.posSearch=$('#posSearch');E.posSearchClear=$('#posSearchClear');E.posBrowseArea=$('#posBrowseArea');
  E.indSearch=$('#indSearch');E.indSearchClear=$('#indSearchClear');E.indArea=$('#indArea');
  E.workAreaChips=$('#workAreaChips');E.jobTypeChips=$('#jobTypeChips');
  E.salaryChips=$('#salaryChips');E.expChips=$('#expChips');E.eduChips=$('#eduChips');
  E.sizeChips=$('#sizeChips');E.stageChips=$('#stageChips');
  E.bottomSettings=$('#bottomSettings');E.bottomResults=$('#bottomResults');
  E.btnReset=$('#btnReset');E.btnCollect=$('#btnCollect');E.btnSend=$('#btnSend');
  E.resultCountNum=$('#resultCountNum');E.resultCountTotal=$('#resultCountTotal');
  E.hiddenFileInput=$('#hiddenFileInput');E.hiddenFileInputB=$('#hiddenFileInputB');E.resumeThumbArea=$('#resumeThumbArea');
  E.progressSection=$('#progressSection');E.progressFill=$('#progressFill');
  E.progressText=$('#progressText');E.progressSub=$('#progressSub');
  E.resultsContent=$('#resultsContent');E.groupedContent=$('#groupedContent');
  E.gearBtn=$('#gearBtn');E.settingsOverlay=$('#settingsOverlay');
  E.settingsClose=$('#settingsClose');
}

// ════════════════════════════════════════════════════════════
// ROUTE FUNCTIONS
// ════════════════════════════════════════════════════════════

function toSettings(){
  // 回退箭头＝中止正在进行的任务（采集 + 投递）：
  // STOP_COLLECT 停采集 worker，STOP_SEND 停投递 worker。两者都发，否则 SW 仍在后台跑、
  // 下一条 COLLECT_PROGRESS / STATE_UPDATE / poll 命中 handleStateUpdate 的 phase recovery
  // 又把用户从 A 页拽回 B 页（旧版只停采集不停投递→投递中回退第一次被弹回 B、第二次才偶然稳）。
  try{chrome.runtime.sendMessage({type:MSG.STOP_COLLECT},function(){void chrome.runtime.lastError;});}catch(_){}
  try{chrome.runtime.sendMessage({type:MSG.STOP_SEND},function(){void chrome.runtime.lastError;});}catch(_){}
  // 用户主动回退挡板：停任务是异步的（关 worker tab / finalizeTask），phase 收敛到终态前仍可能
  // 有一条 'sending'/'collecting' state 广播过来触发 phase recovery 弹回 B。置此 flag 后，
  // handleStateUpdate 在收敛到终态（idle/ready/review/captcha_paused）前一律忽略 phase recovery。
  userBackedOut=true;
  // 抑制本次停止产生的 review：STOP_SEND 终态是 phase='review'，挡板在 review 解除后会继续往下
  // 命中 review 分支把结果页盖在 A 上。回退＝放弃本批，不该再弹 review。开投时 events-b.js 会清此 flag。
  Store.set('reviewDismissed',true);
  // 停掉 B 页轮询 fallback（否则 setInterval 持续拉 state 触发 phase recovery 弹回 B 页）
  if(p1dPollHandle){clearInterval(p1dPollHandle);p1dPollHandle=null;}
  // 清等待挡板，避免下次进 B 页残留旧态
  Store.set('awaitingCollect',false);
  Store.set('mode','settings');Store.set('progressDone',false);
  Store.set('collecting',false);Store.set('sending',false);
  // 回 A 页＝放弃上一轮采集结果：清 Store + 渲染 DOM，否则重新筛选进 B 页会残留上次岗位/计数
  Store.set('jobs',[]);Store.set('groups',[]);Store.set('groupExpanded',{});
  if(E.groupedContent)E.groupedContent.innerHTML='';
  E.hdrTitle.classList.remove('hidden');E.btnBack.classList.add('hidden');
  E.settingsPanel.classList.remove('hidden');E.resultsPanel.classList.add('hidden');
  E.resultsContent.classList.add('hidden');E.progressSection.classList.remove('hidden');
  E.bottomSettings.classList.remove('hidden');E.bottomResults.classList.add('hidden');
  E.progressFill.style.width='0%';E.progressText.textContent='正在搜集岗位...';
  E.progressSub.textContent='';
  // 清掉 review 面板内容（不只是隐藏）——否则上一批 review DOM 残留，A 页下滑可见、且会被重渲染盖上来
  var rp=document.getElementById('reviewPanel');
  if(rp){rp.style.display='none';rp.innerHTML='';rp._expandWired=false;}
  window.renderSettings();
}

function toResults(){
  userBackedOut=false; // 重新进 B 页：清回退挡板，否则新一轮 collecting state 被挡板吞掉卡骨架屏
  Store.set('mode','results');Store.set('progressDone',false);Store.set('collecting',true);
  // 清上一轮结果，确保新一轮收集走 _processJobsUpdate 的「首次构建」分支重渲染
  Store.set('groups',[]);Store.set('jobs',[]);Store.set('groupExpanded',{});
  // B 页无缓存：清空后到本次采集数据到来前，不画任何旧广播，保持加载态（骨架屏）。
  Store.set('awaitingCollect',true);Store.set('groupExpanded',{});
  // B 页无缓存：标记「等待新一轮采集」，在 SW 确认新采集开始(phase='collecting')前，
  // handleStateUpdate 忽略上一轮残留 state，杜绝旧结果回填造成混淆。
  Store.set('awaitingCollect',true);
  // 重置投递按钮到初始态——杜绝上一批「已发送完成」(disabled+绿底)+sending=true 残留带进本批，
  // 否则进 B 页按钮显示「已发送完成」、首点命中停止分支(if sending)只重置文案、需点两次才开投。
  Store.set('sending',false);
  if(E.btnSend){E.btnSend.textContent='一键发送';E.btnSend.classList.remove('sending');E.btnSend.disabled=false;E.btnSend.style.background='';}
  E.hdrTitle.classList.add('hidden');E.btnBack.classList.remove('hidden');
  E.settingsPanel.classList.add('hidden');E.resultsPanel.classList.remove('hidden');
  E.resultsContent.classList.add('hidden');E.progressSection.classList.remove('hidden');
  E.bottomSettings.classList.add('hidden');E.bottomResults.classList.add('hidden');
  E.progressFill.style.width='0%';E.progressText.textContent='正在搜集岗位...';
  E.progressSub.textContent='根据筛选条件智能搜集中';
  var rp=document.getElementById('reviewPanel');
  if(rp){rp.style.display='none';rp.innerHTML='';rp._expandWired=false;} // 彻底清上一批 review，杜绝混杂
  // Skeleton: show placeholder cards matching selected position count
  var posCount=((Store.get('selectedPositions')||[]).concat(Store.get('customPositions')||[])).length||1;
  window.showSkeleton(posCount);
  try{
    var params=window.buildCollectParams();
    chrome.runtime.sendMessage({type:MSG.START_COLLECT,params:params},function(resp){
      if(chrome.runtime.lastError||!resp||!resp.success){
        Store.set('collecting',false);
        Store.set('awaitingCollect',false); // 启动失败：解除挡板，露出错误文案而非卡在骨架屏
        E.progressText.textContent='收集启动失败';
        E.progressSub.textContent=resp?.error||'请确保在BOSS直聘页面打开后重试';
      }
    });
  }catch(e){
    Store.set('collecting',false);
    E.progressText.textContent='收集启动失败';
    E.progressSub.textContent='请刷新页面后重试';
  }
  startBPagePollFallback();
}

function completeCollection(){
  if(p1dPollHandle){clearInterval(p1dPollHandle);p1dPollHandle=null;}
  Store.set('progressDone',true);Store.set('collecting',false);
  E.progressSection.classList.add('hidden');
  E.resultsContent.classList.remove('hidden');
  E.bottomResults.classList.remove('hidden');
  window.updResCnt();
  window.syncResumeFileNames&&window.syncResumeFileNames();
}

// ════════════════════════════════════════════════════════════
// STATE UPDATE HANDLER
// ════════════════════════════════════════════════════════════

// Debounced jobs processing — only deep-clone when jobs actually change, skip if identical
function _processJobsUpdate(jobsData){
  console.log('[P1D-POPUP] _processJobsUpdate enter', { jobsLen: arguments[0] && arguments[0].length });
  _debounceJobsTimer=null;
  // Quick guard: skip heavy processing if jobs data hasn't changed, but still sync greetings
  var curJobs=Store.get('jobs');
  if(curJobs&&curJobs.length===jobsData.length){
    var same=true;
    for(var _i=0;_i<Math.min(curJobs.length,5);_i++){
      if(curJobs[_i].id!==jobsData[_i].id){same=false;break}
    }
    if(same){
      // Jobs unchanged, but greetings may have been updated (async generation completes)
      if(window.applyGreetingsToGroups())window.updateAllGreetings();
      return;
    }
  }
  var jobs=JSON.parse(JSON.stringify(jobsData));
  // 选择先行：进 B 页初始全不选（旧行为=默认全选自动生成，已改）。仅 checked 未指定时置 false，
  // 不覆盖重开投递态里 SW 带回的已选状态。
  jobs.forEach(function(j){if(j.checked===undefined)j.checked=false});
  Store.set('jobs',jobs);

  var existingGroups=Store.get('groups');
  if(existingGroups&&existingGroups.length>0){
    // Groups already exist — 增量校正 groups/DOM 与新 Store.jobs（修幽灵卡），再同步招呼语
    window.syncGroupsWithJobs();
    window.applyGreetingsToGroups();
    window.updateAllGreetings();
  }else{
    // First-time group construction
    Store.set('groupExpanded',{});
    var _picker=Store.get('selectedPositions')||[];
    var _custom=Store.get('customPositions')||[];
    var selPos=_picker.concat(_custom);
    var groups;
    if(selPos.length){
      groups=window.prepareGroups(_picker,_custom,jobs);
      window.initJobCustom(false);
      Store.set('groups',groups);
      window.applyGreetingsToGroups();
      if(Store.get('progressDone')){window.updateAllGreetings();}
    }else if(Store.get('mode')==='results'){
      groups=[{position:'全部岗位',greeting:{text:'正在生成招呼语...',editing:false},fileName:'',jobs:jobs,images:window.defaultGroupImages()}];
      window.initJobCustom(false);
      Store.set('groups',groups);
      window.applyGreetingsToGroups();
      if(Store.get('progressDone')){window.updateAllGreetings();}
    }
    // Always render when groups are first-constructed (progressDone may be set by completeCollection before debounce fires)
    if(Store.get('mode')==='results'){
      window.renderGroupsStable();
    }
  }
}

function startBPagePollFallback(){
  if(p1dPollHandle)return;
  p1dPollHandle=setInterval(function(){
    try{
      chrome.runtime.sendMessage({type:MSG.GET_STATE},function(resp){
        if(chrome.runtime.lastError)return;
        if(resp&&resp.success&&resp.state){
          handleStateUpdate(resp.state);
          if(resp.state.phase==='ready'){
            clearInterval(p1dPollHandle);
            p1dPollHandle=null;
          }
        }
      });
    }catch(e){}
  },500);
}

function handleStateUpdate(state){
  console.log('[P1D-POPUP] handleStateUpdate', { phase: state && state.phase, jobsLen: state && state.jobs && state.jobs.length, greetingsLen: state && state.greetings && Object.keys(state.greetings||{}).length, mode: (window.Store && window.Store.get && window.Store.get('mode')) });
  var mode=Store.get('mode');

  // 用户主动回退挡板：回退到 A 页后，后台任务收敛到任何 phase（collecting/sending 过渡态，或
  // ready/idle/review/captcha_paused 终态）都不得触发 phase recovery 把用户拽回 B。一律丢弃这条
  // state、守住 A 页。挡板只在用户下一次主动进入 B / 开新批时解除（toResults / events-b.js 开投），
  // 不在此按 phase 自动解除——否则采集自然收敛到 'ready' 的瞬间解除挡板，紧接着下方 phase recovery
  // 又把用户弹回 B（采集中回退弹回 B 的真根因）。
  if(userBackedOut){
    return; // 守住 A 页，丢弃所有非用户主动操作触发的 state
  }

  // B 页无缓存：刚进 B 页(awaitingCollect)时本次采集还没开始，SW 可能仍在广播上一次已完成的
  // 采集结果。在见到本次采集的 'collecting' 信号前一律不渲染——保持骨架加载态，杜绝旧数据回填。
  // startCollect 会同步 phase='collecting'+pushState，故 popup 必先收到 'collecting' 再收到新 'ready'。
  if(Store.get('awaitingCollect')){
    if(state.phase==='collecting'){Store.set('awaitingCollect',false);}
    else{return;}
  }

  // Phase recovery (popup reopened mid-flow)
  // 排除 'review'：投完的旧批 state 不该把用户从 A 页拽回 B 页（review 由下方专门分支处理）
  if(mode==='settings'&&state.phase&&state.phase!=='idle'&&state.phase!=='review'){
    Store.set('mode','results');
    Store.set('collecting',state.phase==='collecting');
    E.hdrTitle.classList.add('hidden');E.btnBack.classList.remove('hidden');
    E.settingsPanel.classList.add('hidden');E.resultsPanel.classList.remove('hidden');
    E.resultsContent.classList.add('hidden');E.progressSection.classList.remove('hidden');
    E.bottomSettings.classList.add('hidden');E.bottomResults.classList.add('hidden');
    E.progressFill.style.width='0%';
  }

  // Update Store from incoming state
  if(state.selectedPositions&&state.selectedPositions.length)Store.set('selectedPositions',state.selectedPositions);
  if(state.customPositions)Store.set('customPositions',state.customPositions);
  if(state.greetings)Store.set('greetings',state.greetings);

  // 排除 'review'：投完的旧批 state.jobs 不该重渲 B 页岗位列表/底部计数（这是 18→3 残留的根）
  if(state.jobs&&state.jobs.length&&state.phase!=='review'){
    console.log('[P1D-POPUP] branch:jobs-nonzero hit');
    // 首次加载（groups 不存在）立即渲染，跳过 debounce。后续采集期间的增量更新才 debounce。
    var existingGroups=Store.get('groups');
    if(!existingGroups||!existingGroups.length){
      _processJobsUpdate(state.jobs);
    }else{
      if(_debounceJobsTimer)clearTimeout(_debounceJobsTimer);
      _debounceJobsTimer=setTimeout(function(){_processJobsUpdate(state.jobs)},300);
    }
  }else if(state.greetings&&Store.get('groups')&&Store.get('groups').length&&Store.get('mode')==='results'){
    if(window.applyGreetingsToGroups())window.updateAllGreetings();
  }

  if(state.phase==='ready'&&Store.get('mode')==='results'&&!Store.get('progressDone')){console.log('[P1D-POPUP] branch:phase-ready hit');completeCollection()}

  // Empty 兜底：phase=ready 但 jobs=[] → 替换 skeleton 为空态文案，隐藏投递按钮
  if(state.phase==='ready'&&Array.isArray(state.jobs)&&state.jobs.length===0&&Store.get('mode')==='results'){
    if(E.groupedContent)E.groupedContent.innerHTML='<div class="empty-positions"><div style="font-size:14px;color:var(--text);font-weight:600;margin-bottom:8px">未找到匹配岗位</div><div style="line-height:1.7">请先在浏览器中打开 BOSS 直聘职位搜索页<br>如已打开 BOSS 直聘页面，请放宽筛选条件后再试</div></div>';
    if(E.bottomResults)E.bottomResults.classList.add('hidden');
  }

  // Restore sending progress (popup reopened during send)
  if(state.phase==='sending'){
    Store.set('sending',true);
    E.bottomResults.classList.remove('hidden');
    E.btnSend.textContent='停止发送';E.btnSend.classList.add('sending');E.btnSend.disabled=false;
    if(state.sendProgress){
      var sp=state.sendProgress;
      var _spShown=sp.total>0?Math.min(sp.sent,sp.total):sp.sent; // 分子封顶到分母，杜绝 124/33 式倒挂
      E.progressText.textContent='正在投递 ('+_spShown+'/'+sp.total+')...';
      // 风控降速档弱提示：复用 progress-sub 小字次要色，非弹窗非倒计时非交互
      if(state._captchaSlowMode){
        E.progressSub.classList.remove('hidden');
        E.progressSub.textContent='账户已触发平台认证，本次投递降速以避免封控';
      }else{
        E.progressSub.textContent='';
      }
      E.progressFill.style.width=sp.total>0?Math.min(Math.round(sp.sent/sp.total*100),100)+'%':'0%';
    }
  }

  // CAPTCHA 暂停发送
  if(state.phase==='captcha_paused'){
    Store.set('sending',false);
    E.btnSend.textContent='一键发送';
    E.btnSend.classList.remove('sending');
    E.btnSend.disabled=false;
    E.btnSend.style.background='';
    if(E.bottomResults){E.bottomResults.classList.remove('hidden')}
    showCaptchaWarning();
  }

  // Show review page (popup reopened after send complete, or STATE_UPDATE arrives)
  // 已点「再投一批」后 reviewDismissed=true → 不再自动弹上一批 review，避免盖在新一批 B 页上。
  // 新一批点「一键发送」时清掉该 flag（events-b.js），新一批投完仍正常显示 review。
  if(state.phase==='review'&&!Store.get('reviewDismissed')){
    console.log('[REVIEW-DIAG] line291 trigger', {phase:state.phase, sendResultsLen:(state.sendResults||[]).length, reviewDismissed:Store.get('reviewDismissed'), mode:Store.get('mode'), awaitingCollect:Store.get('awaitingCollect'), sending:Store.get('sending')});
    renderReview(state.sendResults||[],state.sendDuration||0,(state._v6MissedJobs||[]).length);
    E.resultsContent.classList.add('hidden');
    E.progressSection.classList.add('hidden');
    E.bottomResults.classList.add('hidden');
    var rp=document.getElementById('reviewPanel');
    if(rp)rp.style.display='';
  }
}

// ── CAPTCHA 暂停提示 ──
function showCaptchaWarning(){
  var existing=document.getElementById('captchaWarning');
  if(existing)return;
  var warning=document.createElement('div');
  warning.id='captchaWarning';
  warning.className='captcha-warning fade-in';
  warning.innerHTML=
    '<div class="captcha-warning-icon">!</div>'+
    '<div class="captcha-warning-title">检测到验证码，发送已暂停</div>'+
    '<div class="captcha-warning-sub">请在 BOSS 直聘页面手动完成验证后，点击继续发送</div>'+
    '<button class="btn btn-primary" id="resumeSendBtn">继续发送</button>';
  var ps=E.progressSection;
  if(ps&&ps.parentNode){
    ps.parentNode.insertBefore(warning,ps.nextSibling);
  }else{
    E.resultsPanel.appendChild(warning);
  }
  document.getElementById('resumeSendBtn').addEventListener('click',function(){
    var jobs=Store.get('jobs')||[];
    var jobIds=jobs.filter(function(j){return j.checked}).map(function(j){return j.id});
    try{
      chrome.runtime.sendMessage({type:MSG.START_SEND,jobIds:jobIds,retryKind:'captcha_resume'},function(resp){
        var w=document.getElementById('captchaWarning');
        if(resp&&resp.success){
          if(w)w.remove();
          Store.set('sending',true);
          E.btnSend.textContent='停止发送';
          E.btnSend.classList.add('sending');
          E.btnSend.disabled=false;
          E.progressText.textContent='正在继续投递...';
          E.progressSub.textContent='';
        }else{
          E.progressText.textContent='继续投递失败';
          E.progressSub.textContent=(resp&&resp.error)||'请确保BOSS直聘聊天页已打开';
        }
      });
    }catch(e){
      E.progressText.textContent='继续投递失败';
      E.progressSub.textContent='扩展上下文异常，请刷新页面重试';
    }
  });
}

// ════════════════════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════════════════════

function init(){
  if(typeof TAG_DATA==='undefined'){
    console.warn('TAG_DATA not loaded, attempting dynamic load...');
    var appEl=document.getElementById('app');
    if(!appEl)return;
    appEl.innerHTML='<div style="padding:40px;text-align:center;color:#666"><p>正在加载标签数据...</p></div>';
    var script=document.createElement('script');
    script.src='../content/tag-data.js';
    script.onload=function(){
      if(typeof TAG_DATA!=='undefined'){init()}
      else{appEl.innerHTML='<div style="padding:40px;text-align:center"><p style="color:#e74c3c;font-size:14px">标签数据加载失败，请刷新重试</p></div>'}
    };
    script.onerror=function(){appEl.innerHTML='<div style="padding:40px;text-align:center"><p style="color:#e74c3c;font-size:14px">标签数据加载失败，请刷新重试</p></div>'};
    document.head.appendChild(script);
    return;
  }

  initDomRefs();

  // 诊断包：popup 打开事件（USER_EVENT）
  try{if(typeof DiagLogger!=='undefined')DiagLogger.userEvent('popup','popup/侧边栏打开')}catch(_){}

  // A page initial render
  window.renderCityChips('');
  window.renderSettings();
  window.renderResumeImages();
  // 初始 DOM 与 A 页成功渲染后才算真正打开；不与 onInstalled 的 extension_first_run 混用。
  try{if(window.JitouTrack)window.JitouTrack.fire('first_open',{})}catch(_){}
  try{if(window.JitouVideoCode)window.JitouVideoCode.init()}catch(_){}

  // 自定义招呼语三层（globalGreet/groupGreet/jobGreet）从 storage 恢复 → 刷新/重开状态保持。
  // 独立于主 restore：读到即写 Store，再 refreshGreetCustomUI（若已进 B 页则重渲组卡招呼语区/岗位框，
  // 否则后续 renderGroupsStable 读的已是恢复后的 Store）。两条 get 竞态均被覆盖。
  try{chrome.storage.local.get([STORAGE_KEYS.UI.GLOBAL_GREET,STORAGE_KEYS.UI.GROUP_GREET,STORAGE_KEYS.UI.JOB_GREET],function(gr){
    if(typeof gr[STORAGE_KEYS.UI.GLOBAL_GREET]==='string')Store.set('globalGreet',gr[STORAGE_KEYS.UI.GLOBAL_GREET]);
    if(gr[STORAGE_KEYS.UI.GROUP_GREET])Store.set('groupGreet',gr[STORAGE_KEYS.UI.GROUP_GREET]);
    if(gr[STORAGE_KEYS.UI.JOB_GREET])Store.set('jobGreet',gr[STORAGE_KEYS.UI.JOB_GREET]);
    window.refreshGreetCustomUI&&window.refreshGreetCustomUI();
  })}catch(e){}

  // Restore resume images + filter state from storage (merged single call)
  try{chrome.storage.local.get(['resumeImages',STORAGE_KEYS.UI.FILTER_STATE],function(r){
    // Resume images
    var stored=r.resumeImages||[];
    stored.forEach(function(it){
      var thumbSrc=it.thumb||(it.data?arrayBufferToDataUrl(it.data,it.type||'image/jpeg'):null);
      if(!it.data&&!thumbSrc)return;
      var images=Store.get('resumeImages')||[];
      var entry={src:thumbSrc||it.data,name:it.name,id:it.id||Date.now()+'_'+Math.random().toString(36).slice(2,6)};
      if(it.fullSrc)entry.fullSrc=it.fullSrc;
      else if(it.data)entry.fullSrc=arrayBufferToDataUrl(it.data,it.type||'image/jpeg');
      images.push(entry);
      Store.set('resumeImages',images);
    });
    if(stored.length)window.refreshBImages();
    // Filter state
    var filterState=r[STORAGE_KEYS.UI.FILTER_STATE];
    if(filterState){
      if(filterState.selectedCities&&filterState.selectedCities.length)Store.set('selectedCities',filterState.selectedCities);
      if(filterState.selectedPositions)Store.set('selectedPositions',filterState.selectedPositions);
      if(filterState.customPositions)Store.set('customPositions',filterState.customPositions);
      if(filterState.hrActiveFilter)Store.set('hrActiveFilter',filterState.hrActiveFilter);
      if(filterState.welfareFilter)Store.set('welfareFilter',filterState.welfareFilter);
      if(filterState.restDayFilter)Store.set('restDayFilter',filterState.restDayFilter);
      if(filterState.selectedIndustries)Store.set('selectedIndustries',filterState.selectedIndustries);
      if(filterState.workAreasByCity)Store.set('workAreasByCity',filterState.workAreasByCity);
      else if(filterState.workAreas&&filterState.selectedCities&&filterState.selectedCities.length===1){
        // 旧版 flat workAreas 迁移：单城用户绑到其唯一城市
        var _m={};_m[filterState.selectedCities[0]]=filterState.workAreas;Store.set('workAreasByCity',_m);
      }
      if(filterState.jobTypes)Store.set('jobTypes',filterState.jobTypes);
      if(filterState.salaryRanges)Store.set('salaryRanges',filterState.salaryRanges);
      if(filterState.experience)Store.set('experience',filterState.experience);
      if(filterState.education)Store.set('education',filterState.education);
      if(filterState.companySizes)Store.set('companySizes',filterState.companySizes);
      if(filterState.fundingStages)Store.set('fundingStages',filterState.fundingStages);
      window.renderCityChips('');
      window.renderChipSecs();
      window.renderSettings();
    }
  })}catch(e){}

  // Load state from background
  try{
    chrome.runtime.sendMessage({type:MSG.GET_STATE},function(resp){
      console.log('[P1D-POPUP] GET_STATE resp', { success: resp && resp.success, phase: resp && resp.state && resp.state.phase, jobsLen: resp && resp.state && resp.state.jobs && resp.state.jobs.length });
      if(resp&&resp.success&&resp.state)handleStateUpdate(resp.state);
    });
  }catch(e){}

  // Init event delegation
  window.initEventsA();
  window.initEventsB();

  // ── Settings overlay events ──
  function showSettings(){E.settingsOverlay.classList.remove('hidden')}
  function hideSettings(){E.settingsOverlay.classList.add('hidden')}
  E.gearBtn.addEventListener('click',showSettings);
  E.settingsClose.addEventListener('click',hideSettings);
  E.settingsOverlay.addEventListener('click',function(e){
    if(e.target===E.settingsOverlay)hideSettings();
  });

  // ── Chrome message listener ──
  if(typeof chrome!=='undefined'&&chrome.runtime&&chrome.runtime.onMessage){
    chrome.runtime.onMessage.addListener(function(msg){
      console.log('[P1D-POPUP] onMessage', msg && msg.type);
      // 回退挡板：COLLECT_CITY_PROGRESS/COLLECT_PROGRESS/EXTRACT_PROGRESS 直写 E.progressText/
      // progressSub/bottomResults 等 DOM，不经过 handleStateUpdate。STOP_COLLECT 是异步的，停止
      // 生效前后台仍可能再广播几条「迟到」进度——若不挡，会在已回退定格的 A 页上突然改写出
      // B 页内容（如 updateProgress 命中 collected>=total 分支会 remove('hidden') bottomResults），
      // 表现为「第一次点回退仍跳 B、第二次才稳」（第二次时迟到消息已耗尽）。
      if(userBackedOut)return;
      if(msg.type===MSG.COLLECT_CITY_PROGRESS&&msg.progress){
        var p=msg.progress;
        E.progressText.textContent='已完成 '+p.completed+'/'+p.total+' 个城市';
        E.progressSub.textContent='已收集 '+p.jobsCollected+' 个岗位';
      }
      if(msg.type===MSG.COLLECT_PROGRESS){
        window.updateProgress(msg.collected||0,msg.total||0,msg.statusText,msg.statusSub);
      }
      if(msg.type===MSG.EXTRACT_PROGRESS){
        // v6 阶段1：搜索页批量提取HR信息进度
        // msg 包含 { done, total, extracted }
        if(window.updateProgress){
          window.updateProgress(msg.extracted||0,msg.total||0,'正在提取HR信息');
        }
      }
      if(msg.type===MSG.STATE_UPDATE&&msg.state){
        handleStateUpdate(msg.state);
      }
      if(msg.type===MSG.SEND_PROGRESS){
        if(msg.progress){
          var p=msg.progress;
          var _pShown=p.total>0?Math.min(p.sent,p.total):p.sent; // 分子封顶到分母，杜绝倒挂
          E.progressText.textContent='正在发送 ('+_pShown+'/'+p.total+')...';
          E.progressFill.style.width=p.total>0?Math.min(Math.round(p.sent/p.total*100),100)+'%':'0%';
        }
      }
      if(msg.type===MSG.SEND_COMPLETE){
        console.log('[REVIEW-DIAG] SEND_COMPLETE msg arrived', {sending:Store.get('sending'), resultsLen:(msg.results||[]).length, mode:Store.get('mode'), awaitingCollect:Store.get('awaitingCollect')});
        if(Store.get('sending')){
          Store.set('sending',false);
          E.btnSend.textContent='已发送完成';
          E.btnSend.classList.remove('sending');
          E.btnSend.disabled=true;
          E.btnSend.style.background='var(--green)';
          window.renderReview(msg.results||[],msg.duration,msg.missedCount||0);
        }
      }
      if(msg.type===MSG.GREETING_AUTO_ENABLED){
        // pre-flight 自动开启了 BOSS 打招呼开关：投递照常，给一条非阻断提示。
        // 不写 progressSub（EXTRACT_PROGRESS→updateProgress 几秒内会覆盖它），独立 notice 块仿 captchaWarning 插法。
        if(!document.getElementById('greetingAutoNotice')){
          var gn=document.createElement('div');
          gn.id='greetingAutoNotice';
          gn.className='fade-in';
          gn.style.cssText='margin:8px 0;padding:8px 12px;background:#f0f9f4;color:#1a7f4b;border-radius:8px;font-size:12px;line-height:1.5;';
          gn.textContent='已为你自动开启 BOSS『自动打招呼』功能（投递必需）';
          if(E.progressSection&&E.progressSection.parentNode){
            E.progressSection.parentNode.insertBefore(gn,E.progressSection);
          }
        }
      }
      if(msg.type===MSG.ERROR){
        // SW 的 ERROR 消息字段键不统一：收集类用 message，发送类(phase:'sending')用 error。
        // 统一兜底读 message||error，避免真错误被吞成「请重试」。
        var _errText=msg.message||msg.error;
        if(Store.get('mode')==='results'&&!Store.get('progressDone')){
          E.progressText.textContent='收集过程中出现错误';
          E.progressSub.textContent=_errText||'请重试';
        }
        if(Store.get('sending')){
          Store.set('sending',false);
          E.btnSend.textContent='一键发送';
          E.btnSend.classList.remove('sending');
          E.btnSend.disabled=false;
          E.btnSend.style.background='';
          E.progressText.textContent='发送失败';
          E.progressSub.textContent=_errText||'请重试';
        }
      }
    });
  }
}

document.addEventListener('DOMContentLoaded',init);
