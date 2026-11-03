// ════════════════════════════════════════════════════════════
// 即投 — A 页（筛选页）渲染
// ════════════════════════════════════════════════════════════
// Depends on: E, Store, $/$$/esc (global globals)
// Depends on: TAG_DATA (from tag-data.js)

// ── Data access (TAG_DATA wrappers, also used by events-a) ──
function allPos(){
  var r=[],cats=TAG_DATA.positionTree&&TAG_DATA.positionTree.categories;
  if(!cats)return r;
  for(var ci=0;ci<cats.length;ci++){
    var c=cats[ci],l2s=c.children||[];
    for(var li=0;li<l2s.length;li++){
      var l2=l2s[li],l3s=l2.children||[];
      for(var ti=0;ti<l3s.length;ti++){var l3=l3s[ti];r.push({name:l3.name,l2:l2.name,l1:c.name})}
    }
  }
  return r;
}
function allInd(){
  var r=[],cats=TAG_DATA.industryCategories||[];
  for(var gi=0;gi<cats.length;gi++){var g=cats[gi];for(var ii=0;ii<(g.items||[]).length;ii++)r.push({name:g.items[ii],category:g.category})}
  return r;
}
// 某个城市的工作区域候选（含「不限」）；无 districtCodes 的城市/全国 只给「不限」
function getCityAreas(cityCode){
  if(!cityCode)return ['不限'];
  return ['不限'].concat(Object.keys((TAG_DATA.districtCodes||{})[cityCode]||{}));
}
// code→城市名 映射（含全国）
function cityNameMap(){
  var all=[{name:'全国',code:'000000'}].concat(TAG_DATA.cities||[]);
  var m={};for(var i=0;i<all.length;i++)m[all[i].code]=all[i].name;return m;
}
function getPositionCodes(names){
  var codes=[],cats=TAG_DATA.positionTree&&TAG_DATA.positionTree.categories;
  if(!cats)return codes;
  for(var ci=0;ci<cats.length;ci++){
    var l2s=cats[ci].children||[];
    for(var li=0;li<l2s.length;li++){
      var l3s=l2s[li].children||[];
      for(var ti=0;ti<l3s.length;ti++){
        var l3=l3s[ti];
        if(names.indexOf(l3.name)>=0&&codes.indexOf(l3.code)<0)codes.push(l3.code);
      }
    }
  }
  return codes;
}

// ── Shared thumbnail HTML (A page, B page, custom settings) ──
window.renderResumeThumbnailsHTML=function(){
  var images=Store.get('resumeImages')||[];
  var html='';
  for(var ii=0;ii<images.length;ii++){
    html+='<div class="univ-thumb" style="position:relative">'
      +'<img src="'+images[ii].src+'" alt="简历缩略图" data-gimg="'+ii+'">'
      +'<span class="thumb-remove" data-gimg="'+ii+'">&#x2715;</span>'
      +'</div>';
  }
  html+='<div class="univ-thumb-add" data-gact="addImg">+</div>';
  return html;
};

// ── Resume images ──
window.renderResumeImages=function(){
  E.resumeThumbArea.innerHTML=window.renderResumeThumbnailsHTML();
};

// ── City chips ──
// 一二线城市名单（排序优先）
var TIER1_2_CITIES=['北京','上海','广州','深圳','杭州','成都','武汉','南京','苏州','西安','重庆','长沙','天津','郑州','东莞','青岛','厦门','合肥','佛山','宁波','昆明','福州','无锡','济南','大连'];
window.renderCityChips=function(q){
  var selected=Store.get('selectedCities')||[];
  q=(q||'').trim().toLowerCase();
  var cts=[{name:'全国',code:'000000'}].concat(TAG_DATA.cities||[]);
  if(q)cts=cts.filter(function(c){return c.name.toLowerCase().indexOf(q)>=0});
  if(!cts.length){E.cityChipContainer.innerHTML='<div class="city-empty">未匹配到城市</div>';return}
  // 非搜索模式：一二线城市排前面，其余排后面
  if(!q){
    var ordered=[];
    for(var ci=0;ci<cts.length;ci++){if(cts[ci].code==='000000'){ordered.push(cts.splice(ci,1)[0]);break}}
    for(var pi=0;pi<TIER1_2_CITIES.length;pi++){
      for(var ci=0;ci<cts.length;ci++){
        if(cts[ci].name===TIER1_2_CITIES[pi]){ordered.push(cts.splice(ci,1)[0]);break}
      }
    }
    ordered=ordered.concat(cts);
    cts=ordered;
  }
  var isSearch=!!q;
  var wasExpanded=Store.get('cityExpanded')||false;
  E.cityChipContainer.innerHTML=cts.map(function(c){
    var sel=selected.indexOf(c.code)>=0;
    return'<span class="city-chip'+(sel?' selected':'')+'" data-code="'+c.code+'">'+esc(c.name)+'</span>'
  }).join('');
  E.cityChipContainer.classList.remove('city-search-mode','city-expanded');
  if(isSearch)E.cityChipContainer.classList.add('city-search-mode');
  else if(wasExpanded)E.cityChipContainer.classList.add('city-expanded');
  // 管理展开按钮（放在容器外，不受 overflow:hidden 影响）
  var oldBtn=E.cityChipContainer.parentNode.querySelector('.city-expand-btn');
  if(oldBtn)oldBtn.parentNode.removeChild(oldBtn);
  if(!isSearch){
    var expBtn=document.createElement('button');
    expBtn.className='expand-btn city-expand-btn';
    expBtn.textContent=wasExpanded?'收起':'展开更多';
    expBtn.addEventListener('click',function(){
      var nowExpanded=E.cityChipContainer.classList.contains('city-expanded');
      E.cityChipContainer.classList.toggle('city-expanded');
      Store.set('cityExpanded',!nowExpanded);
      expBtn.textContent=nowExpanded?'展开更多':'收起';
    });
    E.cityChipContainer.parentNode.insertBefore(expBtn, E.cityChipContainer.nextSibling);
  }
  window.renderCitySelected();
};

// ── City selected area（复刻「期望职位」已选区）──
window.renderCitySelected=function(){
  if(!E.citySelectedArea)return;
  var selected=Store.get('selectedCities')||[];
  var all=[{name:'全国',code:'000000'}].concat(TAG_DATA.cities||[]);
  var codeName={};
  for(var ci=0;ci<all.length;ci++)codeName[all[ci].code]=all[ci].name;
  if(!selected.length){E.citySelectedArea.innerHTML='';return}
  var html='<div class="selected-area" style="margin-top:14px"><div class="section-subtitle">已选城市</div><div class="selected-tags">';
  html+=selected.map(function(code){
    var nm=codeName[code]||code;
    return'<div class="selected-tag" data-code="'+esc(code)+'">'+esc(nm)+'<span class="tag-remove">&#x2715;</span></div>';
  }).join('');
  html+='</div></div>';
  E.citySelectedArea.innerHTML=html;
};

// ── Position browse ──
window.renderPosBrowse=function(){
  var state=Store.get();
  var raw=(state.posSearchQuery||'').trim();
  var q=raw.toLowerCase();
  var sel=state.selectedPositions||[];
  var custom=state.customPositions||[];
  // 已选区：picker 选中 + 自定义词并排，自定义带 data-custompos + 虚线边框区分
  function selectedAreaHtml(attr){
    if(!sel.length&&!custom.length)return'';
    var h='<div class="selected-area"'+(attr||'')+'><div class="section-subtitle">已选岗位</div><div class="selected-tags">';
    h+=sel.map(function(p){return'<div class="selected-tag" data-pos="'+esc(p)+'">'+esc(p)+'<span class="tag-remove">&#x2715;</span></div>'}).join('');
    h+=custom.map(function(p){return'<div class="selected-tag" data-custompos="'+esc(p)+'" style="border:1px dashed var(--accent)">'+esc(p)+'<span class="tag-remove">&#x2715;</span></div>'}).join('');
    h+='</div></div>';
    return h;
  }
  var html='';
  if(q){
    var all=allPos();var matched=all.filter(function(p){return p.name.toLowerCase().indexOf(q)>=0});
    // 自创词条常驻：只要有输入词（raw），始终提供「+ 添加自创词条」入口——
    // 即使 BOSS 有部分匹配的 bossposition，用户仍可坚持选自己输入的词（如输「数据标注」，
    // BOSS 有「数据标注/AI训练师」，用户只想要「数据标注」）。已在 sel/custom 里的不重复提示。
    var rawTrim=(raw||'').trim();
    var alreadyChosen=rawTrim&&(custom.indexOf(rawTrim)>=0||sel.indexOf(rawTrim)>=0);
    function customAddHtml(){
      if(!rawTrim||alreadyChosen)return'';
      return '<div class="custom-pos-row" style="text-align:center;margin-top:10px"><span class="add-custom-pos" data-addcustom="'+esc(rawTrim)+'" style="padding:8px 14px;display:inline-block;border:1px dashed var(--accent);border-radius:16px;color:var(--accent);cursor:pointer;font-size:13px">+ 添加自创词条「'+esc(rawTrim)+'」</span></div>';
    }
    if(matched.length){
      var groups={};
      for(var i=0;i<matched.length;i++){var p=matched[i];var key=p.l1+'/'+p.l2;if(!groups[key])groups[key]={l1:p.l1,l2:p.l2,items:[]};groups[key].items.push(p.name)}
      html+='<div class="search-results">';var keys=Object.keys(groups);
      for(var ki=0;ki<keys.length;ki++){var g=groups[keys[ki]];html+='<div class="search-result-group"><div class="result-l2-label">'+esc(g.l2)+'<span class="result-l1-label"> '+esc(g.l1)+'</span></div><div class="result-chips">';for(var ii=0;ii<g.items.length;ii++){var sp=sel.indexOf(g.items[ii])>=0;html+='<span class="chip'+(sp?' active':'')+'" data-pos="'+esc(g.items[ii])+'">'+esc(g.items[ii])+'</span>'}html+='</div></div>'}
      html+=customAddHtml(); // 有匹配也照样给自创词条入口（常驻）
      html+='</div>'
    }else{
      html+='<div class="search-results"><div class="empty-positions">未匹配到岗位</div>';
      html+=customAddHtml();
      html+='</div>'
    }
    html+=selectedAreaHtml();
  }else{
    html+=selectedAreaHtml(' style="margin-top:0;border-top:none"');
  }
  E.posBrowseArea.innerHTML=html;
  E.posBrowseArea.style.minHeight=html?'20px':'0'
};

// ── Industry browse（chip 钻取版）──
// 一级行业显示用简称（仅显示；匹配/存储仍用 g.category 真实名）
var IND_SHORT={
  '互联网/AI':'互联网/AI',
  '电子/通信/半导体':'电子/通信/半导体',
  '服务业':'服务业',
  '消费品/批发/零售':'消费品/零售',
  '房地产/建筑':'房地产/建筑',
  '教育培训':'教育培训',
  '广告/传媒/文化/体育':'广告/传媒',
  '制造业':'制造业',
  '专业服务':'专业服务',
  '制药/医疗':'制药/医疗',
  '汽车':'汽车',
  '交通运输/物流':'交通/物流',
  '能源/化工/环保':'能源/化工/环保',
  '金融':'金融',
  '政府/非营利组织/其他':'政府/非营利'
};
function indShort(cat){return IND_SHORT[cat]||cat;}
window.renderInd=function(){
  var state=Store.get();
  var q=(state.indSearchQuery||'').trim().toLowerCase();
  if(q){window.renderIndSearch(q);return}
  var cats=TAG_DATA.industryCategories||[];
  var selInd=state.selectedIndustries||[];
  var exp=state.expandedIndustries||[];
  var openCat=exp.length?exp[0]:null; // 钻取「至多展开一个」类
  // 一排 chip：不限 + 15 个一级行业。不限 = selectedIndustries 为空 → 下游不加 industry 过滤
  var html='<div class="chips-wrap"><span class="chip chip-any'+(selInd.length?'':' active')+'" data-ind-clear="1">不限</span>';
  for(var ci=0;ci<cats.length;ci++){
    var g=cats[ci],items=g.items||[],selCount=0;
    for(var k=0;k<items.length;k++){if(selInd.indexOf(items[k])>=0)selCount++}
    var cls=selCount===0?'':(selCount>=items.length?' active':' partial'); // 全选=active / 部分=partial（同款琥珀样式）
    html+='<span class="chip ind-l1'+cls+'" data-ind-cat="'+esc(g.category)+'">'+esc(indShort(g.category))+'</span>';
  }
  html+='</div>';
  // 钻取面板：展示当前展开类的全部二级行业 + 右上角「全选本类」复选框
  if(openCat){
    var go=null;
    for(var gi=0;gi<cats.length;gi++){if(cats[gi].category===openCat){go=cats[gi];break}}
    if(go){
      var its=go.items||[],allSel=its.length>0;
      for(var m=0;m<its.length;m++){if(selInd.indexOf(its[m])<0){allSel=false;break}}
      html+='<div class="drill"><div class="drill-head"><span class="drill-title">'+esc(go.category)+'</span>'
        +'<span class="drill-all'+(allSel?' checked':'')+'" data-ind-all="'+esc(go.category)+'" title="全选本类"><span class="allbox'+(allSel?' checked':'')+'"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M2.5 6l2.5 2.5L9.5 3.5"/></svg></span></span>'
        +'</div><div class="chips-wrap">';
      for(var n=0;n<its.length;n++){var it=its[n],sel=selInd.indexOf(it)>=0;html+='<span class="chip'+(sel?' active':'')+'" data-ind="'+esc(it)+'">'+esc(it)+'</span>'}
      html+='</div></div>';
    }
  }
  E.indArea.innerHTML=html;
};
window.renderIndSearch=function(q){
  var state=Store.get();
  var selInd=state.selectedIndustries||[];
  var all=allInd();var matched=all.filter(function(p){return p.name.toLowerCase().indexOf(q)>=0||p.category.toLowerCase().indexOf(q)>=0});
  // 搜索态：顶部「不限」+ 匹配到的二级行业 chip（不显示一级 chip 云 / 钻取面板）
  var html='<div class="chips-wrap"><span class="chip chip-any'+(selInd.length?'':' active')+'" data-ind-clear="1">不限</span></div>';
  if(matched.length){html+='<div class="search-results">';var groups={};for(var i=0;i<matched.length;i++){var p=matched[i];if(!groups[p.category])groups[p.category]=[];groups[p.category].push(p.name)}var keys=Object.keys(groups);for(var ki=0;ki<keys.length;ki++){html+='<div class="search-result-group"><div class="result-l2-label">'+esc(keys[ki])+'</div><div class="result-chips">';var items=groups[keys[ki]];for(var ii=0;ii<items.length;ii++){var sel=selInd.indexOf(items[ii])>=0;html+='<span class="chip'+(sel?' active':'')+'" data-ind="'+esc(items[ii])+'">'+esc(items[ii])+'</span>'}html+='</div></div>'}html+='</div>'}else{html+='<div class="search-results"><div class="empty-positions">未匹配到行业</div></div>'}
  E.indArea.innerHTML=html
};

// ── Chips ──
window.renderChips=function(cont,items,sel){
  cont.innerHTML=items.map(function(v){var s=sel.indexOf(v)>=0;return'<span class="chip'+(s?' active':'')+'" data-val="'+esc(v)+'">'+esc(v)+'</span>'}).join('');
};
window.renderHrActiveChips=function(){
  var cont=document.getElementById('hrActiveChips'); if(!cont)return;
  var vals=['不限','只投在线','3日内活跃','本周内活跃','本月内活跃'];
  var cur=Store.get('hrActiveFilter')||'不限';
  cont.innerHTML=vals.map(function(v){return'<span class="chip'+(v===cur?' active':'')+'" data-hract="'+esc(v)+'">'+esc(v)+'</span>'}).join('');
};
// 福利待遇合并卡（多选）：chips [不限] [周末双休] [五险一金]。
// 选择态映射现有两个 filter：restDayFilter='双休' ⇄ 周末双休；welfareFilter='五险一金' ⇄ 五险一金。
// 都不选（两个 filter 均='不限'）→「不限」高亮。点「不限」与点具体项互斥。
window.renderWelfareCombinedChips=function(){
  var cont=document.getElementById('welfareCombinedChips'); if(!cont)return;
  var rest=Store.get('restDayFilter')||'不限';
  var welf=Store.get('welfareFilter')||'不限';
  var restOn=rest==='双休';
  var welfOn=welf==='五险一金';
  var noneOn=!restOn&&!welfOn;
  cont.innerHTML=
    '<span class="chip'+(noneOn?' active':'')+'" data-welfare-combined="none">不限</span>'+
    '<span class="chip'+(restOn?' active':'')+'" data-welfare-combined="restday">周末双休</span>'+
    '<span class="chip'+(welfOn?' active':'')+'" data-welfare-combined="insurance">五险一金</span>';
  // 仅选「周末双休」时弹浅黄警示卡（提示双休依据 JD 文本判断，会过滤掉未写明双休的岗位）
  var warn=document.getElementById('welfareWarn');
  if(warn){
    warn.innerHTML=restOn
      ? '<div class="welfare-warn-card"><svg class="welfare-warn-ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.5L15 14H1z"/><path d="M8 6.5v3.5"/><circle cx="8" cy="12" r=".4" fill="currentColor" stroke="none"/></svg><div class="welfare-warn-tx"><b>可投岗位会大幅减少。</b>双休依据岗位详情是否提及判断，大量实际双休但未写明的岗位会被过滤掉</div></div>'
      : '';
  }
};
// 旧入口名保留为薄包装，避免其它调用点（如 renderChipSecs）失效；统一委托合并渲染。
window.renderWelfareChips=function(){window.renderWelfareCombinedChips();};
window.renderRestDayChips=function(){window.renderWelfareCombinedChips();};
// 工作区域：每个目标城市各渲一组 chip（多城时带城市名小标题），各城独立选区
window.renderWorkAreaGroups=function(){
  var cont=E.workAreaChips; if(!cont)return;
  var cities=Store.get('selectedCities')||[];
  var byCity=Store.get('workAreasByCity')||{};
  var codes=cities.length?cities:['']; // 未选城市 → 单组只「不限」
  // 无区县的城市（全国 000000 等）只有「不限」一个选项 → 多城市时该组是冗余噪音，隐藏
  if(codes.length>1)codes=codes.filter(function(code){return getCityAreas(code).length>1});
  if(!codes.length)codes=[''];
  var multi=codes.length>1;
  var names=cityNameMap();
  function chipsHtml(code){
    var areas=getCityAreas(code);
    var sel=byCity[code]||['不限'];
    return areas.map(function(v){
      var s=sel.indexOf(v)>=0;
      return '<span class="chip'+(s?' active':'')+'" data-city="'+esc(code)+'" data-val="'+esc(v)+'">'+esc(v)+'</span>';
    }).join('');
  }
  cont.className='chips-wrap'+(multi?' wa-grouped':'');
  if(multi){
    cont.innerHTML=codes.map(function(code){
      return '<div class="wa-city-group"><div class="section-subtitle">'+esc(names[code]||code)+'</div><div class="chips-wrap">'+chipsHtml(code)+'</div></div>';
    }).join('');
  }else{
    cont.innerHTML=chipsHtml(codes[0]);
  }
};
window.renderChipSecs=function(){
  var state=Store.get();
  window.renderWorkAreaGroups();
  window.renderChips(E.jobTypeChips,TAG_DATA.jobTypes||['不限','全职','兼职','实习'],state.jobTypes||[]);
  window.renderChips(E.salaryChips,TAG_DATA.salaryRanges||['不限','3K以下','3-5K','5-10K','10-20K','20-50K','50K以上'],state.salaryRanges||[]);
  window.renderChips(E.expChips,TAG_DATA.experience||['不限','在校生(实习)','应届生(校招)','经验不限','1年以内','1-3年','3-5年','5-10年','10年以上'],state.experience||[]);
  window.renderChips(E.eduChips,TAG_DATA.education||['不限','初中及以下','中专/中技','高中','大专','本科','硕士','博士'],state.education||[]);
  window.renderChips(E.sizeChips,TAG_DATA.companySizes||['不限','0-20人','20-99人','100-499人','500-999人','1000-9999人','10000人以上'],state.companySizes||[]);
  window.renderChips(E.stageChips,TAG_DATA.fundingStages||['不限','未融资','天使轮','A轮','B轮','C轮','D轮及以上','已上市','不需要融资'],state.fundingStages||[]);
  window.renderHrActiveChips();
  window.renderWelfareCombinedChips();
};
window.renderSettings=function(){window.renderPosBrowse();window.renderInd();window.renderChipSecs()};

// ── Misc helpers ──
