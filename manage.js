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
  /* ★★★ v0.29.0：自定义**库**（存多个自定义形象）开一个**新 key** ——
     `taskboard.mascot.custom` 的形状**一个字不改**。理由有两条硬的：
       ① 那一份是共享面：mascot.js 的 readConfig/readCustom、网页球、桌面球、
          快照链路全按它的形状读。动它就要重编桌面球 exe，而且共享面两边
          必须逐字节相同（`desktop-ball-tauri` 里那条）。
       ② 快照（native messaging，单条上限 1 MB）里带的是 readMc() 解出来的
          **当前那一个** custom。库要是并进 mascot 配置，就等于每次推快照都把
          一两 MB 的图过一遍那条通道。
     ★ 库只在设置页读写：background.js 的 storage 取值清单里**没有**这个 key。 */
  var LIBKEY = "taskboard.mc.customs";
  /* ★ 团队派发配置（v0.32.0）。同样从常量取，理由与 NTKEY 一模一样。 */
  var IKKEY = (typeof Inbox !== "undefined" && Inbox.CFK) ? Inbox.CFK : "taskboard.inbox";
  /* ★★★ v0.32.0 事故：下面那个 `tmKeep` 原来**没在这儿声明**，直接在 wireTeam 里
     写了一句 `tmKeep = function (patch) {...}`。本文件是 `"use strict"`，
     **给没声明过的变量赋值会抛 ReferenceError** —— 而赋值点正好在启动那一串
     `.then` 的中间，于是一抛之后**后面所有接线一次都没执行**，
     症状就是「设置页所有东西点了没反应」（老大报的就是这个）。
     ★★ 为什么测试一个都没红：测试跑在 **jsdom** 里，而 jsdom **没有实现**这条规则
     —— 同样的两句 Node(V8) 里必抛，jsdom 里会**静默泄漏成 window.tmKeep**。
     ⇒ 「某个规则在我的测试环境里不存在」时，那条规则在测试里**永远是绿的**。
     ★ 所以这里必须**先声明**（值为 null），wireTeam 里再赋值；`_validate.py` 里
       也补了一条静态门：IIFE 里被赋值的名字必须在同文件里有 var/let/const/function 声明。 */
  var tmKeep = null;
  /* 自定义那一组/那一格的显示名。★ 用**常量**而不是在几处各写一遍字面量：
     「设置页那格叫一个名字、快照里叫另一个」是那种没人会去查的不一致。 */
  var CUSTOM_GROUP = "自定义";
  var CUSTOM_NAME = "你自己的图";
  /* 库的条数上限。★ 定这个数的依据是**字节**不是审美：每项 = 源图九宫格
     （480² webp）+ 成品两张雪碧（480² webp，硬上限 400 KB）+ 缩略图（68²），
     典型 100~150 KB。storage.local 配额 10 MB（manifest 里**没有**
     unlimitedStorage），20 项 ≈ 2~3 MB，留下了余量。 */
  var MC_LIB_MAX = 20;
  /* 库里那一项没有缩略图时用的 1×1 透明 GIF。
     ★ 为什么需要它：网格渲染写的是 `c.thumb ? c.thumb : MCBASE + "/thumb/" + c.id + ".webp"`，
       而自定义项的 id 形如 `custom:<sig>` —— 没有 thumb 时那行会拼出一个
       必然 404 的路径，屏幕上就是格子角上一个碎图标。 */
  var MC_BLANK = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

  /* 库的清洗。★ 为什么必须清洗而不是直接信 storage：这个 key 是我们自己写的，
     但**用户可能装过旧版、也可能手工改过**；一条形状不对的记录会让 renderMcGrid
     抛错，而那个错发生在绑定完成之前 —— 屏幕上只表现为「角色网格是空的」，
     连吉祥物开关都跟着失灵，控制台里那句才是真相。
     ★ 顺手按 sig 去重：sig 是「哪一项」的唯一标识，两条同 sig 的记录会让
       「点第 2 项」和「点第 1 项」选中同一个东西（点谁都是它，且不报错）。 */
  function mcLibClean(v){
    var out = [];
    if (!Array.isArray(v)) return out;
    v.forEach(function(x){
      if (!x || typeof x !== "object") return;
      if (typeof x.sig !== "string" || !x.sig) return;
      /* 两张成品雪碧是这一项的**实体**（没有它这一项根本画不出来） */
      if (typeof x.dirs !== "string" || !x.dirs) return;
      if (typeof x.reacts !== "string" || !x.reacts) return;
      for (var i = 0; i < out.length; i++) if (out[i].sig === x.sig) return;
      out.push({
        sig: x.sig,
        name: (typeof x.name === "string" && x.name) ? x.name : CUSTOM_NAME,
        /* src = 九张**归一化后的源图**拼成的 3×3（480² webp）。「编辑」靠它回填。
           ★ 缺失是合法状态：v0.28.x 存下来的那一张只有成品、没有源图。 */
        src: (typeof x.src === "string" && x.src) ? x.src : null,
        /* had = 当初哪几格有图（9 个 "0"/"1"）。回填时用它把空格还原成空格 ——
           源图里空格是透明的，只看像素分不出「这格本来就没图」和「这格是张透明图」。 */
        had: (typeof x.had === "string" && x.had.length === 9) ? x.had : "111111111",
        dirs: x.dirs,
        reacts: x.reacts,
        thumb: (typeof x.thumb === "string") ? x.thumb : ""
      });
    });
    return out.slice(0, MC_LIB_MAX);
  }

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
    ["fsAppId","fsSecret","fsBase","fsTable","fsOn","fsTest","fsNow","fsStat","fsReport",
     "fsLink","fsCreate","fsWhere","fsWhereName","fsWhereCnt","fsWhereHint","fsOpen","fsCopy",
     // ★ v0.27.0：扫码创建应用。fsSave（「保存并同步」）已并进 fsNow，见 fsInit 里的说明。
     "fsQR","fsQRBox","fsQRImg","fsQRHint","fsQROpen","fsQRCancel"]
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

    /* 「立即同步」= 存下当前填的配置 + 推一轮（这原来是「保存并同步」的活）。
       ★ 为什么把两个按钮并成一个（v0.27.0）：
         原来并排三个 —— 测试连接 / 保存并同步 / 立即同步。后两个的差别只是
         「要不要先存配置」，而这个差别对用户没有意义：改完配置的人本来就会先存再同步。
         三个摆一起，只会让人挨个点一遍试。
       ★ 合并方向：行为取原来 fsSave 那套（先 writeCfg 再 sync-now）——
         「配置改了要先生效」这条更安全；文案取「立即同步」，它更直白。
       ★ 删 fsSave 前确认过门槛里没人引用它：_validate.py / _test_manage.js / _pack.py
         只认 fsTest / fsCreate / fsLink / fsBase / fsTable。 */
    fsEls.fsNow.addEventListener("click", function(){
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

    fsEls.fsOn.addEventListener("change", function(){
      Sync.writeCfg({ enabled: fsEls.fsOn.checked }).then(function(){
        toast(fsEls.fsOn.checked ? "已启用，稍后自动同步" : "已停用同步");
      });
    });

    /* ---------- 扫码创建应用（v0.27.0） ----------
       飞书有一条「扫码建应用」的通道（OAuth 2.0 设备授权，RFC 8628），
       用户不必自己跑去开放平台点七八下。三步：
         init  → 问平台支持哪些认证方式
         begin → 拿 device_code 和一条授权链接（这条链接就是要画成二维码的东西）
         poll  → 每 5 秒问一次；用户在飞书里确认完，就回 app_id / app_secret

       ★★ 协议不是猜的。下面这些常数是从官方 Python SDK 的 scene/registration
          源码里逐行读出来的，并在真实环境跑通过（2026-09-19）：
            · 请求体必须是 application/x-www-form-urlencoded。发 JSON 时服务端
              解析不到参数，只回一句含糊的「auth method is unsupported」——
              我第一轮就是被这句话绕了一大圈，以为是权限问题。
            · begin 必须带齐三个参数：archetype=PersonalAgent / auth_method=client_secret
              / request_user_info=open_id，少一个都拿不到码。
            · poll 的「还没扫」是 HTTP 400 + error:"authorization_pending"，不是 200。
            · 实测返回：user_code 形如 VKSQ-SG6P，expires_in=3600 秒，interval=5 秒。
       ★ 端点域是 accounts.feishu.cn（不是 open.feishu.cn）——
         manifest 里为此单开了一条 host_permissions，别当成重复的删掉。 */

    var REG_API = "https://accounts.feishu.cn/oauth/v1/app/registration";
    var qrTimer = null;
    var qrLink = "";
    /* 代际计数：每点一次「扫码创建」就 +1。
       上一轮的轮询发现自己这代过期了就直接退出 —— 
       比布尔标志干净（不用在每处 return 前记得复位），
       也顺手解决了「等待中点取消」和「等待中又点一次」两种情况。 */
    var qrGen = 0;

    function qrStop(){ if (qrTimer) { clearTimeout(qrTimer); qrTimer = null; } }

    function regPost(params){
      var body = Object.keys(params).map(function(k){
        return encodeURIComponent(k) + "=" + encodeURIComponent(params[k]);
      }).join("&");
      return fetch(REG_API, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body
      }).then(function(r){ return r.json(); });
    }

    /* addons = 预填到「用户扫码后的确认页」上的权限。
       ★ 编码方式（JSON → gzip → base64url 去填充）抄自官方 SDK 的 _encode_addons，
         解回来的内容必须与原文逐字相同 —— 这一步在本地用 Python 的 gzip 对过。
       ★ 只声明真正要用的两条：
           bitable:app                    读写任务数据（核心，没有它整个功能不成立）
           drive:drive.metadata:readonly  查这张表的网址（「在飞书打开」用它；拿不到只降级）
         preset:false = 不要平台默认底座那一套权限，最终应用只带上面两条。
         这样用户扫码后的确认页上只有两行权限，看得懂、也少一层顾虑。
       ★ 浏览器侧 gzip 走 CompressionStream（Chrome 80+ 就有；本扩展最低 116）。
         它是流式的，所以这一整段必然是异步的。 */
    function regAddonsBlob(){
      if (typeof CompressionStream !== "function") {
        return Promise.reject(new Error("这个浏览器不支持 CompressionStream"));
      }
      var conf = JSON.stringify({
        preset: false,
        scopes: { tenant: ["bitable:app", "drive:drive.metadata:readonly"] }
      });
      var cs = new CompressionStream("gzip");
      var w = cs.writable.getWriter();
      w.write(new TextEncoder().encode(conf));
      w.close();
      return new Response(cs.readable).arrayBuffer().then(function(buf){
        var u8 = new Uint8Array(buf), s = "";
        for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
        return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      });
    }

    /* 画二维码。库是扩展自带的 qrcode.js（第三方，MIT），不走网络 ——
       授权链接里带着一次性 user_code，发去任何第三方接口画图都等于把它交出去。
       cellSize 给 1：SVG 是矢量的，放大交给 CSS，缩到多大都清晰。 */
    function drawQR(text){
      if (!fsEls.fsQRImg) return false;
      if (typeof qrcode !== "function") return false;
      var qr = qrcode(0, "L");      // 0 = 按内容自动选版本；L = 纠错等级
      qr.addData(text);
      qr.make();
      fsEls.fsQRImg.innerHTML = qr.createSvgTag(1, 0);
      return true;
    }

    if (fsEls.fsQR && fsEls.fsQRBox) {

      fsEls.fsQROpen.addEventListener("click", function(){
        if (!qrLink) return;
        if (typeof chrome !== "undefined" && chrome.tabs && chrome.tabs.create) {
          chrome.tabs.create({ url: qrLink });
        } else {
          window.open(qrLink, "_blank", "noopener");
        }
      });

      fsEls.fsQRCancel.addEventListener("click", function(){
        qrGen++;                 // 让还在跑的那轮自己失效
        qrStop();
        fsEls.fsQRBox.hidden = true;
      });

      fsEls.fsQR.addEventListener("click", function(){
        qrGen++;
        var gen = qrGen;
        qrStop();
        fsEls.fsQRBox.hidden = false;
        fsEls.fsQRImg.innerHTML = "";
        fsEls.fsQROpen.disabled = true;
        fsEls.fsQRHint.textContent = "正在向飞书申请…";

        var dc = "";

        regAddonsBlob().then(function(addons){
          return regPost({ action: "init" }).then(function(init){
            var m = (init && init.supported_auth_methods) || [];
            if (m.indexOf("client_secret") === -1) {
              throw new Error("飞书现在不支持这种方式，过会儿再试");
            }
            return regPost({
              action: "begin",
              archetype: "PersonalAgent",
              auth_method: "client_secret",
              request_user_info: "open_id"
            });
          }).then(function(begin){ return { begin: begin || {}, addons: addons }; });
        }).then(function(o){
          if (gen !== qrGen) return;
          var begin = o.begin;
          if (!begin.device_code || !begin.verification_uri_complete) {
            throw new Error(begin.error_description || begin.error || "飞书没给二维码");
          }
          dc = begin.device_code;
          var u = begin.verification_uri_complete;
          /* 三个只挂在 URL 上的参数（官方 SDK 的 _apply_registration_options 就是这么拼的）：
               from=onboard    给落地页认来源，第三方实现里也是这个值
               createOnly=true 只许**新建**，不许「选一个已有的应用」
               addons         预填的权限（gzip + base64url，见上）
             ★ createOnly 非加不可：不加时确认页上允许挑一个已存在的应用，
               用户随手挑中自己公司正在跑的那个应用，我们就把 bitable 权限
               加到了它身上 —— 按钮写着「扫码创建」，行为却可能是「改别人的应用」。
             ★ 不抄 SDK 的 tp / source：那两个纯粹是给飞书统计 SDK 来源用的，
               我们不是官方 SDK，冒它的名没有意义。 */
          qrLink = u + (u.indexOf("?") >= 0 ? "&" : "?") +
                   "from=onboard&createOnly=true" +
                   "&addons=" + encodeURIComponent(o.addons);

          if (drawQR(qrLink)) {
            fsEls.fsQRHint.textContent = "用飞书扫码确认";
          } else {
            fsEls.fsQRHint.textContent = "二维码没画出来，点下面按钮打开授权页";
          }
          fsEls.fsQROpen.disabled = false;

          var interval = (begin.interval || 5) * 1000;
          var deadline = Date.now() + (begin.expires_in || 600) * 1000;

          function finish(res){
            qrGen++;             // 收工：让这一代失效，别再有残留的轮询
            qrStop();
            fsEls.fsAppId.value = res.client_id;
            fsEls.fsSecret.value = res.client_secret;
            fsEls.fsQRBox.hidden = true;
            // 顺手落盘：第 2 步「新建一张」要拿这两个值，不先存的话
            // 用户中途切页、刷新，刚扫出来的凭据就白扫了。
            Sync.writeCfg({ appId: res.client_id, appSecret: res.client_secret })
              .then(function(){
                toast("应用已创建");
                fsEls.fsStat.textContent = "应用已创建，接着填第 2 步";
              });
          }

          function tick(){
            if (gen !== qrGen) return;
            if (Date.now() > deadline) {
              fsEls.fsQRHint.textContent = "二维码过期了";
              qrStop();
              return;
            }
            regPost({ action: "poll", device_code: dc }).then(function(res){
              if (gen !== qrGen) return;
              res = res || {};
              if (res.client_id && res.client_secret) { finish(res); return; }
              var err = res.error || "";
              if (err === "authorization_pending") {
                /* 正常等待态，什么都不做，下一轮继续问 */
              } else if (err === "slow_down") {
                interval += 5000;      // 平台让慢点，就慢点
              } else if (err === "access_denied") {
                fsEls.fsQRHint.textContent = "你拒绝了这次授权";
                qrStop();
                return;
              } else if (err === "expired_token") {
                fsEls.fsQRHint.textContent = "二维码过期了";
                qrStop();
                return;
              } else if (err) {
                fsEls.fsQRHint.textContent = "飞书回了错误：" + (res.error_description || err);
                qrStop();
                return;
              }
              qrTimer = setTimeout(tick, interval);
            }, function(){
              /* 轮询本身撞上网络抖动不终止 —— 否则用户正扫着，界面
                 却停在「用飞书扫这个码」再也不动了，而码其实还有效。 */
              if (gen === qrGen) qrTimer = setTimeout(tick, interval);
            });
          }
          tick();

        }).catch(function(e){
          if (gen !== qrGen) return;
          fsEls.fsQRHint.textContent = "没能拿到二维码：" + ((e && e.message) || "未知原因");
          fsEls.fsQROpen.disabled = true;
        });
      });
    }

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
     ★ 顺带说明为什么**仍然没有**连带删掉 `.hr` 这个类：别处还在用它分段
       （v0.27.0 起飞书段改用 `.step` 自己的 border-top 分隔、不再用它 ——
        但那只是"少了一个使用者"，不等于"这个类没用了"）。 */

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

  /* ★ v0.26.0：「本周小结」那一行删了（底栏那段回顾整段砍掉，scenes.weekly 一起摘）。
     删开关时要**两处一起走**：这里回填、下面 change 绑定 —— 只删一处的话，
     轻则留一个读不到元素的空 if（无害但误导），重则回填时读 undefined 抛错。 */
  if (aiEl("aiParse"))  aiEl("aiParse").checked  = cfg.scenes.parse === true;
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
  /* ★ v0.25.0 / v0.26.0：这个开关管的是「那句话**谁来写**」，不是「它说不说」。
     关掉它，球照样会说话 —— 只是退回 notify.js 的本地规则句（localLine）。
     ★★ 「说不说」在 v0.26.0 有了自己的开关（球那段的 talk），跟这个是**两件事**：
          · 球段的「点它的时候说一句」= 说 / 不说（说了就是本地句，零成本）
          · 这里的「说一句话」        = 那句话要不要请模型再写一遍
        两句文案故意都出现「说」字，但一个管有无、一个管谁来写。 */
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
               Store.get(NTKEY), Store.get(LIBKEY), Store.get(IKKEY)]).then(function(r){
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

    /* ---------- 网页球主动弹提示（v0.32.0）----------
       ★ 它写的是**团队派发那个 key 里的 speakOn**，但开关摆在悬浮球这一页 ——
         它问的是「球准不准主动开口」，那是球的属性，放在球这一页才找得到
         （项目里有过一次教训：把「说话」开关藏在吉祥物那格，结果关掉吉祥物
           之后开关跟着消失，而球照样在说话）。
       ★★ 走 tmKeep（读-改-写），**不持有 cfg 副本** —— 理由见上面 tmKeep 那条。 */
    var pushBox = document.getElementById("wbPush");
    if (pushBox && typeof Inbox !== "undefined") {
      /* 初值：这里不能直接用 r[7] 那份 —— 团队派发那段可能还没跑、也可能刚改过。
         读一次最新值最稳，代价只是一次 storage 读。 */
      Store.get(IKKEY).then(function (o) {
        pushBox.checked = Inbox.readCfg(o).speakOn === true;
      });
      pushBox.addEventListener("change", function () {
        var on = !!pushBox.checked;
        if (!tmKeep) { pushBox.checked = !on; return; }
        tmKeep({ speakOn: on }).then(function () {
          toast(on ? "有派给你的任务时，球会主动说一句" : "已关掉：球不再主动开口");
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

    /* ---------- 团队派发（v0.32.0）----------
       ★★ 这一块是 v0.32.0 的主干：把「派任务给别人」和「收到别人派的任务」
          两条链路上唯一需要人手填的东西收在这儿 —— 我是谁、组员、团队表。
       ★ 为什么「我是谁」必须手填：扩展不知道装着它的这个人叫什么，
          而派发人恰恰是收件方决定「要不要处理」的第一条信息。
          （做 OAuth 拿真实身份的代价远大于填一次名字，所以不做。）
       ★ 表链接粘进来就拆出 baseToken / tableId（复用 parseBaseLink），
          跟飞书同步那条路同一个手势。 */
    (function wireTeam(){
      var onBox = document.getElementById("tmOn");
      if (!onBox || typeof Inbox === "undefined") return;
      var body = document.getElementById("tmBody");
      var linkEl = document.getElementById("tmLink");
      var baseEl = document.getElementById("tmBase");
      var tblEl = document.getElementById("tmTable");
      var ntEl = document.getElementById("tmNotify");
      var repEl = document.getElementById("tmReport");
      var tryHint = document.getElementById("tmTryHint");
      var nowHint = document.getElementById("tmNowHint");
      var makeHint = document.getElementById("tmMakeHint");

      var cfg = Inbox.readCfg(r[7]);

      function say(el, s){ if (el) el.textContent = s || ""; }

      /* ★★ 唯一写入口：读最新 → 打补丁 → 整块写回。
         绝不直接用内存里那份 cfg 去覆盖 storage（见上面 tmKeep 那条注释）。 */
      tmKeep = function (patch) {
        return Store.get(IKKEY).then(function (o) {
          /* ★★★ v0.33.0 修：「读最新 → 打补丁 → 整块写回」里的**读**原来写错了 ——
             `Inbox.readCfg(o && o[IKKEY])`。
             ★ `Store.get(key)` 已经把外层拆掉了（它内部 `return o[key]`），
               所以 `o` **就是配置本身**；再按 key 索引一次恒为 undefined，
               readCfg(undefined) 得到**全默认值**，于是每次落盘都先把
               baseToken / tableId / me / people / notifyOn 一起清成默认，
               再把这次的补丁盖上去 —— 症状是「拨一下团队开关，表就没了」。
             ★ 为什么它骗过了所有人（包括 v0.32.0 那次真机验收）：开关**本身**是生效的
               （补丁那一项确实写进去了），坏的只是**同一份配置里的兄弟字段**。
               只有「改一项前先写进另一项，看它还在不在」这种断言能发现。
               ⇒ `_test_manage.js` Pass H 补了这条（读-改-写的「读」必须真读到东西）。 */
          var cur = Inbox.readCfg(o);
          Object.keys(patch || {}).forEach(function (k) { cur[k] = patch[k]; });
          cfg = cur;
          return Store.set(cur, IKKEY);
        }).then(function () { paint(); return cfg; });
      };

      function paint(){
        onBox.checked = !!cfg.on;
        /* ★ 配置区整体跟着开关显隐：关着的时候摆一堆输入框，
           用户会以为「填了就生效」，而实际上整条链路是断的。 */
        if (body) body.hidden = !cfg.on;
        if (baseEl) baseEl.value = cfg.baseToken;
        if (tblEl) tblEl.value = cfg.tableId;
        /* ★ 链接框只在**它还是空的时候**用存下来的地址回填。
           用户自己粘进去的那串一个字都不动 —— 我们没有他的租户域名，
           拿 baseToken 重新拼一遍只会得到一个打不开的链接。 */
        if (linkEl && !linkEl.value) linkEl.value = cfg.baseUrl || "";
        if (ntEl) ntEl.checked = cfg.notifyOn === true;
      }

      onBox.addEventListener("change", function(){
        tmKeep({ on: !!onBox.checked }).then(function(){
          toast(onBox.checked ? "已启用团队派发" : "已关掉：不再读写团队表");
        });
      });

      /* 文本类输入：change 时落盘（不是 input —— 每敲一个字写一次 storage，
         敲快了会把上一次还没落的值冲掉，而且没必要）。 */
      if (baseEl) baseEl.addEventListener("change", function(){ tmKeep({ baseToken: baseEl.value }); });
      if (tblEl) tblEl.addEventListener("change", function(){ tmKeep({ tableId: tblEl.value }); });

      if (linkEl) linkEl.addEventListener("change", function(){
        var p = parseBaseLink(linkEl.value);
        if (!p) { say(repEl, "这个链接里没找到多维表格地址"); return; }
        if (p.wiki) { say(repEl, "这是知识库的链接，要的是多维表格（/base/）"); return; }
        if (!p.tableId) { say(repEl, "链接里没有 ?table=tbl…，手动填一下数据表 ID"); }
        else say(repEl, "");
        tmKeep({ baseToken: p.baseToken, tableId: p.tableId });
      });

      if (ntEl) ntEl.addEventListener("change", function(){
        tmKeep({ notifyOn: !!ntEl.checked }).then(function(){
          toast(ntEl.checked ? "收到派发任务时会发系统通知" : "已关掉：不再发通知");
        });
      });

      /* ★ 凭据不在这儿填 —— 复用飞书同步那份（Inbox.withCred），
         所以在打开测试之前先看一眼同步配没配，没配就直说。 */
      function withSync(){
        if (typeof Sync === "undefined" || typeof Sync.readCfg !== "function") {
          return Promise.resolve(null);
        }
        return Sync.readCfg().then(function (sc) {
          var full = Inbox.withCred(cfg, sc);
          if (!full.appId || !full.appSecret) return null;
          return full;
        });
      }

      var testBtn = document.getElementById("tmTest");
      if (testBtn) testBtn.addEventListener("click", function(){
        say(repEl, "正在连接…");
        withSync().then(function (full) {
          if (!full) { say(repEl, "先在「飞书同步」里配好应用（App ID / Secret）"); return; }
          if (!full.baseToken || !full.tableId) { say(repEl, "还没填团队表"); return; }
          return sendToBg({ type: "inbox-test", cfg: full }).then(function (res) {
            say(repEl, (res && res.ok) ? ("连上了：" + (res.detail || "")) :
                                        ("连不上：" + ((res && res.reason) || "未知原因")));
          });
        });
      });

      /* 一键生成：建 Base（没填的话）+「任务」「组员」两张子表 + 补缺的列。
         ★ 回填走 tmKeep（唯一写入口，内部是读-改-写）—— 后台只回结果、
           绝不自己写配置：它手里那份是几秒前的快照，直接写会把这期间
           的其它改动（比如你刚拨的通知开关）一起抹掉。 */
      var makeBtn = document.getElementById("tmMake");
      if (makeBtn) makeBtn.addEventListener("click", function(){
        say(makeHint, "正在生成…");
        withSync().then(function (full) {
          if (!full) { say(makeHint, "先在「飞书同步」里配好应用"); return; }
          /* ★ 这里**不用**原生二次确认：这一步是幂等的（表在就补列、列齐就一个写请求都不发），
             不会覆盖或删除任何东西 —— 而原生确认会打断整页，jsdom 里还直接抛。
             本项目的门：全项目只留「飞书建表」那一处 confirm，那处是真的会替换掉配置。 */
          return sendToBg({ type: "inbox-setup", cfg: full }).then(function (res) {
            if (!res || !res.ok) {
              say(makeHint, "没生成成功：" + ((res && res.reason) || "未知原因"));
              return;
            }
            return tmKeep({
              baseToken: res.baseToken,
              baseUrl: res.baseUrl || cfg.baseUrl,
              tableId: res.tableId,
              peopleTableId: res.peopleTableId
            }).then(function () {
              if (linkEl && res.baseUrl) linkEl.value = res.baseUrl;
              var bad = (res.steps || []).filter(function (s) { return !s.ok && !s.optional; });
              say(makeHint, bad.length
                ? ("有两步没成：" + bad.map(function (s) { return s.name; }).join("、"))
                : "两张子表都好了");
              /* 顺手拉一次组员表：新建的表当然是空的，但**你那个 Base 里可能已经有了** ——
                 有的话这一步就读进来了，不用等满一个轮询周期。 */
              return sendToBg({ type: "inbox-people" });
            });
          });
        });
      });

      var tryBtn = document.getElementById("tmTry");
      if (tryBtn) tryBtn.addEventListener("click", function(){
        sendToBg({ type: "inbox-try" }).then(function (res) {
          say(tryHint, (res && res.ok) ? ("这条就是它的样子：" + (res.message || "")) : "这条通道现在不可用");
        });
      });

      var nowBtn = document.getElementById("tmNow");
      if (nowBtn) nowBtn.addEventListener("click", function(){
        say(nowHint, "正在拉取…");
        sendToBg({ type: "inbox-pull" }).then(function (res) {
          if (!res || !res.ok) { say(nowHint, "拉不到：" + ((res && res.reason) || "未知原因")); return; }
          say(nowHint, res.fresh ? ("新收到 " + res.fresh + " 条") : "没有新任务");
        });
      });

      paint();
    })();

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
      /* ★ v0.29.0：「编辑」是**新按钮**，跟「上传图片」是两种相反的意图 ——
         上传 = 再加一张新的，编辑 = 改当前这一张。见 mcActs 那段 HTML 注释。 */
      var mcEdit = document.getElementById("mcEdit");
      var mcFile = document.getElementById("mcFile");
      var mcUp = document.getElementById("mcUp");
      /* ★ v0.28.0 九格收图用的那几个（见下面「九格收图」那一段） */
      var mcMake = document.getElementById("mcMake");
      var mcCells = document.getElementById("mcCells");
      var mcSheetBtn = document.getElementById("mcSheet");
      var mcFlip = document.getElementById("mcFlip");
      var mcSheetFile = document.getElementById("mcSheetFile");
      var mcCfg = TaskMascot.readConfig(r[4]);
      /* ★★ v0.26.0：「说话」的复选框。它**不在这格 HTML 里**（它有自己的
         .where，跟自己那一行的标签），但它写的是**同一份配置**（mcCfg.talk）——
         所以它的读写必须并进这个块，复用这里的 mcCfg 和 saveMc()。
         在外面另开一段、各自读一次 storage，就会出现「两个 mcCfg 各写各的」，
         后写的那次把前一次静默抹掉 —— 而这类 bug 只在「先换脸、再拨说话」
         这个操作顺序下复现，单测各测各的永远绿。 */
      var talkBox = document.getElementById("talkOn");
      var MCBASE = "mascots";
      var mcNames = {};        /* id → 中文名（渲染网格时顺手记下，paint 要用） */
      /* ★★★ v0.29.0：自定义**库**。`CUSTOM_GROUP` / `CUSTOM_NAME` / `LIBKEY` /
         `MC_LIB_MAX` / `MC_BLANK` / `mcLibClean` 全在**模块级**（文件抬头那段）——
         `CUSTOM_NAME` 原来是这儿块内的一个 var，挪上去是为了让 mcLibClean 用得上它，
         顺手消掉「同一个名字两处各写一遍」。
         ★ 清洗一定要在**这里**做完：下面 renderMcGrid / paintMc / 点格子的绑定
           都直接信 mcLib 里的项，一条坏记录会让绑定断在半路。 */
      var mcLib = mcLibClean(r[6]);
      /* 两张雪碧 dataURL 合计的体积上限（本钱：storage 一处、快照一处）。
         超了就降一档质量重烘，不再往上加。 */
      var MC_IMG_MAX = 400000;
      /* ★★ v0.28.0：九格收图的状态。**声明必须在这里、不能挪到下面那段用它
         的地方去** —— 下面 `if (mcGrid)` 块里的初始化会在读到那一段之前就跑
         `renderMcCells()`，而 `"use strict"` 下块内 `var` 只提升绑定、不提升赋值：
         那时 mcSlots 还是 undefined，一取下标就抛 TypeError。
         （同一类坑见上面 renderMcGrid 那段注释 —— 屏幕上只表现为"网格没重画"，
           而这边的表现是"九格面板是空的、控制台一句 ReferenceError"。） */
      var mcSlots = [null, null, null, null, null, null, null, null, null];
      var mcThumbs = [null, null, null, null, null, null, null, null, null];
      /* ★★★ v0.28.1：`mcFrom` 多了个取值 **-1 = 自动**（原来只有一个 0 起算的格号）。
         -1 = 用户点的是「上传图片」按钮，**没指定是哪一格**；
         >=0 = 用户点的是第 i 格，就从他点的那一格开始铺。
         ★ 为什么必须分开：点「上传图片」和点第 0 格，旧代码里**都是 0** ——
           而这两件事该做的正相反：
             点按钮只选 1 张 → 那是用户心里那张"我的角色"，**是正脸**，该落第 4 格；
             点第 0 格选 1 张 → 用户明说了"这是朝左上那张"，该落第 0 格。
           分不开的后果：传一张正脸被当成"朝左上"，而正脸格（第 4 格）会被
           补图用 DIRS[4]（identity）填成同一张 —— 球上"左上"和"正脸"长得
           一模一样，**转头到左上时不转**。 */
      var mcFrom = -1;
      /* 方向箭头的角度（左上/上/右上 · 左/正脸/右 · 左下/下/右下）。
         第 4 格给 null —— 正脸换成圆点（正对观众，没有"朝哪"这回事）。 */
      var MC_ROT = [-45, 0, 45, -90, null, 90, -135, 180, 135];
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

      /* ---------------- 自定义库（v0.29.0） ----------------
         ★ 要解决的问题（老大原话）："我上传一张图片做成自定义之后，如果想做第二个自定义，
           它会把第一个覆盖掉，没办法保存"。病根是 `mcCfg.custom` **天生只能装一个对象**，
           第二次上传必然覆盖 —— 不是没收好，是**没地方放**。
         ★ 所以做法是：那个字段**一个字不改**，另开一个 key（LIBKEY）存"库"。
           库里每一项 = 一份成品（dirs/reacts/thumb，形状跟 mcCfg.custom 完全相同）
                      + 一份源图（src）—— 后者是「编辑」能成立的前提。
         ★ 「当前是哪一个」由 `mcCfg.custom.sig` 认。库里每一项的 sig 唯一，
           `mcSelect()` 就是把某一项的成品整个搬进 mcCfg.custom —— **纯拷贝、不重烘**：
           重烘要走 canvas + 异步解码，切一次要等一次，而且失败路径又是一堆分支。 */

      function mcLibFind(sig){
        for (var i = 0; i < mcLib.length; i++) if (mcLib[i].sig === sig) return i;
        return -1;
      }

      /* 当前 `mcCfg.custom` 对应库里哪一项（-1 = 不在库里，比如它还没迁进来）。
         ★ 判据是 sig **不是**下标：下标会因为中间删掉一项而整体挪位，
           而 sig 是这一项的身份证 —— 用下标的话「删了第 2 项，当前还指着第 2 项」
           会静默地指向原来第 3 项，屏幕上就是"我删了 A，结果跳到了 C"。 */
      function mcCurIdx(){
        return (mcCfg.custom && mcCfg.custom.sig) ? mcLibFind(mcCfg.custom.sig) : -1;
      }

      /* 库里那一项 → `mcCfg.custom` 的形状。★ 就是原来那四个字段，一个不多一个不少：
         多带的字段会被 TaskMascot.readCustom **静默丢掉**（它只挑 dirs/reacts/thumb/sig），
         所以"顺手带上 src"这种做法除了撑大 storage 没有任何作用。 */
      function mcPayload(it){
        return { dirs: it.dirs, reacts: it.reacts, thumb: it.thumb, sig: it.sig };
      }

      function mcLibSave(){
        /* ★ 写失败要说话：库比单个 custom 大得多（每项上百 KB），
           storage.local 配额是 10 MB。静默失败的话，屏幕上就是
           "我传了第三张，切来切去只有两张" —— 而用户会以为是界面坏了。 */
        return Store.set(mcLib, LIBKEY).catch(function(){ toast("存不下了：先删掉一两张再传"); });
      }

      /* 自动起名：「你自己的图 1 / 2 / 3」。
         ★ 找的是**最小可用号**，不是 `mcLib.length + 1` —— 后者在删过一项之后
           会跟还活着的那一项同名（两格悬停出来一模一样，看不出是两张）。 */
      function mcNextName(){
        for (var n = 1; n <= MC_LIB_MAX + 1; n++) {
          var s = CUSTOM_NAME + " " + n, hit = false;
          for (var i = 0; i < mcLib.length; i++) if (mcLib[i].name === s) { hit = true; break; }
          if (!hit) return s;
        }
        return CUSTOM_NAME;      /* 理论上到不了（条数有上限），兜一个不炸的 */
      }

      /* sig 平时就是时间戳。★ 为什么要防撞：同一毫秒里建两项时 sig 会相同，
         而库里**靠 sig 认项**（mcLibClean 还会按 sig 去重）——
         撞了就是"第二项被清洗掉了"，屏幕上"我传了三张只剩两张"，一句报错都没有。 */
      function mcNewSig(){
        var s = String(Date.now());
        while (mcLibFind(s) >= 0) s = String(Number(s) + 1);
        return s;
      }

      /* 九格里哪几格有图 → "0110..."。★ 回填时要靠它把**空格还原成空格**：
         源图里空格是透明的，而"透明"和"这格本来就该空着"在像素上分不出来。 */
      function mcHad(){
        var s = "";
        for (var i = 0; i < 9; i++) s += mcSlots[i] ? "1" : "0";
        return s;
      }

      /* 九格（已归一化到 CUSTOM.SRC）→ 一张 480² 的源图，存进库供「编辑」回填。
         ★ 存的是**归一化之后**那九张，不是用户原始文件：原图可能 4000×4000，
             存下来一张就几 MB；而 buildDirs 需要的正是 160² 这一档。
         ★ 用 webp 0.85：这是一份"能再烘一次"的中间件，不是成品；质量够用即可。 */
      function mcSrcSheet(cells){
        var S = TaskMascot.CUSTOM.SRC;
        var c = document.createElement("canvas");
        c.width = S * 3;
        c.height = S * 3;
        var g = c.getContext("2d");
        for (var i = 0; i < 9; i++) {
          if (!cells[i]) continue;
          var col = i % 3, row = (i - col) / 3;
          g.drawImage(cells[i], col * S, row * S);
        }
        return c.toDataURL("image/webp", 0.85);
      }

      /* dataURL → 已解码的 Image（mcLoad 收的是 File，走的是 objectURL）。 */
      function mcLoadUrl(url, cb, bad){
        var im = new Image();
        im.onload = function(){ cb(im); };
        im.onerror = function(){ bad("这张源图读不出来"); };
        im.src = url;
      }

      /* 「编辑」= 把库项的**源图**回填进九格。
         ★★★ 为什么回填源图、不回填成品（`dirs`）—— 先摆实测，再讲理由。
           探针 `_p_490_dblbake.py`（Edge 真机，同九张不对称角色图，同一份
           `buildDirs`），把产物当输入再烘，量两件事：

             与原件的平均像素差(/255)   雪碧格里人物占比倍率
             从源图回填   0.488               1.000
             从成品回填   0.558               1.009
             成品再滚一轮 0.791               1.009

           ★★ 所以**不能**把理由写成"叠两次会越改越小 / 越改越歪" ——
             那句话是**推理**（我读到 `paintDirs` 会给格子内缩就推出来了），
             实测**不支持**：占比倍率一直 ≈ 1，根本不缩。
             原因也不难看清：`paintDirs` 写进第 i 格的是 `paintCell` 出来的
             **对齐后原图**，**一处旋转都没有** —— 朝向是靠**格号**表达的，
             不在像素里，所以朝向压根不会被烘第二遍。
             （"旋转会被叠两次"这个印象来自 v0.24.1 那条老路：那时候是
              一张图 + 九组几何变换烘出九个朝向，产物里**真的**有旋转。）
           ★ 那还存源图干什么 —— 两条理由，都不是"修 bug"：
             ① 保真：上面 0.488 / 0.558 是**每一次编辑**都要付的代价。
             ② 解耦（更硬的那条）：`dirs` 是**产物**，它的版式 —— `BASE` 内缩、
                空格用底脸填满、图集次序 —— 全归 `mascotfit.js` 的渲染器所有。
                拿产物当输入，等于把「编辑」这条路的正确性**拴在当期版式上**：
                哪天 `BASE` 从 0.8 改成 0.7，老项的往返就静默错位，一句报错都没有。
             代价实测约 24 KB/项（`srcLen`，一张 480² webp）。
         ★ src 为 null（v0.28.x 存下来的那种）时明说做不到，而不是给一个点了没反应的按钮。 */
      function mcRefill(it, done, bad){
        if (!it || !it.src) {
          return bad("这一张是上一版存的，没留源图；点「上传图片」传一张就能逐格改");
        }
        var had = (typeof it.had === "string" && it.had.length === 9) ? it.had : "111111111";
        mcLoadUrl(it.src, function(im){
          var nine = TaskMascotFit.splitSheet(im);
          if (!nine) return bad("这张源图读不出来");
          for (var i = 0; i < 9; i++) mcSetSlot(i, had.charAt(i) === "1" ? nine[i] : null);
          done();
        }, bad);
      }

      /* 换到库里某一项。**纯拷贝**（见 mcPayload 上面那段）。 */
      function mcSelect(it, msg){
        saveMc({ char: "custom", custom: mcPayload(it) }, msg);
      }

      /* 一次性的老数据迁移，见下面调用处的注释。 */
      function mcMigrate(){
        var c = mcCfg.custom;
        if (!c || !c.dirs || !c.reacts) return;
        if (c.sig && mcLibFind(c.sig) >= 0) return;          /* 已经在库里了 */
        /* ★★ sig 原来有就**留着**，只补空的那种。
           上一版（写这儿的时候）是无条件新生成一个，结果是：升级后第一次打开
           设置页，同一张图换了个 sig → 桌面球的快照指纹跟着变 → **白推一次快照**
           （一百多 KB 的 dataURL 过一遍 native messaging），而这张图一个像素都没变。
           ★ sig 的语义就是"这是哪一张图"，同一张图不该在迁移时换身份。
           ★ 前面那句 `mcLibFind(c.sig) >= 0` 已经保证了 c.sig 不会被别项占用，
             所以直接沿用是安全的。 */
        var sig = c.sig || mcNewSig();
        mcLib.unshift({
          sig: sig, name: mcNextName(), src: null, had: "111111111",
          dirs: c.dirs, reacts: c.reacts, thumb: c.thumb || ""
        });
        c.sig = sig;                    /* mcCfg 是同一个对象，改它就是改当前配置 */
        /* ★ 写库一律走 mcLibSave（**只有这一条写路径**）：
           两处各写各的 = 迟早有一处漏掉新加的字段，而"哪一处写的"看不出来。 */
        mcLibSave();
        Store.set(mcCfg, MCKEY);
      }

      /* 改名：点名字 → 原地换成一个输入框。回车提交、Esc 取消、点别处（blur）提交。
         ★ 为什么不用 prompt()：它在 headless / file:// 下会被拦，而且没法做真机门。
         ★ 为什么不在网格里改：名字是"当前这一项是谁"的显示，改名的入口就该在它身上，
           而不是在一堆格子里（点格子是"换角色"，不是"改名字"）。 */
      function mcRename(at){
        if (document.getElementById("mcNameIn")) return;     /* 已经在改名了 */
        var it = mcLib[at];
        if (!it || !mcName) return;
        var inp = document.createElement("input");
        inp.type = "text";
        inp.id = "mcNameIn";
        inp.className = "mcin";
        inp.maxLength = 12;
        inp.value = it.name;
        mcName.hidden = true;
        mcName.parentNode.insertBefore(inp, mcName.nextSibling);
        inp.focus();
        inp.select();
        var done = false;
        function fin(commit){
          if (done) return;
          done = true;
          var v = commit ? String(inp.value || "").replace(/^\s+|\s+$/g, "").slice(0, 12) : "";
          if (inp.parentNode) inp.parentNode.removeChild(inp);
          mcName.hidden = false;
          /* 空名字不提交：名字是这一项在网格里的标识，清空等于把两格变成一样的 */
          if (v && v !== it.name) {
            it.name = v;
            mcLibSave();
            renderMcGrid();
          }
          paintMc();
        }
        inp.addEventListener("keydown", function(e){
          if (e.key === "Enter") fin(true);
          else if (e.key === "Escape") fin(false);
        });
        inp.addEventListener("blur", function(){ fin(true); });
      }

      /* ★★★ 迁移必须在**第一次 paintMc 之前**跑：paintMc 要靠 mcCurIdx() 找当前项
         来决定名字显示什么、「编辑/删掉」露不露面。晚一步的话，升级后第一次打开
         设置页会看到"名字是一串 id / 少两个按钮"，刷新一下才好。 */
      mcMigrate();

      function paintMc(){
        mcBox.checked = mcCfg.on;
        /* ★ v0.26.0：「说话」也归这张表 —— 它读的是同一个 mcCfg。
           判据写成 `!== false` 而不是 `!!`：跟 readConfig 同一口径。
           写 `!!mcCfg.talk` 的话，老配置读出来是 undefined → 开关显示成「关」，
           而它的**实际行为是开** —— 开关和事实相反是最难信任的一种不一致。 */
        if (talkBox) talkBox.checked = mcCfg.talk !== false;
        /* ★ v0.24.1：这里原来写状态字，现在只**清空**。
           #mcHint 从今往后只在一个场合出现：清单真的没读进来
           （那时网格是空的，必须说话）；平时它一个字都不该有。 */
        if (mcHint) mcHint.textContent = "";
        if (mcPick) mcPick.hidden = !mcCfg.on;
        /* ★ 自定义图的缩略图是 dataURL，不从 MCBASE 拼路径。
           「有没有 thumb」就是判据 —— 跟网格里那格用的是同一个判断，
           两处口径分叉就是「设置页是自己的图、球上还是狐狸」那类怪事的温床。 */
        var isCustom = mcCfg.char === "custom" && !!mcCfg.custom;
        /* ★ v0.29.0：当前这一项在**库**里的下标（-1 = 不在库里）。
           名字、「编辑」「删掉」三样都只认它。 */
        var cur = mcCurIdx();
        if (mcFace) {
          mcFace.style.backgroundImage = "url(" +
            (isCustom ? mcCfg.custom.thumb
                      : (MCBASE + "/thumb/" + mcCfg.char + ".webp")) + ")";
        }
        if (mcName) {
          mcName.textContent = isCustom
            ? ((cur >= 0 ? mcLib[cur].name : "") || CUSTOM_NAME)
            : (mcNames[mcCfg.char] || mcCfg.char);
          /* ★ 只有自定义项能改名：内置那 58 个的名字来自清单（mascots/index.js），
             改了就是两处口径分叉。`.ed` 只把"这里能点"画出来（虚下划线 + 手型），
             **不放说明文字** —— 名字能不能点必须有个看得见的线索，否则这个功能
             等于不存在。 */
          var canName = isCustom && cur >= 0;
          mcName.classList.toggle("ed", canName);
          mcName.title = canName ? "点一下改名" : "";
        }
        /* 没传过图就没有「删掉」—— 一个删不掉东西的按钮比没有按钮更糟。
           ★ v0.29.0：判据从 `!!mcCfg.custom` 收到 `cur >= 0`，因为「删掉」现在删的是
             **库里这一项**：库里没有这一项时它什么也删不掉（点一下＝静默无反应，
             那比按钮不存在更糟）。
           ★「编辑」跟它一起露面：两者都以"当前这一项在库里"为前提。
             源图缺失（旧版存的那张）不在此列 —— 那时「编辑」点了会明说做不到，
             而不是消失（消失＝用户以为功能被砍了）。 */
        if (mcDel) mcDel.hidden = !(isCustom && cur >= 0);
        if (mcEdit) mcEdit.hidden = !(isCustom && cur >= 0);
        if (mcSizeEl) {
          [].forEach.call(mcSizeEl.querySelectorAll("button"), function(b){
            b.classList.toggle("on", Number(b.getAttribute("data-sz")) === mcCfg.size);
          });
        }
        if (mcGrid) {
          /* ★★★ v0.29.0：自定义那几格的 `data-id` 是 **`custom:<sig>`**（每项一条），
             不能再拿 `mcCfg.char`（永远是 "custom"）去比 —— 那样**每一项都亮**
             （屏幕上就是"我选了第 2 张，结果三格全高亮"，看着像全选了）。
             内置角色的 id 里不可能出现冒号，所以这个前缀不会有歧义。 */
          var curId = (isCustom && mcCfg.custom.sig)
            ? ("custom:" + mcCfg.custom.sig) : mcCfg.char;
          [].forEach.call(mcGrid.querySelectorAll("button"), function(b){
            b.classList.toggle("on", b.getAttribute("data-id") === curId);
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

      /* ★★ v0.26.0：说话开关。**故意不受 mcOn 管** —— 吉祥物关着（普通圆球）
         时这一格照样露着，因为「说不说话」跟「长什么样」是两件事：
         普通圆球点一下**照样会说话**（ballpage 的 sayNow 不看 mc.on）。
         跟着 mcOn 藏起来的话就是「关掉吉祥物 → 开关消失 → 声音还在」，
         用户永远找不到关掉它的办法 —— Clippy 死刑判决书里那一条。
         ★ 文案要能自证边界：说清关掉之后「表情还在」，否则用户会以为
           连表情一起没了，为了保住表情而不敢关。 */
      if (talkBox) {
        talkBox.addEventListener("change", function(){
          saveMc({ talk: !!talkBox.checked },
                 talkBox.checked ? "点它会跟你说一句"
                                 : "已关掉：它不再出声（表情还在）");
        });
      }

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
          if (!b) return;
          var id = b.getAttribute("data-id");
          if (!id) return;
          /* ★ v0.29.0：自定义那几格是多条（每项一格），id 形如 `custom:<sig>`。
             走 mcSelect() 把那一项的**成品整个搬进 mcCfg.custom** —— 跟内置角色
             是同一个手势（点格子），不是第二套交互。 */
          if (id.indexOf("custom:") === 0) {
            var it = mcLib[mcLibFind(id.slice(7))];
            if (!it) return;                 /* 库刚被清掉：宁可什么都不做，别写半个 */
            mcSelect(it, "换成了「" + it.name + "」");
            return;
          }
          saveMc({ char: id }, "换成了「" + (mcNames[id] || id) + "」");
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
          /* ★★★ v0.29.0：这一组从「一格」变成「每项一格」。
             ★ 判据是 `mcLib.length` 而**不是** `mcCfg.custom` —— 老大要的是
               "传过的都留着"，所以哪怕当前选的是狐狸，自己传的那几张也该
               **照样摆在网格里**。用 mcCfg.custom 当判据的话，切回内置角色
               那几格就集体消失，用户只会以为"我切了一下，我的图没了"。
             ★ 一句话：**格子在不在，由库说了算；哪一格高亮，才由 mcCfg 说了算。**
               这两件事原来共用一个判据，拆开是这一版的关键一步。 */
          if (mcLib.length) {
            byGroup[CUSTOM_GROUP] = mcLib.map(function(it){
              /* thumb 兜一个 1×1 透明图：下面的渲染写的是
                 `c.thumb ? c.thumb : MCBASE + "/thumb/" + c.id + ".webp"`，
                 而 `custom:<sig>` 拼出来必然 404（格子角上一个碎图标）。 */
              return { id: "custom:" + it.sig, name: it.name, thumb: it.thumb || MC_BLANK };
            });
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
        renderMcCells();
        paintMc();
      }

      /* ---------------- 九格收图（v0.28.0） ----------------
         ★ 老路（v0.24.1）是「一张图 + 九组几何变换」烘出九个朝向 —— 身体跟着头
           一起转（原项目实测：这种画法漂移 22%，正确画法 5%，而且**没有任何对齐
           算法救得回来**），连「朝右」都是把正脸镜像出来的，不对称的角色一眼假。
           现在收**九张真朝向图**。
         ★★ 数据链路**一处没动**：不管九张怎么收，最后都是同一张 custom.dirs
           + custom.reacts + thumb。所以 readCustom / charUrls / 网页球 / 桌面球 /
           快照链路全都不用改 —— 这也是这次改动面能这么小的原因。
         ★ 对准的数学全在 mascotfit.js（那边有单测），这里只管：收图 → 调它 → 存。 */

      function mcCellSvg(i){
        /* 方向箭头。★ 只在空格显示（CSS 里 .has 时藏起来）—— 箭头是给"还不知道
           该放哪张"的人看的；填上之后再压一个符号在上面，看的就是符号不是图了。 */
        if (MC_ROT[i] === null) {
          return '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"/></svg>';
        }
        return '<svg viewBox="0 0 24 24" style="transform:rotate(' + MC_ROT[i] +
               'deg)"><path d="M12 4l7 15-7-4.4L5 19z"/></svg>';
      }

      function mcSetSlot(i, img){
        mcSlots[i] = img;
        /* ★ 缩略图只在换图时算一次：每次渲染都重算九个 120px canvas 是
           「能用但每点一下就顿一下」的做法。 */
        mcThumbs[i] = img ? TaskMascotFit.thumbOf(img, 120) : null;
      }

      function renderMcCells(){
        if (!mcCells) return;
        var i, any = false;
        var frag = document.createDocumentFragment();
        for (i = 0; i < 9; i++) {
          var b = document.createElement("button");
          b.type = "button";
          b.setAttribute("data-i", i);
          b.className = mcSlots[i] ? "has" : "";
          b.innerHTML = mcCellSvg(i);
          if (mcThumbs[i]) {
            var el = document.createElement("img");
            el.src = mcThumbs[i];
            b.appendChild(el);
            any = true;
          }
          frag.appendChild(b);
        }
        while (mcCells.firstChild) mcCells.removeChild(mcCells.firstChild);
        mcCells.appendChild(frag);
        /* 「左右对调」在没图时没有意义（换了两边都是空） */
        if (mcFlip) mcFlip.hidden = !any;
      }

      /* 文件 → 已解码的 Image。★ 用 createObjectURL 而不是 FileReader：
         前者不把整张图读进内存字符串（用户可能一次丢九张手机原图进来）。
         ★★ 与老路的一个关键区别：**不再 cover 裁切**。裁掉一块是永久损失
         （裁到哪一侧就是哪一侧的耳朵没了），而留白由对齐那一步自己收掉。 */
      function mcLoad(file, cb, bad){
        if (!file || (file.type && file.type.indexOf("image/") !== 0)) {
          return bad("这不像是一张图片");
        }
        if (!window.URL || !URL.createObjectURL) return bad("这个环境读不了本地文件");
        var url = URL.createObjectURL(file);
        var im = new Image();
        im.onload = function(){
          URL.revokeObjectURL(url);
          cb(im);
        };
        im.onerror = function(){
          URL.revokeObjectURL(url);
          bad("这不像是一张图片");
        };
        im.src = url;
      }

      /* 一批文件 → 一排 Image。★ 失败只报一次：九张里有两张坏的时候，
         不这么写会连弹两个 toast，后一个把前一个顶掉，用户只看到最后一条。 */
      function mcLoadAll(files, from, done, bad){
        var list = [].slice.call(files || []).slice(0, 9 - from);
        if (!list.length) return bad("没选到文件");
        var got = new Array(list.length), left = list.length, dead = false;
        list.forEach(function(f, k){
          mcLoad(f, function(im){
            if (dead) return;
            got[k] = im;
            if (--left === 0) done(got);
          }, function(msg){
            if (dead) return;
            dead = true;
            bad(msg);
          });
        });
      }

      /* 把一批图从 from 格开始铺。
         ★ clear = true 时先清空九格：不清的话「原来有 9 格、这次只选 2 张」
           会让后 7 格留着上一次的图 —— 而用户以为他刚换了一整张新的。
         ★★ v0.28.1：清空**不再由 `from === 0` 自己决定**，改由调用方给。
           旧写法（from 是 0 就清）在新语义下是错的：单张走自动落位时
           from 也是 4、多张也是 0，而"点某一格补一格"同样会算出 from 0 ——
           三种意图没法用格号反推。两个调用方的真实意图是：
             点「上传图片」= 我换一整套 → clear = true
             点第 i 格     = 我只补这几格 → clear = false（留着别的格） */
      function mcFillFrom(from, imgs, clear){
        var i;
        if (clear) for (i = 0; i < 9; i++) mcSetSlot(i, null);
        for (i = 0; i < imgs.length && from + i < 9; i++) mcSetSlot(from + i, imgs[i]);
      }

      /* ★★★ v0.28.1：点「上传图片」（没指定格）时的落位。
         只给 1 张 = 用户手上就一张脸，那**一定是正脸**（老路也是这么理解的：
         一张图 + 九组几何变换），落第 4 格；给多张 = 按文件名顺序从第 0 格铺起。
         ★ 1 张落第 4 格不是为了好看：落第 0 格的话，那张图成了"朝左上"的基准，
           第 4 格再被补图按 DIRS[4]（identity）填一遍 —— 两格像素级相同。 */
      function mcAutoFrom(n){ return n === 1 ? 4 : 0; }

      /* 九格 → 两张 3×3 雪碧 + 一张缩略图。
         ★ 对准与拼装全走 TaskMascotFit.buildDirs（一处实现，那边有单测）。
         ★★ 表情拿「九张里最正面的那张」烘（fit.base）—— 用户不用多画九张表情，
           跟老路一样只出一张脸。用 fit.base 而不是写死第 4 格：缺正脸时 base
           已经退到左 / 右了；写死第 4 格的话「只传了一侧脸」就没有表情。
         ★ 质量档会在超出体积预算时降一档：这两张 dataURL 要进 storage，
           还要跟着快照过 native messaging（Chrome 那条通道单条消息上限 1MB）。 */
      function mcBake(){
        var S = TaskMascot.CUSTOM.SRC;
        var fit = TaskMascotFit.buildDirs(mcSlots, S);
        if (!fit) return null;
        var face = fit.cells[fit.base];
        if (!face) return null;
        var q = 0.82;
        var dirs = fit.dirs.toDataURL("image/webp", q);
        var rc = document.createElement("canvas");
        rc.width = S * 3;
        rc.height = S * 3;
        var rg = rc.getContext("2d");
        rg.imageSmoothingEnabled = true;
        rg.imageSmoothingQuality = "high";
        TaskMascot.drawAtlas(rg, face, TaskMascot.CUSTOM.REACTS, S);
        var reacts = rc.toDataURL("image/webp", q);
        if (dirs.length + reacts.length > MC_IMG_MAX) {
          q = 0.6;
          dirs = fit.dirs.toDataURL("image/webp", q);
          reacts = rc.toDataURL("image/webp", q);
        }
        /* 缩略图：从正脸那格里**裁掉 BASE 内缩出来的留白**再画 —— 不裁的话，
           自定义角色的缩略图会比内置那 58 个都小一圈（差的正是那 20%）。 */
        var T = TaskMascot.CUSTOM.THUMB;
        var inner = S * TaskMascot.CUSTOM.BASE;
        var off = (S - inner) / 2;
        var tc = document.createElement("canvas");
        tc.width = T;
        tc.height = T;
        tc.getContext("2d").drawImage(face, off, off, inner, inner, 0, 0, T, T);
        /* ★ v0.29.0：把 `cells` 也带出去 —— 那是**九张已经归一化好的源图**
           （每张 CUSTOM.SRC 见方）。「编辑」要的源图就是从它拼出来的，
           再走一遍 metaOfImage/alignPlans 纯属白算，而且结果一定一样。 */
        return { dirs: dirs, reacts: reacts, thumb: tc.toDataURL("image/webp", 0.85),
                 maxUp: fit.maxUp, cells: fit.cells };
      }

      /* 烘 + 整块写 storage。★ 任何一步失败都只 toast 一句话，
         **绝不写半份配置**（写进去就是一张空白球）。
         ★★★ v0.29.0：多了 `asNew`，而且返回值从 true/false 变成**状态串**。
           · asNew = true  → **再加一张新的**（从「上传图片」进来的）
           · asNew = false → **改当前这一张**（点某一格补图 / 左右对调 / 整张九宫格）
         ★ 为什么这个开关必须由调用方给、不能自己猜：两条路烘出来的东西**一模一样**，
           只有"写回哪儿"不同。猜错就是老大报的那个 bug 的第二副面孔 ——
           "点上传，结果又把上一张覆盖了"。而调用方**确实知道**这一轮是从哪个按钮进来的。
         ★ 为什么返回值要分状态：三种失败要说三句不同的话 ——
           烘不出来（图有问题）／库满了（要删一张）／成功。
           只回 true/false 的话，调用方接到 false 就去说"这些图处理不了"，
           而真实原因是**库满了** —— 用户按这句话换十张图也没用。
           用 `""` 表示成功，`if (!rc)` 这种老写法照样成立。 */
      function mcCommit(okMsg, asNew){
        var bun;
        try { bun = mcBake(); } catch (e) { bun = null; }
        if (!bun) return "bake";
        /* ★ 放大超上限时**换掉**那句成功文案，而不是再补一条：两次 toast 会互相
           顶掉，用户只看到最后一条 —— 而他最需要知道的正是「会有点糊」。 */
        if (bun.maxUp > TaskMascotFit.MAX_UP) {
          okMsg = "有张图被放大了 " + bun.maxUp.toFixed(1) + " 倍，会有点糊";
        }
        var at = asNew ? -1 : mcCurIdx();
        /* 条数上限。★ 拒绝，而不是"悄悄挤掉最老的一项"：后者用户看到的是
           "加成功了"，而丢的是他更早那张图 —— 静默的数据丢失没有任何补救入口。 */
        if (at < 0 && mcLib.length >= MC_LIB_MAX) {
          toast("最多存 " + MC_LIB_MAX + " 张，先删掉一张再传");
          return "full";
        }
        var it = {
          /* sig：**换一张新图必须刷新它**。桌面球的快照指纹只认 char，而 char 一直是
             "custom" —— 不刷新的话「换了一张自己的图」在球上完全无感。
             ★ 但**改当前这一项时沿用原来的 sig**：sig 是这一项的身份证，换掉
               等于它从库里消失又冒出一项，当前项当场对不上号（高亮没了）。 */
          sig: at >= 0 ? mcLib[at].sig : mcNewSig(),
          name: at >= 0 ? mcLib[at].name : mcNextName(),
          /* 源图是「编辑」的前提，所以**每次烘都重存一份**（不只是新增那一次）：
             左右对调之后源图也跟着对调了，存旧的会导致"改完编辑回来又变回原样"。 */
          src: mcSrcSheet(bun.cells),
          had: mcHad(),
          dirs: bun.dirs, reacts: bun.reacts, thumb: bun.thumb
        };
        if (at >= 0) mcLib[at] = it; else mcLib.push(it);
        mcLibSave();
        saveMc({ char: "custom", custom: mcPayload(it) }, okMsg);
        renderMcGrid();
        return "";
      }

      if (mcCells) {
        mcCells.addEventListener("click", function(e){
          var b = e.target && e.target.closest ? e.target.closest("button") : null;
          if (!b || !mcFile) return;
          var i = Number(b.getAttribute("data-i"));
          /* 点某一格 = 用户指定了朝向，落错格是**看得见**的错（第 5 格摆着侧脸）。
             取不到合法格号时退回 -1（自动），不要退回 0 —— 0 是"朝左上"，
             那是个**具体的朝向声明**，用它兜底等于把"不知道"说成"就是左上"。 */
          mcFrom = (i >= 0 && i < 9) ? i : -1;
          mcFile.click();
        });
      }

      if (mcUp && mcFile) {
        mcUp.addEventListener("click", function(){
          mcFrom = -1;              /* 自动：由张数决定落位（1 张 = 正脸） */
          mcFile.click();
        });
        mcFile.addEventListener("change", function(){
          /* ★★★ v0.28.1 修的就是这两行的**顺序**：必须先浅拷贝成真数组，再清空 value。
             顺序反了 = 「选了图却报没选到文件」，用户点上传、选完照片，
             弹回来的是一句「没选到文件」。
             ★ `input.files` 是**活的视图**，不是快照（IDL 上是 `[SameObject]`）。
               真机实测（Edge headless，2026-09-19）：
                   赋值后                input.files.length = 2
                   清空 value 后，之前拿到的那个引用 .length = 0   ← 图在这里被丢掉
                   清空 value 后，浅拷贝出来的数组 .length = 2     ← 拷贝就没事
             ★ 而 value 又**必须**清空（不清的话「再传同一批图」不触发 change，
               用户会以为按钮坏了）—— 两件单独看都对的事撞在一起，就是这个 bug。
             ★ 上一版（v0.26.0）写的是 `files[0]`：先把 File 对象取出来，所以一直是好的。
               本版为了「一次多选九张」顺手改成拿整个列表，才踩进来 —— 是**回归**。
             ★ 同一个文件里 `mcSheetFile`（整张九宫格）那条至今仍是 `files[0]` 的形状，
               所以「整张九宫格」好用、「上传图片」坏了。**这个不对称是它藏了一整版的原因**：
               两个入口长得像兄弟，谁也不会想到其中一个坏了；而"旁边那个是好的"
               反而让人先怀疑自己选错了文件。 */
          var files = [].slice.call(mcFile.files || []);
          mcFile.value = "";
          var auto = mcFrom < 0;
          var from = auto ? mcAutoFrom(files.length) : mcFrom;
          mcLoadAll(files, from, function(imgs){
            mcFillFrom(from, imgs, auto);   /* 自动 = 换一整套（清空）；指定格 = 只补那几格 */
            renderMcCells();
            if (mcMake) mcMake.hidden = false;
            /* ★★★ v0.29.0：`asNew = auto`。「从上传按钮进来」（mcFrom 是 -1）
               = 再加一张新的；「点某一格补图」= 改当前这一张。
               ★ 这两个意图共用**同一条 change 通路** —— 上一版就是因为它们共用
                 而又没把意图传下去，才会出现"第二次上传把第一张覆盖掉"。 */
            if (mcCommit("换成了你自己的图", auto) === "bake") {
              toast("这些图处理不了，换几张试试");
            }
          }, function(msg){ toast(msg); });
        });
      }

      if (mcSheetBtn && mcSheetFile) {
        mcSheetBtn.addEventListener("click", function(){ mcSheetFile.click(); });
        mcSheetFile.addEventListener("change", function(){
          /* ★★ 这里写的是 `files[0]` —— **先把 File 对象取出来**，所以下面那句
             `value = ""` 清不掉它。v0.28.1 之前「上传图片」坏了、这一条一直是好的，
             差别就在这一个字符（`files` vs `files[0]`）。
             → 改动这条时**不要**顺手把它"统一"成 `var f = mcSheetFile.files`
               那种更好看的写法：好看的那版是坏的（见上面 mcFile 那段实测数据）。 */
          var f = mcSheetFile.files && mcSheetFile.files[0];
          mcSheetFile.value = "";
          mcLoad(f, function(im){
            /* ①C 的另一半：一张 3×3 整图切九刀。★ 这正是原项目 tiles() 的全部
               作用 —— 它下游的对齐**不关心**这九块来自一张图还是九个文件，
               所以两条入口共用同一条路。 */
            var nine = TaskMascotFit.splitSheet(im);
            if (!nine) return toast("这张图太小了，切不出九格");
            mcFillFrom(0, nine, true);   /* 一整张 = 换一整套，清空 */
            renderMcCells();
            if (mcMake) mcMake.hidden = false;
            /* ★ asNew = false：这一格在九格面板里面，而九格面板是"我正在拼**这一张**"。
               它是给当前项重新供一套源图，不是"再加一张"。 */
            if (mcCommit("换成了你自己的图", false) === "bake") {
              toast("这张图处理不了，换一张试试");
            }
          }, function(msg){ toast(msg); });
        });
      }

      /* ★★★ v0.29.0：点名字改名。判据在 mcRename 里（不在库里就什么都不做）——
         这里只把点击接上，别在监听器里再抄一遍"是不是自定义"的判断。 */
      if (mcName) {
        mcName.addEventListener("click", function(){
          var at = mcCurIdx();
          if (at >= 0) mcRename(at);
        });
      }

      /* ★★★ v0.29.0：「编辑」= 把当前这一项的**源图**回填进九格。
         ★ 它是老大要的 (b)：**已经传完之后还要能改**。旧版没有这个入口，
           所以"想改"只能再传一遍 —— 而再传一遍又只能覆盖（库里只有一格）。
         ★ 回填的是源图不是成品，原因见 mcRefill 上面那段。
         ★ 跟「上传图片」**必须是两个按钮**：上传 = 再加一张新的，编辑 = 改这一张。
           合成一个的后果就是这一版要修的那个问题（第二次上传覆盖第一次）。 */
      if (mcEdit) {
        mcEdit.addEventListener("click", function(){
          var it = mcLib[mcCurIdx()];
          if (!it) return;
          mcRefill(it, function(){
            renderMcCells();
            if (mcMake) mcMake.hidden = false;
            /* ★ mcFrom 归位成 -1：回填之后九格是"这一项的全套"，
               用户接着点某一格时那个处理器会重新赋值，这里不归位也不会错；
               但归位之后「回填完直接点上传」不会被上一次的格号影响。 */
            mcFrom = -1;
          }, toast);
        });
      }

      if (mcFlip) {
        mcFlip.addEventListener("click", function(){
          /* ★ 只换格序、不碰任何图像 —— 所以「九格预览」和「烘出来的雪碧」
             不可能是两套口径。原项目 52 个角色里有 1 个左右画反，而
             shift / palette / width / overlap 四个指标**全绿**，只能靠人眼发现。 */
          var a = TaskMascotFit.swapColumns(mcSlots);
          for (var i = 0; i < 9; i++) mcSetSlot(i, a[i]);
          renderMcCells();
          /* ★ asNew = false：对调的是**当前这一张**，不是新加一张。 */
          mcCommit("左右对调了", false);
        });
      }

      if (mcDel) {
        mcDel.addEventListener("click", function(){
          /* ★★★ v0.29.0：「删掉」从"删掉唯一那张自定义图"变成"**删掉库里当前这一项**"。
             ★ 库里还有别的项时，删完要**自动落到剩下的一项**上，而不是退回狐狸 ——
               退回狐狸的话，用户看到的是"我删了第 2 张，结果球变了样"，
               而库里另外两张还在（他得自己再点回去）。
             ★ 落到"原来那个位置的下一项"，位置用 `min(at, len-1)` 夹住：
               删的是最后一项时那个下标已经越界了，不夹就会拿到 undefined 然后炸在下游。
             ★ 库空了才退回默认角色，并且**连数据一起删**（不是只把 char 换回去）：
               留着两份用不上的 dataURL 在 storage 里，用户再也没有入口能删掉它。
             ★ 回到 TaskMascot.DEFAULT.char 而不是写死 "fox" —— 默认角色将来换了，
               这里跟着换；写死就是第二个口径。 */
          var at = mcCurIdx();
          if (at >= 0) mcLib.splice(at, 1);
          mcLibSave();
          /* ★ v0.28.0：九格面板也要跟着清空、收起来 —— 不清的话，删完之后
             面板里还摆着那九张缩略图，看着像「删了还在」；而下次再点某一格
             换图，会拿一堆已经删掉的图去重烘。 */
          for (var i = 0; i < 9; i++) mcSetSlot(i, null);
          renderMcCells();
          if (mcMake) mcMake.hidden = true;
          if (mcLib.length) {
            renderMcGrid();
            var nx = mcLib[Math.min(at < 0 ? 0 : at, mcLib.length - 1)];
            mcSelect(nx, "已删掉，换成了「" + nx.name + "」");
          } else {
            delete mcCfg.custom;
            saveMc({ char: TaskMascot.DEFAULT.char }, "已删掉你自己的图");
            renderMcGrid();
          }
        });
      }
    }

    bindTabs();
    bindSubTabs();
    bindAbout();
    renderProjects();
    renderArch();
    renderStat();
    aiBind();
    if (typeof Sync !== "undefined") { fsBind(); fsInit(); }
  });
})();
