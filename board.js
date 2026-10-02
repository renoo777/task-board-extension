/* board.js —— 任务数据看板（v0.18.0）
   ============================================================
   这是「设置页 → 看板」那一页的全部逻辑。
   ★★★ 数据源 **v0.40.0 起是三份**（原来只有第一份）：
     ① `taskboard.v1` —— 我自己的任务（KPI / 任务分析 / 趋势 / 热力 / 关注 全用它）；
     ② `taskboard.inbox.outbox`（`Inbox.OUTK`）—— 我派出去的活，后台每轮轮询回读；
     ③ `taskboard.inbox.items`（`Inbox.ITK`）—— 派给我的活。
     第 ②③ 份只服务卡片「团队任务」（v0.40.0 · P0-5）。
   ★★★ 看板**仍然只读** —— 不写 storage、不发消息、不新开同步链路。
   （判据：这个文件里不该出现 Store.set / chrome.runtime.sendMessage。）
   ★★ 只读的代价原本是「团队那块会停在旧状态」（本地状态只在打开弹窗时才被回填），
      解法**不是**去看板里写数据，而是把 `OUTK` 的最新状态按**单调递增**推上去 ——
      算出来就画，一个字节都不落盘（见 `teamInput`）。

   ★ 图表为什么全部手写 SVG，不引图表库
     ① MV3 默认 CSP 禁远程脚本 → 库必须打进包；Chart.js 压缩后约 200KB，
        而我们的包现在才 201KB —— 引一个库等于包体积翻倍。
     ② 我们要画的就四种：柱、条、格、点。手写比配库的 API 更快、更可控。
     ③ 颜色要跟主题变量走（--s-done 等），库的默认皮肤反而更难改。
     ★ 所以这里不出现任何 canvas、不出现任何 import。

   ★ 口径必须和设置页顶部那行「共 N 条任务…」逐字一致
     （renderStat 用 live 排掉归档）。同一份数据两个数字，用户会开始不信这个产品。
     唯一的例外是「总任务」：看板显式写「含归档 N 条」，因为看板是全局视图。

   ★「–」≠「0」（本项目最贵的铁律之一）
     「平均完成周期」在一条都没完成时是**不知道**，显示「–」；
     而「逾期 0 条」是**真没有**，显示 `0`。两者长得像，含义相反。
   ============================================================ */
(function () {
  "use strict";

  var KEY = "taskboard.v1";
  var PKEY = "taskboard.projects";
  var HOLD = "hold";
  var TREND_DAYS = 14;
  var HEAT_WEEKS = 12;
  var FOCUS_MAX = 6;
  /* 团队那三列的**顺序**（值是 `Inbox.CAT_TEXT` 的键）。
     ★ 顺序是**显示**的事，所以生在这儿；而「有哪些类别、各叫什么」是**语义**的事，
       生在 `inbox.js` 一处（弹窗将来也要用同一张表）。
       ⇒ 门要断言这里与 `Object.keys(Inbox.CAT_TEXT)` 逐字相同 ——
         少一个类别 = 看板少一列，而不会有任何地方报错。 */
  var CAT_ORDER = ["todo", "doing", "done"];

  /* ---------------- 小工具 ---------------- */
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function ymd(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function todayStr() { return ymd(new Date()); }
  function dayShift(s, n) {
    var d = new Date(s + "T00:00:00");
    d.setDate(d.getDate() + n);
    return ymd(d);
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function Store(key) {
    key = key || KEY;
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      return chrome.storage.local.get(key).then(function (o) {
        return o[key] !== undefined ? o[key] : null;
      });
    }
    try { var v = localStorage.getItem(key); return Promise.resolve(v ? JSON.parse(v) : null); }
    catch (e) { return Promise.resolve(null); }
  }

  /* ---------------- 团队那三份数据的接口（v0.40.0） ----------------
     ★★ 三个 key 名**不在这里抄一遍**：它们是 `inbox.js` 的东西，抄了就是第二份键名 ——
       哪天 `Inbox.ITK` 改名，看板会安静地读一个空 key（**读空 ≠ 报错**），
       症状是「团队那块永远说还没同步过」，而没有任何东西会红。
     ★ 拿不到 `Inbox` 就返回 null（而不是编一个默认键）—— 那种情况只可能出现在
       某个测试没按 manage.html 的顺序引脚本，这时**说清楚**比猜一个键好。 */
  function teamKeys() {
    if (typeof Inbox === "undefined" || !Inbox.ITK) return null;
    return { ik: Inbox.ITK, ok: Inbox.OUTK, ck: Inbox.CFK };
  }

  /* 三份原始数据 → 「团队任务」那块要的纯数据。
     ★ 为什么**不在 compute 里做**：compute 是这一页唯一被单测直接喂数组的函数
       （门钉着它不碰 document / chrome），而这一步要借 `Inbox` 的四个口径
       （`assignState` / `laterState` / `catOf` / `staleOf`）。
       分开之后：join 归这里、聚合归 `teamOf`、两个都能单独喂数据验。 */
  function teamInput(tasks, ik, ok, ck) {
    if (typeof Inbox === "undefined" || !Inbox.ITK) return null;
    var rows = (ok && Array.isArray(ok.rows)) ? ok.rows : [];
    var remote = {};
    rows.forEach(function (r) { if (r && r.rid) remote[String(r.rid)] = String(r.st || ""); });
    var now = Date.now();
    var out = [], failed = 0, revoked = 0;
    (tasks || []).forEach(function (t) {
      var a = t && t.assign;
      /* 没派出去的本地任务没有 `assign`（或没有接收人）—— 与 `popup` 的
         `outItems()` 同一条判据：**只有 `to` 有值才算派过**。 */
      if (!a || String(a.to || "").trim() === "") return;
      var st = String(a.st || "").trim();
      /* 撤回（本地终态）/ 失败（异常态）**不进三列**：它们是流程外的两条支路，
         塞进「未开始」会让那一列混着「派出去了还没动」和「压根没派出去」——
         而这两件事要做的动作完全不同（一个去催、一个去重派）。 */
      if (st === "revoked") { revoked++; return; }
      if (st === "failed") { failed++; return; }
      /* ★★ 显示状态 = 本地状态与**远端最新状态**里更靠后的那个（单调递增，`laterState`）。
         为什么不能只用本地：`assign.st` 只在**打开弹窗**时被 `applyOutbox` 回填 ——
         没开过弹窗就一直停在「已派发」。看板读得到 `OUTK`（后台每轮都写），
         顺手推一把就能看到最新进度，而且**一个字节都不落盘**（看板只读）。
         为什么要单调：两个来源必然不同步，允许倒退就会出现「完成 → 待办」——
         用户会以为活被退回来了。 */
      var shown = Inbox.laterState(Inbox.assignState(a), remote[String(a.rid || "")] || "");
      var since = Number(a.stAt) || Number(a.at) || 0;
      out.push({
        to: String(a.to).trim(),
        st: shown,
        cat: Inbox.catOf(shown),
        /* 「未领取」= 已派发、对方还没动。**只有这一档**算 ——
           `doing` 说明他已经动了（在做了，不该再催）。
           -1 = 这一条不是未领取；>= 0 = 已经压了这么多天。 */
        silent: (shown === "recorded" && since) ? Math.floor((now - since) / 86400000) : -1
      });
    });
    var items = Array.isArray(ik) ? ik : [];
    return {
      /* ★ `on`：团队派发开没开 —— 与 `popup` 读的是同一个 `readCfg`。
         `ck` 可能是在迁移中途的半个对象，`readCfg` 自己能兜住。 */
      on: !!Inbox.readCfg(ck).on,
      /* ★ `synced`：后台**至少跑过一轮**才有这个时间戳（`OUTK = {at, rows}`）。
         它是「0 条」和「还没同步过」之间唯一的分界 ——
         没有它就只能靠 `rows.length === 0`，而那两种情况长得一模一样。 */
      synced: !!(ok && Number(ok.at)),
      inCount: items.length,
      out: out, failed: failed, revoked: revoked
    };
  }

  /* 纯聚合：三列的计数 + 按人一行（不碰 Inbox、不碰时间 —— 全在 `teamInput` 里做完）。 */
  function teamOf(team) {
    if (!team) return null;
    var out = team.out || [];
    var cols = {};
    CAT_ORDER.forEach(function (k) { cols[k] = 0; });
    var by = {}, order = [];
    out.forEach(function (r) {
      if (r.cat && Object.prototype.hasOwnProperty.call(cols, r.cat)) cols[r.cat]++;
      var p = by[r.to];
      if (!p) { p = by[r.to] = { name: r.to, n: 0, done: 0, silent: -1 }; order.push(r.to); }
      p.n++;
      if (r.cat === "done") p.done++;
      if (r.silent > p.silent) p.silent = r.silent;
    });
    /* 顺手最多的排前面（谁压着活，谁最该被看见）；名字只用来把同量的排稳，
       —— 同级每次刷新换位置，看板就没法竖着读。 */
    var people = order.map(function (k) { return by[k]; }).sort(function (a, b) {
      return (b.n - a.n) || a.name.localeCompare(b.name);
    });
    return {
      on: !!team.on, synced: !!team.synced,
      outCount: out.length, inCount: Number(team.inCount) || 0,
      cols: cols, failed: Number(team.failed) || 0, revoked: Number(team.revoked) || 0,
      people: people
    };
  }

  /* ---------------- 计算层（纯函数） ----------------
     纯函数是这道题的**可测性**所在：喂进去一组任务，出来的每个数字都能
     在测试里逐条对。渲染层只负责把数字摆到该摆的地方。
     ★ 这里不碰 DOM、不碰 storage —— 所以 _test_board.js 能直接调它。 */
  /* 「这条任务交出去了吗」的薄包装（v0.43.0）。
     ★ 判据本体在 `Inbox.isGivenAway` —— `manage.html` 里 `inbox.js` 排在 `board.js` 之前，
       运行时取得到；`_test_board.js` 也是**先 eval inbox.js 再 eval board.js**（两边一致）。
     ★★ 它保持 `compute` 的**纯函数**性质：不碰 storage、不碰 DOM。
     ★★★★ 退化路径**不再重写判据** —— 初稿那句「留退化路径是为了 `_test_board.js`」
       本身就已经过期了（那个测试早就把 `inbox.js` 一起 eval 进来了）。而且抄的那份
       `st !== "revoked"` 是**错的**：它把「派发失败」的活也当成交出去了。
       拿不到就返回 `false`：**安全方向**（宁可多算一件，不可把活藏掉）。
       门（G11）盯着本函数体里不许再出现 `recorded` / `failed` / `a.to` 这类判据字面量。 */
  function givenAway(t) {
    if (typeof Inbox === "undefined" || !Inbox.isGivenAway) return false;
    return Inbox.isGivenAway(t);
  }

  function compute(tasks, projs, team) {
    tasks = Array.isArray(tasks) ? tasks : [];
    projs = Array.isArray(projs) ? projs : [];
    var today = todayStr();
    /* ★★★ v0.43.0：`live` 加上「还没交出去」。这一条是**整块看板的数据源** ——
       在手 / 未完成 / 逾期 / 今天到期 / 按项目 / 按优先级 / 关注列表
       全都从它派生，所以改这一处，上面那一片一起对。
       ★ 为什么看板也算「个人待办」：老大原话是「派发的任务还在我的**个人待办数据**
         里面」—— 他说的不是弹窗那一屏，也包括这个看板上的「在手 N 条」。
         两处不同口径就会变成「看板说在手 8、弹窗说今天 6」，
         而这类数字对不上是最伤信任的一类（`notify.js` 抬头也为它定过性）。 */
    var live = tasks.filter(function (t) { return !t.archived && !givenAway(t); });

    var done = live.filter(function (t) { return t.status === "done"; });
    var doing = live.filter(function (t) { return t.status === "doing"; });
    var hold = live.filter(function (t) { return t.status === HOLD; });
    /* ★ 未完成不含挂起 —— 挂起的东西不该算在手头的活里（与 renderStat 同口径） */
    var open = live.filter(function (t) { return t.status !== "done" && t.status !== HOLD; });
    /* ★★ 归档数**必须直接数 `t.archived`**，不能再用 `tasks.length - live.length`：
       `live` 现在少了「交出去的」那一类，两者相减会把派出去的活**算成归档** ——
       而那个数字看着还挺合理，所以不会有人发现。 */
    var arch = tasks.filter(function (t) { return !!t.archived; }).length;

    /* --- 逾期：有声明的截止日、且那天已经过去了、且还没完成 --- */
    var overdue = live.filter(function (t) {
      return t.status !== "done" && t.date && t.date < today;
    });
    var dueToday = live.filter(function (t) {
      return t.status !== "done" && t.date === today;
    });

    /* --- 本周（周一 00:00 起）。★ 归档的也算：归档只是收起来，活是真干完了 --- */
    var wkStart = (function () {
      var d = new Date(today + "T00:00:00");
      var wd = (d.getDay() + 6) % 7;          // 周一 = 0
      d.setDate(d.getDate() - wd);
      return ymd(d);
    })();
    function doneOn(day) {
      return tasks.filter(function (t) {
        return t.status === "done" && t.doneAt && ymd(new Date(t.doneAt)) === day;
      }).length;
    }
    var weekDone = 0;
    for (var i = 0; i < 7; i++) {
      var d0 = dayShift(wkStart, i);
      if (d0 > today) break;
      weekDone += doneOn(d0);
    }

    /* --- 连续完成天数：从今天往回数，哪天 0 条就停 ---
        ★ 今天还没完成不该把已有streak打断 → 今天为 0 时从昨天起数。 */
    var streak = 0;
    var k = doneOn(today) > 0 ? 0 : -1;
    for (; ; k--) {
      if (doneOn(dayShift(today, k)) > 0) streak++;
      else break;
      if (k < -400) break;                     // 兜底，别让坏数据转成死循环
    }

    /* --- 平均完成周期：createdAt → doneAt 的天数 ---
        ★ 一条都没完成时是 `null`（不知道），不是 0。 */
    var spans = [];
    tasks.forEach(function (t) {
      if (t.status === "done" && t.doneAt && t.createdAt) {
        var s = (t.doneAt - t.createdAt) / 86400000;
        if (s >= 0 && s < 3650) spans.push(s);
      }
    });
    var avgCycle = spans.length
      ? Math.round(spans.reduce(function (a, b) { return a + b; }, 0) / spans.length * 10) / 10
      : null;

    /* --- 近 14 天：每天「新增」和「完成」两条序列 --- */
    var trend = [];
    for (var j = TREND_DAYS - 1; j >= 0; j--) {
      var day = dayShift(today, -j);
      trend.push({
        d: day,
        label: day.slice(5),
        add: tasks.filter(function (t) {
          return t.createdAt && ymd(new Date(t.createdAt)) === day;
        }).length,
        done: doneOn(day)
      });
    }

    /* --- 热力图：近 12 周 × 7 天（GitHub 那种）。
        ★ 对齐到「本周一」结尾，最后一列是本周 —— 否则右边会缺一角。 */
    var heatEnd = (function () {
      var d = new Date(today + "T00:00:00");
      var wd = (d.getDay() + 6) % 7;
      d.setDate(d.getDate() + (6 - wd));
      return ymd(d);
    })();
    var heat = [];
    for (var w = HEAT_WEEKS - 1; w >= 0; w--) {
      for (var dd = 0; dd < 7; dd++) {
        var day2 = dayShift(heatEnd, -(w * 7) - (6 - dd));
        heat.push({ d: day2, n: doneOn(day2), future: day2 > today });
      }
    }

    /* --- 分项目（v0.22.0 起是「任务分析」的骨架，不再只是「分布」）---
       ★ 近 7 天窗口含今天（起点 today-6），与 trend 那条序列同口径 ——
         看板上两个地方说「近 7 天」却用两个窗口，是最容易被抓住的那种不一致。 */
    var wk7 = dayShift(today, -6);
    function cycleOf(list) {
      /* ★★ 「–」≠「0」：这一类**一条都没完成过**时，平均周期是「不知道」（null），
         不是 0 天。显示成 0 会被读成「这类任务当天就做完」—— 意思正好相反。
         与上面 avgCycle 同一套判据，只是分母换成「这一类」。 */
      var sp = [];
      list.forEach(function (t) {
        if (t.status === "done" && t.doneAt && t.createdAt) {
          var d = (t.doneAt - t.createdAt) / 86400000;
          if (d >= 0 && d < 3650) sp.push(d);
        }
      });
      if (!sp.length) return null;
      return Math.round(sp.reduce(function (a, b) { return a + b; }, 0) / sp.length * 10) / 10;
    }
    var byProj = projs.map(function (p) {
      var mine = live.filter(function (t) { return t.project === p.name; });
      var dn = mine.filter(function (t) { return t.status === "done"; });
      return {
        name: p.name,
        color: p.color || "#98a0ad",
        total: mine.length,
        done: dn.length,
        open: mine.filter(function (t) { return t.status !== "done" && t.status !== HOLD; }).length,
        pct: mine.length ? Math.round(dn.length / mine.length * 100) : 0,
        /* 占比的分母是**在手任务总数**，不是「已归类条数」。
           ★ 用后者的话各行加起来正好 100%、看着非常整齐，但那是假的：
             它把「没归类的任务」从分母里悄悄抹掉了，于是占比会集体偏大。 */
        share: live.length ? Math.round(mine.length / live.length * 100) : 0,
        cycle: cycleOf(mine),
        add7: mine.filter(function (t) {
          return t.createdAt && ymd(new Date(t.createdAt)) >= wk7;
        }).length,
        done7: mine.filter(function (t) {
          return t.status === "done" && t.doneAt && ymd(new Date(t.doneAt)) >= wk7;
        }).length
      };
    }).sort(function (a, b) { return b.total - a.total; });

    /* 一条都没归到项目的任务（project 为空，或那个项目名后来被删了）。
       ★ 必须单独留个数：分析表的占比合计对不上 100% 时，用户会先怀疑看板算错了，
         而不是想到「我有几条没归类」—— 那两句导向的行动完全不同。 */
    var assigned = byProj.reduce(function (a, p) { return a + p.total; }, 0);
    var unassigned = Math.max(0, live.length - assigned);

    /* --- 优先级（三档；没设 = 普通） --- */
    var PRI = [["high", "高", "var(--pri-high)"], ["mid", "中", "var(--pri-mid)"], ["", "普通", "var(--pri-low)"]];
    var byPri = PRI.map(function (p) {
      var mine = live.filter(function (t) { return (t.priority || "") === p[0]; });
      return {
        key: p[0], name: p[1], color: p[2],
        total: mine.length,
        open: mine.filter(function (t) { return t.status !== "done"; }).length
      };
    });

    /* --- 需要关注：逾期最久 → 今天到期 → 挂起最久。
        ★ 排序要稳定：同一天的两个任务不能每次刷新换位置。 --- */
    var focus = overdue.slice().sort(function (a, b) {
      return (a.date || "").localeCompare(b.date || "") || (a.createdAt || 0) - (b.createdAt || 0);
    }).map(function (t) { return { t: t, why: "逾期 " + Math.abs(diffDays(t.date, today)) + " 天", kind: "over" }; });

    dueToday.forEach(function (t) { focus.push({ t: t, why: "今天到期", kind: "today" }); });
    hold.slice().sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); })
      .forEach(function (t) { focus.push({ t: t, why: "挂着没动", kind: "hold" }); });

    return {
      today: today,
      total: tasks.length, live: live.length, arch: arch,
      /* ★ 两个「完成数」，都要留：
         `done`   = 看板上看得见的完成数（不含归档）—— 完成率的分子，跟看板画面对得上；
         `doneAll`= 含归档 —— 跟设置页那行「已完成 N 条」对得上（那条是 total−open−hold）。
         只留一个的话，另一个地方势必要就地重算，迟早算岔成两个数。 */
      done: done.length,
      /* 用 tasks.length 现算，别引用上面那个键名 —— `total` 只是返回对象的键，
         在同一个字面量里它不是变量（这里踩过一次 ReferenceError）。
         ★★ v0.43.0：改成**直接数完成条数**，不再用 `tasks.length − open − hold` ——
           那个公式会把「交出去的」也算成已完成（`tasks.length` 含它们，
           而 `open` / `hold` 现在都不含）。它要表达的是「完成过多少条（含归档）」。 */
      doneAll: tasks.filter(function (t) { return t.status === "done"; }).length,
      donePct: live.length ? Math.round(done.length / live.length * 100) : 0,
      open: open.length, doing: doing.length, hold: hold.length,
      overdue: overdue.length, dueToday: dueToday.length,
      weekDone: weekDone, streak: streak, avgCycle: avgCycle,
      trend: trend, heat: heat, byProj: byProj, byPri: byPri,
      unassigned: unassigned,
      focus: focus.slice(0, FOCUS_MAX), focusMore: Math.max(0, focus.length - FOCUS_MAX),
      /* ★ v0.40.0：团队任务那一块（只读）。`null` = 读不到团队模块
         （脚本没按 manage.html 的顺序引）—— 渲染层据此**说清楚**，不是画一排 0。 */
      team: teamOf(team)
    };
  }

  function diffDays(s, today) {
    if (!s) return NaN;
    return Math.round((new Date(s + "T00:00:00") - new Date(today + "T00:00:00")) / 86400000);
  }

  /* ---------------- 渲染层 ---------------- */
  function el(id) { return document.getElementById(id); }
  function svg(w, h, inner) {
    return '<svg class="bd-svg" viewBox="0 0 ' + w + " " + h + '" width="100%" ' +
      'preserveAspectRatio="xMidYMid meet" role="img">' + inner + "</svg>";
  }

  /* --- ① 顶部 KPI 行 ---
     ★ 「平均完成周期」为 null 时给「–」而不是 0 —— 见文件头那条铁律。 */
  function kpiOf(s) {
    return [
      { k: "完成率", v: s.live ? s.donePct + "%" : "–", s: s.live ? s.done + " / " + s.live + " 条" : "还没有任务", tone: "done" },
      { k: "本周完成", v: String(s.weekDone), s: s.streak > 0 ? "连续 " + s.streak + " 天有产出" : "今天还没动", tone: "done" },
      { k: "在手", v: String(s.open), s: s.doing ? "其中 " + s.doing + " 条进行中" : "都在待办", tone: "todo" },
      { k: "逾期", v: String(s.overdue), s: s.overdue ? "最久的在下面" : "没有逾期的", tone: s.overdue ? "over" : "todo" },
      { k: "挂起", v: String(s.hold), s: s.hold ? "需要决定" : "没有挂起的", tone: "hold" },
      { k: "平均周期", v: s.avgCycle === null ? "–" : s.avgCycle + " 天", s: s.avgCycle === null ? "还没有完成的" : "从记下到完成", tone: "todo" }
    ];
  }

  function kpiRow(s) {
    return kpiOf(s).map(function (c) {
      return '<div class="bd-kpi-c" data-tone="' + c.tone + '">' +
        '<span class="bd-k">' + esc(c.k) + "</span>" +
        '<b class="bd-v">' + esc(c.v) + "</b>" +
        '<span class="bd-s">' + esc(c.s) + "</span></div>";
    }).join("");
  }

  /* --- ② 近 14 天：每天两根柱（左=新增 / 右=完成）+ 平均线 --- */
  function trendChart(s) {
    var W = 640, H = 168, padL = 26, padB = 22, padT = 14;
    var n = s.trend.length;
    var max = Math.max(1, Math.max.apply(null, s.trend.map(function (d) { return Math.max(d.add, d.done); })));
    var plotW = W - padL - 8, plotH = H - padT - padB;
    var gap = plotW / n;
    var bw = Math.min(11, Math.max(4, gap / 2.8));

    var bars = "";
    s.trend.forEach(function (d, i) {
      var cx = padL + gap * i + gap / 2;
      var hAdd = Math.round(d.add / max * plotH);
      var hDone = Math.round(d.done / max * plotH);
      var y = padT + plotH;
      bars += '<rect x="' + (cx - bw - 1.5).toFixed(1) + '" y="' + (y - hAdd) + '" width="' + bw.toFixed(1) +
        '" height="' + hAdd + '" rx="2" fill="var(--bd-add)" opacity=".55"/>';
      bars += '<rect x="' + (cx + 1.5).toFixed(1) + '" y="' + (y - hDone) + '" width="' + bw.toFixed(1) +
        '" height="' + hDone + '" rx="2" fill="var(--s-done)"/>';
      // 刻度：逢 5 的倍数或最后一天才写字，否则 14 个标签会糊成一片
      var idx = i === n - 1 || d.label.slice(-1) === "5" || d.label.slice(-1) === "0";
      if (idx) {
        bars += '<text x="' + cx.toFixed(1) + '" y="' + (H - 7) + '" text-anchor="middle" ' +
          'class="bd-tick">' + esc(d.label) + "</text>";
      }
    });

    // 平均完成线（虚线）—— 只在这两周真的有过产出时才画，否则是条贴地的假线
    var avg = s.trend.reduce(function (a, d) { return a + d.done; }, 0) / n;
    var grid = "";
    if (avg > 0) {
      var gy = (padT + plotH - avg / max * plotH).toFixed(1);
      grid += '<line x1="' + padL + '" y1="' + gy + '" x2="' + (W - 8) + '" y2="' + gy +
        '" stroke="var(--line)" stroke-width="1" stroke-dasharray="4 4"/>' +
        '<text x="' + (padL - 5) + '" y="' + (Number(gy) + 3.5).toFixed(1) + '" text-anchor="end" class="bd-tick">' +
        (Math.round(avg * 10) / 10) + "</text>";
    }
    // 基线
    grid += '<line x1="' + padL + '" y1="' + (padT + plotH) + '" x2="' + (W - 8) + '" y2="' + (padT + plotH) +
      '" stroke="var(--line2)" stroke-width="1"/>' +
      '<text x="' + (padL - 5) + '" y="' + (padT + 4) + '" text-anchor="end" class="bd-tick">' + max + "</text>";

    return svg(W, H, grid + bars);
  }

  /* --- ③ 任务分析：按类型逐条拆（v0.22.0 起是本页的主角）---
     老大要的是**分析**：「有哪类任务」只是第一问，后面还得回答「这一类干得怎么样」。
     所以每行除了条数，还带完成率、平均周期、近 7 天还在不在动。
     ★ 不再叫 projBars：它已经不是「画几根条」了，改个名省得下次有人照着旧语义加东西。
     ★ 数字列靠 CSS 的 tabular-nums：比例字宽下数字不等宽，三行的「完成率」
       会各自对不齐，这表就没法竖着读 —— 而竖着读正是它存在的理由。
     ★★ 「–」≠「0」在这里有两个落点，别搞混：
        · 平均周期：这一类一条都没完成过时是**不知道** → `–`（由 compute 给 null）
        · 近 7 天的 0 是**真没有** → 照常显示 `0`
     ★ 空项目（total=0）不渲染：默认项目有 5 个，全列出来表里一半是 0 ——
       那不是在分析，是在报目录。有在手的项目才配占一行。 */
  function anTable(s) {
    var live = s.byProj.filter(function (p) { return p.total > 0; });
    if (!live.length && !s.unassigned) return empty("还没有任务");
    var max = Math.max(1, Math.max.apply(null, live.map(function (p) { return p.total; })));
    var head = '<div class="bd-anrow bd-anhd">' +
      "<span></span><span>类型</span><span>构成（深色=已完成）</span>" +
      '<span class="r">在手</span><span class="r">完成率</span>' +
      '<span class="r">平均周期</span><span class="r">7 天 增/完</span></div>';
    var rows = live.map(function (p) {
      var w = Math.round(p.total / max * 100);
      var wd = p.total ? Math.round(p.done / p.total * 100) : 0;
      return '<div class="bd-anrow">' +
        '<span class="bd-dot" style="background:' + esc(p.color) + '"></span>' +
        '<span class="bd-name" title="' + esc(p.name) + '">' + esc(p.name) + "</span>" +
        '<span class="bd-bar"><i style="width:' + w + "%;background:" + esc(p.color) + '"></i>' +
        '<u style="width:' + Math.round(w * wd / 100) + '%"></u></span>' +
        '<span class="bd-num">' + p.total + "</span>" +
        '<span class="bd-num">' + p.pct + "%</span>" +
        '<span class="bd-num">' + (p.cycle === null ? "–" : p.cycle + " 天") + "</span>" +
        '<span class="bd-num">' + p.add7 + "/" + p.done7 + "</span>" +
        "</div>";
    }).join("");
    var un = s.unassigned > 0
      ? '<div class="bd-anrow bd-anun"><span class="bd-dot"></span>' +
        '<span class="bd-note">另有 ' + s.unassigned +
        " 条没归到任何项目（所以上面各行的占比加起来小于 100%）</span></div>"
      : "";
    return head + rows + un;
  }

  /* --- ④ 优先级：三段堆叠条 --- */
  function priBars(s) {
    var all = s.byPri.reduce(function (a, p) { return a + p.total; }, 0);
    if (!all) return empty("还没有任务");
    var stack = s.byPri.map(function (p) {
      if (!p.total) return "";
      return '<i style="width:' + (p.total / all * 100) + "%;background:" + p.color +
        '" title="' + esc(p.name) + " " + p.total + ' 条"></i>';
    }).join("");
    var rows = s.byPri.map(function (p) {
      return '<div class="bd-row">' +
        '<span class="bd-dot" style="background:' + p.color + '"></span>' +
        '<span class="bd-name">' + esc(p.name) + "</span>" +
        '<span class="bd-num">' + p.total + " 条</span>" +
        '<span class="bd-sub">未完成 ' + p.open + "</span></div>";
    }).join("");
    return '<div class="bd-stack">' + stack + '</div><div class="bd-rows">' + rows + "</div>";
  }

  /* --- ⑤ 完成热力图（GitHub 贡献图）---
     色阶 5 档。★ 0 不是「不知道」，是真没做 —— 所以给它一块最浅的底色，
     而不是留白（留白会被读成「没数据」）。未来的日子（本周还没到的那几天）
     才留白，也就是 `.future`。 */
  function heatCell(n) {
    if (n <= 0) return 0;
    if (n <= 1) return 1;
    if (n <= 3) return 2;
    if (n <= 5) return 3;
    return 4;
  }
  function heatmap(s) {
    var cell = 12, gapC = 3, W = 640;
    var cols = HEAT_WEEKS;
    var gridW = cols * (cell + gapC) - gapC;
    var left = (W - gridW) / 2;             // 居中，两侧留白对称
    var H = 7 * (cell + gapC) - gapC + 20;
    var out = "";
    s.heat.forEach(function (d, i) {
      var wk = Math.floor(i / 7), dk = i % 7;
      var x = left + wk * (cell + gapC);
      var y = dk * (cell + gapC);
      var lv = d.future ? "future" : "l" + heatCell(d.n);
      out += '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + cell + '" height="' + cell +
        '" rx="3" class="bd-cell ' + lv + '"><title>' + esc(d.d) + " · 完成 " + d.n + " 条</title></rect>";
    });
    // 图例（放在右下角，跟格子同一行基线）
    var lx = left + gridW - (5 * (cell + gapC)) - 34;
    out += '<text x="' + lx.toFixed(1) + '" y="' + (H - 6) + '" class="bd-tick">少</text>';
    for (var q = 0; q < 5; q++) {
      out += '<rect x="' + (lx + 20 + q * (cell + gapC)).toFixed(1) + '" y="' + (H - 16) +
        '" width="' + cell + '" height="' + cell + '" rx="3" class="bd-cell l' + q + '"/>';
    }
    out += '<text x="' + (lx + 20 + 5 * (cell + gapC) + 2).toFixed(1) + '" y="' + (H - 6) +
      '" class="bd-tick">多</text>';
    return svg(W, H, out);
  }

  /* --- ⑥ 需要关注 --- */
  function focusList(s) {
    if (!s.focus.length) {
      return empty(s.live ? "没有逾期，也没有挂起的 —— 干净" : "还没有任务");
    }
    var rows = s.focus.map(function (f) {
      return '<div class="bd-focus-row" data-kind="' + f.kind + '">' +
        '<span class="bd-tag">' + esc(f.why) + "</span>" +
        '<span class="bd-ftitle">' + esc(String(f.t.title || "（无题）").slice(0, 40)) + "</span>" +
        '<span class="bd-fproj">' + esc(f.t.project || "未分类") + "</span></div>";
    }).join("");
    var more = s.focusMore ? '<div class="bd-more">还有 ' + s.focusMore + " 条没列出来</div>" : "";
    return rows + more;
  }

  function empty(msg) { return '<div class="bd-empty">' + esc(msg) + "</div>"; }

  /* --- ⑦ 团队任务（v0.40.0 · P0-5 / P0-6）---
     老大原话：「后台看板也增加一个团队任务的看板」。
     ★ 列 = **状态类别**（未开始/进行中/已完成），不是状态 —— Jira 的官方抽象：
       状态可以多，类别只有三个；把九个状态摆成九列，没人看得懂（PRD §4.1）。
       类别词与归类规则都在 `Inbox`（`CAT_TEXT` / `catOf`），这里只决定**顺序**。
     ★★ 「–」≠「0」（本项目最贵的铁律之一）在这里的落点是**两种「空」**：
       · 没同步过  → 「团队任务还没同步过」——**我不知道有几条**，不显示 0
       · 同步过、0 条 → 照常显示 `0`——**真没有**
       两者长得像、含义相反；把前者画成 0，用户会以为活全没了。
     ★ 「另有 N 条没派出去 / 已撤回」单独一句话：它们**不在三列里**（流程外的两条支路），
       不写一句的话，三列加起来对不上「派出去 N 条」，用户会先怀疑看板算错了
       —— 与「没归类的任务」那条同一个道理（见 `unassigned`）。
     ★ 按人一行：谁的活最多排最前（谁压着活最该被看见）；同量按名字排稳 ——
       「同一批数据每次刷新换位置」会让这张表没法竖着读。 */
  function teamBlock(s) {
    var t = s.team;
    if (!t) return empty("这一页读不到团队模块 —— 刷新一下再看看");
    if (!t.on) return empty(Inbox.EMPTY_OFF);
    if (!t.synced) return empty("团队任务还没同步过 —— 打开一次弹窗、或等后台跑一轮就有了");
    var cols = CAT_ORDER.map(function (k) {
      /* ★ v0.42.0：从「上下结构」改成「左右结构」——列名在左、计数徽标在右。
         参考图（老大发来的看板截图）的做法：数字带独立圆角底，扫读时**先看到数字**。
         ★ 数量 `0` 照常渲染（不隐藏）——「真没有」要说得出；
           它与「没同步过 ⇒ 不显示 0」是**两个相反方向**的判据，都要成立（见 teamBlock 抬头）。
         ★ 顺序上是 `bd-ck`（名）在前、`bd-cv`（数）在后：DOM 顺序即视觉顺序，
           右对齐靠 CSS 的 `margin-left:auto`，不靠 `flex-direction:row-reverse`
           —— 后者会让**读屏顺序**也反过来（名字念在数字后面），那是个隐藏的可访问性坑。 */
      return '<div class="bd-col" data-cat="' + k + '">' +
        '<span class="bd-ck">' + esc(Inbox.CAT_TEXT[k]) + "</span>" +
        '<b class="bd-cv">' + t.cols[k] + "</b></div>";
    }).join("");
    var more = [];
    if (t.failed) more.push(t.failed + " 条没派出去");
    if (t.revoked) more.push(t.revoked + " 条已撤回");
    var foot = more.length
      ? '<div class="bd-anrow bd-anun"><span class="bd-dot"></span>' +
        '<span class="bd-note">另有 ' + esc(more.join("、")) +
        "（不在上面三列里）</span></div>"
      : "";
    var people = t.people.length
      ? t.people.map(function (p) {
          /* 「最久未领取」只对**真的还有未领取的**那些人写天数；
             没有的话写「没有未领取的」而**不是** `—`：
             `–` 在本项目里是「不知道」，这里的情况恰恰是「确定没有」，两个意思相反。 */
          return '<div class="bd-row">' +
            '<span class="bd-dot"></span>' +
            '<span class="bd-name" title="' + esc(p.name) + '">' + esc(p.name) + "</span>" +
            '<span class="bd-num">' + p.n + " 条</span>" +
            '<span class="bd-sub">已完成 ' + p.done +
            (p.silent >= 0 ? " · 最久未领取 " + p.silent + " 天" : " · 没有未领取的") +
            "</span></div>";
        }).join("")
      : empty("还没派活给任何人");
    return '<div class="bd-cols">' + cols + "</div>" + foot +
      '<div class="bd-split"><div class="bd-hd"><b>按人</b>' +
      '<span class="sub">派出去的活</span></div><div class="bd-rows">' + people + "</div></div>";
  }

  /* ---------------- 把整页画出来 ---------------- */
  function paint(s) {
    var stat = el("bdStat");
    if (stat) {
      stat.textContent = s.total === 0
        ? "数据看板 · 还没有任务"
        : "数据看板 · " + s.live + " 条在手" + (s.arch ? "（另 " + s.arch + " 条已归档）" : "");
    }
    if (el("bdKpi")) el("bdKpi").innerHTML = kpiRow(s);
    if (el("bdTrend")) el("bdTrend").innerHTML = trendChart(s);
    if (el("bdTrendNote")) {
      var tAdd = s.trend.reduce(function (a, d) { return a + d.add; }, 0);
      var tDone = s.trend.reduce(function (a, d) { return a + d.done; }, 0);
      el("bdTrendNote").textContent = "新增 " + tAdd + " / 完成 " + tDone +
        (s.avgCycle === null ? "" : "　平均 " + s.avgCycle + " 天完成");
    }
    /* 卡头那句「以某类为主」是这一页**唯一的一句结论**。
       ★ 取的是 live 里 total 最大的那一类（byProj 已按 total 降序），
         空项目先被过滤掉 —— 否则「一条都没有的工作」会被当成主要类型报出来。 */
    if (el("bdAnNote")) {
      var top = s.byProj.filter(function (p) { return p.total > 0; })[0];
      el("bdAnNote").textContent = !s.live
        ? ""
        : "共 " + s.live + " 条在手" + (top
            ? "　以「" + top.name + "」为主（" + top.total + " 条，占 " + top.share + "%）"
            : "");
    }
    if (el("bdProj")) el("bdProj").innerHTML = anTable(s);
    if (el("bdPri")) el("bdPri").innerHTML = priBars(s);
    if (el("bdHeat")) el("bdHeat").innerHTML = heatmap(s);
    if (el("bdFocus")) el("bdFocus").innerHTML = focusList(s);
    /* ★ v0.40.0：团队任务块。卡头那行「派出去 N 条 · 收到 M 条」是这一块的**口径声明**
       （像「任务分析」的 bdAnNote、「近 14 天」的 bdTrendNote 一样必须印出来）——
       两个数字两个来源，不写清哪个是哪个，用户会把它们当成一件事。 */
    if (el("bdTeam")) el("bdTeam").innerHTML = teamBlock(s);
    if (el("bdTeamNote")) {
      var tm = s.team;
      el("bdTeamNote").textContent = (!tm || !tm.on || !tm.synced)
        ? "" : ("派出去 " + tm.outCount + " 条 · 收到 " + tm.inCount + " 条");
    }
  }

  function load() {
    var k = teamKeys();
    var jobs = [Store(KEY), Store(PKEY)];
    /* ★★ 三个团队 key 走**同一次** Promise.all：分开读会出现
       「条数用的是新数据、状态用的是旧数据」的中间态（一屏里两个时刻的东西）。 */
    if (k) { jobs.push(Store(k.ik)); jobs.push(Store(k.ok)); jobs.push(Store(k.ck)); }
    return Promise.all(jobs).then(function (r) {
      var data = r[0] || {};
      var projs = Array.isArray(r[1]) ? r[1] : [];
      var tasks = data.tasks || [];
      return compute(tasks, projs, k ? teamInput(tasks, r[2], r[3], r[4]) : null);
    });
  }

  function refresh() {
    return load().then(function (s) { paint(s); return s; });
  }

  /* 切到看板这一页时调一次。★ 不做「一直监听 storage」——
     看板不进后台链路，打开时读一次就够；实时刷新会跟同步写抢同一份 key。 */
  window.Board = {
    compute: compute, refresh: refresh, paint: paint, load: load,
    /* ★ v0.40.0：这两个导出**只给测试**（`_test_board.js` 要能逐条对
       「三份数据 → 三列 + 按人」这一步）。界面走 `load()`/`refresh()`。 */
    teamOf: teamOf, teamInput: teamInput, CAT_ORDER: CAT_ORDER
  };
})();
