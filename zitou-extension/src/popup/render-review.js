// ════════════════════════════════════════════════════════════
// 即投 — Review 页（投递完成汇总）渲染
// ════════════════════════════════════════════════════════════
// Depends on: E, Store, $/esc (global)

window.renderReview=function(sendResults,duration,missedCount){
  var reviewPanel=document.getElementById('reviewPanel');
  if(!reviewPanel)return;

  var results=sendResults||[];
  var successCount=0,failCount=0;
  // 收集失败项的 jobId，供批量重试用
  var failedJobIds=[];
  results.forEach(function(r){
    if(r.success){successCount++;}
    else if(!r.skipped){
      failCount++;
      if(r.jobId!=null)failedJobIds.push(r.jobId);
    }
  });

  var total=successCount+failCount+(results.filter(function(r){return r.skipped}).length);
  // 根据成功率动态显示标题
  var titleText='投递完成';
  var iconColor='var(--green)';
  var iconBg='rgba(5,150,105,.1)';
  var allFailed=successCount===0&&failCount>0; // R3 全失败态：标题=投递失败 + 失败原因提醒
  if(allFailed){
    titleText='投递失败';
    iconColor='var(--accent)';
    iconBg='rgba(217,119,6,.1)';
  }else if(failCount>0){
    titleText='部分成功';
    iconColor='var(--accent)';
    iconBg='rgba(217,119,6,.1)';
  }

  var html='<div class="review-wrapper">'

    // Summary header
    +'<div class="review-summary">'
    +'<div class="review-icon"><svg width="40" height="40" viewBox="0 0 40 40" fill="none"><circle cx="20" cy="20" r="18" fill="'+iconBg+'" stroke="'+iconColor+'" stroke-width="1.5"/><path d="M12 20l6 6 10-10" stroke="'+iconColor+'" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>'
    +'<div class="review-title">'+titleText+'</div>'
    +'<div class="review-stats">'
    +'投递 <span class="review-stat-num">'+total+'</span> 个岗位：'
    +'成功 <span class="review-stat-num" style="color:#22c55e">'+successCount+'</span> ｜'
    +'待重投 <span class="review-stat-num" style="color:#d97706">'+failCount+'</span>'
    +'</div>'
    +'</div>'

    // R3 全失败态：失败原因提醒块（两阶段说明属投递过程页，结果页只交代结果，已整块删除）
    +(allFailed
      ?'<div class="review-fail-reason" style="margin:0 0 12px;padding:10px 12px;background:rgba(217,119,6,.08);border:1px solid rgba(217,119,6,.25);border-radius:8px;font-size:12px;color:var(--accent);line-height:1.6">'
        +'<b>失败可能原因</b>：① 网络不稳定导致发送中断；② 投递过程中手动操作了 BOSS 页面'
        +'<br><b>建议操作</b>：避免操作 BOSS 页面，点击重试'
      +'</div>'
      :'')

    // 待重投批量重试区（仅当有失败项时显示）— 文案与按钮拆分：左侧只描述，右侧独立按钮
    +(failCount>0
      ?'<div class="review-retry-bar">'
        +'<span class="review-retry-bar-text">'+failCount+' 个岗位待重新投递</span>'
        +'<button class="btn btn-primary review-retry-bar-btn" id="btnRetryFailed">一键重试</button>'
      +'</div>'
      :'')

    // Group detail cards
    +'<div class="review-groups">';

  // Group by expected position（与 B 页 render-b.js 同源 matchJobToExpected 归一，
  // 避免「ai产品经理」「AI产品经理」大小写差异被拆成两张卡）。
  var _picker=Store.get('selectedPositions')||[];
  var _custom=Store.get('customPositions')||[];
  var _jobsById={};
  (Store.get('jobs')||[]).forEach(function(j){if(j&&j.id!=null)_jobsById[j.id]=j;});
  var groupMap={};
  results.forEach(function(r){
    var pos=r.positionName||'其他';
    // 优先用期望岗位归一（与 B 页一致）；拿不到 job/期望列表时退化按 positionName 归一
    var job=(r.jobId!=null)?_jobsById[r.jobId]:null;
    var matched=(job&&(_picker.length||_custom.length)&&typeof matchJobToExpected==='function')
      ?matchJobToExpected(job,_picker,_custom):'其他';
    var key,disp;
    if(matched&&matched!=='其他'){key=(''+matched).toLowerCase();disp=matched;}
    else{key=(''+pos).trim().toLowerCase();disp=pos;}
    if(!groupMap[key])groupMap[key]={position:disp,items:[]};
    groupMap[key].items.push(r);
  });

  var posKeys=Object.keys(groupMap);
  for(var pi=0;pi<posKeys.length;pi++){
    var gg=groupMap[posKeys[pi]];
    html+='<div class="review-group-card">'
      +'<div class="review-group-header">'
      +'<span class="review-group-title">'+esc(gg.position)+'</span>'
      +'</div>'
      +'<div class="review-group-items'+(gg.items.length>5?' collapsed':'')+'">';
    for(var ii=0;ii<gg.items.length;ii++){
      var item=gg.items[ii];
      // 方案A·左侧色条范式：状态挪到行最左 2px 竖条（绿=成功 / 灰=非成功），非成功行文字转灰。
      // 非成功 = 真失败（待重投）∪ 跳过（不符筛选标签/未投递）——两者视觉同灰，语义均「未投递成功」。
      // 右侧补简短原因：skipReason 优先；v7 送达路径 skipped/失败多数只带 error（skipReason 不可达）→ 兜底取 error。
      var _ok=!!item.success;
      var _reason='';
      if(!_ok){
        var _raw=item.skipReason||item.error||'';
        _reason=(''+_raw).replace(/^未投递[:：]\s*/,'').trim();
        if(_reason.length>12)_reason=_reason.slice(0,12)+'…';
      }
      html+='<div class="review-item'+(_ok?' review-item-success':' review-item-fail')+'">'
        +'<span class="review-item-bar"></span>'
        +'<span class="review-item-name">'+esc(item.companyName||'')+'</span>'
        +(_reason?'<span class="review-item-reason">'+esc(_reason)+'</span>':'')
        +'</div>';
    }
    html+='</div>';
    if(gg.items.length>5){
      html+='<div class="review-expand-toggle" data-total="'+gg.items.length+'">展开全部 '+gg.items.length+' 个</div>';
    }
    html+='</div>';
  }

  html+='</div>' // review-groups

    // 底部「重新投递」按钮已删（批注 R3）：重投走待重投区的「一键重试」，避免双重投递入口
    +'</div>'; // review-wrapper

  reviewPanel.innerHTML=html;

  // Show review panel, hide results
  E.resultsContent.classList.add('hidden');
  E.bottomResults.classList.add('hidden');
  reviewPanel.style.display='';

  // Wire review group items expand/collapse via delegation.
  // 只绑定一次：renderReview 可能因 STATE_UPDATE 多次调用，
  // 重复 addEventListener 会让监听堆叠，偶数次时点击 toggle 互相抵消 → 按钮看似无反应。
  if(!reviewPanel._expandWired){
    reviewPanel._expandWired=true;
    reviewPanel.addEventListener('click',function(e){
      var expand=e.target.closest('.review-expand-toggle');
      if(expand){
        var card=expand.closest('.review-group-card');
        var items=card?card.querySelector('.review-group-items'):null;
        if(items){
          items.classList.toggle('collapsed');
          expand.textContent=items.classList.contains('collapsed')
            ?'展开全部 '+expand.dataset.total+' 个'
            :'收起';
        }
      }
    });
  }

  // Wire 「一键重试」→ 仅把本轮失败 jobId 重新投递，复用现有 START_SEND 链路。
  // 失败 jobId 列表通过闭包从 renderReview 传入（failedJobIds），不另存 Store 减少复杂度。
  var retryFailedBtn=document.getElementById('btnRetryFailed');
  if(retryFailedBtn&&failedJobIds.length>0){
    retryFailedBtn.addEventListener('click',function(){
      retryFailedBtn.disabled=true;
      retryFailedBtn.textContent='启动中…';
      // 重置投递相关状态，然后派发 START_SEND 仅投失败岗位
      Store.set('sending',true);
      Store.set('reviewDismissed',false);
      reviewPanel.style.display='none';
      reviewPanel.innerHTML='';
      reviewPanel._expandWired=false;
      // 显示进度区
      var progressSection=document.getElementById('progressSection');
      var resultsPanel=document.getElementById('resultsPanel');
      var resultsContent=document.getElementById('resultsContent');
      var progressText=document.getElementById('progressText');
      var progressSub=document.getElementById('progressSub');
      var progressFill=document.getElementById('progressFill');
      var bottomResults=document.getElementById('bottomResults');
      var btnSend=document.getElementById('btnSend');
      if(resultsContent)resultsContent.classList.add('hidden');
      if(bottomResults)bottomResults.classList.add('hidden');
      if(progressSection)progressSection.classList.remove('hidden');
      if(progressText)progressText.textContent='正在重试失败岗位…';
      if(progressSub){progressSub.classList.remove('hidden');progressSub.textContent='共 '+failedJobIds.length+' 个岗位';}
      if(progressFill)progressFill.style.width='0%';
      if(btnSend){btnSend.textContent='停止发送';btnSend.classList.add('sending');btnSend.disabled=false;}
      try{
        chrome.runtime.sendMessage(
          {type:MSG.START_SEND,jobIds:failedJobIds,retryKind:'manual_retry',hrActiveFilter:Store.get('hrActiveFilter')||'不限',restDayFilter:Store.get('restDayFilter')||'不限',welfareFilter:Store.get('welfareFilter')||'不限'},
          function(resp){
            if(chrome.runtime.lastError||!resp||!resp.success){
              Store.set('sending',false);
              if(btnSend){btnSend.textContent='一键发送';btnSend.classList.remove('sending');btnSend.disabled=false;}
              if(progressText)progressText.textContent='重试启动失败';
              if(progressSub){progressSub.classList.remove('hidden');progressSub.textContent=(resp&&resp.error)||'请确保BOSS直聘聊天页已打开';}
            }
          }
        );
      }catch(ex){
        Store.set('sending',false);
        if(btnSend){btnSend.textContent='一键发送';btnSend.classList.remove('sending');btnSend.disabled=false;}
        if(progressText)progressText.textContent='重试启动失败';
        if(progressSub)progressSub.textContent='扩展上下文异常，请刷新页面重试';
      }
    });
  }

};
