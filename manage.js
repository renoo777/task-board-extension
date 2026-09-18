(function(){
  "use strict";

  var KEY = "taskboard.v1";
  var PKEY = "taskboard.projects";
  var PREFKEY = "taskboard.prefs";   // 使用偏好（v0.9.1：自然语言输入开关）
  var WBKEY = "taskboard.webball";   // 网页悬浮球开关（v0.22.0）—— **故意不并进 PREFKEY**
  var MCKEY = "taskboard.mascot";    // 吉祥物配置（v0.24.0）—— 整块对象，同样不并进 PREFKEY
  /* ★ 提醒配置（v0.25.0）。**不从字面量取，取 notify.js 里那个常量** ——
     这个 key 已经有一个权威出处了（Notify.KEY，后台与网页球都读它），
     在这儿再写一遍字符串，就是「球上显示开着、设置页显示关着」那类
     没人会去查的不一致的起点。加载顺序保证 Notify 已经在了（见 manage.html）。 */
  var NTKEY = (typeof Notify !== "undefined" && Notify.KEY) ? Notify.KEY : "taskboard.notify";

  /* 偏好读写的口径必须和弹窗那边**完全一致**（同一个 key、同一个默认值）：
     两处默认值不一样的话，只会出现「设置页显示开着、弹窗里其实没开」这种查半天的怪事。 */
  function readPrefs(v){
    return { nlp: !(v && v.nlp === false) };
  }

  /* ★★ 网页球开关为什么不并成 readPrefs 的第三个字段：
     Store.set 对 taskboard.prefs 是**整块覆盖**（Store.set({nlp:...}, PREFKEY)
     写的是整个对象）。并进去的话，用户随手拨一下「识别句子」，
     就会把网页球开关悄悄抹回默认值 —— 而这类 bug **只在两个开关配合使用时**
     才现形：单测各测各的，全绿。本仓库对同一个坑已有既定解法（AI 配置走独立 key），
     这里沿用。
     ★ 口径与 ballpage.js 的 readOn **逐字一致**：「–」≠「0」，没存过 = 开。
       不一致的症状是「设置页显示开着、网页上却没有球」。 */
  function readWb(v){
    return !(v && v.on === false);
  }
  var STATUSES = ["todo","doing","done"];
  var HOLD = "hold";
  var ALL_STATUSES = STATUSES.concat([HOLD]);

  var PALETTE = ["#5b7fa6","#8b6ba6","#4f8a7d","#b07a5a","#b06b7d","#7a8290","#c0a45c","#5f8d9c"];
  var DEFAULT_PROJECT_NAMES = ["工作","个人","学习","生活","其他"];

  function defaultProjects(){
    return DEFAULT_PROJECT_NAMES.map(function(n,i){
      return { name:n, color:PALETTE[i % PALETTE.length] };
    });
  }

  var Store = {
    get: function(key){
      key = key || KEY;
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        return chrome.storage.local.get(key).then(function(o){
          return o[key] !== undefined ? o[key] : null;
        });
      }
      try { var v = localStorage.getItem(key); return Promise.resolve(v ? JSON.parse(v) : null); }
      catch(e){ return Promise.resolve(null); }
    },
    set: function(v, key){
      key = key || KEY;
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        var o = {}; o[key] = v; return chrome.storage.local.set(o);
      }
      try { localStorage.setItem(key, JSON.stringify(v)); } catch(e){}
      return Promise.resolve();
    }
  };

  function pad(n){ return (n<10?"0":"") + n; }
  function ymd(d){ return d.getFullYear() + "-" + pad(d.getMonth()+1) + "-" + pad(d.getDate()); }
  function todayStr(){ return ymd(new Date()); }
  function diffDays(s){
    if (!s) return NaN;
    var a = new Date(s + "T00:00:00"), b = new Date(todayStr() + "T00:00:00");
    return Math.round((a - b) / 86400000);
  }
  function dateRank(s){ return s ? diffDays(s) : 9999; }
  function byDate(a,b){
    var ra = dateRank(a.date), rb = dateRank(b.date);
    if (ra !== rb) return ra - rb;
    return (a.createdAt||0) - (b.createdAt||0);
  }
  function uid(){ return Math.random().toString(36).slice(2,9); }

  var st = { view:"today", tasks:[] };
  var projects = defaultProjects();

  /* ---------- 轻提示 ---------- */
  var toastTimer = null;
  function toast(msg){
    var el = document.getElementById("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ el.classList.remove("show"); }, 2200);
  }

  /* ---------- 项目列表 ---------- */
  function projColor(name){
    for (var i=0;i<projects.length;i++) if (projects[i].name === name) return projects[i].color;
    return "#c2c7d0";
  }

  function renderProjects(){
    var box = document.getElementById("plist");
    box.innerHTML = "";

    if (!projects.length) {
      var empty = document.createElement("div");
      empty.className = "sub";
      empty.style.margin = "0 0 12px";
      empty.textContent = "还没有项目，下面加一个。";
      box.appendChild(empty);
    }

    projects.forEach(function(p, idx){
      var used = st.tasks.filter(function(t){ return t.project === p.name && t.status !== "done"; }).length;

      var row = document.createElement("div");
      row.className = "prow";

      var dot = document.createElement("button");
      dot.className = "pdot";
      dot.style.background = p.color;
      dot.title = "换颜色";
      dot.addEventListener("click", function(){
        var ci = PALETTE.indexOf(p.color);
        p.color = PALETTE[(ci + 1 + PALETTE.length) % PALETTE.length];
        saveProjects().then(function(){ renderProjects(); });
      });

      var inp = document.createElement("input");
      inp.type = "text";
      inp.value = p.name;
      inp.maxLength = 20;
      inp.addEventListener("keydown", function(e){
        if (e.key === "Enter") inp.blur();
      });
      inp.addEventListener("change", function(){
        var nv = inp.value.trim();
        if (!nv || nv === p.name) { inp.value = p.name; return; }
        if (projects.some(function(q){ return q !== p && q.name === nv; })) {
          toast("已经有同名项目了");
          inp.value = p.name;
          return;
        }
        var old = p.name;
        projects[idx].name = nv;
        // 已有任务跟着改名，不然它们会变成孤儿
        st.tasks.forEach(function(t){ if (t.project === old) t.project = nv; });
        saveProjects().then(function(){ return save(); }).then(function(){
          renderProjects(); renderStat(); toast("已改名为「" + nv + "」");
        });
      });

      var cnt = document.createElement("span");
      cnt.className = "pcount";
      cnt.textContent = used ? used + " 项待办" : "—";

      var del = document.createElement("button");
      del.className = "pdel";
      del.textContent = "\u00d7";
      del.title = "删除项目";
      del.addEventListener("click", function(){
        if (projects.length <= 1) { toast("至少要留一个项目"); return; }
        var name = p.name;
        projects.splice(idx, 1);
        saveProjects().then(function(){ renderProjects(); renderStat(); });
        toast("已删除「" + name + "」，相关任务保留");
      });

      row.appendChild(dot); row.appendChild(inp); row.appendChild(cnt); row.appendChild(del);
      box.appendChild(row);
    });
  }

  function saveProjects(){ return Store.set(projects, PKEY); }

  document.getElementById("projAdd").addEventListener("click", function(){
    var inp = document.getElementById("projName");
    var v = inp.value.trim();
    if (!v) { inp.focus(); return; }
    if (projects.some(function(p){ return p.name === v; })) { toast("已经有这个项目了"); return; }
    projects.push({ name: v, color: PALETTE[projects.length % PALETTE.length] });
    saveProjects().then(function(){ inp.value = ""; renderProjects(); toast("已添加「" + v + "」"); });
  });
  document.getElementById("projName").addEventListener("keydown", function(e){
    if (e.key === "Enter") document.getElementById("projAdd").click();
  });

  /* ---------- 数据 ---------- */
  /* ---------- 归档（v0.8.0） ----------
     弹窗里的「归档已完成」是一键把整列收走。收完之后看板上就看不见了 ——
     设置页不给个落脚点的话，人会以为数据被删了（这是最容易引起恐慌的误会）。
     ★ 归档 = t.archived = true，任务本体一直在 st.tasks 里，导出 JSON 照导。
     ★ 恢复方向是安全的（不删任何东西），所以不设二次确认，只给一句 toast。
       这也正是它不算「危险按钮」的原因 —— 数据模块的禁令针对的是清空/丢弃。 */
  function archCount(){
    return st.tasks.filter(function(t){ return !!t.archived; }).length;
  }
  function renderArch(){
    var n = archCount();
    var box = document.getElementById("archBox");
    if (!box) return;
    box.hidden = n === 0;                       // ★ 没归档就整块不占版面
    if (n) document.getElementById("archNum").textContent = "已归档 " + n + " 条";
  }

  function renderStat(){
    var total = st.tasks.length;
    // 未完成/挂起/进行中都只看「还在看板上」的，归档的单独报数（否则数字和看板对不上）
    var live = st.tasks.filter(function(t){ return !t.archived; });
    // 「未完成」不含挂起 —— 挂起的东西不该算在手头的活里
    var open = live.filter(function(t){ return t.status !== "done" && t.status !== HOLD; }).length;
    var doing = live.filter(function(t){ return t.status === "doing"; }).length;
    var hold = live.filter(function(t){ return t.status === HOLD; }).length;
    var arch = archCount();
    document.getElementById("stat").textContent =
      total === 0 ? "当前没有任何任务。"
      : "共 " + total + " 条任务，未完成 " + open + " 条（进行中 " + doing + " 条）"
        + (hold ? "，挂起 " + hold + " 条" : "")
        // 已完成含归档（归档的都是已完成），后面再单独标出其中多少条被收起来了
        + "，已完成 " + (total - open - hold) + " 条"
        + (arch ? "，已归档 " + arch + " 条" : "");
  }

  /* ---------- 关于「升级前自动备份」 ----------
     background.js 在版本号变化时仍会往 taskboard.backup 写一份上一版数据，
     但**界面上不再有入口**：老大明确说「恢复这份备份」「丢弃」这些不需要，
     数据模块不要任何危险按钮（v0.6.7）。
     ★ 机制留着是有意的：它不占界面、不打扰人，但万一某次升级真出了事，
       可以直接从存储里把它捞出来（读 Local Extension Settings 的 LevelDB 即可）。
       所以这里没有 loadBackup / bakBind —— 不是漏写。

     清空类操作也已按老大要求整块移除（清空已完成 / 清空全部任务）。
     单条删除在弹窗卡片右上角的 ×，够用了；批量清空的风险远大于收益。 */

  function download(name, text, mime){
    var blob = new Blob([text], { type: mime + ";charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function(){ URL.revokeObjectURL(url); a.remove(); }, 600);  }

  document.getElementById("exJson").addEventListener("click", function(){
    download(
      "taskboard-" + todayStr() + ".json",
      JSON.stringify({
        app: "taskboard", version: 1,
        exportedAt: new Date().toISOString(),
        view: st.view, projects: projects, tasks: st.tasks
      }, null, 2),
      "application/json"
    );
    toast("已导出 JSON");
  });

  document.getElementById("exMd").addEventListener("click", function(){
    var buckets = {todo:[],doing:[],done:[],hold:[]};
    st.tasks.forEach(function(t){ if (buckets[t.status]) buckets[t.status].push(t); });

    var out = ["# 任务台导出 " + todayStr(), ""];
    // 挂起排在已完成前面：先看完「还没结束的」，再看结束的
    [["todo","待办"],["doing","进行中"],["hold","挂起"],["done","已完成"]].forEach(function(p){
      var arr = buckets[p[0]];
      if (!arr.length) return;
      out.push("## " + p[1]);
      arr.sort(byDate).forEach(function(t){
        var line = "- [" + (t.status === "done" ? "x" : " ") + "] " + t.title;
        if (t.project) line += "  #" + t.project.replace(/\s+/g, "-");
        if (t.date) line += "  " + t.date;
        if (t.note) line += "  — " + t.note;
        out.push(line);
        if (t.url) out.push("  " + t.url);
      });
      out.push("");
    });
    download("taskboard-" + todayStr() + ".md", out.join("\n"), "text/markdown");
    toast("已导出 Markdown");
  });

  document.getElementById("imBtn").addEventListener("click", function(){
    document.getElementById("fileInput").click();
  });

  document.getElementById("fileInput").addEventListener("change", function(){
    var f = this.files && this.files[0];
    this.value = "";
    if (!f) return;

    var reader = new FileReader();
    reader.onload = function(){
      try {
        var parsed = JSON.parse(reader.result);
        var arr = Array.isArray(parsed) ? parsed : (parsed && parsed.tasks);
        if (!Array.isArray(arr)) throw new Error("这不是任务台导出的格式");

        // 项目也一起并进来
        if (parsed && Array.isArray(parsed.projects)) {
          parsed.projects.forEach(function(p){
            if (p && p.name && !projects.some(function(q){ return q.name === p.name; })) {
              projects.push({ name: p.name, color: p.color || PALETTE[projects.length % PALETTE.length] });
            }
          });
        }

        var seen = {};
        st.tasks.forEach(function(t){ seen[t.id] = true; });

        var added = 0;
        arr.forEach(function(raw){
          if (!raw || !raw.title) return;
          if (raw.id && seen[raw.id]) return;   // 已存在，跳过，不覆盖
          st.tasks.push({
            id: raw.id || uid(),
            title: String(raw.title),
            status: ALL_STATUSES.indexOf(raw.status) >= 0 ? raw.status : "todo",
            project: raw.project || (projects[0] ? projects[0].name : "工作"),
            date: raw.date || null,
            note: raw.note || "",
            url: raw.url || "",
            createdAt: raw.createdAt || Date.now(),
            doneAt: raw.doneAt || null
          });
          added++;
        });

        saveProjects().then(save).then(function(){
          renderProjects(); renderStat();
          toast("导入完成：新增 " + added + " 条，跳过重复 " + (arr.length - added) + " 条");
        });
      } catch (err) {
        toast("导入失败：" + err.message);
      }
    };
    reader.readAsText(f, "utf-8");
  });

  /* ★ 这里原来有个「恢复全部归档」按钮：把 archived 标记整批摘掉。
     已删除，不要再加回来 —— 用户的原话是「点击归档后又恢复归档，这样来回操作
     会把我已有的信息打乱掉」。全量恢复就是那个「一次翻乱看板」的动作。
     取回改成在弹窗底栏点「归档 N」，在抽屉里**逐条**挑着恢复。

  function save(){ return Store.set(st); }

  /* ---------- 飞书同步 ----------
     这一页只负责「填配置、看状态、点按钮」。
     真正的同步一律交给 background 去跑 —— 如果这里也自己跑一轮，
     两个上下文同时写同一张表就会撞上飞书那个「同表不支持并发写」。 */
  var fsEls = {};
  function fsBind(){
    ["fsAppId","fsSecret","fsBase","fsTable","fsOn","fsTest","fsSave","fsNow","fsStat","fsReport",
     "fsLink","fsCreate","fsWhere","fsWhereName","fsWhereCnt","fsWhereHint","fsOpen","fsCopy"]
      .forEach(function(id){ fsEls[id] = document.getElementById(id); });
  }

  /* 从飞书多维表格链接里拆出 base_token 和 table_id。
     让用户直接粘整条链接，不用自己认哪段是哪个 —— 这是最容易填错的一步。
     顺便把「这条链接本身的地址」也带回去存起来：有了它，设置页才能给出
     「在飞书打开底表」的入口，用户以后不用自己去飞书里翻是哪张表。 */
  function parseBaseLink(s){
    var raw = String(s || "").trim();
    if (!raw) return null;
    if (/\/wiki\//.test(raw)) return { wiki:true };
    var m = /\/base\/([A-Za-z0-9]+)/.exec(raw);
    if (m) {
      var t = /[?&]table=(tbl[A-Za-z0-9]+)/.exec(raw);
      return { baseToken:m[1], tableId:t ? t[1] : "", baseUrl: raw.split("?")[0] };
    }
    // 也有人只复制了 token 本身
    if (/^[A-Za-z0-9]{20,}$/.test(raw)) return { baseToken:raw, tableId:"", baseUrl:"" };
    return null;
  }

  function sendToBg(msg){
    if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) {
      return Promise.resolve({ ok:false, reason:"当前环境没有后台进程" });
    }
    return new Promise(function(res){
      chrome.runtime.sendMessage(msg, function(r){
        // 后台没监听者时 lastError 会被设置，此时 r 是 undefined
        if (chrome.runtime.lastError) { res({ ok:false, reason:chrome.runtime.lastError.message }); return; }
        res(r || { ok:false, reason:"后台没有回应" });
      });
    });
  }

  function fmtTime(ms){
    if (!ms) return "";
    var d = new Date(ms);
    return pad(d.getMonth()+1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  /* ---------- 底表位置 ----------
     把「同步到底进了哪张表」直接摆在这一页：表名 + 两条短 id + 表里现有多少条，
     外带「在飞书打开」「复制链接」。
     为什么非做不可：一张多维表格里可以有好几张数据表，飞书网页打开时默认落在
     第一张上，而扩展读写的是配置里指定的那一张。不把目标摆出来，就会出现
     「扩展说同步成功了，我打开飞书却什么也没有」，然后开始怀疑数据丢了。 */

  function fsUrl(cfg){
    var u = String((cfg && cfg.baseUrl) || "").trim();
    if (!u || !cfg.baseToken) return "";
    // 网址里必须真的是这个 base —— 手工改过 Base token 之后，存下来的老网址就失效了
    if (u.indexOf(cfg.baseToken) < 0) return "";
    var q = u.indexOf("?");
    if (q >= 0) u = u.slice(0, q);
    if (cfg.tableId) u += "?table=" + encodeURIComponent(cfg.tableId);
    return u;
  }

  /* 记住「这条数」是替哪张表数的。
     ★ renderWhere 经常被单独调用（点完按钮重画、粘完链接重画），那几次拿不到
       remoteTotal。早先直接写空，结果点一下按钮条数就消失 —— 那条数正是用户
       核对「到底同没同步」的抓手，不能因为重画一次就没了。
       所以按「base/表」存一份，只有表换了才作废。 */
  var whereCnt = null;

  function renderWhere(cfg, remoteTotal){
    var box = fsEls.fsWhere;
    if (!box) return;
    var paint = function(c){
      c = c || {};
      if (!c.baseToken || !c.tableId) { box.hidden = true; return; }
      box.hidden = false;
      var key = String(c.baseToken) + "/" + String(c.tableId);
      if (typeof remoteTotal === "number") whereCnt = { key: key, n: remoteTotal };
      fsEls.fsWhereName.textContent =
        (c.tableName ? "「" + c.tableName + "」" : "（没记表名）") +
        "　" + String(c.baseToken).slice(0, 8) + "… / " + c.tableId;
      fsEls.fsWhereCnt.textContent =
        (whereCnt && whereCnt.key === key) ? "飞书表里现有 " + whereCnt.n + " 条记录" : "";

      /* ★ 两个按钮**永远不禁用**。
         早先写成「没网址就 disabled」，而网址这个字段是 v0.6.6 才开始存的 ——
         老配置升上来之后两个按钮全灰着，点上去毫无反应，只能得出「按钮坏了」。
         禁用一个按钮却不告诉人为什么，比让按钮当场报错还糟。
         现在：有网址直接用；没有就现场去飞书查一次（ensureUrl），
         查不到再给人话提示。 */
      box.dataset.url = fsUrl(c);
      fsEls.fsOpen.disabled = false;
      fsEls.fsCopy.disabled = false;
      fsEls.fsWhereHint.textContent = box.dataset.url
        ? "飞书网页里左边选中的就是这张表。"
        : "点「在飞书打开」会先向飞书查一次这张表的网址，查到就记下来，以后直接跳。";
    };
    if (cfg) return paint(cfg);
    Sync.readCfg().then(paint);
  }

  /* 把 background 返回的同步结果转成 renderFsStat 认得的状态对象。
     抽出来是怕漏字段 —— 少传一个 remoteTotal，底下那行「飞书表里现有 N 条」
     就永远是空的，看起来像没同步。 */
  function okState(r){
    r = r || {};
    return { state:"ok", at:Date.now(), stats:r.stats, conflicts:r.conflicts,
             skippedDeletes:r.skippedDeletes, remoteTotal:r.remoteTotal, retargeted:r.retargeted };
  }

  function renderFsStat(s){
    s = s || { state:"idle" };
    var el = fsEls.fsStat;
    if (el.dataset.busy === "1") return;
    if (s.state === "running") { el.textContent = "同步中…"; return; }
    if (s.state === "error") { el.textContent = "上次同步失败：" + (s.message || "未知错误"); return; }
    if (s.state === "ok") {
      var g = s.stats || {};
      var parts = [];
      if (g.created) parts.push("新推 " + g.created);
      if (g.updated) parts.push("更新 " + g.updated);
      if (g.pulledNew) parts.push("拉来 " + g.pulledNew);
      if (g.pulledUpdate) parts.push("回流 " + g.pulledUpdate);
      if (g.deleted) parts.push("删除 " + g.deleted);
      if (g.revived) parts.push("重建 " + g.revived);
      if (g.conflicts) parts.push("冲突 " + g.conflicts);
      el.textContent = "已同步（" + fmtTime(s.at) + "）" + (parts.length ? "，" + parts.join("，") : "") +
        (s.retargeted ? "，换过表，本地↔远端映射已重置" : "") +
        (s.skippedDeletes ? "，⚠ 有 " + s.skippedDeletes + " 条远端记录本该删掉但被安全阀拦住" : "");
      renderWhere(null, s.remoteTotal);
      renderFsReport(s);
      return;
    }
    el.textContent = "未配置";
    renderWhere(null);
  }

  function renderFsReport(s){
    var box = fsEls.fsReport;
    if (!box) return;
    var html = "";
    if (s.stats && s.stats.revived) {
      html += '<div class="warn">有 ' + s.stats.revived + ' 条本地任务在飞书表里找不到对应记录' +
        '（换过表、表被重建，或有人在飞书里删了），已按本地内容重新推上去。' +
        '你的本地数据一条没动，只是远端被补齐了。</div>';
    }
    if (s.conflicts && s.conflicts.length) {
      html += '<div class="warn">有 ' + s.conflicts.length + ' 条两边都改过，按规则以飞书那份为准。' +
        '被覆盖掉的本地版本标题：' +
        s.conflicts.map(function(c){ return "「" + (c.local && c.local.title || "无标题") + "」"; }).join("、") +
        '</div>';
    }
    if (s.skippedDeletes) {
      html += '<div class="warn">有 ' + s.skippedDeletes + ' 条远端记录在本地已删、本该从飞书一并删掉，' +
        '但数量太大被安全阀拦住了（防止误判导致整张表被清空）。确认确实要删的话点下面的按钮。</div>' +
        '<div class="row wrap mt"><button class="btn danger" id="fsForceDel">确认删除这 ' + s.skippedDeletes + ' 条</button></div>';
    }
    box.innerHTML = html;
    var b = document.getElementById("fsForceDel");
    if (b) b.addEventListener("click", function(){
      fsEls.fsStat.dataset.busy = "1";
      fsEls.fsStat.textContent = "正在强制同步…";
      sendToBg({ type:"sync-now", force:true }).then(function(r){
        delete fsEls.fsStat.dataset.busy;
        renderFsStat(r && r.ok ? okState(r) : null);
        toast("已按你的确认执行");
      });
    });
  }

  function fsLoad(){
    Sync.readCfg().then(function(cfg){
      fsEls.fsAppId.value = cfg.appId || "";
      fsEls.fsSecret.value = cfg.appSecret || "";
      fsEls.fsBase.value = cfg.baseToken || "";
      fsEls.fsTable.value = cfg.tableId || "";
      fsEls.fsOn.checked = !!cfg.enabled;
      renderWhere(cfg);
      return Sync.getStatus();
    }).then(renderFsStat);
  }

  function fsCollect(){
    return {
      appId: fsEls.fsAppId.value.trim(),
      appSecret: fsEls.fsSecret.value.trim(),
      baseToken: fsEls.fsBase.value.trim(),
      tableId: fsEls.fsTable.value.trim(),
      enabled: !!fsEls.fsOn.checked
    };
  }

  function esc(s){
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* 把文本里的 URL 变成可点的链接。飞书的报错里会带「申请权限」直达链接，
     能让用户点一下是最省事的。先切出 URL 再逐段转义，避免转义把链接拆坏。 */
  function linkify(s){
    var raw = String(s == null ? "" : s);
    var out = "", last = 0, re = /https:\/\/[^\s<>"'）)（(]+/g, m;
    while ((m = re.exec(raw)) !== null){
      out += esc(raw.slice(last, m.index));
      var u = m[0], trail = "";
      while (/[.,;，。；:：]$/.test(u)) { trail = u.slice(-1) + trail; u = u.slice(0, -1); }
      out += '<a href="' + esc(u) + '" target="_blank" rel="noopener">' + esc(u) + '</a>' + esc(trail);
      last = m.index + m[0].length;
    }
    return out + esc(raw.slice(last));
  }

  function renderTestReport(res){
    var box = fsEls.fsReport;
    if (!res || !res.steps) {
      box.innerHTML = '<div class="report"><div class="r no"><span class="mk">失败</span><span>' +
        linkify((res && res.reason) || "没有返回结果") + '</span></div></div>';
      return;
    }
    box.innerHTML = '<div class="report">' + res.steps.map(function(s){
      // 三档：通过 / 失败 / 可选。可选那档没做上不影响主流程，
      // 渲染成红的会让人以为整件事挂了。
      var cls = s.ok ? "ok" : (s.optional ? "opt" : "no");
      var mk  = s.ok ? "通过" : (s.optional ? "可选" : "失败");
      return '<div class="r ' + cls + '"><span class="mk">' + mk + '</span><span>' + esc(s.name) +
        (s.detail ? "　" + linkify(s.detail) : "") + '</span></div>';
    }).join("") + '</div>';
  }

  function fsInit(){
    if (!fsEls.fsStat) return;
    fsLoad();

    fsEls.fsTest.addEventListener("click", function(){
      fsEls.fsStat.dataset.busy = "1";
      fsEls.fsStat.textContent = "测试中…会在你的表里写一条探针记录，跑完自动删掉";
      fsEls.fsReport.innerHTML = "";
      // 先存下配置，测试用的是存进去的那份，避免出现「测的是旧配置」
      Sync.writeCfg(fsCollect()).then(function(){
        return sendToBg({ type:"sync-selftest" });
      }).then(function(res){
        delete fsEls.fsStat.dataset.busy;
        if (res && res.needConfig) {
          fsEls.fsStat.textContent = "四个字段都要填全才能测";
          return;
        }
        renderTestReport(res);
        fsEls.fsStat.textContent = res && res.ok
          ? "连接正常，读写改删四种操作都通了"
          : "有步骤失败，看下面的明细";
        toast(res && res.ok ? "连接正常" : "测试未通过");
      });
    });

    fsEls.fsSave.addEventListener("click", function(){
      fsEls.fsStat.dataset.busy = "1";
      fsEls.fsStat.textContent = "保存中，并跑一轮同步…";
      fsEls.fsReport.innerHTML = "";
      Sync.writeCfg(fsCollect()).then(function(){
        return sendToBg({ type:"sync-now" });
      }).then(function(r){
        delete fsEls.fsStat.dataset.busy;
        if (r && r.skipped) { fsEls.fsStat.textContent = "已保存，但未启用（或配置不全），暂不同步"; renderWhere(); return; }
        if (r && r.ok) { renderFsStat(okState(r)); toast("已保存并同步"); }
        else { fsEls.fsStat.textContent = "同步失败：" + ((r && r.error) || (r && r.reason) || "未知原因"); }
      });
    });

    fsEls.fsNow.addEventListener("click", function(){
      fsEls.fsStat.dataset.busy = "1";
      fsEls.fsStat.textContent = "同步中…";
      sendToBg({ type:"sync-now" }).then(function(r){
        delete fsEls.fsStat.dataset.busy;
        if (r && r.skipped) { fsEls.fsStat.textContent = "未启用或配置不全，没有可同步的内容"; return; }
        if (r && r.ok) { renderFsStat(okState(r)); toast("同步完成"); }
        else { fsEls.fsStat.textContent = "同步失败：" + ((r && r.error) || (r && r.reason) || "未知原因"); }
      });
    });

    fsEls.fsOn.addEventListener("change", function(){
      Sync.writeCfg({ enabled: fsEls.fsOn.checked }).then(function(){
        toast(fsEls.fsOn.checked ? "已启用，稍后自动同步" : "已停用同步");
      });
    });

    /* 粘整条链接 → 自动拆出 base_token 和 table_id。
       链接里通常带 ?table=tblxxx（从某个数据表页面复制就有）；
       从 base 首页复制的没有这一段，那就主动列一下表，只有一个就自动填上。 */
    if (fsEls.fsLink) fsEls.fsLink.addEventListener("change", function(){
      var p = parseBaseLink(fsEls.fsLink.value);
      if (!p) { toast("没认出这是多维表格链接"); return; }
      if (p.wiki) { toast("这是知识库里的链接，请打开多维表格本身再复制地址栏"); return; }
      fsEls.fsBase.value = p.baseToken;
      // 顺手把链接本身的地址也记下来 —— 底下「底表」那一行的「在飞书打开」靠它。
      // 表名这时还不知道（换成别的表了），先清掉，免得显示上一张表的旧名字。
      Sync.writeCfg({ baseUrl: p.baseUrl || "", tableName: "" });
      if (p.tableId) {
        fsEls.fsTable.value = p.tableId;
        renderWhere();
        toast("已自动填好 Base token 和数据表 ID");
        return;
      }

      var cfg = fsCollect();
      if (!cfg.appId || !cfg.appSecret) { toast("链接里没带表 ID，先把 App ID / Secret 填上我帮你查"); return; }
      fsEls.fsStat.textContent = "链接里没带表 ID，正在查这张表下有哪些数据表…";
      Feishu.listTables({ appId:cfg.appId, appSecret:cfg.appSecret }, p.baseToken).then(function(list){
        if (list.length === 1) {
          fsEls.fsTable.value = list[0].tableId;
          // 一并把表名存下 —— 设置页显示「底表」时用得上
          Sync.writeCfg({ baseToken: p.baseToken, tableId: list[0].tableId,
                          tableName: list[0].name || "", baseUrl: p.baseUrl || "" })
            .then(function(){ renderWhere(); });
          toast("已填好：这张表下只有「" + list[0].name + "」");
        } else if (list.length > 1) {
          toast("这张表下有 " + list.length + " 个数据表，点开你要用的那个、再复制一次链接");
        } else {
          toast("这张表里还没有数据表");
        }
        // 把状态栏恢复成真实状态，别用「未配置」盖掉上一次同步成功的信息
        Sync.getStatus().then(renderFsStat);
        renderWhere();
      }, function(e){
        fsEls.fsStat.textContent = "查数据表失败：" + ((e && e.message) || "未知原因");
      });
    });

    /* 底表那一行的两个按钮。开着这一页就能跳过去，不用去飞书里翻是哪张表。
       ★ 网址可能是空的 —— 早期版本建表时没存 baseUrl。所以「能不能点」不能
       取决于网址在不在，而要现查一次：查到了就记进配置（下次直接用），
       查不到再给人话。绝不静默。 */
    function ensureUrl(){
      var u = fsEls.fsWhere.dataset.url;
      if (u) return Promise.resolve(u);
      return Sync.readCfg().then(function(cfg){
        if (!cfg || !cfg.baseToken) return "";
        fsEls.fsWhereHint.textContent = "正在向飞书查这张表的网址…";
        return Feishu.metaUrl(cfg, cfg.baseToken).then(function(m){
          if (!m || !m.url) { renderWhere(cfg); return ""; }
          return Sync.writeCfg({ baseUrl: m.url, tableName: m.title || cfg.tableName || "" })
            .then(function(){
              renderWhere({ baseToken:cfg.baseToken, tableId:cfg.tableId,
                            baseUrl:m.url, tableName:m.title || cfg.tableName });
              return fsEls.fsWhere.dataset.url;
            });
        }, function(){ renderWhere(cfg); return ""; });
      });
    }

    var NO_URL_TIP = "没查到这张表的网址。把飞书里那张表的链接粘到上面「已经有表了」那一栏，我就能记住。";

    if (fsEls.fsOpen) fsEls.fsOpen.addEventListener("click", function(){
      ensureUrl().then(function(u){
        if (!u) { toast(NO_URL_TIP); return; }
        if (typeof chrome !== "undefined" && chrome.tabs && chrome.tabs.create) chrome.tabs.create({ url: u });
        else window.open(u, "_blank", "noopener");
      });
    });
    if (fsEls.fsCopy) fsEls.fsCopy.addEventListener("click", function(){
      ensureUrl().then(function(u){
        if (!u) { toast(NO_URL_TIP); return; }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(u).then(function(){ toast("链接已复制"); },
            function(){ toast("复制失败，地址是：" + u); });
        } else {
          toast(u);
        }
      });
    });

    /* 一键建表：建 base → 建数据表与字段 → 清平台默认表 → 设成组织内可编辑 → 填回配置并同步
       ★ 只要 App ID / App Secret。建表不需要邮箱，建完之后的读写也不需要 ——
         表归应用自己，不缺权限。 */
    if (fsEls.fsCreate) fsEls.fsCreate.addEventListener("click", function(){
      var cfg = fsCollect();
      if (!cfg.appId || !cfg.appSecret) { toast("先填 App ID 和 App Secret"); fsEls.fsAppId.focus(); return; }
      if (cfg.baseToken && !confirm("你已经有 Base token 了。再建一张新表会把配置替换成新的，确定？")) return;

      fsEls.fsStat.dataset.busy = "1";
      fsEls.fsStat.textContent = "正在建多维表格，要跟飞书来回几次，稍等…";
      fsEls.fsReport.innerHTML = "";

      Feishu.provision({ appId:cfg.appId, appSecret:cfg.appSecret }).then(function(res){
        delete fsEls.fsStat.dataset.busy;
        renderTestReport({ steps: res.steps });
        if (!res.tableId) { fsEls.fsStat.textContent = "建表没成：" + (res.error || "未知原因"); return; }

        fsEls.fsBase.value = res.appToken;
        fsEls.fsTable.value = res.tableId;
        // baseUrl / tableName 一并存下：底下「底表」那一行靠它们给出「在飞书打开」的入口
        return Sync.writeCfg({
          appId:cfg.appId, appSecret:cfg.appSecret,
          baseToken:res.appToken, tableId:res.tableId, enabled:true,
          baseUrl:res.url || "", tableName:res.tableName || ""
        }).then(function(){
          fsEls.fsOn.checked = true;
          renderWhere();
          fsEls.fsStat.textContent = "表已建好，正在推第一轮…";
          toast("多维表格已创建");
          return sendToBg({ type:"sync-now" });
        }).then(function(r){
          if (r && r.ok) {
            renderFsStat(okState(r));
          } else if (r && r.error) {
            renderFsStat({ state:"error", message:r.error });
          }
        });
      }, function(e){
        delete fsEls.fsStat.dataset.busy;
        fsEls.fsStat.textContent = "建表失败：" + ((e && e.message) || "未知原因");
      });
    });
  }

  /* ---------- 折叠区块：v0.17.0 已删 ----------
     ★ 原来「数据」块自带一个「展开 / 收起」按钮（bindCollapse）——那是
       「六块全铺在一页」时代的东西：页面太长，低频操作收起来换留白。
       改成左导航切页之后它就没意义了 —— 点「数据」本身就是在说「我要看它」，
       再让用户多点一次是白加一层。
     ★ 不要再加回来。真要收东西，用功能块右上角那个「!」卡片。
     ★ 顺带说明为什么**没有**连带删掉 `.hr` 这个类：飞书段仍用它分段。 */

  /* ---------- 桌面悬浮球（v0.11.0） ----------
     设置页只是**问**后台，自己不发原生消息 ——
     native messaging 只能在 Service Worker 里发起，页面里连这个 API 都没有。 */
  function ballPaint(s){
    var dot = document.getElementById("ballDot");
    if (!dot) return;
    var name = document.getElementById("ballName");
    var cnt  = document.getElementById("ballCnt");
    var hint = document.getElementById("ballHint");

    if (!s || s.supported === false) {
      dot.className = "bdot";
      name.textContent = "这个浏览器不支持";
      cnt.textContent = "";
      hint.textContent = (s && s.error) ||
        "球要靠浏览器的「原生消息传递」能力，Chrome / Edge / Tabbit 都有。";
      return;
    }

    /* ★ 只有两态（连上 / 没连上）。球那边也是两态 ——
       这里多画一个"正在连接"的第三态，两边口径就会对不上。 */
    var on = !!s.ok;
    dot.className = "bdot" + (on ? " on" : "");
    name.textContent = on ? "已连上" : "没连上";

    var bits = [];
    if (s.pushes) bits.push("已推 " + s.pushes + " 次");
    if (s.at) bits.push(fmtTime(s.at));
    cnt.textContent = bits.join("，");

    /* ★ 失败原因原样显示，绝不翻译成一句「连接失败」——
       这是唯一的排障抓手，而两种情况完全不同：
         "Specified native messaging host not found." = 宿主程序没装
         "桌面悬浮球没有在运行"                        = 球没开
       折叠成一句笼统的话，等于把线索扔了。 */
    /* ★ v0.16.1：连上之后不再介绍球能干什么（那是介绍，一行就够；
       真想知道的人在 README 里看）。这一行只留**排障线索**。 */
    hint.textContent = on ? "" : (s.error || "还没连过，点「测试连接」试一次。");
  }

  function ballBind(){
    var test = document.getElementById("ballTest");
    if (!test) return;

    // 进页面先问一次（不主动连，免得每次开设置页都拉起一次宿主程序）
    sendToBg({ type: "ball-status" }).then(ballPaint);

    test.addEventListener("click", function(){
      test.disabled = true;
      document.getElementById("ballName").textContent = "连接中…";
      /* 探活是"真连一次再回话"，要等一小会儿（宿主进程启动 + 球没开时的快速失败），
         所以按钮必须先禁用 —— 否则会有人连点五下，然后说"点着没反应"。 */
      sendToBg({ type: "ball-probe" }).then(function(r){
        test.disabled = false;
        ballPaint(r);
      });
    });

    document.getElementById("ballPush").addEventListener("click", function(){
      sendToBg({ type: "ball-push" }).then(function(r){
        ballPaint(r);
        toast(r && r.ok ? "已经把最新任务推给球" : "没推成功 —— 看下面那行原因");
      });
    });
  }

  /* ---------- AI 能力（v0.16.0） ----------

   ★ 为什么配置存独立 key（AI.AIKEY = "taskboard.ai"）而不是并进 prefs：
     上面 nlpOn 的保存是 Store.set({ nlp: ... }, PREFKEY) —— **整块覆盖**。
     AI 的配置里还有 base / model / key，塞进同一个对象的话，
     用户随手关一下「识别日期」就会把 Key 清掉，而这类 bug 只在
     两个功能一起用的时候才现形。分开存，两边互不干扰。

   ★ 权限：manifest 里声明的范围是通配 https（宽泛），但这里只 request
     用户实际填的那个 origin（精确）。Chrome 允许在声明范围内请求任意子集，
     于是用户看到的提示是「读取和更改 api.deepseek.com 上的数据」，
     而不是「读取和更改您在所有网站上的数据」—— 这个差别决定了他敢不敢点「允许」。
     ★ request() 必须在用户手势里同步发起，所以放在 click 回调里、
       不能等 saveCfg 的 Promise 回来再调（那时手势已经过去了）。 */

function aiEl(id){ return document.getElementById(id); }

  /* ---------- 快速选择：七家（v0.18.0）----------
     ★ 颜色 + 首字母做成色块，**不引外部图片**：MV3 CSP 不许远程脚本，
       图片虽然能用，但会把包撑大、还要处理跟不上品牌改版；
       色块零依赖、任何主题下都清楚，也是 Notion / Linear 同类做法。
     ★ base 一律**带 /v1** —— 代码不会替用户补（补错的话报错信息更难懂）。
     ★ model 填的是「最常用那个」，不是「唯一正确那个」，用户随时能改。
     ★ 只有 Claude 带 note：它的官方接口是 /v1/messages，**不是**
       OpenAI 兼容的 /v1/chat/completions。不提这一句的话，
       用户会以为是自己 Key 填错了，然后开始换 Key、换网络，白折腾。 */
  var AI_PRESETS = [
    { prov:"deepseek", name:"DeepSeek", color:"#4D6BFE", ini:"D",
      base:"https://api.deepseek.com/v1", model:"deepseek-chat" },
    { prov:"kimi", name:"Kimi", color:"#111214", ini:"K",
      base:"https://api.moonshot.cn/v1", model:"moonshot-v1-8k" },
    { prov:"claude", name:"Claude", color:"#D97757", ini:"C",
      base:"https://api.anthropic.com/v1", model:"claude-sonnet-4",
      note:"Claude 官方接口不是 OpenAI 兼容格式。如果你用的是中转服务，把地址换成中转给的地址。" },
    { prov:"openai", name:"OpenAI", color:"#10A37F", ini:"O",
      base:"https://api.openai.com/v1", model:"gpt-4o-mini" },
    { prov:"minimax", name:"MiniMax", color:"#E4573D", ini:"M",
      base:"https://api.minimax.chat/v1", model:"abab6.5s-chat" },
    { prov:"glm", name:"GLM", color:"#3856D6", ini:"G",
      base:"https://open.bigmodel.cn/api/paas/v4", model:"glm-4-flash" },
    { prov:"qwen", name:"Qwen", color:"#615CED", ini:"Q",
      base:"https://dashscope.aliyuncs.com/compatible-mode/v1", model:"qwen-plus" }
  ];

  function presetOf(prov){
    for (var i = 0; i < AI_PRESETS.length; i++) {
      if (AI_PRESETS[i].prov === prov) return AI_PRESETS[i];
    }
    return null;
  }

  /* Key 只露尾巴。判据：这一行的作用是回答「有没有填」，
     不是「填的是什么」—— 显示完整 Key 会在截屏、投屏时漏出去。 */
  function maskKey(k){
    k = String(k || "");
    if (!k) return "未填 Key";
    return k.length <= 8 ? "••••••" : "••••" + k.slice(-4);
  }

  /* 只显示域名，不显示整条 URL —— 完整地址会把那一行挤爆，
     而人认地址本来就是认域名。 */
  function hostOf(u){
    return String(u || "").replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  }

  function mLogo(m){
    var p = presetOf(m.prov);
    var color = p ? p.color : "#8d949e";
    var ini = p ? p.ini : (String(m.name || "?").slice(0, 1).toUpperCase());
    return '<span class="mlogo" style="background:' + esc(color) + '">' + esc(ini) + "</span>";
  }

  /* 模型列表。★ 整块重画（见文件头）——不返回增量。 */
  function aiModelsPaint(cfg){
    var box = aiEl("mlist");
    var empty = aiEl("mempty");
    if (!box) return;
    var list = (cfg && Array.isArray(cfg.models)) ? cfg.models : [];
    var active = cfg ? cfg.activeId : "";

    box.innerHTML = list.map(function (m) {
      var on = m.id === active;
      return '<div class="mrow' + (on ? " on" : "") + '" data-id="' + esc(m.id) + '">' +
        mLogo(m) +
        '<span class="mtxt">' +
          '<b class="mname">' + esc(m.name) + "</b>" +
          '<span class="mmeta">' + esc(hostOf(m.base) || "（没填地址）") +
            (m.model ? " · " + esc(m.model) : "") + "</span>" +
        "</span>" +
        '<span class="mkey">' + esc(maskKey(m.key)) + "</span>" +
        '<span class="macts">' +
          (on ? '<span class="mtag">使用中</span>'
              : '<button class="btn sm" type="button" data-act="use">用这个</button>') +
          '<button class="btn sm" type="button" data-act="edit">编辑</button>' +
          '<button class="btn sm" type="button" data-act="del">删除</button>' +
        "</span></div>";
    }).join("");

    /* ★ 空态和列表**互斥**，两个都写死 hidden 的初值会让首屏闪一下 */
    box.hidden = list.length === 0;
    if (empty) empty.hidden = list.length > 0;
  }

function aiPaint(cfg, avail){
  var on = aiEl("aiOn"), more = aiEl("aiMore");
  if (!on || !more) return;

  on.checked = !!cfg.on;
  /* ★ 关掉时这一屏必须**逐行**回到加 AI 之前的样子：
     不留半个灰掉的壳子，也不留一行「已关闭」的说明。 */
  more.hidden = !cfg.on;

  if (aiEl("aiParse"))  aiEl("aiParse").checked  = cfg.scenes.parse === true;
  if (aiEl("aiWeekly")) aiEl("aiWeekly").checked = cfg.scenes.weekly === true;
  if (aiEl("aiSpeak"))  aiEl("aiSpeak").checked  = cfg.scenes.speak === true;

  var isCloud = cfg.where === "cloud";
  if (aiEl("aiWhereLocal")) aiEl("aiWhereLocal").checked = !isCloud;
  if (aiEl("aiWhereCloud")) aiEl("aiWhereCloud").checked = isCloud;
  /* v0.18.0：云端那块从「三个输入框」变成「一张模型列表」。
     这里只负责**画**，增删改在 aiModelBind 里 —— 一屏的东西和一屏的逻辑
     放同一个函数，会变成两个都不好读。 */
  aiModelsPaint(cfg);

  /* ---- 状态（本页顶部那行小字）。它比开关本身更重要：
     用户开完开关最想知道的一件事是「现在到底能不能用」。
     ★ v0.16.1：这一行只说**状态**，不再说**介绍**。
       「不联网、不花钱、不出这台电脑」这类描述已经收进右上角那个「!」；
       这里只留「差一步就能用」的动作指令 —— 那是指引，不是介绍。 ---- */
  /* ★ v0.17.0：这一行**自带主语**。原来它活在 rail 里（头顶就是「AI 能力」
     四个字），所以一个谓词也读得通；rail 收掉之后它孤零零挂在内容区顶部，
     光一句「走云端」读起来是个断句。
     ★ 但这不是把 rail 搬回来 —— 加的是**谓词的主语**（一行小字的前缀），
       不是重复一遍大标题。项目页那行「共 N 条任务…」里的「任务」也是这个角色。
     ★ 反过来项目页那行本来就自明，不用动。 */
  var AI_STAT_PREFIX = "AI 能力 · ";
  var st, hint = "";
  /* ★ 从「当前选中的那条」取凭据，不再读 cfg.cloud ——
     cfg.cloud 是待迁移的老字段，写过 models 之后它就是空的。 */
  var cred = (typeof AI !== "undefined" && AI.activeCloud)
    ? AI.activeCloud(cfg) : { base: "", key: "" };
  var cloudReady = !!(cred.base && cred.key);
  if (!cfg.on) {
    st = "已关闭";
  } else if (isCloud) {
    st = cloudReady ? "走云端" : "云端还没配好";
    if (!cloudReady) hint = "把接口地址和 API Key 填上，再点「保存」。";
  } else {
    st = avail === "available"  ? "本机模型就绪"
       : avail === "downloading" ? "模型正在下载"
       : avail === "downloadable"? "模型还没下载"
       :                          "这台机器不支持";
    /* ★ 唯一必须当场说的话。Chromium 内核的分支浏览器（Tabbit、夸克、
       以及 Microsoft Edge）大多**没有**内置模型 —— 不是坏了，是没编进去。
       不说清的话，用户会以为产品坏了。原因和对照表在「!」里，这里只留动作。 */
    if (avail === "unavailable") hint = "换官方 Chrome，或者把上面切到「云端」。";
  }
  if (aiEl("aiStat")) aiEl("aiStat").textContent = AI_STAT_PREFIX + st;
  if (aiEl("aiWhereHint")) aiEl("aiWhereHint").textContent = hint;

  /* 下载按钮只在「本机 + 真的能下」时露头。★ 不可下载时按钮不出现在 DOM 里，
     而不是出现一个灰的 —— 摆一个点不动的按钮等于给用户出题。 */
  var dl = aiEl("aiDlRow");
  if (dl) dl.hidden = !(cfg.on && !isCloud && avail === "downloadable");
}

function aiPermFor(base, cb){
  var origin;
  try { origin = new URL(base).origin + "/*"; } catch (e) { cb(false); return; }
  if (typeof chrome === "undefined" || !chrome.permissions ||
      !chrome.permissions.contains || !chrome.permissions.request) {
    cb(true);   // 直接用浏览器打开这个页面时的退路（没有扩展 API）
    return;
  }
  chrome.permissions.contains({ origins: [origin] }, function (has) {
    if (has) { cb(true); return; }
    /* ★ 这里仍在 click 的调用栈里（contains 的回调是异步的，但 request
       紧跟着发出，Chrome 的手势判定认这一段）。 */
    try {
      chrome.permissions.request({ origins: [origin] }, function (ok) { cb(!!ok); });
    } catch (e) { cb(false); }
  });
}

function aiBind(){
  if (typeof AI === "undefined") return;
  var on = aiEl("aiOn");
  if (!on) return;

  function refresh(){
    return AI.status().then(function (r) { aiPaint(r.cfg, r.avail); });
  }

  on.addEventListener("change", function(){
    AI.saveCfg({ on: on.checked }).then(function (c) {
      toast(c.on ? "AI 能力已打开" : "AI 能力已关掉，弹窗回到原来的样子");
      return refresh();
    });
  });

  if (aiEl("aiParse")) aiEl("aiParse").addEventListener("change", function(){
    AI.saveCfg({ scenes: { parse: this.checked } }).then(refresh);
  });
  if (aiEl("aiWeekly")) aiEl("aiWeekly").addEventListener("change", function(){
    AI.saveCfg({ scenes: { weekly: this.checked } }).then(refresh);
  });
  /* ★ v0.25.0：关掉它只是让「点球说的那句话」退回本地规则句（notify.js 的
     localLine），**不是让球闭嘴** —— 这条要写在提示里，否则用户会以为
     「关掉 = 它不说话了」，然后开着它却什么都没发生时会觉得是 bug。 */
  if (aiEl("aiSpeak")) aiEl("aiSpeak").addEventListener("change", function(){
    AI.saveCfg({ scenes: { speak: this.checked } }).then(refresh);
  });

  [["aiWhereLocal","local"], ["aiWhereCloud","cloud"]].forEach(function (p) {
    var el = aiEl(p[0]);
    if (!el) return;
    el.addEventListener("change", function(){
      if (!el.checked) return;
      AI.saveCfg({ where: p[1] }).then(refresh);
    });
  });

  /* ---------- 大模型的增删改选（v0.18.0）----------
     ★ 全部活在 aiBind 的闭包里：这几个动作做完都要 refresh()，
       放到外面就得把 refresh 当参数传进来，绕一圈还是同一个作用域的事。 */
  var amEditId = null;     // null = 新增；有值 = 正在编辑那条的 id
  var amProv = "";         // 用户在弹窗里点了哪一家的快速选择

  function aiQuickPaint(sel){
    var box = aiEl("aiQuick");
    if (!box) return;
    box.innerHTML = AI_PRESETS.map(function (p) {
      return '<button type="button" class="qbtn' + (p.prov === sel ? " on" : "") +
        '" data-prov="' + esc(p.prov) + '">' +
        '<span class="qlg" style="background:' + esc(p.color) + '">' + esc(p.ini) + "</span>" +
        '<span class="qname">' + esc(p.name) + "</span></button>";
    }).join("");
  }

  /* 预设的一行提示（只有 Claude 有）。★ 元素**按需创建**，
     不写进 HTML —— 只有一家用到它，为一个边缘情况在骨架里留个空 `<p>`
     是给将来读 HTML 的人出一道无解的题。 */
  function aiNotePaint(note){
    var quick = aiEl("aiQuick");
    if (!quick) return;
    var el = aiEl("aiNote");
    if (!el) {
      el = document.createElement("p");
      el.id = "aiNote";
      el.className = "qnote";
      quick.parentNode.insertBefore(el, quick.nextSibling);
    }
    el.textContent = note || "";
    el.hidden = !note;
  }

  function openAiModal(id){
    amEditId = id || null;
    var box = aiEl("aiModal");
    if (!box) return;
    AI.getCfg().then(function (cfg) {
      var m = null;
      if (amEditId) {
        cfg.models.forEach(function (x) { if (x.id === amEditId) m = x; });
      }
      aiEl("aiModalTitle").textContent = m ? "编辑大模型" : "添加大模型";
      aiEl("amName").value   = m ? m.name   : "";
      aiEl("amBase").value   = m ? m.base   : "";
      aiEl("amModel").value  = m ? m.model  : "";
      aiEl("amKey").value    = m ? m.key    : "";
      aiEl("amPrompt").value = m ? m.prompt : "";
      amProv = m ? m.prov : "";
      aiQuickPaint(amProv);
      aiNotePaint(m ? (presetOf(amProv) || {}).note : null);
      box.hidden = false;
      /* 新增时光标落到「名称」（第一格）；编辑时光标落到地址 ——
         编辑最常改的就是地址和 Key，名称基本不动。 */
      try { (m ? aiEl("amBase") : aiEl("amName")).focus(); } catch (e) {}
    });
  }

  function closeAiModal(){
    var box = aiEl("aiModal");
    if (box) box.hidden = true;
    amEditId = null;
    amProv = "";
    /* ★ 关掉就把输入清空：不清的话，关了再点「添加」会看见上一条的 Key
       还留在框里 —— 那一瞬间很难判断是「串了」还是「本来就是这条」。 */
    ["amName", "amBase", "amModel", "amKey", "amPrompt"].forEach(function (id) {
      var el = aiEl(id); if (el) el.value = "";
    });
  }

  function aiTestConn(){
    var btn = aiEl("amTest");
    var base = (aiEl("amBase").value || "").trim();
    var key = aiEl("amKey").value || "";
    var model = (aiEl("amModel").value || "").trim();
    if (!/^https?:\/\//i.test(base)) { toast("接口地址要以 http:// 或 https:// 开头"); return; }
    if (!key) { toast("还没填 API Key"); return; }

    btn.disabled = true;
    btn.textContent = "测试中…";
    function done(msg) {
      btn.disabled = false;
      btn.textContent = "测试连接";
      toast(msg);
    }
    /* ★ 权限请求必须在**用户手势**里同步发起 —— 不能等别的 Promise 回来再调，
       那时手势已经过去了，Chrome 会直接拒。 */
    aiPermFor(base, function (granted) {
      if (!granted) { done("没有授权访问这个地址，请求发不出去"); return; }
      var ctl = null, timer = null;
      try { ctl = new AbortController(); } catch (e) {}
      timer = setTimeout(function () { try { if (ctl) ctl.abort(); } catch (e) {} }, 12000);

      fetch(String(base).replace(/\/+$/, "") + "/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
        body: JSON.stringify({
          model: model || "gpt-4o-mini",
          messages: [{ role: "user", content: "说一句十个字以内的话" }],
          max_tokens: 20, stream: false
        }),
        signal: ctl ? ctl.signal : undefined
      }).then(function (r) {
        clearTimeout(timer);
        if (!r || !r.ok) {
          /* ★ 失败原因**不折叠成一句「失败」**：地址对不对、Key 对不对、
             网络通不通是三件事，而这里没有服务端日志可查 —— 用户手上的线索
             只有地址和 Key，把状态码给他，他至少知道往哪个方向查。 */
          done("没通（HTTP " + (r ? r.status : "?") + "）—— 核对地址是否含 /v1、Key 是否有效");
          return;
        }
        done("通了 —— 这个地址和 Key 能用");
      }).catch(function () {
        clearTimeout(timer);
        done("没通 —— 网络不可达，或地址写错了");
      });
    });
  }

  function aiModalSave(){
    var name   = (aiEl("amName").value   || "").trim();
    var base   = (aiEl("amBase").value   || "").trim();
    var model  = (aiEl("amModel").value  || "").trim();
    var key    = aiEl("amKey").value || "";
    var prompt = (aiEl("amPrompt").value || "").trim();
    var btn = aiEl("amSave");

    if (!/^https?:\/\//i.test(base)) { toast("接口地址要以 http:// 或 https:// 开头"); return; }
    if (!model) { toast("填一下模型名（例如 deepseek-chat）"); return; }
    /* ★ Key 允许空：自建 / 中转服务有些不要 Key，硬性要求只会让人填个假的。 */

    btn.disabled = true;
    AI.getCfg().then(function (cfg) {
      var list = cfg.models.slice();
      var id = amEditId;
      var rec = {
        id: id || ("m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
        name: name || model,       /* 名字空着就用模型名兜 —— 不留一格空白标题 */
        prov: amProv, base: base, model: model, key: key, prompt: prompt
      };
      if (id) {
        for (var i = 0; i < list.length; i++) if (list[i].id === id) list[i] = rec;
      } else {
        list.push(rec);
      }
      var patch = { models: list };
      /* ★ 新加的**顺手切成当前使用**：刚配好就想用是唯一合理的预期。
         编辑时**不动**选中态 —— 用户可能只是改个 Key，不该顺手换掉正在用的那条。 */
      if (!id) patch.activeId = rec.id;
      return AI.saveCfg(patch).then(function () {
        btn.disabled = false;
        var wasNew = !id;
        closeAiModal();
        toast(wasNew ? "已添加「" + rec.name + "」" : "已经改好了");
        return refresh();
      });
    });
  }

  function aiModelBind(){
    var box = aiEl("mlist");
    if (!box) return;

    /* ★ 事件委托（见文件头）：列表每次刷新整块重画。 */
    box.addEventListener("click", function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest("[data-act]") : null;
      if (!btn) return;
      var row = btn.closest(".mrow");
      if (!row) return;
      var id = row.dataset.id;
      var act = btn.dataset.act;
      var nm = (row.querySelector(".mname") || {}).textContent || "这条";

      if (act === "use") {
        AI.saveCfg({ activeId: id }).then(function () {
          toast("换成了「" + nm + "」");
          return refresh();
        });
        return;
      }
      if (act === "edit") { openAiModal(id); return; }
      if (act === "del") {
        /* 两步确认。★ 不用 window.confirm：原生弹窗打断整页，而且没法被测
           （jsdom 里直接抛 not implemented）—— 一个「测不到的确认」等于没有确认。 */
        if (btn.dataset.sure !== "1") {
          btn.dataset.sure = "1";
          btn.textContent = "确认删除";
          toast("再点一次「确认删除」");
          /* 4 秒后复原：手滑点一下不该留下一个待确认的雷，
             而复原方式是整块重画 —— 和刷新走同一条路，不另写一套。 */
          setTimeout(function () {
            var b = aiEl("mlist");
            if (b && b.querySelector('[data-sure="1"]')) refresh();
          }, 4000);
          return;
        }
        AI.getCfg().then(function (cfg) {
          var list = cfg.models.filter(function (m) { return m.id !== id; });
          return AI.saveCfg({ models: list }).then(function () {
            toast("删掉了「" + nm + "」");
            return refresh();
          });
        });
        return;
      }
    });

    ["aiAdd", "aiAdd2"].forEach(function (id) {
      var b = aiEl(id);
      if (b) b.addEventListener("click", function () { openAiModal(null); });
    });

    var q = aiEl("aiQuick");
    if (q) q.addEventListener("click", function (ev) {
      var b = ev.target && ev.target.closest ? ev.target.closest("[data-prov]") : null;
      if (!b) return;
      var p = presetOf(b.dataset.prov);
      if (!p) return;
      amProv = p.prov;
      /* ★ 名字**只在空的时候补**：用户已经写了「我的便宜模型」，
         点一下预设就被改成「DeepSeek」是丢他的输入。
         地址和模型则整组覆盖 —— 点「快速选择」的意图就是「按这家的默认来」。 */
      if (!(aiEl("amName").value || "").trim()) aiEl("amName").value = p.name;
      aiEl("amBase").value = p.base;
      aiEl("amModel").value = p.model;
      aiQuickPaint(p.prov);
      aiNotePaint(p.note || null);
      try { aiEl("amKey").focus(); } catch (e) {}
    });

    var c1 = aiEl("amCancel");   if (c1) c1.addEventListener("click", closeAiModal);
    var c2 = aiEl("aiModalBg");  if (c2) c2.addEventListener("click", closeAiModal);
    var c3 = aiEl("amSave");     if (c3) c3.addEventListener("click", aiModalSave);
    var c4 = aiEl("amTest");     if (c4) c4.addEventListener("click", aiTestConn);

    /* Esc 关弹窗。★ 只在它真开着的时候拦 —— 无条件 preventDefault
       会把别的 Esc 用途一起吃掉，而那种冲突只在两个功能同时用时才现形。 */
    document.addEventListener("keydown", function (ev) {
      if (ev.key !== "Escape") return;
      var m = aiEl("aiModal");
      if (m && !m.hidden) { ev.preventDefault(); closeAiModal(); }
    });
  }

  aiModelBind();

  if (aiEl("aiDl")) aiEl("aiDl").addEventListener("click", function(){
    var btn = this;
    btn.disabled = true;
    /* ★ v0.16.1：这一行是**进度**不是介绍 —— 静止时留空，
       「要下几个 G」已经收进「在哪跑」那个「!」里。 */
    aiEl("aiDlNote").textContent = "开始下载…（可以先干别的）";
    AI.downloadLocal().then(function (a) {
      btn.disabled = false;
      aiEl("aiDlNote").textContent = "";
      toast(a === "available" ? "模型好了" : "还没好 —— 过一会儿再看这一栏");
      refresh();
    });
  });

  refresh();
}

  /* ---------- 「项目」页内的子标签（v0.17.0） ----------
     「项目列表」管分组与配色，「记一笔」管一句话怎么写进来 —— 同源但不同事，
     所以做成页内二级标签，不做成两个平级导航项。
     ★ 配对表写成常量：HTML 那边 aria-controls 指的也是这两个 id，
       加第三个子标签时只改这里一处。 */
  var SUBS = [["tabProj", "paneProj"], ["tabInput", "s-input"]];
  /* ★ 子标签只活在「项目」这一页里。单独拎成常量：切页那边要按它把子标签
     重置到第一项，加 / 换宿主页时只改这一处。 */
  var SUB_HOST = "s-project";

  function pickSub(i){
    SUBS.forEach(function(p, k){
      var btn  = document.getElementById(p[0]);
      var pane = document.getElementById(p[1]);
      if (btn) {
        btn.classList.toggle("on", k === i);
        btn.setAttribute("aria-selected", k === i ? "true" : "false");
      }
      if (pane) pane.hidden = (k !== i);
    });
  }

  function bindSubTabs(){
    if (!document.getElementById(SUBS[0][0])) return;
    SUBS.forEach(function(p, i){
      var btn = document.getElementById(p[0]);
      if (btn) btn.addEventListener("click", function(){ pickSub(i); });
    });
    pickSub(0);
  }

  /* ---------- 左导航切页（v0.17.0） ----------
     ★ 从「滚动锚点 + IntersectionObserver 跟随高亮」改成**真切换**：
       点左边一项，右边只留那一块。原来的做法六块全在 DOM 里铺着，
       想看飞书就得先滚过项目、填写、球三屏 —— 功能一多，设置页就成了一条长走廊。
     ★ 仍然是**只切 hidden，不重建 DOM**：表单里刚敲了一半的值、
       已经绑好的监听器、脚本里存的 element 引用全都原样有效。
       切页只是几次属性写，没有渲染成本，也不会把状态弄丢。
     ★ hash 照旧是 #s-xxx —— 深链、刷新、前进后退都能复现同一页。
       认不出的 hash 落回第一块，绝不留一屏空白。
     ★ 不再需要 IntersectionObserver 了：一页只有一块，没有"滚动到哪儿"可言。 */
  function bindTabs(){
    var links = [].slice.call(document.querySelectorAll(".nav a"));
    var secs  = [].slice.call(document.querySelectorAll(".sec"));
    if (!links.length || !secs.length) return;

    var ids = secs.map(function(s){ return s.id; });

    function show(id, writeHash){
      if (ids.indexOf(id) < 0) return false;      // 认不出的锚点：不动，交给调用方兜底
      secs.forEach(function(s){ s.hidden = (s.id !== id); });
      /* ★ 回到「项目」页就把子标签拨回「项目列表」（详见 `_p_222_subtab.py` 抬头）。
         放在 show() 里而不是 click 回调里 —— 「点导航」和「外部改 hash」两条路
         走同一个规则，不出现各说各话。`#s-input` 那条兜底在 show() 之后
         立刻 pickSub(1) 覆盖掉这次重置，是全页唯一的例外。 */
      if (id === SUB_HOST) pickSub(0);
      /* ★ 切到看板就现读一次数据（v0.18.0）。**不做常驻 storage 监听**：
         看板不进后台链路，打开时读一次就够；常驻监听会跟同步写抢同一个 key
         （而且用户在看板时同步正好回来，画面会在他眼皮底下跳一下）。 */
      if (id === "s-board" && window.Board) window.Board.refresh();
      links.forEach(function(a){
        a.classList.toggle("on", a.getAttribute("href") === "#" + id);
      });
      if (writeHash && location.hash !== "#" + id) location.hash = id;
      return true;
    }

    links.forEach(function(a){
      a.addEventListener("click", function(ev){
        ev.preventDefault();
        if (show(a.getAttribute("href").slice(1), true)) window.scrollTo(0, 0);
      });
    });

    /* ★ 认不出的 hash 落回第一块，绝不留白。
       ★ `#s-input` 是个特例：那是 v0.17.0 之前「填写」的锚点，老书签 /
         老 README 可能还指着它 —— 落到「项目」页**并替用户把子标签切到
         「记一笔」**，而不是丢给他一个查无此锚的空白页。 */
    function fromHash(){
      var id = (location.hash || "").slice(1);
      if (id === "s-input") {
        show("s-project", false);
        pickSub(1);
        return;
      }
      show(ids.indexOf(id) >= 0 ? id : ids[0], false);
    }

    window.addEventListener("hashchange", fromHash);
    fromHash();
  }

  /* ---------- 关于页（v0.24.0） ----------
     ★ 三件事：展开双码、复制收款人备注、把版本号从 manifest 读出来。
     ★ 版本号**不写死在 HTML 里**（见那句首屏占位的注释）：写死就是第二个
       版本号出处，manifest 一升版它就开始说谎，而且没有任何症状。
     ★ 复制走双路：Clipboard API 在扩展页可用，但它返回 Promise、且要求
       文档聚焦 —— 失败时降级 execCommand，绝不留下一个「点了没反应」的按钮。
       用户点了复制却什么都没发生，比按钮不存在更糟（他会去手动选中，
       然后以为自己选中了没复制上）。 */
  function fallbackCopy(text){
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    /* 不能用 display:none / hidden —— 那样选不中，execCommand 直接返回 false。
       挪到视口外是唯一既看不见、又真能选中的做法。 */
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  function copyNick(text){
    var note = function(ok){ toast(ok ? "已复制：" + text : "复制失败，请手动选中"); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function(){ note(true); },
        function(){ note(fallbackCopy(text)); });
      return;
    }
    note(fallbackCopy(text));
  }

  function bindAbout(){
    var btn = document.getElementById("abToggle");
    var box = document.getElementById("abDonate");
    if (btn && box) {
      btn.addEventListener("click", function(){
        /* ★ 以 aria-expanded 为唯一真值，不另设一个 open 变量：
           两处状态迟早对不上，而对不上时屏幕上看不出谁对。 */
        var open = btn.getAttribute("aria-expanded") === "true";
        btn.setAttribute("aria-expanded", open ? "false" : "true");
        box.hidden = open;
      });
    }
    [].slice.call(document.querySelectorAll(".ab-copy")).forEach(function(b){
      b.addEventListener("click", function(){
        copyNick(b.getAttribute("data-nick") || "");
      });
    });
    var ver = document.getElementById("abVer");
    if (!ver) return;
    var mv = "";
    try { mv = chrome.runtime.getManifest().version; } catch (e) { mv = ""; }
    if (mv) ver.textContent = "v" + mv;
  }

  /* ---------- 启动 ---------- */
  Promise.all([Store.get(PKEY), Store.get(), Store.get(PREFKEY), Store.get(WBKEY), Store.get(MCKEY),
               Store.get(NTKEY)]).then(function(r){
    var list = r[0], data = r[1];
    if (Array.isArray(list) && list.length) projects = list;
    if (data && Array.isArray(data.tasks)) {
      st.view = data.view || "today";
      st.tasks = data.tasks;
    }
    /* 自然语言开关。★ 存的是 { nlp: bool } 整个对象，不是单个布尔 ——
       以后再加别的偏好时不用改 key，老数据也不会因为多一个字段就读不出来。 */
    var nlpBox = document.getElementById("nlpOn");
    if (nlpBox) {
      var pr = readPrefs(r[2]);
      nlpBox.checked = pr.nlp;
      nlpBox.addEventListener("change", function(){
        Store.set({ nlp: !!nlpBox.checked }, PREFKEY).then(function(){
          toast(nlpBox.checked ? "已打开「识别日期 / #项目 / !优先级」"
                               : "已关掉：记一笔按纯文字处理");
        });
      });
    }

    /* 网页悬浮球开关（v0.22.0）
       ★ 拨完立刻写、不等「保存」按钮 —— 跟上面 nlpOn 同一个手势习惯，
         同一页里两个开关两种交互是最容易被骂的那种不一致。
       ★★ v0.24.1：原来这里会在开关旁边回一行状态字。删了 ——
         开关**自己就是回执**（轨道变实心 + 钮滑过去），旁边再摆一行字是噪声。
         老大原话：「不要有文字提示，只要按钮显示就好了」。 */
    var wbBox = document.getElementById("wbOn");
    if (wbBox) {
      wbBox.checked = readWb(r[3]);
      wbBox.addEventListener("change", function(){
        var on = !!wbBox.checked;
        /* ★ 写的是整个 {on:...} 对象：这个 key 目前只有这一个字段，
           将来要加字段时必须**连着这里一起改成合并写**，不然就是上面那个坑的复刻。 */
        Store.set({ on: on }, WBKEY).then(function(){
          toast(on ? "网页上会显示悬浮球" : "已关掉：任何网页都不再出现悬浮球");
        });
      });
    }

    /* ---------- 主动提醒（v0.25.0）----------
       ★★ 这个开关跟上面三个有一处**根本差别**：那三个问的是「要不要在屏幕上
         多画点东西」，默认值都倾向开；这个问的是「要不要在你没看着它的时候
         跳出来」。所以它**默认关，而且只有显式勾上才算开**（notify.js 的 readCfg）。
         风险不对称，默认值就不该对称 —— 跟 AI 总开关默认关是同一条理由。
       ★★ 写入必须是**完整对象**：Store.set 对这个 key 是整块覆盖，而
         「上次什么时候发的」（lastAt）就存在同一个对象里 —— 只写 {on:true}
         会把 lastAt 抹掉，症状是「关掉再打开，当天可能被提醒两次」，
         而且只在那个操作顺序下复现。
       ★★ 关掉时**不清 lastAt**：日限流要继续作数。清了的话，用户关一下再打开
         就等于把当天的额度重置了 —— 他随手一拨，那天就多收一条。 */
    var ntBox = document.getElementById("ntOn");
    if (ntBox) {
      var ntAct = document.getElementById("ntAct");
      var ntHint = document.getElementById("ntHint");
      var ntTest = document.getElementById("ntTest");
      var ntCfg = (typeof Notify !== "undefined")
        ? Notify.readCfg(r[5]) : { on: false, lastAt: 0 };

      function ntWhen(ts){
        var d = new Date(ts);
        return (d.getMonth() + 1) + "月" + d.getDate() + "日 " +
          String(d.getHours()).padStart(2, "0") + ":" +
          String(d.getMinutes()).padStart(2, "0");
      }
      function ntPaint(){
        ntBox.checked = !!ntCfg.on;
        /* ★ 「试一条」跟着开关一起露头/收起：关着的时候摆一个按钮，
           用户点它发出的通知会让他以为「我明明关了啊」。 */
        if (ntAct) ntAct.hidden = !ntCfg.on;
        if (ntHint) ntHint.textContent = ntCfg.lastAt ? ("上次提醒 " + ntWhen(ntCfg.lastAt)) : "";
      }

      ntBox.addEventListener("change", function(){
        ntCfg.on = !!ntBox.checked;
        Store.set(ntCfg, NTKEY).then(function(){
          ntPaint();
          toast(ntCfg.on ? "有任务过期、你又一天没来时，会提醒你一次"
                         : "已关掉：不再主动提醒");
        });
      });

      if (ntTest) ntTest.addEventListener("click", function(){
        if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) {
          toast("这条通道现在不可用");
          return;
        }
        /* ★ 走后台的 dry 通道：手点的这一次**不记账** —— 否则用户试完就把
           今天那条额度用掉了，真到该提醒的时候它不吭声，而他会以为功能是坏的。 */
        chrome.runtime.sendMessage({ type: "notify-test" }, function (res){
          toast((res && res.ok) ? ("这条就是它的样子：" + res.message) : "这条通道现在不可用");
        });
      });

      ntPaint();
    }

    /* ---------- 吉祥物（v0.24.0）
       ★★ 这个 key 的每一次写入都必须是**完整对象**（on / char / size / reacts）。
         Store.set 对它同样是整块覆盖：只写 {char:"cat"} 会把 on 一起抹掉，
         症状是「换了个脸，吉祥物自己关上了」—— 而且只在「先关过、再换脸」时复现，
         单测各测各的永远绿。所以本地维护一份 mcCfg，所有改动都在它上面合并再整块写。
       ★ 角色清单读 mascots/index.json（处理资源时生成的），**不在这儿写死数组** ——
         写死的话，以后增删一个角色要改两处，而漏掉的那处不会报错，只是少一个。
       ★ readConfig 与 ballpage.js 共用同一份实现（mascot.js 里的那个），
         所以「设置页显示开着、网页上却是关的」这类两处口径不一致的怪事不会发生。 */
    var mcBox = document.getElementById("mcOn");
    if (mcBox && typeof TaskMascot !== "undefined") {
      var mcHint = document.getElementById("mcHint");
      var mcPick = document.getElementById("mcPick");
      var mcFace = document.getElementById("mcFace");
      var mcName = document.getElementById("mcName");
      var mcSizeEl = document.getElementById("mcSize");
      var mcGrid = document.getElementById("mcGrid");
      var mcDel = document.getElementById("mcDel");
      var mcFile = document.getElementById("mcFile");
      var mcUp = document.getElementById("mcUp");
      var mcCfg = TaskMascot.readConfig(r[4]);
      var MCBASE = "mascots";
      var mcNames = {};        /* id → 中文名（渲染网格时顺手记下，paint 要用） */
      /* 自定义那一组/那一格的显示名。★ 用**常量**而不是在三处各写一遍字面量：
         「设置页那格叫一个名字、快照里叫另一个」是那种没人会去查的不一致。 */
      var CUSTOM_GROUP = "自定义";
      var CUSTOM_NAME = "你自己的图";
      /* 两张雪碧 dataURL 合计的体积上限（本钱：storage 一处、快照一处）。
         超了就降一档质量重烘，不再往上加。 */
      var MC_IMG_MAX = 400000;
      /* ★★★ v0.24.1：给 `renderMcGrid` 在**函数作用域**上先占一个位置。
         它的调用方除了下面初始化那条，还有**上传 / 删掉**两条异步路径 ——
         那两处写在 `else { ... }` 块的**外面**，而 manage.js 是 `"use strict"`：
         严格模式下块内的 function 声明是**块作用域**的，块外那个标识符压根没绑过值，
         调用那句直接抛 ReferenceError。
         ★ 这个 bug 极难发现 —— 屏幕上看到的只是「网格没重画」，而同一时刻
           storage 已经写进去了、左边预览脸也换了、「删掉」也露面了；
           file:// 下 onerror 只有一句没有栈的 "Script error."。
           → 真机探针 `_p_395_upshot.py` 抓到的；jsdom 那批查的是源码形状 + 预置渲染，
             **从没真的走一遍 change**（jsdom 没有 canvas，走不到那儿）。
         ★ 块里改成**赋值**（而不是也搬出来）：`mcOrder/mcByGroup` 那些状态留在块里，
           由这个闭包捕获 —— 一个渲染器、一份状态，不会出现两个渲染器各画一半。
         ★ 默认给个空函数：清单没读进来时块不会跑，那时调用它就是「什么也不做」，
           比 undefined 被当函数调用（又是一个 ReferenceError/TypeError）稳。 */
      var renderMcGrid = function(){};


      function paintMc(){
        mcBox.checked = mcCfg.on;
        /* ★ v0.24.1：这里原来写状态字，现在只**清空**。
           #mcHint 从今往后只在一个场合出现：清单真的没读进来
           （那时网格是空的，必须说话）；平时它一个字都不该有。 */
        if (mcHint) mcHint.textContent = "";
        if (mcPick) mcPick.hidden = !mcCfg.on;
        /* ★ 自定义图的缩略图是 dataURL，不从 MCBASE 拼路径。
           「有没有 thumb」就是判据 —— 跟网格里那格用的是同一个判断，
           两处口径分叉就是「设置页是自己的图、球上还是狐狸」那类怪事的温床。 */
        var isCustom = mcCfg.char === "custom" && !!mcCfg.custom;
        if (mcFace) {
          mcFace.style.backgroundImage = "url(" +
            (isCustom ? mcCfg.custom.thumb
                      : (MCBASE + "/thumb/" + mcCfg.char + ".webp")) + ")";
        }
        if (mcName) mcName.textContent = isCustom
          ? CUSTOM_NAME : (mcNames[mcCfg.char] || mcCfg.char);
        /* 没传过图就没有「删掉」—— 一个删不掉东西的按钮比没有按钮更糟 */
        if (mcDel) mcDel.hidden = !mcCfg.custom;
        if (mcSizeEl) {
          [].forEach.call(mcSizeEl.querySelectorAll("button"), function(b){
            b.classList.toggle("on", Number(b.getAttribute("data-sz")) === mcCfg.size);
          });
        }
        if (mcGrid) {
          [].forEach.call(mcGrid.querySelectorAll("button"), function(b){
            b.classList.toggle("on", b.getAttribute("data-id") === mcCfg.char);
          });
        }
      }

      /* 合并写入。msg 为空就静默（换尺寸没必要每次都弹一句） */
      function saveMc(patch, msg){
        for (var k in patch) if (patch.hasOwnProperty(k)) mcCfg[k] = patch[k];
        Store.set(mcCfg, MCKEY).then(function(){
          paintMc();
          if (msg) toast(msg);
        });
      }

      paintMc();

      mcBox.addEventListener("change", function(){
        saveMc({ on: !!mcBox.checked },
               mcBox.checked ? "球会变成会转头的小家伙" : "已关掉：退回原来那颗圆球");
      });

      if (mcSizeEl) {
        mcSizeEl.addEventListener("click", function(e){
          var b = e.target.closest ? e.target.closest("button") : null;
          if (!b) return;
          saveMc({ size: Number(b.getAttribute("data-sz")) }, null);
        });
      }

      if (mcGrid) {
        mcGrid.addEventListener("click", function(e){
          var b = e.target.closest ? e.target.closest("button") : null;
          if (!b || !b.getAttribute("data-id")) return;
          saveMc({ char: b.getAttribute("data-id") },
                 "换成了「" + (mcNames[b.getAttribute("data-id")] || b.getAttribute("data-id")) + "」");
        });
      }

      /* ★★ 清单从 `mascots/index.js` 来（`<script src>` **同步**加载，见那个文件的抬头）。
         为什么不是当场 fetch 那个 .json：Chrome 对 `file://` 下的 fetch 是**直接拒绝**的
         （实测 `TypeError: Failed to fetch`），而设置页在 file:// 下也要能看 ——
         真机验收与本地预览都走这条路。换 script 标签之后三种协议一律可用，
         顺带还消掉两条：① 网格不再「晚一拍弹出来」；② 没有 reject 路径要兜。
         ★ 用 `typeof` 挡一层：清单文件没打进包时这个标识符**不存在**，
           直接写 `MASCOT_INDEX` 会在取值那一步抛 ReferenceError，
           那不是 Promise 的 reject，接不住 —— 整段 boot 会断在半路上（设置页半页空白）。
         ★ 失败仍然要**说话**：开关看着是开的、网格却是空的，用户只会觉得「坏了」，
           而控制台里那句 404 他永远看不到。 */
      var list = (typeof MASCOT_INDEX !== "undefined" && Array.isArray(MASCOT_INDEX))
        ? MASCOT_INDEX : null;
      if (!mcGrid || !list || !list.length) {
        if (mcHint) mcHint.textContent = "角色清单没读到（mascots/index.js 没进包）";
        if (mcGrid) mcGrid.textContent =
          "角色清单加载失败；若一直这样，是包里的 mascots/ 没打进去。";
      } else {
        /* ★★★ 分组必须**先聚类再渲染**。清单是按 id 字典序排的（afro / astronaut /
           bear / beard / builder / …），组名在里面**来回跳**（人物,人物,动物,人物,…）——
           原来写成「组名一变就新起一条标题」，真机截图里就是一屏三个「人物」、
           同一组被拆成好几段，而屏幕上**一点报错都没有**（它只是「标题有点多」）。
           ★ 所以这里**不许**出现「上一条是什么组」那种比较：那就是这个 bug 的形状，
             `_pack.py` 有一条反向门专门盯着 `lastGroup` 这个名字。
           ★ 组的先后 = 组名**第一次出现**的顺序（人物 / 动物 / 机器与物件），
             不是字典序（字典序会把「机器与物件」排到最前，跟清单的直觉顺序对不上）。 */
        var order = [], byGroup = {};
        list.forEach(function(c){
          var g = c.group || "其他";
          if (!byGroup[g]) { byGroup[g] = []; order.push(g); }
          byGroup[g].push(c);
          mcNames[c.id] = c.name;
        });

        /* ★★ 用户自己的图也**占一格**，而且排在最前面、自己一组。
           为什么不另做一套「自定义」面板：换回内置角色和换到自己的图，
           手势必须是**同一个**（都是点格子）—— 两套交互就是「同一页里两个开关
           两种手感」的复刻，本仓库在 v0.22.0 已经栽过一次同形状的。
           ★ 它随 mcCfg.custom 来去（删掉之后要能收回去），所以单独一个同步函数；
             它是**幂等**的，重复调用不会把自定义组插两次。 */
        function mcSyncCustomGroup(){
          var at = order.indexOf(CUSTOM_GROUP);
          if (mcCfg.custom) {
            byGroup[CUSTOM_GROUP] = [{
              id: "custom", name: CUSTOM_NAME, thumb: mcCfg.custom.thumb
            }];
            if (at < 0) order.unshift(CUSTOM_GROUP);
          } else if (at >= 0) {
            order.splice(at, 1);
            delete byGroup[CUSTOM_GROUP];
          }
        }

        /* ★ 提成函数（原来这段是内联的）：传完图/删完图都要**重画一遍**网格，
           而「重画」只有这一条路 —— 复制一份到上传分支里 = 两个渲染器迟早不一致。 */
        renderMcGrid = function(){
          mcSyncCustomGroup();
          while (mcGrid.firstChild) mcGrid.removeChild(mcGrid.firstChild);
          var frag = document.createDocumentFragment();
          order.forEach(function(g){
            var sep = document.createElement("div");
            sep.className = "mcsep";
            /* ★ 标题带上**自己那组的条数**：每组最后一行多半填不满，
               不带条数时那片空白看起来像「渲染断了」；带上它就是「这组就这么多」。 */
            sep.textContent = g + " · " + byGroup[g].length;
            frag.appendChild(sep);
            byGroup[g].forEach(function(c){
              var b = document.createElement("button");
              b.type = "button";
              b.setAttribute("data-id", c.id);
              b.title = c.name;
              var img = document.createElement("img");
              /* ★ 自定义那格用 dataURL、内置的拼路径 —— 判据是「有没有 thumb」 */
              img.src = c.thumb ? c.thumb : (MCBASE + "/thumb/" + c.id + ".webp");
              img.alt = c.name;
              /* ★ 用 setAttribute 而不是 img.loading = ...：属性才是浏览器认的那份；
                 而且 jsdom 没实现 loading 这个反射属性，写 property 在单测里读不到，
                 「是不是 lazy」这条门就变成永远红的假红。 */
              img.setAttribute("loading", "lazy");
              b.appendChild(img);
              frag.appendChild(b);
            });
          });
          mcGrid.appendChild(frag);
        };
        renderMcGrid();
        paintMc();
      }

      /* ---------------- 上传自己的图（v0.24.1） ----------------
         ★ 全流程三步：归一化 → 烘雪碧 → 整块写 storage。
           任何一步失败都只 toast 一句话，**绝不写半份配置**（写进去就是一张空白球）。 */

      /* 归一化：读文件 → cover 裁到 SRC 见方。走 createObjectURL 而不是 FileReader，
         前者不把整张图读进内存字符串（用户可能丢一张 20MB 的手机原图进来）。 */
      function mcNorm(file, cb, bad){
        if (!file) return bad("没选到文件");
        if (!window.URL || !URL.createObjectURL) return bad("这个环境读不了本地文件");
        var url = URL.createObjectURL(file);
        var im = new Image();
        im.onload = function(){
          var cv = null;
          try {
            var S = TaskMascot.CUSTOM.SRC;
            var r = TaskMascot.coverRect(im.width, im.height, S);
            cv = document.createElement("canvas");
            cv.width = S;
            cv.height = S;
            var g = cv.getContext("2d");
            /* ★ 先铺一层白：透明 PNG 直接画上去，在深色主题里背后是深底，
               看着像"图坏了"。铺白之后至少是一张正常的方图。 */
            g.fillStyle = "#fff";
            g.fillRect(0, 0, S, S);
            g.imageSmoothingEnabled = true;
            g.imageSmoothingQuality = "high";
            g.drawImage(im, r.x, r.y, r.w, r.h);
          } catch (e) {
            cv = null;
          }
          URL.revokeObjectURL(url);
          if (cv) cb(cv);
          else bad("这张图处理不了");
        };
        im.onerror = function(){
          URL.revokeObjectURL(url);
          bad("这不像是一张图片");
        };
        im.src = url;
      }

      /* 烘两张 3×3 雪碧 + 一张缩略图。
         ★ 质量档会在超出体积预算时自动降一档：这两张 dataURL 要进 storage，
           还要跟着快照过 native messaging（Chrome 那条通道单条消息上限 1MB）。 */
      function mcBake(cv){
        function sheet(plan, q){
          var box = TaskMascot.CUSTOM.SRC * 3;
          var c2 = document.createElement("canvas");
          c2.width = box;
          c2.height = box;
          var g2 = c2.getContext("2d");
          g2.imageSmoothingEnabled = true;
          g2.imageSmoothingQuality = "high";
          TaskMascot.drawAtlas(g2, cv, plan, TaskMascot.CUSTOM.SRC);
          return c2.toDataURL("image/webp", q);
        }
        var dirs = sheet(TaskMascot.CUSTOM.DIRS, 0.82);
        var reacts = sheet(TaskMascot.CUSTOM.REACTS, 0.82);
        if (dirs.length + reacts.length > MC_IMG_MAX) {
          dirs = sheet(TaskMascot.CUSTOM.DIRS, 0.6);
          reacts = sheet(TaskMascot.CUSTOM.REACTS, 0.6);
        }
        var T = TaskMascot.CUSTOM.THUMB;
        var tc = document.createElement("canvas");
        tc.width = T;
        tc.height = T;
        tc.getContext("2d").drawImage(cv, 0, 0, T, T);
        return { dirs: dirs, reacts: reacts, thumb: tc.toDataURL("image/webp", 0.85) };
      }

      if (mcUp && mcFile) {
        mcUp.addEventListener("click", function(){ mcFile.click(); });
        mcFile.addEventListener("change", function(){
          var f = mcFile.files && mcFile.files[0];
          /* ★ 立刻清空：不清的话「再传同一张图」不会触发 change（值没变），
             用户会以为按钮坏了。 */
          mcFile.value = "";
          mcNorm(f, function(cv){
            var bun;
            try {
              bun = mcBake(cv);
            } catch (e) {
              toast("这张图太大了，换一张小点的试试");
              return;
            }
            saveMc({ char: "custom", custom: {
              dirs: bun.dirs, reacts: bun.reacts, thumb: bun.thumb,
              /* sig：换图必须刷新它。桌面球的快照指纹只认 char，而 char 一直是
                 "custom" —— 不换 sig 的话「换了一张自己的图」在球上完全无感。 */
              sig: String(Date.now())
            } }, "换成了你自己的图");
            renderMcGrid();
          }, function(msg){ toast(msg); });
        });
      }

      if (mcDel) {
        mcDel.addEventListener("click", function(){
          /* ★ 删掉要**连数据一起删**（不是只把 char 换回去）：留着两份用不上的
             dataURL 在 storage 里，用户再也没有入口能删掉它。
             ★ 回到 TaskMascot.DEFAULT.char 而不是写死 "fox" —— 默认角色将来换了，
               这里跟着换；写死就是第二个口径。 */
          delete mcCfg.custom;
          saveMc({ char: TaskMascot.DEFAULT.char }, "已删掉你自己的图");
          renderMcGrid();
        });
      }
    }

    bindTabs();
    bindSubTabs();
    bindAbout();
    renderProjects();
    renderArch();
    renderStat();
    ballBind();
    aiBind();
    if (typeof Sync !== "undefined") { fsBind(); fsInit(); }
  });
})();
