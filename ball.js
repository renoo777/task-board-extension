// 任务台 · 桌面悬浮球桥（扩展侧唯一出口）
//
// 干什么：把 storage.local 里的任务推给桌面那颗球；接住球发上来的「新建 / 改状态」。
//
//   扩展 SW ──connectNative("com.taskboard.ball")──> taskboard-host.exe
//                                                        │ TCP 127.0.0.1:<球自己选的端口>
//                                                        ▼
//                                                   taskboard-ball.exe（这一端是监听方）
//
// 三条纪律（每条都是踩出来的）：
//
// 1) ★ 球只做视图、不做仓库。这里只「推快照 / 收命令」，绝不建第二份数据 ——
//    数据永远只有 storage.local 一份。球点圆圈时先乐观改自己的显示，真值由我们
//    紧接着推回去的快照覆盖。这样两边不会各说各话。
//
// 2) ★★「球没开」是常态，不是错误。connectNative 在宿主不存在时**不抛错**，
//    错误只出现在 onDisconnect 的 chrome.runtime.lastError 里 —— 那是唯一的排障抓手，
//    必须原样留给人看（设置页会显示它）。千万别把它吞成一句「连接失败」。
//
// 3) ★★ MV3 的 SW 随时被回收，port 会跟着断，所以每个入口都先 ensure()（天然幂等）。
//    连不上时只留**最新一份**快照（pending），连上立刻补推 —— 不排队、不重放：
//    球要的是「现在长什么样」，不是「这十分钟里改过哪几次」。

var Ball = (function () {
  "use strict";

  var HOST = "com.taskboard.ball";
  var KEY = "taskboard.v1";
  var PKEY = "taskboard.projects";
  /* 吉祥物配置（v0.24.0）：桌面球没有自己的仓库，形态也得从扩展这边拿。
     ★ 解析口径用 mascot.js 里那份 readConfig（SW 里 importScripts 了 mascot.js）——
       球要是自己再写一份默认值，就会出现「网页上是狐狸、桌面球是圆球」这种
       两处不一致，而两边的单测各测各的、全绿。 */
  var MCKEY = "taskboard.mascot";

  var PUSH_MS = 250;                       // storage 连续改动时的合并窗口
  var RETRY_MS = [5000, 15000, 60000];     // 退避档位：失败越多等得越久，封顶 60s
  var MAX_TASKS = 500;                     // 快照上限（宿主→扩展单条 ≤1MB，留足余量）

  /* ============================ 纯函数区 ============================
     这一段不碰 chrome，任何改动都能被单测直接钉住。 */

  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function ymd(ms) {
    var d = new Date(ms);
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  function uid() { return Math.random().toString(36).slice(2, 9); }

  /* 只带走球真正要用的字段。
     ★ 为什么必须裁：note / url 是用户自己写的东西，球一个字都不显示，
       没有理由把它们送出浏览器进程；顺带把单条消息压到很小。 */
  function pick(t) {
    return {
      id: t.id,
      title: t.title || "",
      status: t.status || "todo",
      project: t.project || "",
      date: t.date || "",
      doneAt: t.doneAt || null,
      archived: !!t.archived           // 球靠它把归档的排除掉（归档是本地标记，不进飞书）
    };
  }

  /* 吉祥物配置的兜底。
     ★ 为什么这里要再兜一层：mascot.js 是靠 importScripts 进 SW 的，而 ball.js
       在**单测里是被单独 require 的**（_test_ball.js 不加载 mascot.js）——
       那种环境下 TaskMascot 是 undefined。不兜的话整个桥在单测里直接炸，
       而且炸的位置在 snapshot 里，看起来像是「快照坏了」。
     ★ 兜的值必须和 TaskMascot.DEFAULT 逐字一致（on 的口径是 `on !== false`）。 */
  function readMc(v) {
    if (typeof TaskMascot !== "undefined" && TaskMascot.readConfig) {
      return TaskMascot.readConfig(v);
    }
    v = (v && typeof v === "object") ? v : {};
    var size = Math.round(Number(v.size) || 72);
    if (size < 44) size = 44;
    if (size > 120) size = 120;
    /* ★★ v0.24.1：兜底分支**不解析** custom 的字段，但必须做**形状判断 + 回退**。
       上一版我只写了 `custom: null`，结果 char 指着 "custom" 却一张图都没有 ——
       球那边会安静地 404 出一颗空白球（页面上一个字都不报）。
       ★ 这里的判断只有「两张图在不在」这一条，细节（sig/thumb）仍归 mascot.js，
         口径没有分叉成两份。 */
    var custom = (v.custom && typeof v.custom.dirs === "string" && v.custom.dirs &&
                  typeof v.custom.reacts === "string" && v.custom.reacts)
      ? v.custom : null;
    var char = (typeof v.char === "string" && v.char) ? v.char : "fox";
    if (char === "custom" && !custom) char = "fox";
    return {
      on: v.on !== false,
      char: char,
      size: size,
      reacts: v.reacts !== false,
      /* ★ v0.26.0：跟 TaskMascot.readConfig 保持逐字一致。
         ★ 桌面球**读都不用读**它（球不说话），但兜底分支必须把它带上 ——
           这条兜底存在的意义就是「口径没有分叉成两份」，
           少一个字段就等于亲手造了一次分叉。 */
      talk: v.talk !== false,
      custom: custom
    };
  }

  /* 构造下行快照。projects 原样带走 —— 球要用 name → color 画项目色点。
     ★ mascot 也一起走（v0.24.0）：桌面球没有自己的存储，形态是扩展说了算。 */
  function snapshot(data, projects, now, mc) {
    var all = (data && Array.isArray(data.tasks)) ? data.tasks : [];
    /* ★ tasks 是「最新在前」（新建走的是 unshift），所以超上限要砍**尾巴**。
       写成 slice(length - MAX) 会正好反过来 —— 留下最老的、把刚建的扔掉，
       而且是静默的：球上就是"我刚记的那条不见了"。 */
    var head = all.length > MAX_TASKS ? all.slice(0, MAX_TASKS) : all;
    return {
      type: "snapshot",
      at: now || Date.now(),
      total: all.length,
      tasks: head.map(pick),
      projects: (Array.isArray(projects) ? projects : []).map(function (p) {
        return { name: p && p.name, color: (p && p.color) || "#8b9099" };
      }),
      /* ★ 带的是**解析后**的配置，不是 storage 里的原始值。
         球那边不该再做一次默认值判断 —— 那等于把口径复制了一份到球上，
         而球是另一个仓库（Tauri 工程），改起来根本想不起来还有这一处。 */
      /* ★★ v0.24.1：自定义图**只在它真的是当前角色时**才跟着快照走。
         那两张雪碧是 dataURL，合起来一两百 KB —— 球还是圆球形态时让它们
         每一条快照都跟着过 native messaging，是白烧带宽（Chrome 那条通道
         单条消息上限 1MB，塞满它是要付代价的）。
         ★ 注意只裁**快照**这份拷贝：storage 里那份必须留着，
           否则用户切回自定义角色时图就没了。 */
      mascot: (function () {
        var m = readMc(mc);
        if (m.char !== "custom") m.custom = null;
        return m;
      })()
    };
  }

  var OK_STATUS = { todo: 1, doing: 1, done: 1 };

  /* 处理球发上来的命令。**返回结果而不是直接写 storage** —— 这样单测可以
     只喂一个对象、断言一个对象，不用搭假 chrome。
     返回值：{ changed, data, reply }
       changed=false 时 data 是原值（调用方不用写） */
  function apply(msg, data, o) {
    o = o || {};
    var now = o.now || Date.now();
    var base = data && typeof data === "object" ? data : { view: "today", tasks: [] };
    var tasks = Array.isArray(base.tasks) ? base.tasks.slice() : [];
    var projects = Array.isArray(o.projects) ? o.projects : [];
    var type = msg && msg.type;

    if (type === "create") {
      // 标题：跟弹窗那边一个口径（折白、去首尾、截到 160）
      var title = String(msg.title == null ? "" : msg.title).replace(/\s+/g, " ").trim().slice(0, 160);
      if (!title) return { changed: false, data: base, reply: { type: "ack", ok: false, reason: "empty" } };

      // ★ 项目只认已有项目名（球上没地方选项目，猜错了就退回默认），
      //   跟自然语言输入那条纪律同源：不许凭空造出一个新项目。
      var names = projects.map(function (p) { return p && p.name; });
      var proj = names.indexOf(msg.project) >= 0
        ? msg.project
        : (o.lastProject && names.indexOf(o.lastProject) >= 0 ? o.lastProject : (names[0] || "工作"));

      var nt = {
        id: uid(),
        title: title,
        status: "todo",
        project: proj,
        date: ymd(now),
        note: "",
        url: "",
        createdAt: now,
        doneAt: null,
        priority: "",
        order: null
      };
      tasks.unshift(nt);
      return {
        changed: true,
        data: { view: base.view || "today", tasks: tasks },
        reply: { type: "ack", ok: true, action: "create", id: nt.id, project: proj }
      };
    }

    if (type === "set-status") {
      if (!OK_STATUS[msg.status]) {
        return { changed: false, data: base, reply: { type: "ack", ok: false, reason: "bad-status" } };
      }
      for (var i = 0; i < tasks.length; i++) {
        if (tasks[i].id !== msg.id) continue;
        if (tasks[i].status === msg.status) {
          return { changed: false, data: base, reply: { type: "ack", ok: true, action: "set-status", noop: true } };
        }
        /* ★ 浅拷贝出这一条再改。`tasks.slice()` 只拷了数组本身，元素还是**同一个对象引用**——
           直接改它就是改调用方手里那份。生产里 data 是刚读出来的、改了看不出问题，
           但「apply 不改入参」这个契约得守住：破了它，单测连调两次第二次看到的就是上一次的残留，
           属于最难查的一类假绿。 */
        var t = {};
        for (var k in tasks[i]) {
          if (Object.prototype.hasOwnProperty.call(tasks[i], k)) t[k] = tasks[i][k];
        }
        // ★ doneAt 的写法必须和拖拽 / 键盘 / 就地编辑**完全一致**：
        //   进 done 记时间，离开 done 清掉。球是三档循环（todo→doing→done→todo），
        //   所以这里既可能进 done 也可能出 done，两个方向都要处理。
        t.status = msg.status;
        t.doneAt = msg.status === "done" ? now : null;
        tasks[i] = t;
        return {
          changed: true,
          data: { view: base.view || "today", tasks: tasks },
          reply: { type: "ack", ok: true, action: "set-status", id: t.id, status: t.status }
        };
      }
      return { changed: false, data: base, reply: { type: "ack", ok: false, reason: "not-found" } };
    }

    return { changed: false, data: base, reply: { type: "ack", ok: false, reason: "unknown-type" } };
  }

  /* 内容指纹：同一份数据被反复触发时不要重复推。只做调试用，不参与业务判断。
     ★★ mascot 必须进指纹（v0.24.0）：设置页改配置走的是 storage.onChanged →
        pushSoon（**不带 force**），而指纹只看任务的话，「只换了个脸」这次改动
        会被判成「内容没变」而**整条跳过** —— 表现是「设置页换完脸，桌面球没反应，
        要等下一次记一笔才跟着变」。这类「只有这一条改动路径」的 bug 最难复现，
        所以钉在这里而不是靠调用方记得传 force。 */
  function fingerprint(snap) {
    var s = "";
    for (var i = 0; i < snap.tasks.length; i++) {
      var t = snap.tasks[i];
      s += t.id + ":" + t.status + ":" + (t.archived ? 1 : 0) + ";";
    }
    var m = snap.mascot;
    /* ★★ v0.24.1：自定义图的指纹要带上 sig。char 一直是 "custom"，
       只按 char 比对的话「换了一张自己的图」在球那边**看不出变化** ——
       这正是上面那条注释描述的坑的复刻，换了个字段而已。 */
    /* ★★ v0.26.0：`talk` **故意不进指纹**（别以为是漏了）。
       判据是「指纹变了 = 球那边有东西要重画」，而桌面球不说话 ——
       它压根没做「点球开口」那条路，这个字段对它零影响。
       加进去的代价是「每拨一次说话开关就白推一次快照」，换不来任何画面变化。
       ★ 反过来说：**哪天桌面球真的开口说话了，这里必须一起加**，
         否则就会复刻上面那条注释描述的坑 —— 拨了开关，球要等下一次记一笔才反应。 */
    var ms = m ? (m.on ? "1" : "0") + m.char + m.size + (m.reacts ? "r" : "") +
      (m.custom ? ":" + m.custom.sig : "") : "-";
    return snap.tasks.length + "|" + s + "|" + ms;
  }

  /* ============================ 连通道 ============================ */

  var port = null;
  var timer = null;        // pushSoon 的合并窗口
  var retryTimer = null;
  var retryStep = 0;       // 退避档位
  var pending = null;      // 连不上时留的最新一份快照
  var lastFp = "";         // 刚推过的那份的指纹
  var booted = false;

  var last = {
    ok: false, at: 0, error: "", pushes: 0, ups: 0, conns: 0, host: HOST
  };

  function hasNative() {
    return (typeof chrome !== "undefined" && chrome.runtime &&
            typeof chrome.runtime.connectNative === "function");
  }

  // 宿主回报的错误码 → 人话。设置页直接显示这句，所以别写成日志腔。
  function humanError(code) {
    if (code === "ball_not_running") return "桌面悬浮球没有在运行 —— 先双击 taskboard-ball.exe";
    if (code === "no_host") return "宿主程序没装上 —— 跑一次「安装悬浮球」";
    return "宿主回报：" + code;
  }

  function clearRetry() {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    retryStep = 0;
  }

  function scheduleRetry() {
    if (retryTimer) return;
    var wait = RETRY_MS[Math.min(retryStep, RETRY_MS.length - 1)];
    retryStep++;
    retryTimer = setTimeout(function () {
      retryTimer = null;
      connect();
    }, wait);
  }

  function connect() {
    if (port) return port;
    if (!hasNative()) { last.ok = false; last.error = "这个浏览器不支持原生消息传递"; return null; }

    // ★ connectNative 在宿主不存在时不会抛错，只在 onDisconnect 里报
    //   "Specified native messaging host not found." —— 但也可能直接抛 TypeError（权限没声明），
    //   所以两头都要兜住。
    try {
      port = chrome.runtime.connectNative(HOST);
    } catch (e) {
      last.ok = false;
      last.error = (e && e.message) || String(e);
      scheduleRetry();
      return null;
    }
    last.conns++;
    lastFp = "";                       // 新连接：指纹作废，下次一定重推

    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
    return port;
  }

  function onDisconnect() {
    var err = null;
    try { err = chrome.runtime.lastError; } catch (e) { /* 某些分支读它会抛 */ }
    last.ok = false;
    last.at = Date.now();
    // 宿主不在 → 这句是"宿主没装"；球没开 → 宿主的 host-error 已经先写进 last.error 了
    if (err && err.message) last.error = err.message;
    else if (!last.error) last.error = "通道断了";
    port = null;
    scheduleRetry();
  }

  function reply(obj) {
    if (!port) return false;
    try { port.postMessage(obj); return true; } catch (e) { return false; }
  }

  function onMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    var type = msg.type;

    // 宿主自己报的错（球没开 / 宿主没装）
    if (type === "host-error") {
      last.error = humanError(msg.code);
      last.ok = false;
      return;
    }

    last.ups++;
    last.at = Date.now();

    // 球建链自报家门、或主动要快照 —— 两种情况都是「给我来一份最新的」
    if (type === "hello" || type === "snapshot-request") {
      last.ok = true;
      push({ force: true });
      return;
    }
    if (type === "ping") { last.ok = true; reply({ type: "pong", from: "taskboard-extension" }); return; }
    if (type === "create" || type === "set-status") { handleCommand(msg); return; }
  }

  /* ---------- 球改了数据：写 storage，然后把真值推回去 ---------- */
  function handleCommand(msg) {
    if (typeof chrome === "undefined" || !chrome.storage) return;
    chrome.storage.local.get([KEY, PKEY, "lastProject"], function (o) {
      var data = o && o[KEY] ? o[KEY] : { view: "today", tasks: [] };
      var r = apply(msg, data, {
        now: Date.now(),
        projects: (o && Array.isArray(o[PKEY])) ? o[PKEY] : [],
        lastProject: (o && o.lastProject) || ""
      });
      if (!r.changed) { reply(r.reply); return; }
      var patch = {};
      patch[KEY] = r.data;
      chrome.storage.local.set(patch, function () {
        reply(r.reply);
        // 立刻回推：球那边是乐观更新，这里要用真值把它盖回去
        // （id 是扩展生成的，球自己编不出来）
        push({ force: true });
      });
    });
  }

  /* ---------- 下行：推快照 ----------
     read() 内部统一取一次 storage：pushSoon / pushNow / probe 都走它，
     省得每加一个入口就抄一遍取值逻辑。 */
  function read(cb) {
    if (typeof chrome === "undefined" || !chrome.storage) { cb(null, null, null); return; }
    chrome.storage.local.get([KEY, PKEY, MCKEY], function (o) {
      cb(o && o[KEY] ? o[KEY] : null,
         (o && Array.isArray(o[PKEY])) ? o[PKEY] : [],
         (o && o[MCKEY]) || null);
    });
  }

  /* force=true：不管指纹、不管节流，立刻推（球主动要、或球刚改了东西） */
  function push(opts) {
    opts = opts || {};
    read(function (data, projects, mc) {
      var snap = snapshot(data, projects, Date.now(), mc);
      var fp = fingerprint(snap);
      if (!opts.force && fp === lastFp) return;          // 内容没变，白推一次没意义
      var p = port || connect();
      if (!p) { pending = snap; return; }                 // 连不上：只留最新一份，连上补推
      try {
        p.postMessage(snap);
        pending = null;
        lastFp = fp;
        last.ok = true;
        last.at = Date.now();
        last.pushes++;
        last.error = "";                                  // 推成功即清错，否则旧错会一直挂着
      } catch (e) {
        pending = snap;
        last.error = (e && e.message) || String(e);
        last.ok = false;
      }
      // 补推：上一条是 pending 说明当时没连上，现在连上了
      if (pending && port) {
        var q = pending; pending = null;
        try { port.postMessage(q); last.pushes++; } catch (e2) { pending = q; }
      }
    });
  }

  /* storage 连续改动（拖一条卡、打字打一半…）合并成一次推 */
  function pushSoon() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () { timer = null; push({}); }, PUSH_MS);
  }

  function pushNow() { return push({ force: true }); }

  /* ---------- 设置页用：探一次，返回能直接显示的结果 ---------- */
  function probe() {
    return new Promise(function (res) {
      if (!hasNative()) {
        res({ ok: false, error: "这个浏览器不支持原生消息传递", host: HOST });
        return;
      }
      if (port) {
        // 已经连着 → 推一份并报好（顺手把 pending 清掉）
        push({ force: true });
        setTimeout(function () { res(status()); }, 60);
        return;
      }
      // 没连着 → 现在连一次，等一小会儿看它是通是断
      clearRetry();
      connect();
      setTimeout(function () { res(status()); }, 900);
    });
  }

  function status() {
    return {
      ok: !!last.ok,
      at: last.at,
      error: last.error,
      host: HOST,
      pushes: last.pushes,
      ups: last.ups,
      conns: last.conns,
      pending: pending ? pending.tasks.length : 0,
      supported: hasNative()
    };
  }

  /* ---------- 启动 ----------
     MV3 里 SW 每次被唤醒都会重新执行整个 background.js，所以这里天然只跑一次；
     但还是加个 booted 兜一下（免得以后有人在别处也调）。 */
  function boot() {
    if (booted) return;
    booted = true;
    read(function (data, projects, mc) {
      if (data) { var snap = snapshot(data, projects, Date.now(), mc); lastFp = fingerprint(snap); }
      connect();
      push({ force: true });     // 已有数据就先推一份：SW 被回收又醒来时球能立刻对表
    });
  }

  return {
    HOST: HOST,
    boot: boot,
    pushNow: pushNow,
    pushSoon: pushSoon,
    probe: probe,
    status: status,
    // 下面几个导出只为单测（生产代码不要直接调）
    _snapshot: snapshot,
    _apply: apply,
    _fingerprint: fingerprint,
    _humanError: humanError,
    _reset: function () { port = null; pending = null; lastFp = ""; booted = false;
                          if (timer) { clearTimeout(timer); timer = null; } clearRetry(); }
  };
})();
