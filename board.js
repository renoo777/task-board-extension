/* board.js —— 任务数据看板（v0.18.0）
   ============================================================
   这是「设置页 → 看板」那一页的全部逻辑。数据只有一份：`taskboard.v1`。
   看板**只读** —— 不写 storage、不发消息、不新开同步链路。
   （判据：这个文件里不该出现 Store.set / chrome.runtime.sendMessage。）

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

  /* ---------------- 计算层（纯函数） ----------------
     纯函数是这道题的**可测性**所在：喂进去一组任务，出来的每个数字都能
     在测试里逐条对。渲染层只负责把数字摆到该摆的地方。
     ★ 这里不碰 DOM、不碰 storage —— 所以 _test_board.js 能直接调它。 */
  function compute(tasks, projs) {
    tasks = Array.isArray(tasks) ? tasks : [];
    projs = Array.isArray(projs) ? projs : [];
    var today = todayStr();
    var live = tasks.filter(function (t) { return !t.archived; });

    var done = live.filter(function (t) { return t.status === "done"; });
    var doing = live.filter(function (t) { return t.status === "doing"; });
    var hold = live.filter(function (t) { return t.status === HOLD; });
    /* ★ 未完成不含挂起 —— 挂起的东西不该算在手头的活里（与 renderStat 同口径） */
    var open = live.filter(function (t) { return t.status !== "done" && t.status !== HOLD; });
    var arch = tasks.length - live.length;

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
         在同一个字面量里它不是变量（这里踩过一次 ReferenceError）。 */
      doneAll: tasks.length - open.length - hold.length,
      donePct: live.length ? Math.round(done.length / live.length * 100) : 0,
      open: open.length, doing: doing.length, hold: hold.length,
      overdue: overdue.length, dueToday: dueToday.length,
      weekDone: weekDone, streak: streak, avgCycle: avgCycle,
      trend: trend, heat: heat, byProj: byProj, byPri: byPri,
      unassigned: unassigned,
      focus: focus.slice(0, FOCUS_MAX), focusMore: Math.max(0, focus.length - FOCUS_MAX)
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
  }

  function load() {
    return Promise.all([Store(KEY), Store(PKEY)]).then(function (r) {
      var data = r[0] || {};
      var projs = Array.isArray(r[1]) ? r[1] : [];
      return compute(data.tasks || [], projs);
    });
  }

  function refresh() {
    return load().then(function (s) { paint(s); return s; });
  }

  /* 切到看板这一页时调一次。★ 不做「一直监听 storage」——
     看板不进后台链路，打开时读一次就够；实时刷新会跟同步写抢同一份 key。 */
  window.Board = { compute: compute, refresh: refresh, paint: paint, load: load };
})();
