// 岗位收集模块 — DOM 解析 + 无限滚动 + 标签聚类 + URL 筛选
const JobCollector = {
  collected: new Map(), // id → job
  stopped: false,
  scrollDelay: 1500,
  maxPages: 20, // 最多翻20页

  // ── 福利数据关联：读 welfare-collector（MAIN world）写的 DOM 属性 ──
  // welfare-collector hook joblist.json 拿到 encryptJobId → welfareList，
  // 写 data-jitou-welfare-map。这里按 job.id（= encryptJobId）关联。
  // 拿不到属性/对应键缺失 → 返回 null，由消费方按严格规则进入投递阶段三路终判。
  readWelfareMap() {
    try {
      const raw = document.documentElement.getAttribute('data-jitou-welfare-map');
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  },

  // 工作制字段关联：读 data-jitou-daysperweek-map（encryptJobId → daysPerWeekDesc）。
  // ⚠️ 网页端绝大多数为空（工作制只活在标题文本），仅作双休严格①路「白捡」高置信来源。
  readDaysPerWeekMap() {
    try {
      const raw = document.documentElement.getAttribute('data-jitou-daysperweek-map');
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  },

  // HR 前置过滤元数据关联：读 data-jitou-hrmeta-map（encryptJobId → {bossOnline,proxyJob,proxyType,anonymous,securityId}）。
  // welfare-collector（MAIN world）hook joblist.json 写入，这里按 job.id（=encryptJobId）关联。
  // 拿不到/缺失 → 返回 null，消费方 fail-open（bossOnline 未知放行、isHeadhunter=false）。
  readHrMetaMap() {
    try {
      const raw = document.documentElement.getAttribute('data-jitou-hrmeta-map');
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  },

  // ── 双休标题打标 ──
  // BOSS 网页端工作制信息只活在 jobName 标题文本里，零结构化字段（四重印证锁死，
  // 见 需求收集/双休筛选-HANDOFF.md 0′ 节）。故双休唯一可落地方案 = 标题关键词打标，
  // 数据源 = 已采集的 jobName，零额外请求、零新增风控面。
  // 返回 'double'（命中双休白名单）| 'no'（命中非双休黑名单）| 'unknown'（都不命中）。
  // 黑名单优先于白名单：标题同时出现"双休"和"大小周/单休"时判 no（更保守，宁可不标也不误标）。
  classifyRestDay(jobName) {
    const t = String(jobName || '');
    if (!t) return 'unknown';
    // 黑名单：即便含"休"字也不算稳定双休（单双休=有时单休，排除）
    const NO = ['大小周', '单休', '做六休一', '单双周', '单双休'];
    for (let i = 0; i < NO.length; i++) {
      if (t.indexOf(NO[i]) !== -1) return 'no';
    }
    // 白名单：标题明写稳定双休
    const YES = ['双休', '周末双休', '做五休二', '五天工作制', '五天双休'];
    for (let j = 0; j < YES.length; j++) {
      if (t.indexOf(YES[j]) !== -1) return 'double';
    }
    return 'unknown';
  },

  // ── 卡片解析 ──
  parseCard(card, welfareMap, daysPerWeekMap, hrMetaMap) {
    const nameEl = card.querySelector(SELECTORS.jobs.jobName);
    const salaryEl = card.querySelector(SELECTORS.jobs.jobSalary);
    const companyEl = card.querySelector(SELECTORS.jobs.company);
    const tags = [...card.querySelectorAll(SELECTORS.jobs.tagList)].map((t) => t.textContent.trim());
    const link = card.querySelector('a')?.href || '';
    const id = link.match(/job_detail\/([^.]+)\.html/)?.[1] || link;

    // welfareList：从 MAIN world 拦截器数据按 id 关联；拿不到则 null（缺失→投递阶段三路终判）
    const welfareList = (welfareMap && Array.isArray(welfareMap[id])) ? welfareMap[id] : null;
    // daysPerWeekDesc：工作制字段（双休严格①路），拿不到则 null（绝大多数为空，①不命中走②）
    const daysPerWeekDesc = (daysPerWeekMap && typeof daysPerWeekMap[id] === 'string') ? daysPerWeekMap[id] : null;

    const name = nameEl?.textContent.trim() || '';

    // ── HR 前置过滤元数据（Phase 2，新增；joblist 的 bossOnline/proxyJob/anonymous/securityId）──
    const hm = (hrMetaMap && hrMetaMap[id]) ? hrMetaMap[id] : null;
    const bossOnline = (hm && typeof hm.bossOnline === 'boolean') ? hm.bossOnline : undefined;
    const proxyJob = (hm && typeof hm.proxyJob === 'number') ? hm.proxyJob : undefined;
    const anonymous = (hm && typeof hm.anonymous === 'number') ? hm.anonymous : undefined;
    const securityId = (hm && typeof hm.securityId === 'string') ? hm.securityId : undefined;
    // 猎头/匿名岗（proxyJob=1 或 anonymous 非0）：独立页不渲活跃度，需 B3 点真卡拿分级活跃度
    const isHeadhunter = !!(proxyJob || (anonymous && anonymous !== 0));

    return {
      id,
      name,
      salary: decodeSalary(salaryEl?.textContent || ''),
      company: companyEl?.textContent.trim() || '',
      tags,
      link,
      welfareList,
      daysPerWeekDesc,
      restDay: this.classifyRestDay(name), // 双休标题打标：'double'|'no'|'unknown'
      bossOnline,
      proxyJob,
      anonymous,
      securityId,
      isHeadhunter,
    };
  },

  // ── 解析当前页所有卡片 ──
  parseCurrentPage() {
    const cards = document.querySelectorAll(SELECTORS.jobs.jobCard);
    const welfareMap = this.readWelfareMap();
    const daysPerWeekMap = this.readDaysPerWeekMap();
    const hrMetaMap = this.readHrMetaMap();
    let newCount = 0;
    cards.forEach((card) => {
      const job = this.parseCard(card, welfareMap, daysPerWeekMap, hrMetaMap);
      if (job.id && !this.collected.has(job.id)) {
        this.collected.set(job.id, job);
        newCount++;
      } else if (job.id && this.collected.has(job.id)) {
        // 回填：旧记录此前未拿到 welfareList/daysPerWeekDesc（DOM 先于 joblist.json 解析时），现补上
        const prev = this.collected.get(job.id);
        if (!prev.welfareList && job.welfareList) prev.welfareList = job.welfareList;
        if (!prev.daysPerWeekDesc && job.daysPerWeekDesc) prev.daysPerWeekDesc = job.daysPerWeekDesc;
        // HR 前置过滤元数据回填（DOM 先于 joblist 解析时补上）
        if (prev.bossOnline === undefined && job.bossOnline !== undefined) prev.bossOnline = job.bossOnline;
        if (prev.proxyJob === undefined && job.proxyJob !== undefined) prev.proxyJob = job.proxyJob;
        if (prev.anonymous === undefined && job.anonymous !== undefined) prev.anonymous = job.anonymous;
        if (!prev.securityId && job.securityId) prev.securityId = job.securityId;
        if (!prev.isHeadhunter && job.isHeadhunter) prev.isHeadhunter = job.isHeadhunter;
      }
    });
    return newCount;
  },

  // ── 获取当前筛选标签 ──
  getActiveTags() {
    const tags = [];
    const synthesis = document.querySelector(SELECTORS.jobs.synthesis);
    if (synthesis) tags.push({ type: 'recommend', name: synthesis.textContent.trim() });

    document.querySelectorAll(SELECTORS.jobs.expectItemText).forEach((el) => {
      tags.push({ type: 'expect', name: el.textContent.trim() });
    });
    return tags;
  },

  // ═══════════════════════════════════════════════════════════════════
  // 方案②：页内直调 joblist.json 分页采集（绕 hidden tab 懒加载节流）
  // ───────────────────────────────────────────────────────────────────
  // 根因（已确证）：Chrome 引擎级对 hidden/后台 tab 节流 → BOSS 无限滚动懒加载不触发
  // → scrollToLoad 首轮 newCards<=currentCount+1 即早退，只采首屏 ~14-15 岗。
  // 网络请求不受可见性节流，后台 tab 照跑。故采集期在 CS(ISOLATED, 同源 fetch 自动带
  // 登录 cookie) 主动按节奏调 joblist.json?page=N 拿全量数据。
  // URL 模板来源：welfare-collector.js(MAIN world) hook 页面自己发的真实请求，写
  // data-jitou-joblist-url（含全部签名/查询参数），这里读它作模板只换 page，不自己拼猜。
  // fail-open：page1 失败（抓不到 URL / 非 200 / code!=0 / 无 zpData）→ 回退 scrollToLoad。
  // ═══════════════════════════════════════════════════════════════════

  // 读 welfare-collector 暴露的真实列表请求模板（轮询等页面首个请求发生）。
  // 返回 {url, method, body, kind} 或 null（拿不到 → 消费方 fail-open 回退 DOM 采集）。
  // 0717 真机实证：带 query=POST search/joblist.json（body 为 form-urlencoded 含 page/query/city…）；
  // 无 query=GET recommend/job/list.json（page 在 URL）。无签名/token，同源复放即可。
  async readJoblistReq(timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 8000);
    while (Date.now() < deadline) {
      try {
        const raw = document.documentElement.getAttribute('data-jitou-joblist-req');
        if (raw) {
          const o = JSON.parse(raw);
          if (o && o.url) return o;
        }
      } catch (e) {}
      await sleep(400);
    }
    // 兜底：老属性只有 URL（视作 GET recommend）
    try {
      const u = document.documentElement.getAttribute('data-jitou-joblist-url');
      if (u) return { url: u, method: 'GET', body: '', kind: 'recommend' };
    } catch (e) {}
    return null;
  },

  // 把请求模板套到第 page 页：POST 换 body.page，GET 换 url.page。返回 {url, init}。
  buildPagedRequest(req, page) {
    const isPost = String(req.method || 'GET').toUpperCase() === 'POST';
    if (isPost) {
      let body = String(req.body || '');
      if (/(^|&)page=\d+/.test(body)) body = body.replace(/(^|&)page=\d+/, '$1page=' + page);
      else body += (body ? '&' : '') + 'page=' + page;
      return {
        url: req.url,
        init: {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json, text/plain, */*' },
          body: body,
        },
      };
    }
    // GET：换 URL 的 page 参数
    let url = req.url;
    try {
      const u = new URL(req.url, location.href);
      u.searchParams.set('page', String(page));
      url = u.href;
    } catch (e) {}
    return {
      url: url,
      init: { method: 'GET', credentials: 'same-origin', headers: { 'Accept': 'application/json, text/plain, */*' } },
    };
  },

  // 经 welfare-collector（MAIN world）走 BOSS 自己的 fetch 复放第 page 页（postMessage 往返）。
  // 返回驱动回传对象 {ok, code, list, hasMore} 或 {ok:false, reason}（超时/驱动缺失）。
  // 走 BOSS fetch = 带齐其拦截器 header，最忠实真流量，比 ISOLATED 裸 fetch 更少触 code=37。
  _mainReqSeq: 0,
  fetchPageViaMain(page, timeoutMs) {
    return new Promise((resolve) => {
      const nonce = 'zt' + Date.now() + '_' + (++this._mainReqSeq);
      let done = false;
      const onMsg = (ev) => {
        if (ev.source !== window) return;
        const d = ev.data;
        if (!d || d.__ztRes !== 'fetchListPage' || d.nonce !== nonce) return;
        done = true;
        window.removeEventListener('message', onMsg);
        resolve(d);
      };
      window.addEventListener('message', onMsg);
      try { window.postMessage({ __ztReq: 'fetchListPage', nonce: nonce, page: page }, '*'); } catch (e) {}
      setTimeout(() => { if (!done) { window.removeEventListener('message', onMsg); resolve({ ok: false, reason: 'timeout' }); } }, timeoutMs || 12000);
    });
  },

  // 复放单页：MAIN world（BOSS fetch，privileged）优先 → 超时/驱动缺失时 ISOLATED 同源直连兜底。
  // 返回 { ok, list, hasMore, code? }；ok=false 时消费方据 code 止损/回退。
  async fetchJoblistPage(req, page) {
    const viaMain = await this.fetchPageViaMain(page, 12000);
    if (viaMain && viaMain.ok) {
      return { ok: true, list: viaMain.list || [], hasMore: viaMain.hasMore !== false, code: viaMain.code };
    }
    // MAIN 明确拿到响应但被 BOSS 拒（code=37 等）→ 不再直连加压，直接失败上抛
    if (viaMain && typeof viaMain.code === 'number' && viaMain.code !== 0) {
      return { ok: false, list: [], hasMore: false, code: viaMain.code };
    }
    // MAIN 超时/无模板/驱动缺失/fetchErr → ISOLATED 同源直连兜底
    return await this.fetchJoblistPageDirect(req, page);
  },

  // ISOLATED 同源直连复放（兜底：MAIN 驱动不可用时）。返回 { ok, list, hasMore, code? }。
  async fetchJoblistPageDirect(req, page) {
    try {
      const pr = this.buildPagedRequest(req, page);
      const resp = await fetch(pr.url, pr.init);
      if (!resp || !resp.ok) return { ok: false, list: [], hasMore: false };
      const obj = await resp.json();
      // BOSS 包 {code:0, zpData:{jobList, hasMore}}；code!=0（如 37 访问过频/需验证）视为失败
      if (!obj || (typeof obj.code === 'number' && obj.code !== 0)) return { ok: false, list: [], hasMore: false, code: (obj && obj.code) };
      const zp = obj.zpData;
      if (!zp || !Array.isArray(zp.jobList)) return { ok: false, list: [], hasMore: false };
      return { ok: true, list: zp.jobList, hasMore: (zp.hasMore !== false) };
    } catch (e) {
      return { ok: false, list: [], hasMore: false };
    }
  },

  // joblist.json 的 jobList[i] → 与 parseCard 完全同构的 job 对象（下游 matchJobToExpected/
  // 分组/发送队列都吃它）。字段逐一对齐 parseCard 返回结构。
  mapApiJobToJob(j) {
    j = j || {};
    const id = j.encryptJobId || '';
    const name = j.jobName || '';
    // salary：DOM 路径存解码后明文（如 "15-25K"）；API salaryDesc 已是明文，直接用。
    const salary = j.salaryDesc || '';
    // company：DOM 路径取 .job-card-footer .boss-info（品牌名）；API 对应 brandName。
    const company = j.brandName || '';
    // tags：镜像 DOM .tag-list li。0717 真机比对实证：卡片 .tag-list li = jobLabels（经验+学历，
    // 如 ["1-3年","大专"]），非 skills（skills 是不展示的技能关键词长数组）。故取 jobLabels 保同构。
    const tags = Array.isArray(j.jobLabels) ? j.jobLabels.slice() : [];
    // link：镜像 DOM 卡片 <a> href = /job_detail/<encryptJobId>.html?lid=..&securityId=..
    // 下游发送(startSendV7)据此导航详情页；缺 lid/securityId 也能靠 id fallback，仍尽量带全。
    let link = 'https://www.zhipin.com/job_detail/' + id + '.html';
    const qp = [];
    if (j.lid) qp.push('lid=' + encodeURIComponent(j.lid));
    if (j.securityId) qp.push('securityId=' + encodeURIComponent(j.securityId));
    if (qp.length) link += '?' + qp.join('&');
    const welfareList = Array.isArray(j.welfareList) ? j.welfareList : null;
    const daysPerWeekDesc = (typeof j.daysPerWeekDesc === 'string' && j.daysPerWeekDesc.trim()) ? j.daysPerWeekDesc.trim() : null;
    const bossOnline = (typeof j.bossOnline === 'boolean') ? j.bossOnline : undefined;
    const proxyJob = (typeof j.proxyJob === 'number') ? j.proxyJob : undefined;
    const anonymous = (typeof j.anonymous === 'number') ? j.anonymous : undefined;
    const securityId = (typeof j.securityId === 'string' && j.securityId) ? j.securityId : undefined;
    // 猎头/匿名岗（与 parseCard 同判）：proxyJob=1 或 anonymous 非0
    const isHeadhunter = !!(proxyJob || (anonymous && anonymous !== 0));
    return {
      id, name, salary, company, tags, link,
      welfareList, daysPerWeekDesc,
      restDay: this.classifyRestDay(name),
      bossOnline, proxyJob, anonymous, securityId, isHeadhunter,
    };
  },

  // API 分页采集主循环。返回：true=API 路径成功承接（page1 ok，已灌 collected）；
  // false=应回退 DOM（拿不到模板 / page1 失败）。任何异常内部吞掉后返回 false（fail-open）。
  async collectViaApi(progressCb) {
    const req = await this.readJoblistReq(8000);
    if (!req) return false; // 页面还没发过列表请求（或 hook 未生效）→ 回退 DOM

    let page = 1;
    let prevCount = 0;
    let stall = 0;
    while (!this.stopped && page <= this.maxPages) {
      const res = await this.fetchJoblistPage(req, page);
      if (!res.ok) {
        // page1 就失败 → 整体回退 DOM（不误判风控为「采完」）；page>1 失败 → 优雅收工返已得
        if (page === 1) return false;
        break;
      }
      // 灌入 collected（dedupe by encryptJobId），带 welfareList/daysPerWeekDesc 回填语义
      for (let i = 0; i < res.list.length; i++) {
        const job = this.mapApiJobToJob(res.list[i]);
        if (!job.id) continue;
        if (!this.collected.has(job.id)) {
          this.collected.set(job.id, job);
        } else {
          const prev = this.collected.get(job.id);
          if (!prev.welfareList && job.welfareList) prev.welfareList = job.welfareList;
          if (!prev.daysPerWeekDesc && job.daysPerWeekDesc) prev.daysPerWeekDesc = job.daysPerWeekDesc;
          if (prev.bossOnline === undefined && job.bossOnline !== undefined) prev.bossOnline = job.bossOnline;
        }
      }
      const currentCount = this.collected.size;
      if (currentCount !== prevCount) {
        progressCb({ collected: currentCount });
        stall = 0;
      } else {
        stall++;
      }
      prevCount = currentCount;

      // 停止条件：本页空 / hasMore=false / 连续两页无新增（重复页，防死循环）
      if (res.list.length === 0 || !res.hasMore || stall >= 2) break;

      page++;
      // 节奏仿真人滚动：3-5s/页抖动（不加速、不并发；BOSS 对高频复放有 code=37 软封锁，
      // 慢节奏降触发与封号风险。封号风险优先于采集完整度，见 memory project-ban-risk）
      await sleep(3000 + Math.floor(Math.random() * 2000));
    }
    return true;
  },

  // ── 无限滚动 ──
  async scrollToLoad(progressCb) {
    this.stopped = false;

    // 等首批卡片渲染（页面刚跳转 AJAX 未回时，避免立即 break 退出）
    const cardSelector = SELECTORS.jobs.jobCard;
    const waitStart = Date.now();
    while (Date.now() - waitStart < 10000) {
      if (document.querySelectorAll(cardSelector).length > 0) break;
      await sleep(500);
    }

    let page = 0;
    let prevCount = 0;

    while (!this.stopped && page < this.maxPages) {
      this.parseCurrentPage();
      const currentCount = this.collected.size;
      if (currentCount !== prevCount) {
        progressCb({ collected: currentCount });
        prevCount = currentCount;
      }

      // 滚动到底
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(this.scrollDelay);

      // 检测是否有新内容加载
      const newCards = document.querySelectorAll(SELECTORS.jobs.jobCard);
      if (newCards.length <= currentCount + 1) {
        // 可能没有更多了
        await sleep(1000);
        this.parseCurrentPage();
        if (this.collected.size === currentCount) break;
      }
      page++;
    }

    // 最终解析
    this.parseCurrentPage();
  },

  // ── 按标签聚类 ──
  clusterByTag() {
    const clusters = {};
    for (const job of this.collected.values()) {
      const primaryTag = job.tags[0] || '其他';
      if (!clusters[primaryTag]) clusters[primaryTag] = [];
      clusters[primaryTag].push(job);
    }
    return clusters;
  },

  // ── 取每类代表性 JD ──
  sampleJDs(clusters, perCluster = 5) {
    const samples = {};
    for (const [tag, jobs] of Object.entries(clusters)) {
      samples[tag] = jobs.slice(0, perCluster).map((j) => ({
        title: j.name,
        tags: j.tags,
        desc: j.name, // JD 详情需额外抓取
      }));
    }
    return samples;
  },

  // ── 福利精筛（严格过滤 · 列表初筛） ──
  // requireWelfare：需要包含的福利关键词数组（如 ['五险一金']）。
  // 严格规则：① 关闭/空条件 → 原样返回；② welfareList 缺失(null/非数组) → 放行到投递阶段
  // 由 JD 正文终判（不在列表丢，投递阶段正文不命中则跳过，见 content.js）；③ welfareList 已知
  // 且含全部要求关键词 → 保留（确认命中）；④ welfareList 已知但不含 → 滤掉（可靠丢弃）。
  // 返回 { kept, dropped, unknown }：kept=保留岗位（确认命中 + 待正文终判），dropped=明确不满足被滤，
  // unknown=因数据缺失而放行到投递终判的岗位数（供上层提示/统计）。
  filterByWelfare(jobs, requireWelfare) {
    const need = Array.isArray(requireWelfare) ? requireWelfare.filter(Boolean) : [];
    if (need.length === 0) {
      return { kept: jobs, dropped: [], unknown: 0 };
    }
    const kept = [];
    const dropped = [];
    let unknown = 0;
    for (const job of jobs) {
      const wl = job && job.welfareList;
      if (!Array.isArray(wl)) {
        // 数据未知 → 放行到投递阶段正文终判
        unknown++;
        kept.push(job);
        continue;
      }
      const ok = need.every((kw) => wl.some((w) => String(w).indexOf(kw) !== -1));
      if (ok) kept.push(job);
      else dropped.push(job);
    }
    return { kept, dropped, unknown };
  },

  // ── 双休精筛（严格过滤 · 列表初筛 + 命中置顶） ──
  // restDayFilter：'双休' 时启用，其余/空 → 不筛原样返回。
  // 严格规则：① 标题命中双休白名单（restDay==='double'）→ 保留并置顶（确认命中）；② 标题命中
  // 非双休黑名单（restDay==='no'，如大小周/单休）→ 明确滤掉；③ restDay==='unknown'（标题没写
  // 工作制）→ 放行到投递阶段由 JD 正文终判（投递阶段正文/标题均未明确 double 则跳过，见 content.js）。
  // kept 顺序 = 双休命中岗在前（置顶），待正文终判岗在后，保持各自原相对顺序。
  // 返回 { kept, dropped, unknown }：unknown=因标题无工作制信息而放行到投递终判的岗位数。
  filterByRestDay(jobs, restDayFilter) {
    const list = Array.isArray(jobs) ? jobs : [];
    if (restDayFilter !== '双休') {
      return { kept: list, dropped: [], unknown: 0 };
    }
    const hit = [];     // restDay==='double'，置顶（确认命中）
    const pending = []; // restDay==='unknown'，放行到投递阶段正文终判，保留在后
    const dropped = [];  // restDay==='no'，明确非双休
    for (const job of list) {
      const rd = (job && job.restDay) || JobCollector.classifyRestDay(job && job.name);
      if (rd === 'double') hit.push(job);
      else if (rd === 'no') dropped.push(job);
      else pending.push(job);
    }
    return { kept: hit.concat(pending), dropped, unknown: pending.length };
  },

  // ── 按标签分组顺序发送计划 ──
  buildSendPlan(clusters, greetings) {
    const plan = [];
    for (const [tag, jobs] of Object.entries(clusters)) {
      for (const job of jobs) {
        plan.push({
          jobId: job.id,
          category: tag,
          greeting: greetings[tag] || '',
        });
      }
    }
    return plan;
  },
};

// ── 收集入口 ──
// 注意：导航逻辑已移至 service worker，避免页面重载销毁 content script 执行上下文
async function runCollection(params, progressCb) {
  JobCollector.collected.clear();
  JobCollector.stopped = false;

  // 方案②：优先页内直调 joblist.json 分页（绕 hidden tab 懒加载节流）。
  // 回退铁律（fail-open）：拿不到 URL 模板 / page1 失败 / 抛异常 → 走 DOM 无限滚动兜底，
  // 绝不让采集整体挂掉。可见 tab 场景 DOM 兜底仍最稳。
  let apiOk = false;
  try {
    apiOk = await JobCollector.collectViaApi(progressCb);
  } catch (e) {
    apiOk = false;
    try { if (typeof ErrorLogger !== 'undefined') ErrorLogger.logError('collectViaApi 异常: ' + (e && e.message), e && e.stack, 'runCollection'); } catch (_) {}
  }
  if (!apiOk && !JobCollector.stopped) {
    await JobCollector.scrollToLoad(progressCb);
  }
  const clusters = JobCollector.clusterByTag();

  return {
    jobs: [...JobCollector.collected.values()],
    clusters,
    count: JobCollector.collected.size,
    jdSamples: JobCollector.sampleJDs(clusters),
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
