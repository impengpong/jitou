// ════════════════════════════════════════════════════════════
// 即投 — B 页（结果页）事件委托
// ════════════════════════════════════════════════════════════
// Depends on: E, Store, $/$$/esc (global)
// Depends on: MSG (from constants.js)
// Depends on: render-b.js (window.* functions)

window.initEventsB=function(){
  if(window._eventsBInitialized)return;
  window._eventsBInitialized=true;

  // ── JD 定制招呼语预取：独立消息监听（与 popup.js 主监听并存，多 listener 合法）──
  // STATE_UPDATE phase 驱动控制器：collecting→重置；ready→默认选 75 并起预取。JD_PROGRESS→回填。
  if(typeof chrome!=='undefined'&&chrome.runtime&&chrome.runtime.onMessage){
    chrome.runtime.onMessage.addListener(function(msg){
      if(!msg||!window.JDPrefetch)return;
      if(msg.type==='JD_PROGRESS'){window.JDPrefetch.onProgress(msg);return;}
      if(msg.type===MSG.STATE_UPDATE&&msg.state){
        var ph=msg.state.phase;
        if(ph==='collecting')window.JDPrefetch.reset();
        // 选择先行：ready 不再自动全选+自动起生成。初始全不选，生成由「生成招呼语」按钮显式触发。
      }
    });
  }

  // ── Grouped content delegation ──
  E.groupedContent.addEventListener('click',function(e){
    try{
      // Per-job custom image upload
      var jact=e.target.closest('[data-gact="addJobImg"]');
      if(jact){
        var jobId=jact.dataset.jobId;
        var fileInput=document.getElementById('jobFile_'+jobId);
        if(fileInput)fileInput.click();
        return
      }
      // Per-job custom image remove
      var jrem=e.target.closest('.thumb-remove[data-job-img]');
      if(jrem){
        var jid=jrem.dataset.jobImg;
        var idx=parseInt(jrem.dataset.idx);
        var jc=Store.get('jobCustom')||{};
        var entry=jc[jid];
        if(entry&&entry.images&&idx>=0&&idx<entry.images.length){
          entry.images.splice(idx,1);
          Store.set('jobCustom',jc);
          // Re-render this job's thumb area
          var thumbArea=jrem.closest('.univ-thumb-area');
          if(thumbArea)thumbArea.innerHTML=window.renderJobThumbnailsHTML(jid);
        }
        return
      }

      // 单岗招呼语刷新键（done / failed 态）→ 重生成该岗（带 force 跳 SW 缓存）
      var jgRefresh=e.target.closest('[data-jobgreet-refresh]');
      if(jgRefresh){
        var rJobId=jgRefresh.getAttribute('data-jobgreet-refresh');
        if(rJobId&&window.JDPrefetch&&window.JDPrefetch.refreshJob)window.JDPrefetch.refreshJob(rJobId);
        return
      }
      // 点单岗招呼语文字 → 进编辑看全文（展开整段 textarea）
      var jgText=e.target.closest('.greet-text[data-jobgreet-text]');
      if(jgText){
        window.showJobGreetEditor(jgText.getAttribute('data-jobgreet-text'));
        return
      }

      // 岗位卡招呼语模式下拉（AI 定制 / 单岗位-自定义）：点 mini-label 展开菜单
      var greetdd=e.target.closest('[data-greetdd]');
      if(greetdd){
        window.toggleGreetModeMenu(greetdd.getAttribute('data-greetdd'),greetdd);
        return
      }
      // 下拉菜单项选定 → 设岗位级模式
      var setmode=e.target.closest('[data-setjobmode]');
      if(setmode){
        window.setJobGreetMode(setmode.getAttribute('data-job-id'),setmode.getAttribute('data-setjobmode'));
        return
      }
      // 组级招呼语二段胶囊（AI 定制 / 自定义）
      var segopt=e.target.closest('.seg-opt[data-groupmode]');
      if(segopt){
        var sgi=parseInt(segopt.dataset.gi);
        if(!isNaN(sgi))window.setGroupGreetMode(sgi,segopt.dataset.groupmode);
        return
      }

      // Greeting actions (rewrite)
      var gact=e.target.closest('[data-gact]');
      if(gact){
        if(gact.dataset.gact==='addImg'){
          // B 页组级添加：入口带组标识 data-ggi，上传只写该组 g.images（无 ggi 时兜底走 A 页全局入口）
          var addGgi=gact.dataset.ggi;
          if(addGgi!==undefined&&E.hiddenFileInputB){
            E.hiddenFileInputB.dataset.ggi=addGgi;
            E.hiddenFileInputB.click();
          }else{
            E.hiddenFileInput.click();
          }
          return
        }
        if(gact.dataset.gact==='addJobImg')return; // handled above
        var gi=parseInt(gact.dataset.g);
        if(isNaN(gi))return;
        var groups=Store.get('groups')||[];
        var g=groups[gi];
        if(!g)return;
        if(gact.dataset.gact==='rewrite'){
          gact.classList.add('spinning');
          var jdSamples=g.jobs.slice(0,5).map(function(j){
            return{title:j.name,tags:j.tags,desc:j.name};
          });
          chrome.runtime.sendMessage({type:MSG.REGENERATE_GREETING,category:g.position,jdSamples:jdSamples},function(resp){
            if(resp&&resp.success&&resp.greeting){
              g.greeting.text=resp.greeting;
              g.greeting.editing=false;
              Store.set('groups',groups);
              window.syncGroupGreeting(gi);
            }
            // Targeted update: refresh greeting display only
            window.updateGroupGreeting(gi);
            gact.classList.remove('spinning');
          });
        }
        return
      }

      // Expand group
      var exp=e.target.closest('.expand-more-jobs');
      if(exp){
        var egi=parseInt(exp.dataset.gi);
        if(!isNaN(egi))window.expandGroup(egi);
        return
      }

      // Click greet-text to edit
      var gt=e.target.closest('.greet-text[data-g]');
      if(gt){
        window.showGreetingEditor(parseInt(gt.dataset.g));
        return
      }

      // Image remove (B page) — 按组删除：只动该组 g.images，不再碰全局 resumeImages/storage
      var rem=e.target.closest('.thumb-remove[data-ggi]');
      if(rem){
        var rgi=parseInt(rem.dataset.ggi);
        var idx=parseInt(rem.dataset.idx);
        if(!isNaN(rgi)&&!isNaN(idx)&&idx>=0){
          var rGroups=Store.get('groups')||[];
          var rg=rGroups[rgi];
          if(rg&&rg.images&&idx<rg.images.length){
            rg.images.splice(idx,1);
            Store.set('groups',rGroups);
            window.refreshGroupImages(rgi);
          }
        }
        return
      }

      // Image lightbox (B page thumbnails) — 组级缩略图用该组 g.images 的 fullSrc
      var thumbImg=e.target.closest('.univ-thumb img');
      if(thumbImg){
        var src=thumbImg.src;
        if(thumbImg.dataset.ggi!==undefined){
          var lGroups=Store.get('groups')||[];
          var lg=lGroups[parseInt(thumbImg.dataset.ggi)];
          var lImg=lg&&lg.images&&lg.images[parseInt(thumbImg.dataset.idx)];
          if(lImg&&lImg.fullSrc)src=lImg.fullSrc;
        }else{
          var gimg=thumbImg.dataset.gimg;
          var images=Store.get('resumeImages')||[];
          var imgData=images[parseInt(gimg)];
          if(imgData&&imgData.fullSrc)src=imgData.fullSrc;
        }
        showImageLightbox(src);
        return
      }

      // Job custom toggle (lazy create)
      var toggle=e.target.closest('.job-custom-toggle');
      if(toggle){
        var id=toggle.dataset.jobId;
        window.toggleJobCustom(id);
        return
      }

      // Help tip: click ? to open full-size help image in new tab
      var helpTip=e.target.closest('.help-tip');
      if(helpTip){
        var imgUrl=chrome.runtime.getURL('src/popup/auto-reply-help.png');
        var html='<html><head><meta charset="utf-8"><title>自动回复简历说明</title><style>body{margin:0;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;background:#f0f0f0;font-family:-apple-system,BlinkMacSystemFont,sans-serif}img{max-width:800px;width:90%;border-radius:8px;box-shadow:0 2px 12px rgba(0,0,0,.12)}p{color:#555;font-size:14px;margin-top:16px}</style></head><body><img src="'+imgUrl+'" alt="自动回复说明"><p>帮助您识别 HR 消息中的关键词，进行自动回复附件简历。</p></body></html>';
        var b64=btoa(unescape(encodeURIComponent(html)));
        chrome.tabs.create({ url: 'data:text/html;charset=utf-8;base64,'+b64 });
        return
      }

      // Master checkbox: tri-state toggle for all jobs in group
      var master=e.target.closest('.job-master-checkbox');
      if(master){
        window.toggleGroupMaster(parseInt(master.dataset.masterGi));
        return
      }

      // 勾选框（独立模块）：点它才判定投不投这个岗，与「点卡片看详情」解耦
      var checkbox=e.target.closest('.job-checkbox');
      if(checkbox){
        window.toggleJobCheck(checkbox.dataset.jobId);
        return
      }

      // 点卡片主体 → 在 BOSS 左侧列表定位并打开该岗 JD（不投递、不勾选）
      var it=e.target.closest('.job-item');
      if(it){
        if(e.target.closest('.job-custom-settings')) return; // 自定义面板内不触发
        if(e.target.closest('.job-greet-host')) return; // 招呼语区（下拉/文本框/菜单）内不触发定位
        var jcId=it.dataset.jobId;
        var jcJob=(Store.get('jobs')||[]).filter(function(j){return j.id===jcId})[0];
        // 整卡点非按钮区 → btnEl 传 null，仅靠 setActiveJobCard 高亮做反馈（不在卡上塞「定位中」文案）
        if(jcJob)window.openJobDetailOnBoss(jcJob,null);
      }
    }catch(ex){console.error('groupedContent click:',ex)}
  });

  // Greeting textarea: Enter exits editing
  E.groupedContent.addEventListener('keydown',function(e){
    var ta=e.target.closest('.greet-textarea[data-g]');
    if(ta&&e.key==='Enter'&&!e.shiftKey){
      e.preventDefault();
      window.saveAndHideGreetingEditor(parseInt(ta.dataset.g));
    }
  });
  E.groupedContent.addEventListener('focusout',function(e){
    var ta=e.target.closest('.greet-textarea[data-g]');
    if(ta){window.saveAndHideGreetingEditor(parseInt(ta.dataset.g));return}
    // 单岗招呼语编辑：失焦即回展示态（customGreeting 已由 input 守护实时落盘 + 置 userEdited）
    var jta=e.target.closest('.jobgreet-ta[data-job-id]');
    if(jta&&window.saveJobGreetEditor)window.saveJobGreetEditor(jta.getAttribute('data-job-id'));
  });

  // Greeting & file name input (live sync)
  E.groupedContent.addEventListener('input',function(e){
    // 组级-自定义招呼语文本（data-groupgreet=gi → 落 groupGreet[position].text）
    var gGreet=e.target.closest('textarea[data-groupgreet]');
    if(gGreet){
      var ggi=parseInt(gGreet.dataset.groupgreet);
      var gGroups=Store.get('groups')||[];
      var gG=gGroups[ggi];
      if(gG){
        var gg=Store.get('groupGreet')||{};
        if(!gg[gG.position])gg[gG.position]={mode:'custom',text:''};
        gg[gG.position].text=gGreet.value;
        gg[gG.position].mode='custom';
        Store.set('groupGreet',gg);
      }
      return
    }
    // 单岗位-自定义招呼语文本（data-jobgreet=jobId → 落 jobGreet[jobId].text）
    var jGreet=e.target.closest('textarea[data-jobgreet]');
    if(jGreet){
      var jid=jGreet.dataset.jobgreet;
      var jg=Store.get('jobGreet')||{};
      if(!jg[jid])jg[jid]={mode:'custom',text:''};
      jg[jid].text=jGreet.value;
      Store.set('jobGreet',jg);
      return
    }
    var ta=e.target.closest('.greet-textarea[data-g]');
    if(ta){
      var gi=parseInt(ta.dataset.g);
      var groups=Store.get('groups')||[];
      var g=groups[gi];
      if(g)g.greeting.text=ta.value;
      Store.set('groups',groups);
      return
    }
    var fn=e.target.closest('.att-name-input[data-g]');
    if(fn){
      var gi=parseInt(fn.dataset.g);
      var groups=Store.get('groups')||[];
      var g=groups[gi];
      if(g)g.fileName=fn.value;
      Store.set('groups',groups);
      syncResumeFileNames();
      return
    }
    var inp=e.target.closest('.custom-ta');
    if(inp){
      var id=inp.dataset.jobId;
      var setting=inp.dataset.cs;
      var jc=Store.get('jobCustom')||{};
      var entry=jc[id];
      if(!entry)return;
      // 编辑守护：用户手改过该岗 → 标记 userEdited，JD_PROGRESS 后续不再覆盖
      if(setting==='greeting'){entry.customGreeting=inp.value;entry.userEdited=true;}
      Store.set('jobCustom',jc);
    }
  });

  // Per-job custom image upload (change event on dynamically created file inputs)
  E.groupedContent.addEventListener('change',function(e){
    var fileInput=e.target.closest('input[type="file"][id^="jobFile_"]');
    if(!fileInput)return;
    var files=fileInput.files;
    if(!files||!files.length)return;
    var jobId=fileInput.id.replace('jobFile_','');
    var jc=Store.get('jobCustom')||{};
    if(!jc[jobId])jc[jobId]={expanded:false,customGreeting:'',customFileName:'',images:[]};
    if(!jc[jobId].images)jc[jobId].images=[];
    // 组图片下沉副本（_fromGroup）不算用户 per-job 自定义：用户手动加图时先清掉，避免混发
    jc[jobId].images=jc[jobId].images.filter(function(im){return !im._fromGroup});
    var maxNew=10-(jc[jobId].images.length);
    var todo=[];
    for(var fi=0;fi<files.length&&todo.length<maxNew;fi++)todo.push(files[fi]);
    var done=0;
    var thatDiv=fileInput.closest('.univ-thumb-area');
    for(var ti=0;ti<todo.length;ti++)(function(f){
      var reader=new FileReader();
      reader.onload=function(ev){
        var ab=ev.target.result;
        var u8=new Uint8Array(ab);
        var img=new Image();
        img.onload=function(){
          var cv=document.createElement('canvas');
          var w=img.width,h=img.height;
          if(w>120){h=h*120/w;w=120}
          if(h>160){w=w*160/h;h=160}
          cv.width=Math.round(w);
          cv.height=Math.round(h);
          cv.getContext('2d').drawImage(img,0,0,cv.width,cv.height);
          var thumb=cv.toDataURL('image/jpeg',0.7);
          var cvLb=document.createElement('canvas');
          var lbW=img.width,lbH=img.height;
          if(lbW>800){lbH=lbH*800/lbW;lbW=800}
          if(lbH>1000){lbW=lbW*1000/lbH;lbH=1000}
          cvLb.width=Math.round(lbW);
          cvLb.height=Math.round(lbH);
          cvLb.getContext('2d').drawImage(img,0,0,cvLb.width,cvLb.height);
          var lightboxSrc=cvLb.toDataURL('image/jpeg',0.85);
          jc[jobId].images.push({src:thumb,fullSrc:lightboxSrc,name:f.name});
          URL.revokeObjectURL(img.src);
          done++;
          if(done===todo.length){
            fileInput.value='';
            Store.set('jobCustom',jc);
            if(thatDiv)thatDiv.innerHTML=window.renderJobThumbnailsHTML(jobId);
          }
        };
        img.src=URL.createObjectURL(new Blob([ab],{type:f.type}));
      };
      reader.readAsArrayBuffer(f);
    })(todo[ti]);
  });

  // ── B 页按组图片上传（hiddenFileInputB.dataset.ggi 标识目标组，只写该组 g.images）──
  E.hiddenFileInputB&&E.hiddenFileInputB.addEventListener('change',function(e){
    var gi=parseInt(E.hiddenFileInputB.dataset.ggi);
    var files=e.target.files;
    if(!files||!files.length||isNaN(gi))return;
    var groups=Store.get('groups')||[];
    var g=groups[gi];
    if(!g)return;
    if(!g.images)g.images=[];
    var maxNew=10-g.images.length;
    var todo=[];
    for(var fi=0;fi<files.length&&todo.length<maxNew;fi++)todo.push(files[fi]);
    if(!todo.length){e.target.value='';return}
    var done=0;
    for(var ti=0;ti<todo.length;ti++)(function(f){
      var reader=new FileReader();
      reader.onload=function(ev){
        var ab=ev.target.result;
        var img=new Image();
        img.onload=function(){
          var cv=document.createElement('canvas');
          var w=img.width,h=img.height;
          if(w>120){h=h*120/w;w=120}
          if(h>160){w=w*160/h;h=160}
          cv.width=Math.round(w);
          cv.height=Math.round(h);
          cv.getContext('2d').drawImage(img,0,0,cv.width,cv.height);
          var thumb=cv.toDataURL('image/jpeg',0.7);
          var cvLb=document.createElement('canvas');
          var lbW=img.width,lbH=img.height;
          if(lbW>800){lbH=lbH*800/lbW;lbW=800}
          if(lbH>1000){lbW=lbW*1000/lbH;lbH=1000}
          cvLb.width=Math.round(lbW);
          cvLb.height=Math.round(lbH);
          cvLb.getContext('2d').drawImage(img,0,0,cvLb.width,cvLb.height);
          var lightboxSrc=cvLb.toDataURL('image/jpeg',0.85);
          g.images.push({src:thumb,fullSrc:lightboxSrc,name:f.name,id:Date.now()+'_'+Math.random().toString(36).slice(2,6)});
          URL.revokeObjectURL(img.src);
          done++;
          if(done===todo.length){
            e.target.value='';
            Store.set('groups',groups);
            window.refreshGroupImages(gi);
          }
        };
        img.src=URL.createObjectURL(new Blob([ab],{type:f.type}));
      };
      reader.readAsArrayBuffer(f);
    })(todo[ti]);
  });

  // ── B 页顶部「全局-自定义招呼语」区块（在 resultsContent 内、groupedContent 之外）──
  if(E.resultsContent){
    E.resultsContent.addEventListener('click',function(e){
      var tg=e.target.closest('.b-greet-toggle');
      if(tg){window.toggleGlobalGreet&&window.toggleGlobalGreet();}
    });
    E.resultsContent.addEventListener('input',function(e){
      var g=e.target.closest('textarea[data-globalgreet]');
      if(g)Store.set('globalGreet',g.value);
    });
  }

  // ── Send button ──
  E.btnSend.addEventListener('click',function(){
    var sending=Store.get('sending');
    if(sending){
      // 停止＝硬中止 + 统一终态：不在本地把 sending 置 false（否则后续 SEND_COMPLETE 的
      // `if(sending)` 守卫为假 → review 不渲染）。保持 sending=true，让 SW 的 stopSend→
      // finalizeTask→SEND_COMPLETE 回来时正常落 review（底部按钮变「重新投递」）。
      // 诊断包：用户点停止（popup 侧打点；即使 STOP_SEND 没送达 SW 也有记录）
      try{if(typeof DiagLogger!=='undefined')DiagLogger.userEvent('popup','用户点击「停止发送」按钮')}catch(_){}
      E.btnSend.textContent='正在停止...';
      E.btnSend.disabled=true;
      E.progressText.textContent='正在停止...';
      E.progressSub.textContent='正在收尾，请稍候';
      try{chrome.runtime.sendMessage({type:MSG.STOP_SEND})}catch(ex){}
      return
    }
    // 选择先行 + 显式生成：按钮意图分流——置灰/生成中不动作；「生成招呼语」态点击起生成（不发送）。
    var intent=window.sendBtnIntent?window.sendBtnIntent():'send';
    if(intent==='disabled'||intent==='generating')return;
    if(intent==='generate'){
      if(window.JDPrefetch&&window.JDPrefetch.startManual)window.JDPrefetch.startManual();
      return
    }
    // intent==='send'：勾选岗招呼语全就绪 → 走原发送逻辑
    var jobs=Store.get('jobs')||[];
    var jobIds=jobs.filter(function(j){return j.checked}).map(function(j){return j.id});
    // 防御：Store 无勾选岗位（如 UI 勾选与 Store 脱节的幽灵卡场景）→ 不发 START_SEND，给用户可见提示
    if(jobIds.length===0){
      alert('当前没有已勾选的岗位，请重新勾选岗位后再投递');
      return
    }
    // ── JD 定制招呼语就绪闸：仍在生成中则不放行，提示稍候（别漏发定制语）──
    var jdPending=window.JDPrefetch?window.JDPrefetch.pendingCount():0;
    if(jdPending>0){
      alert('定制招呼语生成中 '+window.JDPrefetch.done+'/'+window.JDPrefetch.total+'，请稍候片刻再投递');
      return
    }
    // ── 投递数量闸门（gate）：在投递入口前置，向 SW 读当天已成功投递数后决策 ──
    // 两闸合并为一个 cap：cap = min(单批硬限 75, 日剩余 remaining)。本批 N=jobIds.length。
    //   日上限 150（本地自然日）：remaining=150-当天已投。
    //   ① cap<=0（日额度已满）→ 硬拦整批，弹窗提示。
    //   ② N>cap 且撞日剩余（remaining<75）→ 硬截断：confirm「只投前 cap 个」，文案讲清剩日额度。
    //   ③ N>cap 且撞单批 75（remaining 仍≥75）→ 硬截断：confirm「单批最多 75，只投前 75」。
    //   ④ N<=cap → 正常投，无提示。
    // 读计数失败（SW 异常）走 fail-open：count=0 → remaining=150 → cap=75，单批硬拦照常生效。
    var DAILY_LIMIT=150, BATCH_HARD_LIMIT=75;
    chrome.runtime.sendMessage({type:MSG.GET_DAILY_SEND_COUNT},function(gateResp){
      var alreadyToday=0;
      var gateCountOk=!chrome.runtime.lastError&&gateResp&&gateResp.success&&typeof gateResp.count==='number';
      if(gateCountOk)alreadyToday=gateResp.count;
      if(gateResp&&typeof gateResp.limit==='number')DAILY_LIMIT=gateResp.limit;
      var remaining=Math.max(0,DAILY_LIMIT-alreadyToday);
      var N=jobIds.length;
      var cap=Math.min(BATCH_HARD_LIMIT,remaining); // 本批实际可投 = 单批硬限 与 日剩余 取小
      // 诊断包：读计数失败 → SW 异常 fail-open（count=0），记一条 warn
      try{if(!gateCountOk&&typeof DiagLogger!=='undefined')DiagLogger.warn('popup.limitGate','读当天投递计数失败，放行(count=0) lastError='+(chrome.runtime.lastError?String(chrome.runtime.lastError.message||chrome.runtime.lastError):'none')+' N='+N)}catch(_){}
      // 诊断包：gate 决策分支记录（脱敏，只记数值+分支名+slice后数量）
      // 撞日剩余=remaining<cap+? 实判：N>cap 时，若 remaining<BATCH_HARD_LIMIT 则撞日上限，否则撞单批硬限
      var gateBranch=(N<=cap)?'正常':(cap<=0?'硬拦-额度已满':(remaining<BATCH_HARD_LIMIT?'硬拦-截断-日上限':'硬拦-截断-单批'));

      if(N>cap){
        if(cap<=0){
          // ① 日额度已满：整批拦下
          try{if(typeof DiagLogger!=='undefined')DiagLogger.userEvent('popup.limitGate','gate分支='+gateBranch+' 今日已投='+alreadyToday+' 本批N='+N+' 上限='+DAILY_LIMIT+' slice后='+jobIds.length)}catch(_){}
          alert('Boss 官方不支持一天沟通数量大于 150 个，不建议超额投递');
          return; // 今日额度已满，整批拦下
        }
        // 硬截断 confirm：取消=整批不投；确定=只投前 cap 个、其余丢弃。文案区分撞的是单批 75 还是日剩余。
        var capMsg;
        if(remaining<BATCH_HARD_LIMIT){
          // ② 撞日剩余（remaining<75）
          capMsg='今日已投 '+alreadyToday+' 个，本批 '+N+' 个，超过 BOSS 日上限 150（今日还剩 '+remaining+' 个可投）。BOSS 官方不支持超额沟通。\n\n确定：只投前 '+remaining+' 个，其余丢弃；\n取消：本批不投，请自行减少岗位数后重试。';
        }else{
          // ③ 撞单批硬限 75（日剩余仍充足）
          capMsg='单批最多投递 75 个（数量过大易卡顿/触发风控），本批 '+N+' 个。\n\n确定：只投前 75 个，其余丢弃；\n取消：本批不投，请自行减少岗位数后重试。';
        }
        if(!confirm(capMsg)){
          try{if(typeof DiagLogger!=='undefined')DiagLogger.userEvent('popup.limitGate',gateBranch+'-用户取消 今日已投='+alreadyToday+' 本批N='+N+' 上限='+DAILY_LIMIT+' remaining='+remaining+' cap='+cap)}catch(_){}
          return; // 用户取消：整批不投
        }
        jobIds=jobIds.slice(0,cap); // 用户确定：只投前 cap 个
      }
      // ④ N<=cap：直接走
      try{if(typeof DiagLogger!=='undefined')DiagLogger.userEvent('popup.limitGate','gate分支='+gateBranch+' 今日已投='+alreadyToday+' 本批N='+N+' 上限='+DAILY_LIMIT+' cap='+cap+' slice后='+jobIds.length)}catch(_){}

      startSendAfterGate(jobIds);
    });
    return; // 实际启动在 gate 回调里
  });

  // ── gate 通过后的真正投递启动（原 Send 逻辑整体下沉，核心发送链零改动）──
  function startSendAfterGate(jobIds){
    // 诊断包：用户点一键发送（任务启动 USER_EVENT，popup 侧）
    try{if(typeof DiagLogger!=='undefined')DiagLogger.userEvent('popup','用户点击「一键发送」 jobs='+jobIds.length)}catch(_){}
    // 组图片下沉到组内岗位的 jobCustom.images，发送链路（job-sender 读 ui:jobCustom）才能按组生效
    window.syncGroupImagesToJobCustom&&window.syncGroupImagesToJobCustom();
    // 发送招呼语解析 + 落盘（绕过 persistUIState 300ms 防抖）：
    //  - AI 模式岗：沿用 jobCustom[id].customGreeting（生成结果，含用户手改）。
    //  - 自定义模式岗：按 单岗位 > 期望岗位 > 全局 > 出厂兜底 解析，写入快照的 customGreeting。
    // 用 jobCustom 深拷贝快照写盘（不污染 Store 里 AI 岗的 customGreeting），SW buildSendQueueV6 直接读 customGreeting → 零改动。
    try{
      if(typeof STORAGE_KEYS!=='undefined'&&typeof chrome!=='undefined'&&chrome.storage){
        var _jc=Store.get('jobCustom')||{};
        var _snap=JSON.parse(JSON.stringify(_jc));
        var _globalGreet=(Store.get('globalGreet')||'').trim();
        var _groupGreet=Store.get('groupGreet')||{};
        var _jobGreet=Store.get('jobGreet')||{};
        var _factory=(typeof FACTORY_DEFAULT_GREETING!=='undefined')?FACTORY_DEFAULT_GREETING:'您好，我对这个岗位很感兴趣，我的经历与岗位要求比较匹配，已附上简历，期待与您进一步沟通。';
        var _jobsAll=Store.get('jobs')||[];
        var _jobById={};for(var _k=0;_k<_jobsAll.length;_k++)_jobById[_jobsAll[_k].id]=_jobsAll[_k];
        for(var _i=0;_i<jobIds.length;_i++){
          var _id=jobIds[_i];
          var _job=_jobById[_id];
          if(!_job)continue;
          if(window.effGreetMode(_job)!=='custom')continue; // AI 岗不动
          var _pos=window.groupPosOfJob(_id);
          var _jt=((_jobGreet[_id]&&_jobGreet[_id].text)||'').trim();
          var _gt=((_groupGreet[_pos]&&_groupGreet[_pos].text)||'').trim();
          var _resolved=_jt||_gt||_globalGreet||_factory;
          if(!_snap[_id])_snap[_id]={expanded:false,customGreeting:'',customFileName:'',images:[]};
          _snap[_id].customGreeting=_resolved;
          _snap[_id].userEdited=true; // 防 SW 侧后续 JD_PROGRESS 覆盖（自定义岗本不进 JDPrefetch，双保险）
        }
        var _save={};_save[STORAGE_KEYS.UI.JOB_CUSTOM]=_snap;
        chrome.storage.local.set(_save);
        window.S.jobCustom=_snap; // 快照同步回内存：后续 persistUIState 防抖回写的即同一份解析数据，不再覆盖掉落盘快照
      }
    }catch(_e){}
    Store.set('sending',true);
    Store.set('progressDone',false);
    Store.set('reviewDismissed',false); // 新一批开投 → 解除抑制，本批投完正常弹 review
    E.progressSection.classList.remove('hidden');
    try{E.progressSection.scrollIntoView({behavior:'smooth',block:'start'})}catch(ex){}
    E.btnSend.textContent='停止发送';
    E.btnSend.classList.add('sending');
    E.btnSend.disabled=false;
    E.progressText.textContent='正在启动投递...';
    E.progressSub.textContent='首岗位需等待约 10 秒，后续会加快，请稍等';
    E.progressFill.style.width='0%';
    try{
      chrome.runtime.sendMessage({type:MSG.START_SEND,jobIds:jobIds,hrActiveFilter:Store.get('hrActiveFilter')||'不限',restDayFilter:Store.get('restDayFilter')||'不限',welfareFilter:Store.get('welfareFilter')||'不限'},function(resp){
        if(chrome.runtime.lastError||!resp||!resp.success){
          Store.set('sending',false);
          E.btnSend.textContent='一键发送';
          E.btnSend.classList.remove('sending');
          E.btnSend.disabled=false;
          E.btnSend.style.background='';
          E.progressText.textContent='投递启动失败';
          E.progressSub.classList.remove('hidden');
          E.progressSub.textContent=(resp&&resp.error)||'请确保BOSS直聘聊天页已打开';
        }else{

          E.progressText.textContent='正在投递...';
          E.progressSub.classList.remove('hidden');
          E.progressSub.textContent='共 '+jobIds.length+' 个岗位';
        }
      });
    }catch(ex){
      Store.set('sending',false);
      E.btnSend.textContent='一键发送';
      E.btnSend.classList.remove('sending');
      E.btnSend.disabled=false;
      E.btnSend.style.background='';

      E.progressText.textContent='投递启动失败';
      E.progressSub.classList.remove('hidden');
      E.progressSub.textContent='扩展上下文异常，请刷新页面重试';
    }
  }

};
