// ════════════════════════════════════════════════════════════
// 即投 — A 页（筛选页）事件委托
// ════════════════════════════════════════════════════════════
// Depends on: E, Store, $/$$/esc/tog/togD (global)
// Depends on: TAG_DATA (from tag-data.js)
// Depends on: MSG (from constants.js)
// Depends on: render-a.js, getCityAreas/renderWorkAreaGroups (from render-a.js)

window.initEventsA=function(){
  if(window._eventsAInitialized)return;
  window._eventsAInitialized=true;

  // ── City chips ──
  E.cityChipContainer.addEventListener('click',function(e){
    var chip=e.target.closest('.city-chip');if(!chip)return;
    var code=chip.dataset.code;
    var selected=Store.get('selectedCities')||[];
    var i=selected.indexOf(code);
    if(i>=0){selected.splice(i,1);var _b=Store.get('workAreasByCity')||{};if(_b[code]){delete _b[code];Store.set('workAreasByCity',_b)}}else selected.push(code);
    Store.set('selectedCities',selected);
    window.renderCityChips(E.cityInput.value);
    window.renderChipSecs();
    try{persistFilterState()}catch(ex){}
  });
  E.cityInput.addEventListener('input',function(){window.renderCityChips(E.cityInput.value)});

  // ── City selected tags（删除已选城市，复刻「期望职位」已选 tag 交互）──
  E.citySelectedArea.addEventListener('click',function(e){
    var tag=e.target.closest('.selected-tag[data-code]');
    if(!tag)return;
    var selected=Store.get('selectedCities')||[];
    var i=selected.indexOf(tag.dataset.code);
    if(i>=0)selected.splice(i,1);
    var _b=Store.get('workAreasByCity')||{};if(_b[tag.dataset.code]){delete _b[tag.dataset.code];Store.set('workAreasByCity',_b)}
    Store.set('selectedCities',selected);
    window.renderCityChips(E.cityInput.value);
    window.renderChipSecs();
    try{persistFilterState()}catch(ex){}
  });

  // ── Thumbnail helper ──
  function createThumbnail(file, maxW, maxH){
    return new Promise(function(resolve){
      var reader = new FileReader();
      reader.onload = function(e){
        var img = new Image();
        img.onload = function(){
          var cv = document.createElement('canvas');
          var w = img.width, h = img.height;
          if(w > maxW){h = h * maxW / w; w = maxW}
          if(h > maxH){w = w * maxH / h; h = maxH}
          cv.width = Math.round(w);
          cv.height = Math.round(h);
          cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
          resolve(cv.toDataURL('image/jpeg', 0.7));
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    });
  }
  window.createThumbnail = createThumbnail;

  // ── Resume upload (先构建完整数组，最后一次性写入 storage 避免并行覆盖) ──
  E.hiddenFileInput.addEventListener('change',function(e){
    var files=e.target.files;
    if(!files||!files.length)return;
    var images=Store.get('resumeImages')||[];
    var maxNew=10-images.length;
    var todo=[];
    for(var fi=0;fi<files.length&&todo.length<maxNew;fi++)todo.push(files[fi]);
    var pendingImages=[];
    var pendingStore=[];
    var done=0;
    function chkDoneAll(){
      done++;
      if(done===todo.length){
        e.target.value='';
        // 所有缩略图生成完毕，一次性更新 Store 和 chrome.storage
        var newImages=Store.get('resumeImages')||[];
        pendingImages.forEach(function(pi){newImages.push(pi)});
        Store.set('resumeImages',newImages);
        window.refreshBImages();
        // 原子写入 storage（通过 serailized queue 避免竞态）
        atomicUpdateResumeImages(function(arr){
          pendingStore.forEach(function(ps){arr.push(ps)});
          return arr;
        });
      }
    }
    for(var ti=0;ti<todo.length;ti++)(function(f){
      var reader=new FileReader();
      reader.onload=function(ev){
        var ab=ev.target.result;
        var u8=new Uint8Array(ab);
        var data=Array.prototype.slice.call(u8);
        var id=Date.now()+'_'+Math.random().toString(36).slice(2,6);
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
          // Lightbox-size version (much larger for detail viewing)
          var cvLb=document.createElement('canvas');
          var lbW=img.width,lbH=img.height;
          if(lbW>800){lbH=lbH*800/lbW;lbW=800}
          if(lbH>1000){lbW=lbW*1000/lbH;lbH=1000}
          cvLb.width=Math.round(lbW);
          cvLb.height=Math.round(lbH);
          cvLb.getContext('2d').drawImage(img,0,0,cvLb.width,cvLb.height);
          var lightboxSrc=cvLb.toDataURL('image/jpeg',0.85);
          pendingImages.push({src:thumb,fullSrc:lightboxSrc,name:f.name,id:id});
          pendingStore.push({name:f.name,type:f.type,data:data,id:id,thumb:thumb,fullSrc:lightboxSrc});
          URL.revokeObjectURL(img.src);
          chkDoneAll();
        };
        img.src=URL.createObjectURL(new Blob([ab],{type:f.type}));
      };
      reader.readAsArrayBuffer(f);
    })(todo[ti]);
  });

  // A page resume thumb click delegation
  E.resumeThumbArea.addEventListener('click',function(e){
    var imgEl=e.target.closest('.univ-thumb img');
    if(imgEl){
      var gimg=imgEl.dataset.gimg;
      var images=Store.get('resumeImages')||[];
      var imgData=images[parseInt(gimg)];
      var src=(imgData&&imgData.fullSrc)?imgData.fullSrc:imgEl.src;
      showImageLightbox(src);return
    }
    var add=e.target.closest('[data-gact="addImg"]');
    if(add){E.hiddenFileInput.click();return}
    var rem=e.target.closest('.thumb-remove');
    if(rem){
      var idx=parseInt(rem.dataset.gimg);
      if(!isNaN(idx)&&idx>=0){
        var images=Store.get('resumeImages')||[];
        if(idx<images.length){
          var rid=images[idx].id;
          images.splice(idx,1);
          Store.set('resumeImages',images);
          window.refreshBImages();
          atomicUpdateResumeImages(function(arr){
            return arr.filter(function(it){return it.id!==rid});
          });
        }
      }
    }
  });

  // ── Position search ──
  E.posBrowseArea.addEventListener('click',function(e){
    var addBtn=e.target.closest('[data-addcustom]');
    if(addBtn){
      var w=(addBtn.dataset.addcustom||'').trim();
      if(w){
        var cp=Store.get('customPositions')||[];
        var sp=Store.get('selectedPositions')||[];
        if(cp.indexOf(w)<0&&sp.indexOf(w)<0)cp.push(w);
        Store.set('customPositions',cp);
        E.posSearch.value='';Store.set('posSearchQuery','');E.posSearchClear.style.display='none';
        window.renderPosBrowse();persistFilterState();
      }
      return
    }
    var ctag=e.target.closest('.selected-tag[data-custompos]');
    if(ctag){
      var cp2=Store.get('customPositions')||[];
      var ci=cp2.indexOf(ctag.dataset.custompos);
      if(ci>=0)cp2.splice(ci,1);
      Store.set('customPositions',cp2);
      window.renderPosBrowse();persistFilterState();
      return
    }
    var chip=e.target.closest('.chip[data-pos]');
    if(chip){
      var sel=Store.get('selectedPositions')||[];
      togD(sel,chip.dataset.pos,false);
      Store.set('selectedPositions',sel);
      window.renderPosBrowse();
      persistFilterState();
      return
    }
    var tag=e.target.closest('.selected-tag[data-pos]');
    if(tag){
      var sel=Store.get('selectedPositions')||[];
      var i=sel.indexOf(tag.dataset.pos);
      if(i>=0)sel.splice(i,1);
      Store.set('selectedPositions',sel);
      window.renderPosBrowse();
      persistFilterState();
      return
    }
  });
  // ── HR 活跃度单选 ──
  var _hrActiveCont=document.getElementById('hrActiveChips');
  if(_hrActiveCont){
    _hrActiveCont.addEventListener('click',function(e){
      var c=e.target.closest('.chip[data-hract]');if(!c)return;
      Store.set('hrActiveFilter',c.dataset.hract);
      if(window.renderHrActiveChips)window.renderHrActiveChips();
      persistFilterState();
    });
  }
  // ── 福利待遇合并卡（多选）── chips: 不限 / 周末双休 / 五险一金。
  // 周末双休 ⇄ restDayFilter='双休'，五险一金 ⇄ welfareFilter='五险一金'，可同时选（AND）。
  // 「不限」= 清空两个 filter；点具体项时自动取消「不限」（互斥靠 filter 置位天然实现）。
  var _welfareCont=document.getElementById('welfareCombinedChips');
  if(_welfareCont){
    _welfareCont.addEventListener('click',function(e){
      var c=e.target.closest('.chip[data-welfare-combined]');if(!c)return;
      var kind=c.dataset.welfareCombined;
      if(kind==='none'){
        Store.set('restDayFilter','不限');
        Store.set('welfareFilter','不限');
      }else if(kind==='restday'){
        Store.set('restDayFilter',(Store.get('restDayFilter')==='双休')?'不限':'双休');
      }else if(kind==='insurance'){
        Store.set('welfareFilter',(Store.get('welfareFilter')==='五险一金')?'不限':'五险一金');
      }
      if(window.renderWelfareCombinedChips)window.renderWelfareCombinedChips();
      persistFilterState();
    });
  }
  E.posSearch.addEventListener('input',function(){
    Store.set('posSearchQuery',E.posSearch.value);
    var q=Store.get('posSearchQuery');
    E.posSearchClear.style.display=q?'block':'none';
    window.renderPosBrowse()
  });
  E.posSearchClear.addEventListener('click',function(){
    E.posSearch.value='';
    Store.set('posSearchQuery','');
    E.posSearchClear.style.display='none';
    window.renderPosBrowse();
    E.posSearch.focus()
  });

  // ── Industry search ──
  // 取某一级行业（category）下全部二级行业名
  function indItemsOf(cat){
    var cats=TAG_DATA.industryCategories||[];
    for(var i=0;i<cats.length;i++){if(cats[i].category===cat)return (cats[i].items||[]).slice()}
    return [];
  }
  E.indArea.addEventListener('click',function(e){
    // 「不限」= 清空已选（语义=不按行业过滤）+ 收起钻取面板
    var clr=e.target.closest('[data-ind-clear]');
    if(clr){
      Store.set('selectedIndustries',[]);
      Store.set('expandedIndustries',[]);
      window.renderInd();
      persistFilterState();
      return
    }
    // 钻取面板「全选本类」复选框：未全选→全选该类二级；已全选→取消该类二级
    var allBtn=e.target.closest('[data-ind-all]');
    if(allBtn){
      var cat=allBtn.dataset.indAll;
      var items=indItemsOf(cat);
      var sel=Store.get('selectedIndustries')||[];
      var allSel=items.length>0&&items.every(function(it){return sel.indexOf(it)>=0});
      if(allSel){sel=sel.filter(function(it){return items.indexOf(it)<0})}
      else{items.forEach(function(it){if(sel.indexOf(it)<0)sel.push(it)})}
      Store.set('selectedIndustries',sel);
      window.renderInd();
      persistFilterState();
      return
    }
    // 二级行业 chip：多选 toggle 进/出 selectedIndustries
    var chip=e.target.closest('.chip[data-ind]');
    if(chip){
      var sel=Store.get('selectedIndustries')||[];
      togD(sel,chip.dataset.ind,false);
      Store.set('selectedIndustries',sel);
      window.renderInd();
      persistFilterState();
      return
    }
    // 一级行业 chip：展开/收起钻取面板（同一时刻至多展开一个类）
    var l1=e.target.closest('.chip[data-ind-cat]');
    if(l1){
      var cat2=l1.dataset.indCat;
      var exp=Store.get('expandedIndustries')||[];
      Store.set('expandedIndustries',(exp.length===1&&exp[0]===cat2)?[]:[cat2]);
      window.renderInd();
      return
    }
  });
  E.indSearch.addEventListener('input',function(){
    Store.set('indSearchQuery',E.indSearch.value);
    var q=Store.get('indSearchQuery');
    E.indSearchClear.style.display=q?'block':'none';
    window.renderInd()
  });
  E.indSearchClear.addEventListener('click',function(){
    E.indSearch.value='';
    Store.set('indSearchQuery','');
    E.indSearchClear.style.display='none';
    window.renderInd();
    E.indSearch.focus()
  });

  // ── 工作区域：按城市分组，每城独立 toggle（chip 携 data-city）──
  E.workAreaChips.addEventListener('click',function(e){
    var c=e.target.closest('.chip');if(!c||!c.dataset.val)return;
    var code=c.dataset.city||'';
    var v=c.dataset.val;
    var byCity=Store.get('workAreasByCity')||{};
    var arr=(byCity[code]||['不限']).slice();
    togD(arr,v,true); // 工作区域首项恒为「不限」，互斥
    byCity[code]=arr;
    Store.set('workAreasByCity',byCity);
    window.renderWorkAreaGroups();
    persistFilterState();
  });

  // ── Chip sections ──
  var chipSecs=[
    {e:E.jobTypeChips,k:'jobTypes'},
    {e:E.salaryChips,k:'salaryRanges'},
    {e:E.expChips,k:'experience'},
    {e:E.eduChips,k:'education'},
    {e:E.sizeChips,k:'companySizes'},
    {e:E.stageChips,k:'fundingStages'}
  ];
  var chipData={
    jobTypes:['不限','全职','兼职','实习'],
    salaryRanges:['不限','3K以下','3-5K','5-10K','10-20K','20-50K','50K以上'],
    experience:['不限','在校生(实习)','应届生(校招)','经验不限','1年以内','1-3年','3-5年','5-10年','10年以上'],
    education:['不限','初中及以下','中专/中技','高中','大专','本科','硕士','博士'],
    companySizes:['不限','0-20人','20-99人','100-499人','500-999人','1000-9999人','10000人以上'],
    fundingStages:['不限','未融资','天使轮','A轮','B轮','C轮','D轮及以上','已上市','不需要融资']
  };
  chipSecs.forEach(function(sec){
    sec.e.addEventListener('click',function(e){
      var c=e.target.closest('.chip');if(!c||!c.dataset.val)return;
      var v=c.dataset.val;
      // 工作性质/薪资待遇 BOSS 平台只支持单选（同选多项会出不来岗位）→ 点某项即替换为单值
      if(sec.k==='jobTypes'||sec.k==='salaryRanges'){
        Store.set(sec.k,[v]);
        window.renderChips(sec.e,chipData[sec.k],Store.get(sec.k)||[]);
        persistFilterState();
        return;
      }
      var arr=Store.get(sec.k)||[];
      var da=chipData[sec.k];
      var hd=da&&da[0]==='不限';
      togD(arr,v,hd);
      Store.set(sec.k,arr);
      window.renderChips(sec.e,chipData[sec.k],Store.get(sec.k)||[]);
      persistFilterState();
    })
  });

  // ── Reset & Collect buttons ──
  E.btnReset.addEventListener('click',function(){
    Store.set('selectedCities',[]);
    Store.set('selectedPositions',[]);
    Store.set('customPositions',[]);
    Store.set('hrActiveFilter','不限');
    Store.set('welfareFilter','不限');
    Store.set('restDayFilter','不限');
    Store.set('selectedIndustries',[]);
    Store.set('expandedIndustries',[]);
    Store.set('workAreasByCity',{});
    Store.set('jobTypes',['不限']);
    Store.set('salaryRanges',['不限']);
    Store.set('experience',['不限']);
    Store.set('education',['不限']);
    Store.set('companySizes',['不限']);
    Store.set('fundingStages',['不限']);
    Store.set('posSearchQuery','');
    Store.set('indSearchQuery','');
    E.posSearch.value='';
    E.indSearch.value='';
    E.posSearchClear.style.display='none';
    E.indSearchClear.style.display='none';
    Store.set('resumeImages',[]);
    window.renderResumeImages();
    Store.set('cityExpanded',false);
    window.renderCityChips('');
    chrome.storage.local.remove('resumeImages',function(){});
    window.renderSettings();
    persistFilterState();
    // 清除发送相关状态（保留 sw:sendResults：投递结果是诊断证据，重置不删）
    chrome.storage.local.remove('sw:sentJobIds');
    chrome.runtime.sendMessage({type:'CLEAR_SENT_JOB_IDS'});
  });
  E.btnCollect.addEventListener('click',function(){
    var cities=Store.get('selectedCities')||[];
    var positions=Store.get('selectedPositions')||[];
    var customPos=Store.get('customPositions')||[];
    if(!cities.length||(!positions.length&&!customPos.length)){
      try{
        if(window.JitouTrack)window.JitouTrack.fire('config_blocked',{
          reason_code:!cities.length?'missing_city':'missing_position'
        });
      }catch(_){}
      alert('请至少选择目标城市和期望职位');
      return;
    }
    try{if(window.JitouTrack)window.JitouTrack.fire('first_config_completed',{})}catch(_){}
    window.toResults();
  });
  E.btnBack.addEventListener('click',window.toSettings);
};

// ── Collect params builder ──
window.buildCollectParams=function(){
  var state=Store.get();
  var urlParams={city:(state.city||{}).code||''};
  var selectedCities=state.selectedCities||[];
  if(selectedCities.length>0)urlParams.city=selectedCities[0];
  var _allPos=(state.selectedPositions||[]).concat(state.customPositions||[]);
  if(_allPos.length>0)urlParams.query=_allPos.join(',');
  if(state.jobTypes&&state.jobTypes.length>0){var jtMap={'全职':'1901','兼职':'1903','实习':'1902'};var mapped=state.jobTypes.map(function(t){return jtMap[t]}).filter(Boolean);if(mapped.length)urlParams.jobType=mapped.join(',')}
  if(state.experience&&state.experience.length>0){var expMap={'在校生(实习)':'108','应届生(校招)':'102','经验不限':'101','1年以内':'103','1-3年':'104','3-5年':'105','5-10年':'106','10年以上':'107'};var mapped=state.experience.map(function(e){return expMap[e]}).filter(Boolean);if(mapped.length)urlParams.experience=mapped.join(',')}
  if(state.education&&state.education.length>0){var degMap={'初中及以下':'209','中专/中技':'208','高中':'206','大专':'202','本科':'203','硕士':'204','博士':'205'};var mapped=state.education.map(function(d){return degMap[d]}).filter(Boolean);if(mapped.length)urlParams.degree=mapped.join(',')}
  if(state.salaryRanges&&state.salaryRanges.length>0){var salaryMap={'3K以下':'402','3-5K':'403','5-10K':'404','10-20K':'405','20-50K':'406','50K以上':'407'};var mapped=state.salaryRanges.map(function(s){return salaryMap[s]}).filter(Boolean);if(mapped.length)urlParams.salary=mapped.join(',')}
  if(state.selectedIndustries&&state.selectedIndustries.length>0){var mapped=state.selectedIndustries.map(function(n){return TAG_DATA.industryCodes[n]}).filter(Boolean);if(mapped.length)urlParams.industry=mapped.join(',');}
  if(state.companySizes&&state.companySizes.length>0){var scaleMap={'0-20人':'301','20-99人':'302','100-499人':'303','500-999人':'304','1000-9999人':'305','10000人以上':'306'};var mapped=state.companySizes.map(function(s){return scaleMap[s]}).filter(Boolean);if(mapped.length)urlParams.scale=mapped.join(',')}
  if(state.fundingStages&&state.fundingStages.length>0){var stageMap={'未融资':'801','天使轮':'802','A轮':'803','B轮':'804','C轮':'805','D轮及以上':'806','已上市':'807','不需要融资':'808'};var mapped=state.fundingStages.map(function(s){return stageMap[s]}).filter(Boolean);if(mapped.length)urlParams.stage=mapped.join(',')}
  // 工作区域：每城独立 → 各算各的 multiBusinessDistrict（区名转 6 位 districtCode；区中文名写 district= 无效）
  // districtByCity[城市code] = 'code1,code2'，下游 collectOnTab 按当前城市 tab 取对应值
  var _byCity=state.workAreasByCity||{};
  var districtByCity={};
  Object.keys(_byCity).forEach(function(cityCode){
    var dMap=(typeof TAG_DATA!=='undefined'&&TAG_DATA.districtCodes)?TAG_DATA.districtCodes[cityCode]:null;
    if(!dMap)return;
    var codes=(_byCity[cityCode]||[]).map(function(n){return dMap[n];}).filter(function(c){return c!=null;});
    if(codes.length)districtByCity[cityCode]=codes.join(',');
  });
  // 首城（单城路径 / fallback）写入 urlParams
  var _firstCity=(selectedCities&&selectedCities[0])||(state.city&&state.city.code)||'';
  if(districtByCity[_firstCity])urlParams.multiBusinessDistrict=districtByCity[_firstCity];
  var tags=[];
  if(_allPos.length>0)tags.push.apply(tags,_allPos);
  var selectedFilters={};
  if(Object.keys(_byCity).length>0)selectedFilters.workAreasByCity=JSON.parse(JSON.stringify(_byCity));
  if(state.jobTypes&&state.jobTypes.length>0)selectedFilters.jobTypes=[].concat(state.jobTypes);
  if(state.salaryRanges&&state.salaryRanges.length>0)selectedFilters.salaryRanges=[].concat(state.salaryRanges);
  if(state.experience&&state.experience.length>0)selectedFilters.experience=[].concat(state.experience);
  if(state.education&&state.education.length>0)selectedFilters.education=[].concat(state.education);
  if(state.selectedIndustries&&state.selectedIndustries.length>0)selectedFilters.industries=[].concat(state.selectedIndustries);
  if(state.companySizes&&state.companySizes.length>0)selectedFilters.companySizes=[].concat(state.companySizes);
  if(state.fundingStages&&state.fundingStages.length>0)selectedFilters.fundingStages=[].concat(state.fundingStages);
  return {urlParams:urlParams,tags:tags,filters:selectedFilters,districtByCity:districtByCity,selectedPositions:[].concat(state.selectedPositions||[]),customPositions:[].concat(state.customPositions||[]),selectedCities:selectedCities,welfareFilter:state.welfareFilter||'不限',restDayFilter:state.restDayFilter||'不限',hrActiveFilter:state.hrActiveFilter||'不限'};
};

// ── A 页筛选条件持久化 ──
var _filterPersistTimer = null;
function persistFilterState() {
  clearTimeout(_filterPersistTimer);
  _filterPersistTimer = setTimeout(function () {
    if (typeof chrome === 'undefined' || !chrome.storage) return;
    if (typeof STORAGE_KEYS === 'undefined') return;
    try {
      var s = Store.get();
      chrome.storage.local.set({
        [STORAGE_KEYS.UI.FILTER_STATE]: {
          selectedCities: s.selectedCities,
          selectedPositions: s.selectedPositions,
          customPositions: s.customPositions,
          hrActiveFilter: s.hrActiveFilter,
          welfareFilter: s.welfareFilter,
          restDayFilter: s.restDayFilter,
          selectedIndustries: s.selectedIndustries,
          workAreasByCity: s.workAreasByCity,
          jobTypes: s.jobTypes,
          salaryRanges: s.salaryRanges,
          experience: s.experience,
          education: s.education,
          companySizes: s.companySizes,
          fundingStages: s.fundingStages,
        }
      });
    } catch (e) {}
  }, 300);
}

// ── Image lightbox ──
function showImageLightbox(src) {
  var overlay = document.createElement('div');
  overlay.className = 'img-lightbox-overlay';
  overlay.innerHTML = '<img src="' + src + '" class="img-lightbox">';
  overlay.addEventListener('click', function() {
    overlay.remove();
    document.removeEventListener('keydown', esc);
  });
  function esc(e) {
    if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', esc); }
  }
  document.addEventListener('keydown', esc);
  document.body.appendChild(overlay);
}
