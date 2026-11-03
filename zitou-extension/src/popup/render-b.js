// ════════════════════════════════════════════════════════════
// 即投 — B 页（结果页）四级增量 DOM 渲染
// ════════════════════════════════════════════════════════════
// Depends on: E, Store, $/$$/esc (global)
// Depends on: CONFIG (from constants.js)
// Depends on: MSG (from constants.js)
// Depends on: renderResumeThumbnailsHTML (from render-a.js)

// ── Internal: track rendered job count per group ──
var _jobsRendered={};

// ── State preparation helpers ──

// ── 组图片初始默认：A 页全局 resumeImages 深拷贝（每组独立数组，不共享引用）──
window.defaultGroupImages=function(){
  return JSON.parse(JSON.stringify(Store.get('resumeImages')||[]));
};

// 分来源传 picker(严格) + custom(宽松)，与 SW matchJobToPosition 完全同源。
window.prepareGroups=function(picker,custom,jobs){
  picker=picker||[];custom=custom||[];
  var allPos=picker.concat(custom);
  if(!allPos.length)return[];
  // 归组统一委托共享真相源 matchJobToExpected（constants.js），与 SW matchJobToPosition 完全同源
  // → B 页编辑组 === 发送组（编辑 key === 发送 key），且采到的岗位不会落「其他」。
  var groups=[],byPos={};
  allPos.forEach(function(pos){
    var g={position:pos,greeting:{text:'正在生成招呼语...',editing:false},fileName:'',jobs:[],images:window.defaultGroupImages()};
    groups.push(g);byPos[pos]=g;
  });
  var unmatched=[];
  jobs.forEach(function(job){
    var pos=matchJobToExpected(job,picker,custom);
    if(pos!=='其他'&&byPos[pos]){byPos[pos].jobs.push(job);}
    else{unmatched.push(job);}
  });
  groups=groups.filter(function(g){return g.jobs.length>0});
  // 「其他」仅作 0 匹配极端 fallback（采集与分组同源，正常不该出现）
  if(unmatched.length){
    groups.push({position:'其他',greeting:{text:'正在生成招呼语...',editing:false},fileName:'',jobs:unmatched,images:window.defaultGroupImages()});
  }
  return groups;
};

window.initJobCustom=function(force){
  if(force)Store.set('jobCustom',{});
  var jc=Store.get('jobCustom')||{};
  var jobs=Store.get('jobs')||[];
  jobs.forEach(function(j){
    if(!jc[j.id])jc[j.id]={expanded:false,customGreeting:'',customFileName:'',images:[]};
  });
  Store.set('jobCustom',jc);
};

window.applyGreetingsToGroups=function(){
  var greetings=Store.get('greetings');
  if(!greetings||!Object.keys(greetings).length)return false;
  var groups=Store.get('groups')||[];
  var changed=false;
  groups.forEach(function(g){
    // 优先用期望岗位名匹配（SW 按 position 聚类生成），fallback 到 tag 首项
    var aiGreeting=greetings[g.position];
    if(!aiGreeting){
      var bestTag='其他',bestCount=0,tagCounts={};
      g.jobs.forEach(function(j){
        var tag=(j.tags&&j.tags[0])||'其他';
        tagCounts[tag]=(tagCounts[tag]||0)+1;
      });
      for(var t in tagCounts){if(tagCounts[t]>bestCount){bestTag=t;bestCount=tagCounts[t]}}
      aiGreeting=greetings[bestTag];
    }
    if(aiGreeting&&g.greeting.text!==aiGreeting){g.greeting.text=aiGreeting;changed=true}
  });
  if(changed)Store.set('groups',groups);
  return changed;
};

window.syncGroupGreeting=function(gi){
  var groups=Store.get('groups')||[];
  var g=groups[gi];
  if(!g||!g.jobs.length)return;
  // 用期望岗位名作为 greeting key（与 SW position-based 聚类保持一致）
  var key=g.position;
  if(!key) return;
  var greetings=Store.get('greetings')||{};
  greetings[key]=g.greeting.text;
  Store.set('greetings',greetings);
  try{chrome.runtime.sendMessage({type:MSG.UPDATE_GREETING,category:key,greeting:g.greeting.text})}catch(ex){}
};

// ── Progress ──
window.updateProgress=function(collected,total,statusText,statusSub){
  if(total>0){
    E.progressFill.classList.remove('indeterminate');
    E.progressFill.style.width=Math.min(Math.round(collected/total*100),100)+'%';
  } else {
    E.progressFill.classList.add('indeterminate');
    E.progressFill.style.width='30%';
  }
  E.progressText.textContent=statusText||'正在搜集岗位...';
  // 删「已找到 N 个匹配岗位」计数：进度条只有实时分子、无分母画不出确定进度，且「匹配」措辞误导
  // （BOSS 搜索页会混进大量与 query 无关岗位，搜集≠匹配）。statusSub 由上游显式传入时才显示。
  E.progressSub.textContent=statusSub||'';
  if(total>0&&collected>=total){
    E.progressFill.classList.remove('indeterminate');
    E.progressText.textContent='完成！共搜集 '+total+' 个岗位';
    E.progressSub.textContent='';
    E.bottomResults.classList.remove('hidden');
  }
};

// ── Level 1: Group card structure stabilization ──

// ── 组级缩略图 HTML（每组独立 g.images，data-ggi 标识组）──
window.renderGroupThumbnailsHTML=function(gi){
  var g=(Store.get('groups')||[])[gi];
  var images=(g&&g.images)||[];
  var html='';
  for(var ii=0;ii<images.length;ii++){
    html+='<div class="univ-thumb" style="position:relative">'
      +'<img src="'+images[ii].src+'" alt="简历缩略图" data-ggi="'+gi+'" data-idx="'+ii+'">'
      +'<span class="thumb-remove" data-ggi="'+gi+'" data-idx="'+ii+'">&#x2715;</span>'
      +'</div>';
  }
  html+='<div class="univ-thumb-add" data-gact="addImg" data-ggi="'+gi+'">+</div>';
  return html;
};

// ── 单组卡 DOM 构建（renderGroupsStable 首建 + syncGroupsWithJobs 增量建组共用）──
function _buildGroupCardEl(g,gi){
  var card=document.createElement('div');
    card.className='group-card';
    card.dataset.gi=gi;

    // Header
    var hdr=document.createElement('div');
    hdr.className='group-header';
    hdr.innerHTML='<span class="group-title">'+esc(g.position)+'</span>'
      +'<span class="group-count">'+g.jobs.length+'个岗位</span>';
    card.appendChild(hdr);

    // 组级招呼语单框已废（一岗一招呼语：招呼语下放到每张岗位卡内常显，见 renderJobItemHTML）。

    // Resume images section (per group) — 始终渲染，空态保留添加入口
    // 每组独立 g.images（data-garea 标识组级缩略图区，供按组刷新）
    var rSec=document.createElement('div');
    rSec.className='group-section';
    rSec.innerHTML='<div class="section-subtitle">图片版简历</div>'
      +'<div class="univ-thumb-area" data-garea="'+gi+'" style="flex-wrap:wrap">'
      +window.renderGroupThumbnailsHTML(gi)
      +'</div>';
    card.appendChild(rSec);

    // 组级「招呼语」区块（插在图片版简历与岗位之间）：AI 定制 / 自定义 二段胶囊 + 自定义时组文本框
    var grSec=document.createElement('div');
    grSec.className='group-section group-greet-sec';
    grSec.dataset.gi=gi;
    grSec.innerHTML=window.groupGreetSecHTML(g,gi);
    card.appendChild(grSec);

    // Jobs container (empty, populated by Level 2)
    var jobsSec=document.createElement('div');
    jobsSec.className='group-section';
    var jobsTitle=document.createElement('div');
    jobsTitle.className='section-subtitle';
    jobsTitle.style.marginBottom='8px';
    jobsTitle.style.display='flex';
    jobsTitle.style.alignItems='center';
    jobsTitle.style.justifyContent='space-between';
    jobsTitle.innerHTML='<span>岗位</span>'
      +'<div class="job-master-checkbox" data-master-gi="'+gi+'"><svg class="jm-check" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2.5 6l2.5 3 4.5-5"/></svg><svg class="jm-dash" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2.5 6h7"/></svg></div>';
    jobsSec.appendChild(jobsTitle);
    var jobsContainer=document.createElement('div');
    jobsContainer.className='group-jobs';
    jobsContainer.dataset.gi=gi;
    jobsSec.appendChild(jobsContainer);
    card.appendChild(jobsSec);

  return card;
}

// ── 组级「招呼语」区块 HTML（二段胶囊 + 自定义时组文本框）──
window.groupGreetSecHTML=function(g,gi){
  var gg=(Store.get('groupGreet')||{})[g&&g.position]||{};
  var mode=(gg.mode==='custom')?'custom':'ai';
  var html='<div class="section-subtitle">招呼语</div>'
    +'<div class="greet-mode-seg" data-gi="'+gi+'">'
    +'<div class="seg-opt'+(mode==='ai'?' active':'')+'" data-groupmode="ai" data-gi="'+gi+'">AI 定制</div>'
    +'<div class="seg-opt'+(mode==='custom'?' active':'')+'" data-groupmode="custom" data-gi="'+gi+'">自定义</div>'
    +'</div>';
  if(mode==='custom'){
    html+='<div class="group-default-greet">'
      +'<textarea class="custom-ta" data-groupgreet="'+gi+'" placeholder="留空则发送全局-自定义招呼语。">'+esc(gg.text||'')+'</textarea>'
      +'</div>';
  }
  return html;
};

// 切组级模式 → 落 groupGreet[position].mode + 重渲该组招呼语区 + 强制重渲组内各岗框（切换 AI/自定义框类型）
window.setGroupGreetMode=function(gi,mode){
  var groups=Store.get('groups')||[];
  var g=groups[gi];
  if(!g)return;
  var gg=Store.get('groupGreet')||{};
  if(!gg[g.position])gg[g.position]={mode:'ai',text:''};
  gg[g.position].mode=mode;
  Store.set('groupGreet',gg);
  var sec=document.querySelector('#groupedContent .group-greet-sec[data-gi="'+gi+'"]');
  if(sec)sec.innerHTML=window.groupGreetSecHTML(g,gi);
  window.forceRenderGroupJobBoxes(gi);
  window.JDPrefetch&&window.JDPrefetch.renderAllJobStates&&window.JDPrefetch.renderAllJobStates();
  window.syncSendBtnGenState&&window.syncSendBtnGenState();
};

// 强制重渲某组已渲染岗位的招呼语框（绕开 typing 守护，用于模式切换需切换框类型时）
window.forceRenderGroupJobBoxes=function(gi){
  var groups=Store.get('groups')||[];
  var g=groups[gi];
  if(!g)return;
  var jc=Store.get('jobCustom')||{};
  (g.jobs||[]).forEach(function(job){
    var host=document.querySelector('#groupedContent .job-greet-host[data-job-id="'+job.id+'"]');
    if(!host)return;
    var base=window.jobGreetBaseStatus(job,jc);
    var status=(base==='pending')?'queued':base;
    var greeting=(jc[job.id]&&jc[job.id].customGreeting)||'';
    host.innerHTML=window.jobGreetBoxHTML(job.id,status,greeting);
    window.markClampedGreets(host);
  });
};

// ── B 页顶部「全局-自定义招呼语」区块（常驻 resultsContent 顶部，组卡之上；默认折叠）──
window.ensureGlobalGreetBlock=function(){
  var host=E.resultsContent;
  if(!host)return;
  if(document.getElementById('bGlobalGreet'))return;
  var box=document.createElement('div');
  box.id='bGlobalGreet';
  box.className='greet-card b-default-greet collapsed-row';
  box.innerHTML='<div class="job-resume-toggle collapsed b-greet-toggle">&#9654; 全局-自定义招呼语</div>';
  host.insertBefore(box,host.firstChild);
};
window.renderGlobalGreetBlock=function(expand){
  var box=document.getElementById('bGlobalGreet');
  if(!box)return;
  var val=Store.get('globalGreet')||'';
  if(expand){
    box.classList.remove('collapsed-row');
    box.classList.add('expanded');
    box.innerHTML='<div class="job-resume-toggle b-greet-toggle">&#9660; 全局-自定义招呼语</div>'
      +'<textarea class="custom-ta" data-globalgreet="1" rows="3" placeholder="自定义招呼语发送顺序：单岗位 > 期望岗位 > 全局。留空则发送：您好，我对这个岗位很感兴趣，我的经历与岗位要求比较匹配，已附上简历，期待与您进一步沟通。">'+esc(val)+'</textarea>';
  }else{
    box.classList.add('collapsed-row');
    box.classList.remove('expanded');
    box.innerHTML='<div class="job-resume-toggle collapsed b-greet-toggle">&#9654; 全局-自定义招呼语</div>';
  }
};
window.toggleGlobalGreet=function(){
  var box=document.getElementById('bGlobalGreet');
  if(!box)return;
  window.renderGlobalGreetBlock(!box.classList.contains('expanded'));
};

// 恢复自定义招呼语三层后（popup 重开），若已在 B 页则重渲全局块 + 各组招呼语区/岗位框
window.refreshGreetCustomUI=function(){
  if(Store.get('mode')!=='results')return;
  window.ensureGlobalGreetBlock();
  var box=document.getElementById('bGlobalGreet');
  if(box)window.renderGlobalGreetBlock(box.classList.contains('expanded'));
  var groups=Store.get('groups')||[];
  for(var gi=0;gi<groups.length;gi++){
    var sec=document.querySelector('#groupedContent .group-greet-sec[data-gi="'+gi+'"]');
    if(sec)sec.innerHTML=window.groupGreetSecHTML(groups[gi],gi);
    window.forceRenderGroupJobBoxes(gi);
  }
  window.syncSendBtnGenState&&window.syncSendBtnGenState();
};

window.renderGroupsStable=function(){
  var groups=Store.get('groups')||[];
  window.ensureGlobalGreetBlock&&window.ensureGlobalGreetBlock(); // B 页顶部「全局-自定义招呼语」常驻块
  E.groupedContent.innerHTML='';
  _jobsRendered={};

  var frag=document.createDocumentFragment();
  for(var gi=0;gi<groups.length;gi++){
    var g=groups[gi];
    // 旧快照兼容：无 g.images 时回填 A 页全局默认（深拷贝，不共享引用）
    if(g&&!g.images)g.images=window.defaultGroupImages();
    _jobsRendered[gi]=0;
    frag.appendChild(_buildGroupCardEl(g,gi));
  }
  E.groupedContent.appendChild(frag);

  // Level 2: Initial append (default CONFIG.MAX_JOBS_PER_GROUP = 6)
  var maxPerGroup=CONFIG.MAX_JOBS_PER_GROUP||6;
  for(var gi2=0;gi2<groups.length;gi2++){
    window.appendJobsToGroup(gi2,0,maxPerGroup);
    window.recalcGroupMaster(gi2);
  }

  window.updResCnt();
  window.JDPrefetch&&window.JDPrefetch.renderAllJobStates&&window.JDPrefetch.renderAllJobStates();
};

// ── Level 2: Job item HTML ──

// 招呼语刷新图标（单岗刷新键复用，与 mockup 同形）
var JOBGREET_REFRESH_SVG='<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2 8a6 6 0 0 1 11.3-3.3M14 8a6 6 0 0 1-11.3 3.3"/><path d="M13.5 2v3h-3M2.5 14v-3h3"/></svg>';

// ── 单岗招呼语派生状态 ──
// 'none'    : 未勾选（不渲染招呼语框，对照 mockup 76+ 普通未勾卡）
// 'done'    : 已生成（含用户手改）→ 文字 5 行截断 + 刷新键 + 可点进编辑
// 'failed'  : 生成失败（ok=false 且无招呼语）→ 失败提示 + 刷新键
// 'generating'/'queued' : 勾选了但还没出招呼语；并发内的算生成中、其余排队（无 SW 单岗起始信号，按并发数启发式区分）
window.jobGreetBaseStatus=function(job,jc){
  if(!job)return 'none';
  var e=(jc||{})[job.id];
  if(e&&e.excluded)return 'excluded'; // 取JD阶段三标签终判不符→排除tag（已取消勾选，故须先于 checked 判才显）
  if(!job.checked)return 'none';
  if(e&&(e.userEdited||(e.customGreeting&&e.customGreeting.trim())))return 'done';
  if(e&&e.jdFailed)return 'failed';
  return 'pending'; // generating / queued 由 renderAllJobStates 按并发顺序细分
};

// skipReason（content.js judgeJdFilters 原值）→ 展示文案（文案E）。原值不改，仅在渲染层映射。
window.jobExcludeReasonText=function(skipReason){
  switch(skipReason){
    case '未明确双休':   return '不符合「周末双休」筛选条件';
    case '未明确五险一金': return '不符合「五险一金」筛选条件';
    case 'HR活跃不符':   return '不符合「'+(({'3日内活跃':'HR 3日内活跃','本周内活跃':'HR 本周内活跃','本月内活跃':'HR 本月内活跃','只投在线':'HR 在线'})[Store.get('hrActiveFilter')]||'HR 活跃度')+'」筛选条件';
    default:            return '不符合筛选条件';
  }
};

// ── 自定义招呼语：有效模式判定（岗位级覆盖 > 组级 > 默认 AI）──
// 组 key = g.position（matchJobToExpected 同真相源，编辑 key===发送 key）。
window.groupPosOfJob=function(jobId){
  var gi=window.giOfJob(jobId);
  var g=(Store.get('groups')||[])[gi];
  return g?g.position:'';
};
window.effGreetMode=function(jobOrId){
  var id=(typeof jobOrId==='string')?jobOrId:(jobOrId&&jobOrId.id);
  if(!id)return 'ai';
  var jg=(Store.get('jobGreet')||{})[id];
  if(jg&&(jg.mode==='ai'||jg.mode==='custom'))return jg.mode; // 岗位级覆盖
  var gg=(Store.get('groupGreet')||{})[window.groupPosOfJob(id)];
  if(gg&&gg.mode==='custom')return 'custom';                  // 组级
  return 'ai';                                                // 默认
};

// AI 模式招呼语框的下拉 mini-label（两态：AI 定制招呼语 ▾ / 单岗位-自定义招呼语 ▾）
function greetDdLabelHTML(jobId,label,muted){
  return '<div class="mini-label dropdown'+(muted?' muted':'')+'" data-greetdd="'+jobId+'">'
    +esc(label)+' <span class="dd-caret">&#9660;</span></div>';
}

// 单岗招呼语框内层 HTML（mini-label + greet-card），随状态切换
window.jobGreetBoxHTML=function(jobId,status,greeting){
  if(status==='none')return '';
  if(status==='excluded'){
    // 取JD阶段三标签终判不符（V3 整卡降调退场）：占招呼语框位显极简一行 text-weak 文案（不生成招呼语、已取消勾选=不进投递队列）
    var ex=(Store.get('jobCustom')||{})[jobId]||{};
    return '<div class="excl-faint"><span class="excl-icon">&#8856;</span>'+esc(window.jobExcludeReasonText(ex.skipReason))+'</div>';
  }
  // 自定义模式岗：下拉 mini-label + 单岗位-自定义招呼语输入框（不进 JDPrefetch，无 AI 状态卡）
  if(window.effGreetMode(jobId)==='custom'){
    var jg=(Store.get('jobGreet')||{})[jobId]||{};
    return greetDdLabelHTML(jobId,'单岗位-自定义招呼语',false)
      +'<textarea class="custom-ta jobcustom-ta" data-jobgreet="'+jobId+'" placeholder="留空则发送期望岗位-自定义招呼语。">'+esc(jg.text||'')+'</textarea>';
  }
  // AI 定制模式：下拉 mini-label + 原状态卡（done/failed/queued/generating）
  if(status==='done'){
    return greetDdLabelHTML(jobId,'AI 定制招呼语',false)
      +'<div class="greet-card jobgreet" style="position:relative">'
      +'<div class="greet-text clip5" data-jobgreet-text="'+jobId+'">'+esc(greeting||'')+'</div>'
      +'<span class="greet-refresh" data-jobgreet-refresh="'+jobId+'">'+JOBGREET_REFRESH_SVG+'</span>'
      +'</div>';
  }
  if(status==='failed'){
    return greetDdLabelHTML(jobId,'AI 定制招呼语',false)
      +'<div class="greet-card jobgreet"><div class="greet-fail">生成失败，请刷新'
      +'<span class="greet-refresh inline" data-jobgreet-refresh="'+jobId+'">'+JOBGREET_REFRESH_SVG+'</span>'
      +'</div></div>';
  }
  if(status==='queued'){
    return greetDdLabelHTML(jobId,'AI 定制招呼语',true)
      +'<div class="greet-card jobgreet"><div class="skel"><div class="queued-tip">&#9203; 等待中…</div></div></div>';
  }
  // generating（含 pending 兜底）
  return greetDdLabelHTML(jobId,'AI 定制招呼语',true)
    +'<div class="greet-card jobgreet"><div class="skel">'
    +'<div class="skel-line" style="width:92%"></div><div class="skel-line" style="width:100%"></div><div class="skel-line" style="width:74%"></div>'
    +'<div class="gen-tip" style="margin-top:10px"><span class="spin"></span>正在生成招呼语…</div>'
    +'</div></div>';
};

// ── 招呼语模式下拉菜单（岗位卡 mini-label 点击展开，两项：AI 定制招呼语 / 单岗位-自定义招呼语）──
window.toggleGreetModeMenu=function(jobId,anchor){
  var host=anchor.parentNode;
  if(!host)return;
  var existing=host.querySelector('.greet-mode-menu');
  // 先关掉所有已展开菜单（单开）
  var all=document.querySelectorAll('#groupedContent .greet-mode-menu');
  for(var i=0;i<all.length;i++)all[i].remove();
  if(existing)return; // 点自身已展开 → 收起
  var eff=window.effGreetMode(jobId);
  var menu=document.createElement('div');
  menu.className='greet-mode-menu';
  menu.innerHTML='<div class="menu-item'+(eff==='ai'?' on':'')+'" data-setjobmode="ai" data-job-id="'+jobId+'">AI 定制招呼语'+(eff==='ai'?' <span class="tick">&#10003;</span>':'')+'</div>'
    +'<div class="menu-item'+(eff==='custom'?' on':'')+'" data-setjobmode="custom" data-job-id="'+jobId+'">单岗位-自定义招呼语'+(eff==='custom'?' <span class="tick">&#10003;</span>':'')+'</div>';
  anchor.insertAdjacentElement('afterend',menu);
};
// 选定岗位级模式 → 落 jobGreet[jobId].mode + 强制重渲该岗框（绕开 typing 守护，因需切换框类型）
window.setJobGreetMode=function(jobId,mode){
  var jg=Store.get('jobGreet')||{};
  if(!jg[jobId])jg[jobId]={mode:'',text:''};
  jg[jobId].mode=mode;
  Store.set('jobGreet',jg);
  var jobs=Store.get('jobs')||[],job=null;
  for(var i=0;i<jobs.length;i++)if(jobs[i].id===jobId){job=jobs[i];break;}
  var jc=Store.get('jobCustom')||{};
  var base=job?window.jobGreetBaseStatus(job,jc):'none';
  var status=(base==='pending')?'queued':base; // 切回 AI 且未生成 → 等待中（生成按钮显式触发）
  var greeting=(jc[jobId]&&jc[jobId].customGreeting)||'';
  var host=document.querySelector('#groupedContent .job-greet-host[data-job-id="'+jobId+'"]');
  if(host){host.innerHTML=window.jobGreetBoxHTML(jobId,status,greeting);window.markClampedGreets(host);}
  window.JDPrefetch&&window.JDPrefetch.renderAllJobStates&&window.JDPrefetch.renderAllJobStates();
  window.syncSendBtnGenState&&window.syncSendBtnGenState();
};

// 某 Range 末行（最后一个 client rect）的渲染宽度，用于把第 5 行卡到约 7/8。
function lastGreetLineWidth(el){
  var r=document.createRange();
  r.selectNodeContents(el);
  var rects=r.getClientRects();
  if(!rects.length)return 0;
  return rects[rects.length-1].width;
}
// 确定性截断：把招呼语真截成「前 4 行满 + 第 5 行约 7/8 + 字面 …」，所见即所得（不靠 CSS 渐变伪切口）。
// data-full 存原文供重跑还原（框 innerHTML 重建时元素是新的，首跑读 textContent 存下）。
// ≤5 行放得下的短招呼语直接返回，不截不加 …。隐藏态（scrollHeight=0）也返回，展开重渲时再截。
function clampGreetTo5(el){
  var full=el.getAttribute('data-full');
  if(full===null){full=el.textContent;el.setAttribute('data-full',full);}
  el.textContent=full;
  if(!el.clientWidth||el.scrollHeight===0)return; // 隐藏/未布局 → 不动，展开重渲再处理
  var cs=getComputedStyle(el);
  var lh=parseFloat(cs.lineHeight); if(!(lh>0))lh=parseFloat(cs.fontSize)*1.6;
  var padV=parseFloat(cs.paddingTop)+parseFloat(cs.paddingBottom);
  var maxH=Math.round(lh*5+padV)+2;               // scrollHeight 含 padding，阈值必含
  if(el.scrollHeight<=maxH)return;                 // ≤5 行放得下 → 不截不加 …
  var ell='…';
  var contentW=el.clientWidth-parseFloat(cs.paddingLeft)-parseFloat(cs.paddingRight);
  var targetW=contentW*0.875;                       // 第 5 行填到 7/8
  // 1) 二分找「slice(0,n)+… 仍 ≤5 行」的最大 n
  var lo=1,hi=full.length,fit=1;
  while(lo<=hi){var mid=(lo+hi)>>1;el.textContent=full.slice(0,mid)+ell;
    if(el.scrollHeight<=maxH){fit=mid;lo=mid+1;}else{hi=mid-1;}}
  // 2) 从 fit 往回收，直到第 5 行（末行）宽度 ≤ 7/8（回收只缩末行、不跳到第 4 行）
  var n=fit;
  for(;n>0;n--){el.textContent=full.slice(0,n)+ell;
    if(lastGreetLineWidth(el)<=targetW)break;}
  el.textContent=full.slice(0,Math.max(1,n))+ell;
}
// 招呼语框进 DOM 后对每个 done 态 clip5 框做确定性 5 行截断。rAF 等布局完成再量，scope 缺省全文档。
window.markClampedGreets=function(scope){
  var root=scope||document;
  requestAnimationFrame(function(){
    var els=root.querySelectorAll('.greet-card.jobgreet .greet-text.clip5');
    for(var i=0;i<els.length;i++)clampGreetTo5(els[i]);
  });
};

// 局部刷新某岗招呼语框（找不到该卡 DOM 则 no-op，待展开/重渲时重建）
window.updateJobGreetBox=function(jobId,status,greeting){
  var host=document.querySelector('#groupedContent .job-greet-host[data-job-id="'+jobId+'"]');
  if(!host)return;
  // 编辑中的卡不打扰（AI 编辑 .jobgreet-ta 或 单岗位自定义 .jobcustom-ta 在输入）
  if(host.querySelector('.jobgreet-ta')||host.querySelector('.jobcustom-ta'))return;
  host.innerHTML=window.jobGreetBoxHTML(jobId,status,greeting);
  // V3 整卡降调退场：JD 预取动态翻转排除态时，同步给外层卡加/去 job-item--excluded
  var item=host.closest&&host.closest('.job-item');
  if(item)item.classList.toggle('job-item--excluded',status==='excluded');
  window.markClampedGreets(host); // done 态框进 DOM 后量测溢出，仅真截断才显 …
};

function renderJobItemHTML(job){
  var jc=Store.get('jobCustom')||{};
  var st=window.jobGreetBaseStatus(job,jc);
  var greeting=(jc[job.id]&&jc[job.id].customGreeting)||'';
  // 选择先行：pending 岗首渲染为「等待中」（生成显式触发），renderAllJobStates 在有在途运行时再升为「生成中」
  var boxHTML=(st==='none')?'':window.jobGreetBoxHTML(job.id,st==='pending'?'queued':st,greeting);
  var resumeImgHTML=job.checked?window.renderJobResumeImgSection(job.id):'';
  var exclCls=(st==='excluded')?' job-item--excluded':''; // V3 整卡降调退场
  return '<div class="job-item'+exclCls+'" data-job-id="'+job.id+'"><div class="job-top-row">'
    +'<div class="job-checkbox'+(job.checked?' checked':'')+'" data-job-id="'+job.id+'"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2.5 6l2.5 3 4.5-5"/></svg></div>'
    +'<div class="job-info">'
    +'<div class="job-title">'+esc(job.name)+'</div>'
    +'<div class="job-company">'+esc(job.company)+'</div>'
    +'<div class="job-salary">'+esc(job.salary||'')+'</div>'
    +'<div class="job-tags">'+(job.tags||[]).map(function(t){return'<span class="job-tag">'+esc(t)+'</span>'}).join('')+'</div>'
    +'<div class="job-greet-host" data-job-id="'+job.id+'">'+boxHTML+'</div>'
    +'<div class="job-resume-host" data-job-id="'+job.id+'">'+resumeImgHTML+'</div>'
    +'</div></div></div>';
}

// ── Level 2: Incremental job append (DocumentFragment) ──

window.appendJobsToGroup=function(gi,start,count){
  var groups=Store.get('groups')||[];
  var g=groups[gi];
  if(!g)return;

  var jobsContainer=document.querySelector('.group-jobs[data-gi="'+gi+'"]');
  if(!jobsContainer)return;

  var end=Math.min(start+count,g.jobs.length);
  if(start>=end)return;

  var frag=document.createDocumentFragment();
  var wrapper=document.createElement('div');

  for(var ji=start;ji<end;ji++){
    var job=g.jobs[ji];
    wrapper.innerHTML=renderJobItemHTML(job);
    frag.appendChild(wrapper.firstElementChild);
  }

  // Remove expand button before appending
  var expandBtn=jobsContainer.querySelector('.expand-more-jobs');
  if(expandBtn)expandBtn.parentNode.removeChild(expandBtn);

  jobsContainer.appendChild(frag);
  _jobsRendered[gi]=end;

  // Re-add expand button if more jobs remain
  if(end<g.jobs.length){
    var btn=document.createElement('div');
    btn.className='expand-more-jobs';
    btn.dataset.gi=gi;
    btn.textContent='展开全部 '+g.jobs.length+' 个岗位（剩余 '+(g.jobs.length-end)+' 个）';
    jobsContainer.appendChild(btn);
  }
  // 新追加的卡按当前态校正招呼语框（queued/generating 顺位）
  window.JDPrefetch&&window.JDPrefetch.renderAllJobStates&&window.JDPrefetch.renderAllJobStates();
};

// ── Level 3: Targeted updates ──

// 单批硬上限（=BOSS 封号软线）：选中集恒 ≤ 此值。来源 CONFIG.SOFT_BATCH_LIMIT，别硬编。
window.batchCap=function(){
  return (typeof CONFIG!=='undefined'&&CONFIG.SOFT_BATCH_LIMIT)||75;
};
window.selectedCount=function(){
  var jobs=Store.get('jobs')||[];
  var n=0;for(var i=0;i<jobs.length;i++)if(jobs[i].checked)n++;return n;
};

// 满额 toast（side panel 底部居中黑色药丸，~2.5s 自动消失）
window.showCapToast=function(text){
  var host=document.getElementById('app')||document.body;
  var t=document.getElementById('capToast');
  if(t)t.remove();
  t=document.createElement('div');
  t.id='capToast';t.className='toast';
  t.innerHTML='<span class="ic">&#9888;&#65039;</span>'+esc(text);
  host.appendChild(t);
  setTimeout(function(){if(t&&t.parentNode)t.parentNode.removeChild(t);},2500);
};

window.toggleJobCheck=function(jobId){
  // 防御：先查 Store 再翻 DOM——id 不在 Store.jobs（幽灵卡）时不翻 class、不静默吞，留 warn 便于排查
  var jobs=Store.get('jobs')||[];
  var found=false,idx=-1;
  for(var i=0;i<jobs.length;i++){
    if(jobs[i].id===jobId){idx=i;found=true;break}
  }
  if(!found){console.warn('[即投] toggleJobCheck: 岗位不在 Store.jobs，已忽略点击 id=',jobId);return}
  // 硬上限闸：勾一个原本未选的岗，若已选满 cap → 拦截（不进选中集）+ toast，名额释放（取消已选）后可再勾
  if(!jobs[idx].checked){
    if(window.selectedCount()>=window.batchCap()){
      window.showCapToast('为避开 Boss 封号，单批投递上限 '+window.batchCap()+' 个');
      return;
    }
  }
  jobs[idx].checked=!jobs[idx].checked;
  var nowChecked=jobs[idx].checked;
  var cb=document.querySelector('.job-checkbox[data-job-id="'+jobId+'"]');
  if(cb)cb.classList.toggle('checked',nowChecked);
  Store.set('jobs',jobs);
  window.updResCnt();
  window.recalcGroupMaster(window.giOfJob(jobId));
  window.JDPrefetch&&window.JDPrefetch.onSelectionChanged();
  // 勾/取消 → 刷新该岗及全体招呼语态（新勾未生成的进生成中，取消的去框）
  window.JDPrefetch&&window.JDPrefetch.renderAllJobStates&&window.JDPrefetch.renderAllJobStates();
};

// ── Master checkbox (derived tri-state per group) ──

window.giOfJob=function(jobId){
  var groups=Store.get('groups')||[];
  for(var gi=0;gi<groups.length;gi++){
    var js=groups[gi].jobs||[];
    for(var j=0;j<js.length;j++){if(js[j].id===jobId)return gi}
  }
  return -1;
};

// returns 'all' | 'none' | 'partial'
window.groupMasterState=function(gi){
  var groups=Store.get('groups')||[];
  var g=groups[gi];
  if(!g||!g.jobs.length)return 'none';
  var jobs=Store.get('jobs')||[];
  var checkedMap={};
  for(var i=0;i<jobs.length;i++)checkedMap[jobs[i].id]=!!jobs[i].checked;
  var checked=0;
  for(var k=0;k<g.jobs.length;k++){if(checkedMap[g.jobs[k].id])checked++}
  if(checked===0)return 'none';
  if(checked===g.jobs.length)return 'all';
  return 'partial';
};

window.recalcGroupMaster=function(gi){
  if(gi<0)return;
  var el=document.querySelector('.job-master-checkbox[data-master-gi="'+gi+'"]');
  if(!el)return;
  var st=window.groupMasterState(gi);
  el.classList.remove('checked','indeterminate');
  if(st==='all')el.classList.add('checked');
  else if(st==='partial')el.classList.add('indeterminate');
};

window.toggleGroupMaster=function(gi){
  var groups=Store.get('groups')||[];
  var g=groups[gi];
  if(!g||!g.jobs.length)return;
  // all or partial -> clear all; none -> select all
  var target=window.groupMasterState(gi)==='none';
  var jobs=Store.get('jobs')||[];
  // 全选时受硬上限约束：只补到 cap，超出部分不勾 + toast（保证选中集恒 ≤ cap）
  var cap=window.batchCap();
  var capped=false;
  var checkedNow={};
  for(var c=0;c<jobs.length;c++)checkedNow[jobs[c].id]=!!jobs[c].checked;
  // 该组当前已选数（target=全选时这些会保留）
  var groupIds={};
  for(var k=0;k<g.jobs.length;k++)groupIds[g.jobs[k].id]=true;
  var checkedOutside=0;
  for(var o=0;o<jobs.length;o++){if(checkedNow[jobs[o].id]&&!groupIds[jobs[o].id])checkedOutside++;}
  var room=Math.max(0,cap-checkedOutside); // 组外已占用后，本组最多还能勾 room 个
  var ids={}; // 实际要翻成 target 的岗 id
  if(target){
    var picked=0;
    for(var gk=0;gk<g.jobs.length;gk++){
      if(picked<room){ids[g.jobs[gk].id]=true;picked++;}
      else capped=true; // 超出名额的不勾
    }
  }else{
    for(var uk=0;uk<g.jobs.length;uk++)ids[g.jobs[uk].id]=true; // 取消：组内全清
  }
  for(var i=0;i<jobs.length;i++){if(ids[jobs[i].id])jobs[i].checked=target}
  Store.set('jobs',jobs);
  // sync rendered job-checkbox DOM within this group
  var container=document.querySelector('.group-jobs[data-gi="'+gi+'"]');
  if(container){
    var boxes=container.querySelectorAll('.job-checkbox[data-job-id]');
    for(var b=0;b<boxes.length;b++){
      var bid=boxes[b].dataset.jobId;
      if(groupIds[bid])boxes[b].classList.toggle('checked',!!(ids[bid]&&target));
    }
  }
  if(capped)window.showCapToast('为避开 Boss 封号，单批投递上限 '+cap+' 个');
  window.updResCnt();
  window.recalcGroupMaster(gi);
  window.JDPrefetch&&window.JDPrefetch.onSelectionChanged();
  window.JDPrefetch&&window.JDPrefetch.renderAllJobStates&&window.JDPrefetch.renderAllJobStates();
};

window.renderJobThumbnailsHTML=function(jobId){
  var entry=(Store.get('jobCustom')||{})[jobId];
  var images=(entry&&entry.images)||[];
  var html='';
  for(var ii=0;ii<images.length;ii++){
    if(images[ii]._fromGroup)continue; // 只展示用户手动上传的 per-job 图；组下沉副本不显（data-idx 保留真实数组下标供删除）
    html+='<div class="univ-thumb" style="position:relative">'
      +'<img src="'+images[ii].src+'" alt="简历缩略图" data-job-img="'+jobId+'" data-idx="'+ii+'">'
      +'<span class="thumb-remove" data-job-img="'+jobId+'" data-idx="'+ii+'">&#x2715;</span>'
      +'</div>';
  }
  html+='<input type="file" id="jobFile_'+jobId+'" accept=".jpg,.jpeg,.png" style="display:none">'
    +'<div class="univ-thumb-add" data-gact="addJobImg" data-job-id="'+jobId+'">+</div>';
  return html;
};

// ── 自定义简历图区（每岗卡内，勾选时随招呼语框一同出现）──
// 默认折叠：只显折叠头「▸ 自定义简历图」，点开才出 ➕ 上传缩略区（省地方，见截图反馈）。
// 展开态存 jobCustom[jobId].resumeExpanded（默认 false=折叠；避开 expanded——那是「自定义消息」区的）。
// 上传后此岗投递发这张（覆盖本组通用图）。存储走 jobCustom[jobId].images
//（无 _fromGroup 标记=用户手动图，job-sender 优先读、组下沉避让）。
window.renderJobResumeImgSection=function(jobId){
  var entry=(Store.get('jobCustom')||{})[jobId]||{};
  var expanded=!!entry.resumeExpanded;
  var imgs=(entry.images||[]).filter(function(im){return !im._fromGroup;}); // 仅计用户手动图（与缩略区展示口径一致）
  var arrow=expanded?'&#9660;':'&#9654;';
  var cntBadge=imgs.length?' <span class="resume-toggle-cnt">'+imgs.length+'</span>':'';
  var head='<div class="job-resume-toggle'+(expanded?'':' collapsed')+'" data-job-id="'+jobId+'">'
    +arrow+' 自定义简历图'+cntBadge+'</div>';
  if(!expanded)return head; // 折叠态只留头，➕ 上传区不占位
  return head
    +'<div class="univ-thumb-area jobimg-area" style="flex-wrap:wrap">'
    +window.renderJobThumbnailsHTML(jobId)
    +'</div>';
};

// 折叠头点击 → 翻转 resumeExpanded 并只重渲染本岗简历图区（与 toggleJobCustom 同范式）。
window.toggleJobResumeImg=function(jobId){
  var jc=Store.get('jobCustom')||{};
  if(!jc[jobId])jc[jobId]={expanded:false,customGreeting:'',customFileName:'',images:[]};
  jc[jobId].resumeExpanded=!jc[jobId].resumeExpanded;
  Store.set('jobCustom',jc);
  var host=document.querySelector('#groupedContent .job-resume-host[data-job-id="'+jobId+'"]');
  if(host)host.innerHTML=window.renderJobResumeImgSection(jobId);
};

// 文档级委托监听折叠头（事件层归 events-b.js，但本任务仅动 render-b.js/popup.css，故就近委托，一次性挂）。
// click 冒泡到 document 时触发；与 events-b.js 的 groupedContent 委托互不干扰（选择器互斥、均不阻止冒泡）。
if(!window.__resumeToggleWired){
  window.__resumeToggleWired=true;
  document.addEventListener('click',function(e){
    var t=e.target.closest&&e.target.closest('.job-resume-toggle');
    if(t&&t.dataset.jobId)window.toggleJobResumeImg(t.dataset.jobId);
  });
}

// 幂等同步某岗自定义简历图区：show 且当前空→填充；!show 且当前有内容→清空。
// 只在勾选态切换时动 DOM（renderAllJobStates 每次进度刷新都调，避免闪烁/打断上传）。
window.updateJobResumeImgBox=function(jobId,show){
  var host=document.querySelector('#groupedContent .job-resume-host[data-job-id="'+jobId+'"]');
  if(!host)return;
  var has=host.childElementCount>0;
  if(show&&!has)host.innerHTML=window.renderJobResumeImgSection(jobId);
  else if(!show&&has)host.innerHTML='';
};

window.createJobCustomSettings=function(jobId){
  var item=document.querySelector('.job-item[data-job-id="'+jobId+'"]');
  if(!item)return null;
  var jc=Store.get('jobCustom')||{};
  if(!jc[jobId])jc[jobId]={expanded:false,customGreeting:'',customFileName:'',images:[]};
  Store.set('jobCustom',jc);
  var div=document.createElement('div');
  div.className='job-custom-settings';
  div.dataset.jobId=jobId;
  div.style.display='none';
  var thumbsHtml='<div class="univ-thumb-area" style="flex-wrap:wrap;margin-bottom:8px">'
    +window.renderJobThumbnailsHTML(jobId)
    +'</div>';

  div.innerHTML=thumbsHtml
    +'<textarea class="custom-ta" data-job-id="'+jobId+'" data-cs="greeting" placeholder="请输入自定义招呼语">'+esc(jc[jobId].customGreeting)+'</textarea>';
  var jobInfo=item.querySelector('.job-info');
  if(jobInfo)jobInfo.appendChild(div);
  return div;
};

window.toggleJobCustom=function(jobId){
  var settings=document.querySelector('.job-custom-settings[data-job-id="'+jobId+'"]');
  var toggle=document.querySelector('.job-custom-toggle[data-job-id="'+jobId+'"]');
  var jc=Store.get('jobCustom')||{};
  var entry=jc[jobId];
  if(!entry||!toggle)return;
  if(settings){
    var expanded=settings.style.display!=='none';
    settings.style.display=expanded?'none':'block';
    toggle.innerHTML=expanded?'&#9654; 自定义消息':'&#9660; 自定义消息';
    entry.expanded=!expanded;
  }else{
    settings=window.createJobCustomSettings(jobId);
    if(settings){
      settings.style.display='block';
      toggle.innerHTML='&#9660; 自定义消息';
      entry.expanded=true;
    }
  }
  Store.set('jobCustom',jc);
};

// ── 点卡片主体 → 在 BOSS 左侧列表定位并打开该岗 JD（r4 已删独立「查看JD详情」按钮，整卡可点）──
// 按 encryptJobId 唯一定位左侧卡并点击展开详情（不投递、不勾选）。
// btnEl（可选）= 兼容旧调用的反馈按钮，传入时在其上显示「定位中…/失败」；整卡点为 null，仅靠高亮反馈。
// 高亮「当前正在查看 JD」的岗位卡：清掉旧 active，给当前卡加 viewing 态（同时只一张）
window.setActiveJobCard=function(jobId){
  var prev=document.querySelectorAll('#groupedContent .job-item--viewing');
  for(var i=0;i<prev.length;i++)prev[i].classList.remove('job-item--viewing');
  if(!jobId)return;
  var cur=document.querySelector('#groupedContent .job-item[data-job-id="'+jobId+'"]');
  if(cur)cur.classList.add('job-item--viewing');
};

window.openJobDetailOnBoss=function(job,btnEl){
  if(!job)return;
  window.setActiveJobCard(job.id); // 点击即给视觉反馈，标记当前查看中的卡
  var origTxt=btnEl?btnEl.textContent:'';
  if(btnEl)btnEl.textContent='定位中...';
  try{
    // #③ 多城市多 tab：带上该岗采集时的归属 tab，SW 据此切到正确 BOSS 搜索页再定位（无则 SW 降级到第一个搜索页）
    chrome.runtime.sendMessage({type:MSG.OPEN_JOB_DETAIL,jobId:job.id,jobName:job.name,company:job.company,sourceTabId:job._sourceTabId},function(resp){
      if(!btnEl)return;
      if(chrome.runtime.lastError||!resp||!resp.success){
        btnEl.textContent=(resp&&resp.error)||'未找到该岗位';
        setTimeout(function(){btnEl.textContent=origTxt},2200);
      }else{
        btnEl.textContent=origTxt;
      }
    });
  }catch(ex){if(btnEl)btnEl.textContent=origTxt}
};

window.showGreetingEditor=function(gi){
  var greetText=document.querySelector('.greet-text[data-g="'+gi+'"]');
  var textarea=document.querySelector('.greet-textarea[data-g="'+gi+'"]');
  var groups=Store.get('groups')||[];
  var g=groups[gi];
  if(!g||!greetText||!textarea)return;
  textarea.value=g.greeting.text; // 以 Store 真相赋值，避免露出建卡时的陈旧快照
  greetText.classList.add('hidden');
  textarea.classList.remove('hidden');
  g.greeting.editing=true;
  Store.set('groups',groups);
  setTimeout(function(){textarea.focus()},0);
};

window.saveAndHideGreetingEditor=function(gi){
  var greetText=document.querySelector('.greet-text[data-g="'+gi+'"]');
  var textarea=document.querySelector('.greet-textarea[data-g="'+gi+'"]');
  var groups=Store.get('groups')||[];
  var g=groups[gi];
  if(!g||!greetText||!textarea)return;
  g.greeting.text=textarea.value;
  // 诊断包：招呼语编辑保存（脱敏：只记 key+长度，不记正文）
  try{if(typeof DiagLogger!=='undefined')DiagLogger.info('popup.greeting','招呼语编辑保存 key=g'+gi+' len='+String(textarea.value||'').length)}catch(_){}
  g.greeting.editing=false;
  Store.set('groups',groups);
  greetText.textContent=textarea.value;
  greetText.classList.remove('hidden');
  textarea.classList.add('hidden');
  window.syncGroupGreeting(gi);
};

window.updateGroupGreeting=function(gi){
  var groups=Store.get('groups')||[];
  var g=groups[gi];
  if(!g)return;
  var greetText=document.querySelector('.greet-text[data-g="'+gi+'"]');
  if(greetText)greetText.textContent=g.greeting.text;
  var ta=document.querySelector('.greet-textarea[data-g="'+gi+'"]');
  if(ta&&!g.greeting.editing&&document.activeElement!==ta)ta.value=g.greeting.text;
};

window.updateAllGreetings=function(){
  var groups=Store.get('groups')||[];
  groups.forEach(function(g,gi){window.updateGroupGreeting(gi)});
};

window.expandGroup=function(gi){
  var g=(Store.get('groups')||[])[gi];
  if(!g)return;
  Store.get('groupExpanded')||{};
  var exp=Store.get('groupExpanded')||{};
  exp[gi]=true;
  Store.set('groupExpanded',exp);
  var rendered=_jobsRendered[gi]||0;
  var remaining=g.jobs.length-rendered;
  if(remaining>0)window.appendJobsToGroup(gi,rendered,remaining);
};

window.refreshBImages=function(){
  window.renderResumeImages(); // A page
  // B 页：每组用各自 g.images 刷新（data-garea 仅组级缩略图区，不碰 job custom settings 的独立图片）
  $$('#groupedContent .univ-thumb-area[data-garea]').forEach(function(area){
    var gi=parseInt(area.dataset.garea);
    if(!isNaN(gi))area.innerHTML=window.renderGroupThumbnailsHTML(gi);
  });
};

// ── 单组缩略图刷新（按组上传/删除后只刷对应组）──
window.refreshGroupImages=function(gi){
  var area=document.querySelector('#groupedContent .univ-thumb-area[data-garea="'+gi+'"]');
  if(area)area.innerHTML=window.renderGroupThumbnailsHTML(gi);
};

window.updResCnt=function(){
  var jobs=Store.get('jobs')||[];
  var c=jobs.filter(function(j){return j.checked}).length;
  E.resultCountNum.textContent=c;
  E.resultCountTotal.textContent=jobs.length;
  E.btnSend.disabled=c===0;
  window.syncSendBtnGenState&&window.syncSendBtnGenState();
  window.updateWarnNote&&window.updateWarnNote();
};

// ── 顶部条件警告条：仅「搜集到的岗位总数 > cap」才渲染（≤cap 时不渲染）──
// 插在 #jdProgress 之后、groupedContent 之前（resultsContent 内）。
window.updateWarnNote=function(){
  var host=E.resultsContent;
  if(!host)return;
  var total=(Store.get('jobs')||[]).length;
  var cap=window.batchCap();
  var el=document.getElementById('jdWarnNote');
  if(total<=cap){if(el)el.remove();return;}
  if(!el){
    el=document.createElement('div');
    el.id='jdWarnNote';
    el.className='warn-note';
    // 紧跟 #jdProgress 之后（无则插到全局招呼语块之后、groupedContent 之前）
    var bar=document.getElementById('jdProgress');
    var _gbW=document.getElementById('bGlobalGreet');
    if(bar&&bar.nextSibling)host.insertBefore(el,bar.nextSibling);
    else if(E.groupedContent&&E.groupedContent.parentNode===host)host.insertBefore(el,E.groupedContent);
    else host.insertBefore(el,_gbW?_gbW.nextSibling:host.firstChild);
  }
  el.innerHTML='&#9888;&#65039; 共搜集 '+total+' 个岗位<br>为避开 Boss 封号，单批投递上限 '+cap+' 个';
};

// ── 勾选中的 AI 模式岗里「还没生成招呼语」的数量（done/failed 均视为已就绪，不阻塞发送）──
window.aiNeedGenCount=function(){
  var jobs=Store.get('jobs')||[];
  var jc=Store.get('jobCustom')||{};
  var n=0;
  for(var i=0;i<jobs.length;i++){
    var j=jobs[i];
    if(!j.checked)continue;
    if(window.effGreetMode(j)!=='ai')continue; // 自定义岗天然就绪
    var e=jc[j.id];
    var isDone=e&&(e.userEdited||(e.customGreeting&&e.customGreeting.trim()));
    var isFailed=e&&e.jdFailed; // 失败岗发送时被 SW 丢弃，不阻塞按钮
    if(!isDone&&!isFailed)n++;
  }
  return n;
};

// ── 底栏按钮意图机（选择先行 + 显式生成）：disabled / generating / generate / send ──
// disabled  : 未勾任何岗 → 置灰「生成招呼语」+ title 提示
// generating: 生成运行中（JDPrefetch 在途）→「生成中…」置灰
// generate  : 勾了需 AI 生成的岗、当前无在途运行 → 可点「生成招呼语」（点击起生成）
// send      : 勾选岗招呼语全就绪（AI 全生成完 + 自定义天然就绪，或全是自定义岗）→「一键发送」
window.sendBtnIntent=function(){
  if(Store.get('sending'))return 'stop';
  if(window.selectedCount()===0)return 'disabled';
  var running=(window.JDPrefetch&&window.JDPrefetch._started&&window.JDPrefetch.pendingCount)?window.JDPrefetch.pendingCount():0;
  if(running>0)return 'generating';
  if(window.aiNeedGenCount()>0)return 'generate';
  return 'send';
};

// ── footer 发送键：按 sendBtnIntent 切文字/态（投递中不动，由 events-b 发送链管）──
window.syncSendBtnGenState=function(){
  if(!E.btnSend)return;
  if(Store.get('sending'))return; // 投递中按钮文案由 events-b 发送链管
  var intent=window.sendBtnIntent();
  E.btnSend.classList.remove('dim');
  E.btnSend.removeAttribute('title');
  if(intent==='disabled'){
    E.btnSend.textContent='生成招呼语';
    E.btnSend.disabled=true;
    E.btnSend.title='勾选岗位后开始';
  }else if(intent==='generating'){
    E.btnSend.textContent='生成中…';
    E.btnSend.classList.add('dim');
    E.btnSend.disabled=true;
  }else if(intent==='generate'){
    E.btnSend.textContent='生成招呼语';
    E.btnSend.disabled=false;
  }else{ // send
    E.btnSend.textContent='一键发送';
    E.btnSend.disabled=false;
  }
};

// ── 单岗招呼语进编辑（点已生成文字 → 展开整段可改 textarea，复用 custom-ta 的 input 同步 + 编辑守护）──
window.showJobGreetEditor=function(jobId){
  var host=document.querySelector('#groupedContent .job-greet-host[data-job-id="'+jobId+'"]');
  if(!host)return;
  var jc=Store.get('jobCustom')||{};
  if(!jc[jobId]){jc[jobId]={expanded:false,customGreeting:'',customFileName:'',images:[]};Store.set('jobCustom',jc);}
  var cur=(jc[jobId]&&jc[jobId].customGreeting)||'';
  host.innerHTML='<div class="mini-label">AI 定制招呼语</div>'
    +'<textarea class="custom-ta jobgreet-ta" data-job-id="'+jobId+'" data-cs="greeting">'+esc(cur)+'</textarea>';
  var ta=host.querySelector('.jobgreet-ta');
  if(ta){setTimeout(function(){ta.focus();ta.selectionStart=ta.selectionEnd=ta.value.length;},0);}
};
// 退出编辑：回 done 态展示（customGreeting 已由 input 守护实时落盘）
window.saveJobGreetEditor=function(jobId){
  var jc=Store.get('jobCustom')||{};
  var cur=(jc[jobId]&&jc[jobId].customGreeting)||'';
  window.updateJobGreetBox(jobId,cur&&cur.trim()?'done':'failed',cur);
};

// ── 幽灵卡根治：groups/DOM 与 Store.jobs 增量校正 ──
// _processJobsUpdate 在 jobs 长度变化时整体替换 Store.jobs，但 groups DOM 只首建不重建，
// 导致 DOM 卡 id 不在 Store.jobs（UI 勾了 Store 没勾 → 投递 0 岗 / 反向多投隐形岗位）。
// 此函数做增量校正（不整体重跑 renderGroupsStable，避免丢用户输入、闪烁）：
//   1. groups 里 id 已不在新 jobs 的 → 从组数据和 DOM 移除
//   2. 新 jobs 里 id 不在 groups 的 → 按现有归组逻辑（matchJobToExpected 同真相源）归组并增量渲染，组不存在则增建组卡
//   3. 存活 id 保留用户勾选状态（新 jobs 默认 checked=true 不得覆盖用户已取消的勾选）
window.syncGroupsWithJobs=function(){
  var jobs=Store.get('jobs')||[];
  var groups=Store.get('groups')||[];
  if(!groups.length)return;
  var jobById={};
  for(var i=0;i<jobs.length;i++)jobById[jobs[i].id]=jobs[i];
  var inGroup={};
  var touched={};
  // 1+3) 移除幽灵卡 + 存活卡恢复用户勾选状态（组内引用替换为新 Store.jobs 对象，保持共享引用模式）
  for(var gi=0;gi<groups.length;gi++){
    var g=groups[gi];
    var oldJobs=g.jobs||[];
    var kept=[];
    for(var j=0;j<oldJobs.length;j++){
      var old=oldJobs[j];
      var nj=jobById[old.id];
      if(nj){
        if(old.checked!==undefined)nj.checked=old.checked;
        kept.push(nj);
        inGroup[old.id]=true;
      }else{
        touched[gi]=true;
        var el=document.querySelector('#groupedContent .job-item[data-job-id="'+old.id+'"]');
        if(el){
          if(el.parentNode)el.parentNode.removeChild(el);
          if(_jobsRendered[gi]>0)_jobsRendered[gi]--;
        }
      }
    }
    g.jobs=kept;
  }
  // 2) 新 jobs 归组：复用首建同源的 matchJobToExpected；「全部岗位」模式全部归入该组
  var picker=Store.get('selectedPositions')||[];
  var custom=Store.get('customPositions')||[];
  var byPos={},giOf={};
  groups.forEach(function(gg,idx){byPos[gg.position]=gg;giOf[gg.position]=idx});
  for(var k=0;k<jobs.length;k++){
    var njob=jobs[k];
    if(inGroup[njob.id])continue;
    var pos=byPos['全部岗位']?'全部岗位':matchJobToExpected(njob,picker,custom);
    var tg=byPos[pos];
    if(!tg){
      // 该期望岗位此前无组（首建时 0 岗被过滤）→ 增建组卡（数据+DOM，追加到末尾不动既有 gi）
      tg={position:pos,greeting:{text:'正在生成招呼语...',editing:false},fileName:'',jobs:[],images:window.defaultGroupImages()};
      groups.push(tg);
      var ngi=groups.length-1;
      byPos[pos]=tg;giOf[pos]=ngi;
      _jobsRendered[ngi]=0;
      E.groupedContent.appendChild(_buildGroupCardEl(tg,ngi));
    }
    tg.jobs.push(njob);
    inGroup[njob.id]=true;
    touched[giOf[pos]]=true;
  }
  Store.set('groups',groups); // appendJobsToGroup 内部读 Store，先落数据
  Store.set('jobs',jobs);     // 存活岗位 checked 已在上面就地恢复
  // 3) 受影响组的 DOM 校正：计数、空组隐藏、增量补渲、展开按钮、master 三态
  var maxPer=(typeof CONFIG!=='undefined'&&CONFIG.MAX_JOBS_PER_GROUP)||6;
  var exp=Store.get('groupExpanded')||{};
  for(var tk in touched){
    var tgi=parseInt(tk);
    var tgrp=groups[tgi];
    if(!tgrp)continue;
    var card=document.querySelector('.group-card[data-gi="'+tgi+'"]');
    if(card){
      card.style.display=tgrp.jobs.length?'':'none'; // 空组隐藏（不删卡，保持 gi 索引稳定）
      var cnt=card.querySelector('.group-count');
      if(cnt)cnt.textContent=tgrp.jobs.length+'个岗位';
    }
    var rendered=_jobsRendered[tgi]||0;
    var target=exp[tgi]?tgrp.jobs.length:Math.min(tgrp.jobs.length,maxPer);
    if(rendered<target){
      window.appendJobsToGroup(tgi,rendered,target-rendered);
    }else{
      // 渲染数不变 → 手动校正「展开全部」按钮文案/存在性
      var container=document.querySelector('.group-jobs[data-gi="'+tgi+'"]');
      if(container){
        var btn=container.querySelector('.expand-more-jobs');
        if(rendered>=tgrp.jobs.length){
          if(btn&&btn.parentNode)btn.parentNode.removeChild(btn);
        }else{
          if(!btn){btn=document.createElement('div');btn.className='expand-more-jobs';btn.dataset.gi=tgi;container.appendChild(btn)}
          btn.textContent='展开全部 '+tgrp.jobs.length+' 个岗位（剩余 '+(tgrp.jobs.length-rendered)+' 个）';
        }
      }
    }
    window.recalcGroupMaster(tgi);
  }
  window.updResCnt();
  // 同步后断言：DOM 渲染卡 id 集合 ⊆ Store.jobs id 集合
  var domItems=document.querySelectorAll('#groupedContent .job-item[data-job-id]');
  for(var d=0;d<domItems.length;d++){
    var did=domItems[d].dataset.jobId;
    if(!jobById[did])console.warn('[即投] syncGroupsWithJobs 断言失败：DOM 残留幽灵卡 id=',did);
  }
};

// ── 发送前：组图片下沉到组内每个岗位的 jobCustom.images（job-sender 优先读 ui:jobCustom，无需改 SW/content）──
// 组图片仍等于 A 页全局默认（按 id 比对）→ 不下沉，走 job-sender 的全局 resumeImages 兜底（二进制原图，省 storage 配额）；
// 组图片被用户改过 → 下沉该组所有岗位（带 _fromGroup 标记，不覆盖用户手动设置的 per-job 图片）。
window.syncGroupImagesToJobCustom=function(){
  var groups=Store.get('groups')||[];
  if(!groups.length)return;
  var globalIds=(Store.get('resumeImages')||[]).map(function(im){return im.id}).join(',');
  var jc=Store.get('jobCustom')||{};
  var changed=false;
  groups.forEach(function(g){
    var gImgs=g.images||[];
    var isDefault=gImgs.map(function(im){return im.id}).join(',')===globalIds;
    (g.jobs||[]).forEach(function(j){
      if(!jc[j.id])jc[j.id]={expanded:false,customGreeting:'',customFileName:'',images:[]};
      var entry=jc[j.id];
      var imgs=entry.images||[];
      var hasUserImgs=false;
      for(var i=0;i<imgs.length;i++){if(!imgs[i]._fromGroup){hasUserImgs=true;break}}
      if(hasUserImgs)return; // 用户手动 per-job 图片优先，不动
      var cleared=!isDefault&&gImgs.length===0; // 组图被用户明确清空（非默认且空）→ 不走全局兜底
      if(!!entry.noImages!==cleared){entry.noImages=cleared;changed=true;try{if(typeof DiagLogger!=='undefined')DiagLogger.info('popup.groupImg','noImages变更 jobId='+j.id+' cleared='+cleared+' noImages='+cleared)}catch(_){}}
      var next=isDefault?[]:gImgs.map(function(im){return{id:im.id,src:im.src,fullSrc:im.fullSrc,name:im.name,_fromGroup:true}});
      if(imgs.length||next.length){entry.images=next;changed=true}
    });
  });
  if(changed){
    Store.set('jobCustom',jc);
    // persistUIState 有 300ms 防抖，发送链路读 storage——这里直写一次确保发送前已落盘
    try{
      if(typeof STORAGE_KEYS!=='undefined'){
        var save={};save[STORAGE_KEYS.UI.JOB_CUSTOM]=jc;
        chrome.storage.local.set(save);
      }
    }catch(ex){}
  }
};

// ── Skeleton loading placeholders ──
window.showSkeleton=function(groupCount){
  var container=E.groupedContent;
  if(!container)return;
  var html='';
  for(var i=0;i<groupCount;i++){
    html+='<div class="skeleton-card">'
      +'<div class="skeleton-title"></div>'
      +'<div class="skeleton-line"></div>'
      +'<div class="skeleton-line"></div>'
      +'<div class="skeleton-line"></div>'
      +'</div>';
  }
  container.innerHTML=html;
};
// hideSkeleton removed — renderGroupsStable replaces innerHTML, auto-clearing skeleton

// ════════════════════════════════════════════════════════════
// JD 定制招呼语预取控制器（甲方案：进 B 页后台静默预取选中岗 JD 招呼语）
// 单写者：popup 是 ui:jobCustom 唯一写者；SW 仅经 JD_PROGRESS 回填，命中 userEdited 不覆盖。
// 契约字符串硬编码（与 SW 端一致）：START_JD_PREFETCH / CANCEL_JD_PREFETCH / JD_PROGRESS。
// ════════════════════════════════════════════════════════════
// 单批投递上限（=BOSS 封号软线），默认选中前 cap 岗。来源 CONFIG.SOFT_BATCH_LIMIT，别硬编。
window.JD_BATCH_CAP=(typeof CONFIG!=='undefined'&&CONFIG.SOFT_BATCH_LIMIT)||75;
window.JDPrefetch={
  _started:false,      // 本批是否已发起预取
  _startTimer:null,    // scheduleStart 防抖
  _retriggerTimer:null,// 换选区重触发防抖
  _forceIds:null,      // 本次 start 需强制重生成（跳 SW 缓存）的 jobId 集，发出后清空
  _lastSig:null,       // 上次已发批次签名（jobId 集有序拼接）；同批不重发闸 → 掐 run 风暴
  done:0,
  total:0,

  // 采集中→新一批：清零（独立 onMessage 监听见 phase='collecting' 调）
  reset:function(){
    this._started=false;this.done=0;this.total=0;this._lastSig=null;
    clearTimeout(this._startTimer);clearTimeout(this._retriggerTimer);
    this._renderBar();
  },

  // 采集完成（phase='ready'）防抖触发：默认选中前 75 → 起预取（每批一次）
  scheduleStart:function(){
    var self=this;
    clearTimeout(this._startTimer);
    // 让 popup.js 的 _processJobsUpdate(300ms 防抖)先落定 jobs，再读最终岗位集
    this._startTimer=setTimeout(function(){
      if(self._started)return;
      self.applyDefaultSelection();
      self.start();
    },450);
  },

  // 默认选中前 75 岗（扁平顺序），同步勾选框 DOM + 组 master + 计数
  applyDefaultSelection:function(){
    var jobs=Store.get('jobs')||[];
    if(!jobs.length)return;
    var cap=window.JD_BATCH_CAP;
    for(var i=0;i<jobs.length;i++)jobs[i].checked=(i<cap);
    Store.set('jobs',jobs);
    // 同步已渲染勾选框
    var checkedMap={};
    for(var k=0;k<jobs.length;k++)checkedMap[jobs[k].id]=!!jobs[k].checked;
    var boxes=document.querySelectorAll('#groupedContent .job-checkbox[data-job-id]');
    for(var b=0;b<boxes.length;b++){
      boxes[b].classList.toggle('checked',!!checkedMap[boxes[b].dataset.jobId]);
    }
    var groups=Store.get('groups')||[];
    for(var gi=0;gi<groups.length;gi++)window.recalcGroupMaster(gi);
    window.updResCnt();
    // 默认选区落定后刷新各岗框：前 cap 进生成中、cap 之后未勾的去框
    this.renderAllJobStates();
  },

  // 收集当前勾选岗（≤cap），带 jobLink + category
  _buildPayload:function(){
    var groups=Store.get('groups')||[];
    var jobs=Store.get('jobs')||[];
    var checkedMap={};
    for(var k=0;k<jobs.length;k++)checkedMap[jobs[k].id]=!!jobs[k].checked;
    var out=[];
    var cap=window.JD_BATCH_CAP;
    for(var gi=0;gi<groups.length&&out.length<cap;gi++){
      var g=groups[gi];var gj=g.jobs||[];
      for(var j=0;j<gj.length&&out.length<cap;j++){
        var job=gj[j];
        if(!checkedMap[job.id])continue;
        if(window.effGreetMode(job)!=='ai')continue; // 自定义模式岗不进 JDPrefetch（只生成 AI 岗）
        out.push({jobId:job.id,jobLink:job.link||'',category:g.position,sourceTabId:job._sourceTabId});
      }
    }
    return out;
  },

  // 发起预取（先 CANCEL 旧的，再 START 新的）。force 集中的岗让 SW 跳缓存重生成（单岗刷新用）。
  start:function(){
    var payload=this._buildPayload();
    var force=this._forceIds;
    // 本批签名（jobId 集有序拼接）：同批已在途/已发就短路，不重发 CANCEL/START → 掐 run 风暴根因
    // （collecting/ready 抖动、重复 STATE_UPDATE 会反复触发 start；同批多 run 并发砸后端致组级 8s 超时）
    var sig=payload.map(function(p){return p.jobId;}).sort().join(',');
    var forced=!!(force&&force.length);
    if(!forced&&this._started&&sig===this._lastSig){
      // 同批重触发：只刷进度条（done 可能已推进），不发消息、不重起 run
      this.total=payload.length;
      this.done=this._countReady(payload);
      this._renderBar();
      return;
    }
    this._forceIds=null;
    // force 的岗本地视作未就绪（已在 refreshJob 清了 customGreeting），不计入 done
    this.total=payload.length;
    this.done=this._countReady(payload);
    this._renderBar();
    if(!payload.length)return;
    this._lastSig=sig;
    // seed：popup 已有招呼语回填 SW 内存缓存（MV3 idle 杀 SW 后 _jdGreetingCache 清空，重启 run 全 miss 会重生成）。force 岗不 seed（本就要重生成）。
    var seedArr=[];
    var jcSeed=Store.get('jobCustom')||{};
    for(var si=0;si<payload.length;si++){
      var sid=payload[si].jobId;
      if(force&&force.indexOf(sid)!==-1)continue;
      var se=jcSeed[sid];
      if(se&&typeof se.customGreeting==='string'&&se.customGreeting.trim())seedArr.push({jobId:sid,greeting:se.customGreeting,degraded:!!se.degraded});
    }
    try{chrome.runtime.sendMessage({type:'CANCEL_JD_PREFETCH'});}catch(e){}
    try{chrome.runtime.sendMessage({type:'START_JD_PREFETCH',jobs:payload,force:force||[],seed:seedArr},function(){/* ack 忽略，进度走 JD_PROGRESS */});}catch(e){}
    this._started=true;
  },

  // 单岗刷新：清掉该岗已生成招呼语 + 解除编辑守护 → 进生成中态 → 带 force 重起预取（SW 跳缓存重生成该岗）
  refreshJob:function(jobId){
    var jc=Store.get('jobCustom')||{};
    if(!jc[jobId])jc[jobId]={expanded:false,customGreeting:'',customFileName:'',images:[]};
    jc[jobId].customGreeting='';
    jc[jobId].userEdited=false;
    jc[jobId].jdFailed=false;
    Store.set('jobCustom',jc);
    window.updateJobGreetBox(jobId,'generating','');
    this._forceIds=[jobId];
    this._started=true;
    this.start();
    this.renderAllJobStates();
  },

  // 全量刷新每岗招呼语框态：done/failed 据 jobCustom，pending 按并发数细分 generating/queued。
  renderAllJobStates:function(){
    var jobs=Store.get('jobs')||[];
    var jc=Store.get('jobCustom')||{};
    var conc=(typeof CONFIG!=='undefined'&&CONFIG.JD_API_CONCURRENCY)||3;
    // 有在途生成运行时才把前 conc 个 pending 岗显示为「生成中」，其余「等待中」；
    // 无运行（选择先行、未点生成）时所有 pending AI 岗一律「等待中」，不显误导的生成中骨架。
    var running=(this._started&&this.pendingCount()>0);
    var pendingSeen=0;
    for(var i=0;i<jobs.length;i++){
      var job=jobs[i];
      var base=window.jobGreetBaseStatus(job,jc);
      var status=base;
      // 自定义模式岗：忽略 AI 状态，jobGreetBoxHTML 内部按 effGreetMode 渲染自定义框（不占并发位）
      if(base==='pending'&&window.effGreetMode(job)==='ai'){
        status=(running&&pendingSeen<conc)?'generating':'queued';
        pendingSeen++;
      }
      var greeting=(jc[job.id]&&jc[job.id].customGreeting)||'';
      window.updateJobGreetBox(job.id,status,greeting);
      window.updateJobResumeImgBox(job.id,!!job.checked);
    }
    window.syncSendBtnGenState&&window.syncSendBtnGenState();
  },

  // 已就绪计数（已有 customGreeting 或用户已手改）— 重触发时秒回放的缓存可立即计入
  _countReady:function(payload){
    var jc=Store.get('jobCustom')||{};
    var n=0;
    for(var i=0;i<payload.length;i++){
      var e=jc[payload[i].jobId];
      if(e&&(e.userEdited||(e.customGreeting&&e.customGreeting.trim())))n++;
    }
    return n;
  },

  // 选择先行：勾选变化不再自动重触发生成（生成由「生成招呼语」按钮显式触发）。
  // 只刷新进度条 + 按钮态；新勾的未生成 AI 岗会让按钮回「生成招呼语」态（增量生成）。
  onSelectionChanged:function(){
    this._renderBar();
    window.syncSendBtnGenState&&window.syncSendBtnGenState();
  },

  // 「生成招呼语」按钮显式触发：建 payload（勾选∩AI 岗，跳缓存复用 seed）起生成。
  // 增量：已生成的岗 _countReady 计入 done，只生成新勾的未就绪 AI 岗（复用 SW 缓存/seed）。
  startManual:function(){
    this._started=true;
    this.start();
    this.renderAllJobStates();
    window.syncSendBtnGenState&&window.syncSendBtnGenState();
  },

  // 收到 SW 回填的单岗招呼语
  onProgress:function(msg){
    if(!msg||!msg.jobId)return;
    var jc=Store.get('jobCustom')||{};
    var id=msg.jobId;
    if(!jc[id])jc[id]={expanded:false,customGreeting:'',customFileName:'',images:[]};
    // 取JD阶段三标签终判不符 → 标记 excluded + 取消该岗勾选（=不进投递队列）+ 渲染排除 tag
    if(msg.excluded){
      jc[id].excluded=true;
      jc[id].skipReason=msg.skipReason||'';
      jc[id].jdFailed=false;jc[id].degraded=false;
      Store.set('jobCustom',jc);
      // 取消勾选：events-b.js:376 jobs.filter(checked) 是唯一投递入口，取消勾选=天然不投
      var jobsE=Store.get('jobs')||[];
      for(var xi=0;xi<jobsE.length;xi++){
        if(jobsE[xi].id===id){
          if(jobsE[xi].checked){
            jobsE[xi].checked=false;
            var cbE=document.querySelector('.job-checkbox[data-job-id="'+id+'"]');
            if(cbE)cbE.classList.remove('checked');
          }
          break;
        }
      }
      Store.set('jobs',jobsE);
      window.updResCnt&&window.updResCnt();
      window.recalcGroupMaster&&window.recalcGroupMaster(window.giOfJob(id));
      if(typeof msg.done==='number')this.done=msg.done;
      if(typeof msg.total==='number')this.total=msg.total;
      this._renderBar();
      this.renderAllJobStates();
      return;
    }
    jc[id].degraded=!!msg.degraded; // 存真值供 jdStat/诊断读降级率（只存不显，v1 不做用户可见标记）
    // 失败 = ok 假且无招呼语（如天花板超限/脏项）→ 标记供失败态渲染；成功则清失败标记
    jc[id].jdFailed=!(msg.ok&&msg.greeting);
    // 单写者 + 编辑守护：用户手改过的岗不覆盖（degraded 也照常填，不特殊标记打扰用户）
    if(!jc[id].userEdited&&msg.ok&&msg.greeting){
      jc[id].customGreeting=msg.greeting;
    }
    Store.set('jobCustom',jc); // 落盘（含 degraded/jdFailed）；编辑守护已在上分支内决定是否改 customGreeting
    if(typeof msg.done==='number')this.done=msg.done;
    if(typeof msg.total==='number')this.total=msg.total;
    this._renderBar();
    // 该岗翻 done/failed + 后续 pending 顺位前移（queued→generating）
    this.renderAllJobStates();
  },

  // gate：仍在生成中的岗数（投递前判 0 才放行）
  pendingCount:function(){
    if(!this._started||this.total<=0)return 0;
    return Math.max(0,this.total-this.done);
  },

  // 进度条 UI（插入 resultsContent 顶部，renderGroupsStable 只清 groupedContent 不动它）
  // 文案居中：生成中=琥珀「正在结合岗位详情 + 简历图片定制招呼语：n / 总」+spinner。
  // 完成态不再显示绿字「招呼语已生成完成」——全部生成后直接移除进度条，不留空壳。
  // 警告条已拆为独立 #jdWarnNote（仅搜集总数 > cap 才显），不再塞进度条里。
  _renderBar:function(){
    var host=E.resultsContent;
    if(!host)return;
    var el=document.getElementById('jdProgress');
    // 已全部生成完成：移除进度条（连带去掉完成态文案），仅刷新警告条
    if(this.total<=0||this.done>=this.total){if(el)el.remove();window.updateWarnNote&&window.updateWarnNote();return;}
    if(!el){
      el=document.createElement('div');
      el.id='jdProgress';
      el.className='jd-progress';
      el.innerHTML='<div class="jd-progress-text"></div>'
        +'<div class="jd-progress-track"><div class="jd-progress-fill"></div></div>';
      var _gb=document.getElementById('bGlobalGreet');
      host.insertBefore(el,_gb?_gb.nextSibling:host.firstChild);
    }
    var pct=this.total>0?Math.min(Math.round(this.done/this.total*100),100):0;
    var txt=el.querySelector('.jd-progress-text');
    var fill=el.querySelector('.jd-progress-fill');
    // 走到这里必是生成中（done>=total 已在上方提前 return）
    if(txt)txt.innerHTML='<span class="spin"></span>正在结合岗位详情 + 简历图片定制招呼语：'+this.done+' / '+this.total;
    if(fill)fill.style.width=pct+'%';
    window.updateWarnNote&&window.updateWarnNote();
  },
};
